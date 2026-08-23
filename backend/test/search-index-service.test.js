import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import {
  createSearchIndexService,
  normalizeSearchIndexEntry,
  normalizeSearchQuery,
  SEARCH_INDEX_ERROR_CODES
} from '../src/services/searchIndexService.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function createDatabase() {
  const database = new Database(':memory:')
  const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-24T00:00:00.000Z'
  })
  return database
}

function fixtures(version = 1) {
  return [
    {
      entryKey: 'note:1',
      resourceType: 'note',
      domainId: 1,
      title: version === 1 ? '统一搜索设计' : '统一搜索实现',
      body: 'NAS 本机全文检索与故障恢复。',
      tags: ['搜索', 'NAS'],
      status: 'complete',
      sourceKind: 'owner_note',
      sourceLabel: '个人笔记',
      locator: { route: '/blog', postId: 1 },
      sourceUpdatedAt: `2026-08-2${version}T01:00:00.000Z`
    },
    {
      entryKey: 'code-file:2:src/search.js',
      resourceType: 'code_file',
      resourceId: 22,
      domainId: 2,
      parentDomainId: 2,
      title: 'search.js',
      subtitle: 'pr-manager · src/search.js',
      body: 'export function noop() {}\nexport function buildUnifiedSearch() {\n  return "BM25"\n}',
      tags: ['js'],
      status: 'read_only',
      sourceKind: 'git_nas',
      sourceLabel: 'pr-manager',
      locator: { route: '/code', repositoryId: 2, path: 'src/search.js', line: 1 },
      sourceUpdatedAt: '2026-08-24T01:00:00.000Z'
    }
  ]
}

test('normalizes CJK queries and rejects internal paths', () => {
  const query = normalizeSearchQuery({ q: '统一搜索', types: 'note,code_file', limit: 10 })
  assert.match(query.ftsQuery, /统一/u)
  assert.deepEqual(query.types, ['note', 'code_file'])
  assert.throws(
    () => normalizeSearchIndexEntry({
      ...fixtures()[1],
      locator: { route: '/code', repositoryId: 2, path: 'C:\\private\\secret.js', line: 1 }
    }, '2026-08-24T00:00:00.000Z'),
    (error) => error?.code === SEARCH_INDEX_ERROR_CODES.INPUT_INVALID
  )
})

test('refreshes incrementally, filters deterministically, and returns code line references', nativeTestOptions, async () => {
  const database = createDatabase()
  let source = fixtures()
  let tick = 0
  const service = createSearchIndexService({
    database,
    collectEntries: async () => ({ entries: source, errors: [] }),
    now: () => new Date(Date.UTC(2026, 7, 24, 2, 0, tick++))
  })
  try {
    const first = await service.refresh({ rebuild: true })
    assert.deepEqual(first, {
      status: 'ready', inserted: 2, updated: 0, skipped: 0, deleted: 0, entryCount: 2, errorCount: 0
    })
    const note = service.query({ q: '统一搜索', type: 'note', tag: '搜索' })
    assert.equal(note.total, 1)
    assert.equal(note.data[0].entryKey, 'note:1')
    assert.deepEqual(note.data[0].locator, { route: '/blog', postId: 1 })
    assert.equal(note.index.pcWorker.status, 'unavailable')
    const code = service.query({ q: 'buildUnifiedSearch', source: 'git_nas' })
    assert.equal(code.total, 1)
    assert.deepEqual(code.data[0].locator, {
      route: '/code', repositoryId: 2, path: 'src/search.js', line: 2
    })
    const rebuilt = await service.refresh({ rebuild: true })
    assert.deepEqual(
      { inserted: rebuilt.inserted, deleted: rebuilt.deleted, entryCount: rebuilt.entryCount },
      { inserted: 2, deleted: 2, entryCount: 2 }
    )
    assert.equal(service.query({ q: 'buildUnifiedSearch' }).total, 1)
    const repeated = await service.refresh()
    assert.equal(repeated.skipped, 2)
    database.exec('DROP TABLE search_index_fts')
    const healed = await service.refresh()
    assert.equal(healed.skipped, 2)
    assert.equal(service.query({ q: 'buildUnifiedSearch' }).total, 1)
    source = [fixtures(2)[0]]
    const changed = await service.refresh()
    assert.deepEqual(
      { updated: changed.updated, deleted: changed.deleted, entryCount: changed.entryCount },
      { updated: 1, deleted: 1, entryCount: 1 }
    )
    assert.equal(service.query({ q: '实现' }).data[0].title, '统一搜索实现')
    assert.equal(service.query({ q: 'buildUnifiedSearch' }).total, 0)
  } finally {
    database.close()
  }
})

test('reports a stable missing-index error instead of using a LIKE fallback', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    const service = createSearchIndexService({ database, collectEntries: async () => [] })
    assert.throws(
      () => service.query({ q: 'anything' }),
      (error) => error?.code === SEARCH_INDEX_ERROR_CODES.INDEX_MISSING
    )
    assert.equal(service.getStatus().status, 'missing')
  } finally {
    database.close()
  }
})
