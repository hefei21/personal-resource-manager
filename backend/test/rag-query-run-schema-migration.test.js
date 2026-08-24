import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  CREATE_RAG_QUERY_RUNS_SQL,
  RAG_QUERY_RUN_CONTEXT_MAX_BYTES,
  RAG_QUERY_RUN_INDEXES_SQL,
  RAG_QUERY_RUN_MIGRATIONS,
  RAG_QUERY_RUN_TABLE
} from '../src/config/ragQueryRunSchema.js'

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

const registry = createMigrationRegistry(RAG_QUERY_RUN_MIGRATIONS)

function migrate(database) {
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function createTaskParent(database, id = 17) {
  database.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY)')
  database.prepare('INSERT INTO tasks (id) VALUES (?)').run(id)
}

function insertRun(database, overrides = {}) {
  const values = {
    runId: 'opaque-run-1',
    ownerScope: 'a'.repeat(64),
    taskId: 17,
    taskIdempotencyKey: 'rag-answer-17',
    taskType: 'rag.answer.generate',
    processorVersion: 'v1',
    status: 'pending',
    contextJson: JSON.stringify({ query: '受控查询', evidence: [{ citationId: 'C1', body: 'private derived text' }] }),
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    expiresAt: '2026-08-25T00:15:00.000Z',
    ...overrides
  }
  return database.prepare(`
    INSERT INTO ${RAG_QUERY_RUN_TABLE} (
      run_id, owner_scope, task_id, task_idempotency_key, task_type,
      processor_version, status, context_json, created_at, updated_at, expires_at
    ) VALUES (
      @runId, @ownerScope, @taskId, @taskIdempotencyKey, @taskType,
      @processorVersion, @status, @contextJson, @createdAt, @updatedAt, @expiresAt
    )
  `).run(values)
}

test('registers 0086 with a frozen compatible shape and restart-safe indexes', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    assert.deepEqual(RAG_QUERY_RUN_MIGRATIONS.map(({ id }) => id), ['0086_rag_query_runs'])
    const first = migrate(database)
    assert.deepEqual(first.executed.map(({ id }) => id), ['0086_rag_query_runs'])
    assert.deepEqual(checkMigrationCompatibility(database, RAG_QUERY_RUN_MIGRATIONS[0].compatibility), {
      status: 'satisfied',
      kind: 'table-transition',
      table: RAG_QUERY_RUN_TABLE,
      reason: 'matched'
    })
    assert.deepEqual(
      database.prepare(`SELECT name, type FROM sqlite_schema WHERE name LIKE 'rag_query_runs%' ORDER BY type, name`).all(),
      [
        { name: RAG_QUERY_RUN_TABLE, type: 'table' },
        { name: 'idx_rag_query_runs_expiry', type: 'index' },
        { name: 'idx_rag_query_runs_owner_expiry', type: 'index' },
        { name: 'idx_rag_query_runs_task_id', type: 'index' }
      ]
    )
    const repeated = migrate(database)
    assert.equal(repeated.executed.length, 0)
    assert.equal(repeated.skipped.length, 1)
  } finally {
    database.close()
  }
})

test('binds run ownership and task identity while bounding private derived context', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    createTaskParent(database)
    migrate(database)
    insertRun(database)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RAG_QUERY_RUN_TABLE}`).get().count, 1)

    assert.throws(() => insertRun(database, { runId: 'opaque-run-2' }))
    for (const overrides of [
      { runId: '12' },
      { runId: 'opaque/run-2' },
      { ownerScope: 'A'.repeat(64) },
      { ownerScope: 'a'.repeat(63) },
      { taskType: 'other.task' },
      { status: 'unknown' },
      { contextJson: 'x' },
      { contextJson: 'not-json' },
      { taskId: null, taskIdempotencyKey: null },
      { taskIdempotencyKey: 'x'.repeat(257) },
      { contextJson: JSON.stringify({ body: 'x'.repeat(RAG_QUERY_RUN_CONTEXT_MAX_BYTES) }) }
    ]) assert.throws(() => insertRun(database, { ...overrides, runId: `opaque-${Math.random().toString(36).slice(2)}` }))

    database.prepare(`DELETE FROM ${RAG_QUERY_RUN_TABLE}`).run()
    assert.throws(() => insertRun(database, { taskId: 999 }))
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('migration rolls back the table and indexes on an index conflict', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    ensureMigrationControlTables(database)
    database.exec('CREATE TABLE rag_query_run_conflict (id INTEGER PRIMARY KEY)')
    database.exec('CREATE UNIQUE INDEX idx_rag_query_runs_task_id ON rag_query_run_conflict(id)')
    assert.throws(() => migrate(database))
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?").get(RAG_QUERY_RUN_TABLE).count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_rag_query_runs_%'").get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
  } finally {
    database.close()
  }
})

assert.equal(typeof CREATE_RAG_QUERY_RUNS_SQL, 'string')
assert.equal(typeof RAG_QUERY_RUN_INDEXES_SQL, 'string')
