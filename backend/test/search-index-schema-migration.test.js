import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'

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

function migrate(database) {
  const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-24T00:00:00.000Z'
  })
}

test('creates the FTS5 external-content schema and repeats safely', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    const summary = migrate(database)
    assert.deepEqual(summary.executed.map(({ id }) => id), [
      '0074_search_index_entries',
      '0075_search_index_fts'
    ])
    assert.deepEqual(
      database.prepare("SELECT name, type FROM sqlite_schema WHERE name LIKE 'search_index_%' ORDER BY name").all(),
      [
        { name: 'search_index_entries', type: 'table' },
        { name: 'search_index_entries_autoinc', type: 'table' },
        { name: 'search_index_fts', type: 'table' },
        { name: 'search_index_fts_config', type: 'table' },
        { name: 'search_index_fts_data', type: 'table' },
        { name: 'search_index_fts_docsize', type: 'table' },
        { name: 'search_index_fts_idx', type: 'table' },
        { name: 'search_index_state', type: 'table' }
      ].filter(({ name }) => name !== 'search_index_entries_autoinc')
    )
    assert.deepEqual(database.prepare('SELECT id, schema_version, status, entry_count FROM search_index_state').get(), {
      id: 1,
      schema_version: 1,
      status: 'empty',
      entry_count: 0
    })
    const repeated = migrate(database)
    assert.equal(repeated.executed.length, 0)
    assert.equal(repeated.skipped.length, 2)
  } finally {
    database.close()
  }
})

test('supports deterministic external-content rebuilds', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const insert = database.prepare(`
      INSERT INTO search_index_entries (
        entry_key, resource_type, domain_id, title, source_kind, search_text,
        locator_json, source_fingerprint, indexed_at
      ) VALUES (?, 'note', 1, ?, 'owner_note', ?, ?, ?, ?)
    `)
    insert.run(
      'note:1',
      '统一搜索',
      '统一搜索 统一 搜索 统 一 搜 索',
      '{"route":"/blog","postId":1}',
      'a'.repeat(64),
      '2026-08-24T00:00:00.000Z'
    )
    database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('rebuild')").run()
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM search_index_fts WHERE search_index_fts MATCH '统一'").get().count, 1)
    database.prepare('UPDATE search_index_entries SET search_text = ?, source_fingerprint = ? WHERE entry_key = ?')
      .run('故障恢复 故障 恢复', 'b'.repeat(64), 'note:1')
    database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('rebuild')").run()
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM search_index_fts WHERE search_index_fts MATCH '统一'").get().count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM search_index_fts WHERE search_index_fts MATCH '故障'").get().count, 1)
    database.prepare('DELETE FROM search_index_entries WHERE entry_key = ?').run('note:1')
    database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('rebuild')").run()
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM search_index_fts').get().count, 0)
  } finally {
    database.close()
  }
})
