import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

import { CODE_SYMBOL_INDEX_MIGRATIONS } from '../src/config/codeSymbolIndexSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  createCodeSymbolIndexService,
  normalizeCodeSymbolSnapshot
} from '../src/services/codeSymbolIndexService.js'

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

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function setup() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO code_repositories (id, name) VALUES (1, 'search-service');
  `)
  const registry = createMigrationRegistry(CODE_SYMBOL_INDEX_MIGRATIONS)
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-24T00:00:00.000Z'
  })
  let tick = 0
  const service = createCodeSymbolIndexService({
    database,
    now: () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++))
  })
  return { database, service }
}

function snapshot(commit = COMMIT_A, overrides = {}) {
  const content = `export class SearchService {
  query(input) {
    return input
  }
}
`
  return {
    repositoryId: 1,
    sourceKind: 'managed_git',
    branch: 'main',
    commit,
    files: [{ path: 'src/search.js', content, contentHash: hash(content) }],
    ...overrides
  }
}

test('atomically activates commit-bound symbols and returns public line locators', nativeTestOptions, () => {
  const { database, service } = setup()
  try {
    const refreshed = service.refreshSnapshot(snapshot())
    assert.deepEqual(refreshed, {
      repositoryId: 1,
      snapshotId: 1,
      status: 'ready',
      skipped: false,
      fileCount: 1,
      symbolCount: 2,
      errorCount: 0
    })
    const result = service.query({ q: 'SearchService.query', limit: 5 })
    assert.equal(result.total, 1)
    assert.equal(result.data[0].title, 'SearchService.query')
    assert.deepEqual(result.data[0].locator, {
      route: '/code', repositoryId: 1, path: 'src/search.js', line: 2, commit: COMMIT_A
    })
    assert.equal(result.data[0].indexStatus, 'ready')
    assert.equal(JSON.stringify(result).includes('E:\\'), false)
    assert.equal(service.query({ q: 'query', source: 'git_nas' }).total, 0)
    assert.equal(service.query({ q: 'query', source: 'managed_git', tag: 'method' }).total, 1)
    assert.equal(service.query({ q: 'query', scope: 'external' }).total, 0)
    assert.equal(service.query({ q: 'query', author: 'Owner' }).total, 0)

    const skipped = service.refreshSnapshot(snapshot())
    assert.equal(skipped.skipped, true)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_symbol_snapshots').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_symbol_entries').get().count, 2)
  } finally {
    database.close()
  }
})

test('replaces the active snapshot on commit change and records partial extraction input', nativeTestOptions, () => {
  const { database, service } = setup()
  try {
    service.refreshSnapshot(snapshot())
    const result = service.refreshSnapshot(snapshot(COMMIT_B, {
      errors: [{ code: 'CODE_SYMBOL_UNREADABLE_FILE', path: 'src/broken.ts' }]
    }))
    assert.equal(result.status, 'partial')
    assert.equal(result.errorCount, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_symbol_snapshots').get().count, 1)
    assert.equal(database.prepare('SELECT commit_hash FROM code_symbol_snapshots').get().commit_hash, COMMIT_B)
    const query = service.query({ q: 'query' })
    assert.equal(query.data[0].locator.commit, COMMIT_B)
    assert.equal(query.data[0].indexStatus, 'partial')
  } finally {
    database.close()
  }
})

test('does not hide new partial-read errors behind a same-commit skip', nativeTestOptions, () => {
  const { database, service } = setup()
  try {
    service.refreshSnapshot(snapshot())
    const partial = service.refreshSnapshot(snapshot(COMMIT_A, {
      errors: [{ code: 'CODE_SYMBOL_UNREADABLE_FILE', path: 'src/broken.ts' }]
    }))
    assert.equal(partial.skipped, false)
    assert.equal(partial.status, 'partial')
    assert.equal(database.prepare('SELECT status FROM code_symbol_repository_state').get().status, 'partial')
  } finally {
    database.close()
  }
})

test('failed activation rolls back the candidate and preserves the previous snapshot as stale', nativeTestOptions, () => {
  const { database, service } = setup()
  try {
    service.refreshSnapshot(snapshot())
    database.exec(`
      CREATE TRIGGER reject_commit_b
      BEFORE INSERT ON code_symbol_snapshots
      WHEN NEW.commit_hash = '${COMMIT_B}'
      BEGIN
        SELECT RAISE(ABORT, 'candidate rejected');
      END;
    `)
    assert.throws(() => service.refreshSnapshot(snapshot(COMMIT_B)), /refresh failed/iu)
    assert.equal(database.prepare('SELECT commit_hash FROM code_symbol_snapshots').get().commit_hash, COMMIT_A)
    assert.equal(database.prepare('SELECT status FROM code_symbol_repository_state').get().status, 'failed')
    const query = service.query({ q: 'SearchService' })
    assert.equal(query.data[0].locator.commit, COMMIT_A)
    assert.equal(query.data[0].indexStatus, 'stale')
  } finally {
    database.close()
  }
})

test('validates full hashes, content identity, relative paths, and collection limits', () => {
  const content = 'export function safe() {}\n'
  assert.throws(() => normalizeCodeSymbolSnapshot({
    repositoryId: 1,
    sourceKind: 'managed_git',
    commit: 'abc1234',
    files: []
  }), /commit/u)
  assert.throws(() => normalizeCodeSymbolSnapshot({
    repositoryId: 1,
    sourceKind: 'managed_git',
    commit: COMMIT_A,
    files: [{ path: '../escape.js', content, contentHash: hash(content) }]
  }), /path/u)
  assert.throws(() => normalizeCodeSymbolSnapshot({
    repositoryId: 1,
    sourceKind: 'managed_git',
    commit: COMMIT_A,
    files: [{ path: 'safe.js', content, contentHash: 'c'.repeat(64) }]
  }), /does not match/u)
})
