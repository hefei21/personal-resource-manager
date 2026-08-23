import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import {
  PC_WORKER_CREDENTIAL_TABLE,
  PC_WORKER_ENROLLMENT_TABLE,
  PC_WORKER_MIGRATIONS,
  PC_WORKER_TABLE
} from '../src/config/pcWorkerSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
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
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }
const workerMigrations = applicationMigrationRegistry.migrations.filter(({ id }) =>
  PC_WORKER_MIGRATIONS.some((migration) => migration.id === id)
)
const workerRegistry = createMigrationRegistry(workerMigrations)

function openDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  return database
}

function runMigrations(database) {
  return executeMigrationBatch({
    database,
    registry: workerRegistry,
    plan: createMigrationPlan(workerRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-23T00:00:00.000Z'
  })
}

test('Stage 5 creates the three Worker tables and repeats compatibility checks', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    assert.equal(PC_WORKER_MIGRATIONS.length, 3)
    const first = runMigrations(database)
    assert.equal(first.executedCount, 3)
    assert.equal(first.skippedCount, 0)
    assert.deepEqual(first.executed.map(({ id }) => id), [
      '0071_pc_workers', '0072_pc_worker_enrollments', '0073_pc_worker_credentials'
    ])
    for (const migration of workerMigrations) {
      assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'satisfied')
    }
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    assert.equal(runMigrations(database).executedCount, 0)
  } finally {
    database.close()
  }
})

test('Worker credential tables reject raw or malformed credential state', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    runMigrations(database)
    const now = '2026-08-23T00:00:00.000Z'
    database.prepare(`INSERT INTO ${PC_WORKER_TABLE} (
      id, display_name, protocol_version, agent_version, platform, architecture,
      capabilities_json, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run('pcw-00000000-0000-4000-8000-000000000001', 'PC', '0.1.0', 'win32', 'x64', '{"processors":[],"resources":{}}', now, now)
    assert.throws(() => database.prepare(`INSERT INTO ${PC_WORKER_ENROLLMENT_TABLE}
      (token_hash, expires_at, created_at) VALUES (?, ?, ?)`)
      .run('raw-secret', now, now))
    assert.throws(() => database.prepare(`INSERT INTO ${PC_WORKER_CREDENTIAL_TABLE}
      (token_hash, worker_id, kind, generation, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('a'.repeat(64), 'missing-worker', 'access', 1, now, now))
  } finally {
    database.close()
  }
})
