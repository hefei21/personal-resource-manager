import assert from 'node:assert/strict'
import test from 'node:test'

import { readRagCoverage } from '../src/services/ragCoverageService.js'

function coverageDatabase() {
  const rows = {
    documents: [{ id: 7, title: 'Owner document' }],
    books: [{ id: 23, title: 'Owner ebook' }],
    code_repositories: [{ id: 5, title: 'Owner repository' }]
  }
  return {
    prepare(sql) {
      return {
        get(tableName) {
          if (sql.includes('sqlite_master')) return Object.hasOwn(rows, tableName) ? { present: 1 } : undefined
          return undefined
        },
        all() {
          const table = Object.keys(rows).find((name) => sql.includes(`FROM ${name}`))
          return table ? rows[table] : []
        }
      }
    }
  }
}

test('coverage summarizes active supported resources without exposing storage internals', async () => {
  const coverage = await readRagCoverage({
    database: coverageDatabase(),
    limit: 100,
    offset: 0,
    sourceStatusProvider: ({ sourceType, sourceId }) => {
      if (sourceType === 'code_repository') return null
      if (sourceType === 'ebook') {
        return {
          sourceState: { status: 'ready', updatedAt: '2026-08-29T00:00:00.000Z' },
          chunks: { count: 12 },
          embedding: { status: 'ready' }
        }
      }
      return { sourceState: { status: 'missing' }, chunks: { count: 0 }, embedding: { status: 'missing' } }
    }
  })
  assert.deepEqual(coverage.summary, {
    total: 2,
    indexed: 1,
    ready: 1,
    partial: 0,
    pending: 0,
    stale: 0,
    failed: 0,
    missing: 1
  })
  assert.equal(coverage.data[0].source.title, 'Owner document')
  assert.equal(coverage.data[1].source.title, 'Owner ebook')
  assert.equal(coverage.data[1].chunkCount, 12)
  assert.doesNotMatch(JSON.stringify(coverage), /storage|path|sha256|secret|token/iu)
})

test('coverage isolates per-source status failures and supports type pagination', async () => {
  const coverage = await readRagCoverage({
    database: coverageDatabase(),
    type: 'ebook',
    limit: 1,
    offset: 0,
    sourceStatusProvider: () => { throw Object.assign(new Error('unavailable'), { code: 'RAG_SOURCE_STATUS_UNAVAILABLE' }) }
  })
  assert.equal(coverage.total, 1)
  assert.equal(coverage.data[0].status, 'failed')
  assert.equal(coverage.data[0].errorCode, 'RAG_SOURCE_STATUS_UNAVAILABLE')
})
