import assert from 'node:assert/strict'
import test from 'node:test'

import { createHybridSearchService } from '../src/services/hybridSearchService.js'

function item(entryKey, overrides = {}) {
  return Object.freeze({
    entryKey,
    resourceType: 'code_file',
    locator: Object.freeze({ route: '/code', repositoryId: 1, path: `${entryKey}.js`, line: 1 }),
    score: 1,
    ...overrides
  })
}

function ftsService() {
  return {
    getStatus: () => ({ status: 'ready', entryCount: 4 }),
    query: ({ q, limit = 20, offset = 0 }) => ({
      query: q,
      data: [item('fts-a'), item('shared'), item('fts-b')].slice(offset, offset + limit),
      total: 3,
      limit,
      offset,
      summary: { code_file: 3, document: 0 },
      index: { status: 'ready' },
      externalDiscovery: { enabled: false, status: 'not_configured' }
    })
  }
}

function symbolService(status = 'ready') {
  return {
    getStatus: () => ({ status, symbolCount: status === 'missing' ? 0 : 2 }),
    query: ({ q, limit = 20, offset = 0 }) => ({
      query: q,
      data: status === 'missing' ? [] : [item('symbol-a'), item('shared')].slice(offset, offset + limit),
      total: status === 'missing' ? 0 : 2,
      limit,
      offset,
      index: { status }
    })
  }
}

test('supports independently measurable FTS, symbol, and default hybrid modes', () => {
  const service = createHybridSearchService({ ftsService: ftsService(), symbolService: symbolService() })
  const fts = service.query({ q: 'search', mode: 'fts', limit: 5 })
  assert.equal(fts.retrieval.mode, 'fts')
  assert.deepEqual(fts.data.map(({ entryKey }) => entryKey), ['fts-a', 'shared', 'fts-b'])

  const symbols = service.query({ q: 'search', mode: 'symbol', limit: 5 })
  assert.equal(symbols.retrieval.mode, 'symbol')
  assert.deepEqual(symbols.data.map(({ entryKey }) => entryKey), ['symbol-a', 'shared'])

  const hybrid = service.query({ q: 'search', limit: 5 })
  assert.equal(hybrid.retrieval.mode, 'hybrid')
  assert.equal(hybrid.total, 5)
  assert.deepEqual(hybrid.data.map(({ entryKey }) => entryKey), ['shared', 'symbol-a', 'fts-a', 'fts-b'])
  assert.deepEqual(hybrid.data[0].retrieval.channels, ['fts', 'symbol'])
  assert.equal(hybrid.index.symbols.symbolCount, 2)
})

test('falls back exactly to FTS when the symbol schema is missing or pagination is too deep', () => {
  const missing = createHybridSearchService({ ftsService: ftsService(), symbolService: symbolService('missing') })
  const fallback = missing.query({ q: 'search', limit: 2 })
  assert.equal(fallback.retrieval.mode, 'fts')
  assert.equal(fallback.retrieval.reason, 'symbol_index_missing')
  assert.deepEqual(fallback.data.map(({ entryKey }) => entryKey), ['fts-a', 'shared'])

  const ready = createHybridSearchService({ ftsService: ftsService(), symbolService: symbolService() })
  const deep = ready.query({ q: 'search', limit: 20, offset: 90 })
  assert.equal(deep.retrieval.mode, 'fts')
  assert.equal(deep.retrieval.reason, 'deep_pagination')
})

test('rejects unsupported retrieval modes before querying either index', () => {
  const service = createHybridSearchService({ ftsService: ftsService(), symbolService: symbolService() })
  assert.throws(() => service.query({ q: 'search', mode: 'vector' }), (error) => error.code === 'SEARCH_INPUT_INVALID')
})
