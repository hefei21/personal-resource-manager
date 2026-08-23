import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { CODE_SYMBOL_INDEX_MIGRATIONS } from '../src/config/codeSymbolIndexSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'

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
  const registry = createMigrationRegistry(CODE_SYMBOL_INDEX_MIGRATIONS)
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-24T00:00:00.000Z'
  })
}

test('creates rebuildable code symbol snapshot, entry, and active-state tables', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    const summary = migrate(database)
    assert.deepEqual(summary.executed.map(({ id }) => id), [
      '0076_code_symbol_snapshots',
      '0077_code_symbol_entries',
      '0078_code_symbol_repository_state'
    ])
    assert.deepEqual(
      database.prepare(`
        SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'code_symbol_%'
         ORDER BY name
      `).all().map(({ name }) => name),
      ['code_symbol_entries', 'code_symbol_repository_state', 'code_symbol_snapshots']
    )
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_code_symbol_%' ORDER BY name").all().map(({ name }) => name),
      [
        'idx_code_symbol_entries_name',
        'idx_code_symbol_entries_repository',
        'idx_code_symbol_entries_snapshot',
        'idx_code_symbol_snapshots_repository',
        'idx_code_symbol_state_active'
      ]
    )
    const repeated = migrate(database)
    assert.equal(repeated.executed.length, 0)
    assert.equal(repeated.skipped.length, 3)
  } finally {
    database.close()
  }
})

test('enforces full commit hashes, source identities, and active-state domains', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    assert.throws(() => database.prepare(`
      INSERT INTO code_symbol_snapshots (
        repository_id, source_kind, commit_hash, extractor_version, strategy_version,
        status, indexed_at
      ) VALUES (1, 'managed_git', 'abc1234', 'v1', 'symbols-v1', 'ready', '2026-08-24T00:00:00.000Z')
    `).run(), /CHECK constraint failed/u)
    assert.throws(() => database.prepare(`
      INSERT INTO code_symbol_repository_state (repository_id, schema_version, status)
      VALUES (1, 1, 'stale')
    `).run(), /CHECK constraint failed/u)
  } finally {
    database.close()
  }
})
