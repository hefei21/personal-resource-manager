import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import {
  TaskStoreError,
  createTaskStore,
  deriveTaskIdempotencyKey,
  normalizeTaskIdentity
} from '../src/services/taskStore.js'

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
const taskMigration = applicationMigrationRegistry.migrations.find(({ id }) => id === '0054_persistent_tasks')

function applyTaskMigration(database) {
  ensureMigrationControlTables(database)
  const registry = createMigrationRegistry([taskMigration])
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-20T00:00:00.000Z'
  })
}

function taskInput(overrides = {}) {
  return {
    taskType: 'document.extract',
    processorVersion: 'extractor-v1',
    subjectType: 'document',
    subjectId: 42,
    subjectVersionId: 7,
    subjectContentSha256: 'a'.repeat(64),
    executionClass: 'disk',
    input: { mode: 'text', pages: [1, 2] },
    ...overrides
  }
}

test('task identity is normalized into a stable content-bound idempotency key', () => {
  const first = normalizeTaskIdentity({
    taskType: 'document.extract',
    processorVersion: 'extractor-v1',
    subjectType: 'document',
    subjectId: 42,
    subjectVersionId: 7,
    subjectContentSha256: 'a'.repeat(64)
  })
  const second = normalizeTaskIdentity({
    subjectContentHash: 'A'.repeat(64),
    subjectVersionId: '7',
    subjectId: '42',
    subjectType: 'document',
    processorVersion: 'extractor-v1',
    taskType: 'document.extract'
  })
  assert.deepEqual(first, second)
  assert.match(deriveTaskIdempotencyKey(first), /^task:[a-f0-9]{64}$/u)
  assert.equal(deriveTaskIdempotencyKey(first), deriveTaskIdempotencyKey(second))
  assert.throws(
    () => normalizeTaskIdentity({ ...first, title: 'must-not-identify-a-task' }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_IDENTITY_INVALID'
  )
})

test('task input validation rejects circular JSON and invalid scheduling values before database access', () => {
  const circular = {}
  circular.self = circular
  const fakeDatabase = {
    prepare() { throw new Error('database must not be reached') },
    transaction(callback) { return callback }
  }
  const store = createTaskStore({ database: fakeDatabase, now: '2026-08-20T01:02:03.000Z' })
  assert.throws(
    () => store.enqueue(taskInput({ input: circular })),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_JSON_INVALID'
  )
  assert.throws(
    () => store.enqueue(taskInput({ maxAttempts: 0 })),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_NUMBER_INVALID'
  )
  assert.throws(
    () => store.enqueue(taskInput({ executionClass: 'unbounded' })),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_EXECUTION_CLASS_INVALID'
  )
})

test('0054 creates the persistent task shape and preserves an existing database', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept');")
    assert.equal(checkMigrationCompatibility(database, taskMigration.compatibility).status, 'missing')
    const summary = applyTaskMigration(database)
    assert.equal(summary.executedCount, 1)
    assert.equal(database.prepare('SELECT value FROM sentinel').pluck().get(), 'kept')
    assert.equal(checkMigrationCompatibility(database, taskMigration.compatibility).status, 'satisfied')

    const columns = database.pragma('table_xinfo(tasks)')
    assert.equal(columns.find(({ name }) => name === 'status').dflt_value, "'pending'")
    assert.equal(columns.find(({ name }) => name === 'execution_class').dflt_value, "'cpu'")
    assert.equal(columns.find(({ name }) => name === 'max_attempts').dflt_value, '3')
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'tasks' ORDER BY name").pluck().all(),
      ['idx_tasks_claim', 'idx_tasks_created_at', 'idx_tasks_idempotency_key', 'idx_tasks_subject']
    )
    assert.throws(() => database.prepare(`INSERT INTO tasks (
      idempotency_key, input_fingerprint, task_type, processor_version, subject_type, subject_id,
      input_json, status, execution_class, priority, available_at, max_attempts, created_at, updated_at
    ) VALUES (?, ?, 'x', 'v1', 'document', '1', '{}', 'lost', 'cpu', 0, ?, 1, ?, ?)`)
      .run('task:' + 'b'.repeat(64), 'c'.repeat(64), '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'))
  } finally {
    database.close()
  }
})

test('TaskStore enqueues atomically, deduplicates canonical input, and fails closed on conflicts', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    applyTaskMigration(database)
    const store = createTaskStore({ database, now: '2026-08-20T01:02:03.000Z' })
    const first = store.enqueue(taskInput())
    const repeated = store.enqueue(taskInput({ input: { pages: [1, 2], mode: 'text' } }))
    const created = first.task
    assert.equal(first.created, true)
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, created.id)
    assert.equal(database.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1)
    assert.equal(created.status, 'pending')
    assert.equal(created.executionClass, 'disk')
    assert.deepEqual(created.input, { mode: 'text', pages: [1, 2] })
    assert.equal(store.getById(String(created.id)).idempotencyKey, created.idempotencyKey)
    assert.equal(store.getByIdempotencyKey(created.idempotencyKey).id, created.id)
    assert.deepEqual(store.list({ status: ['pending', 'failed'], executionClass: 'disk', limit: 10 }).map(({ id }) => id), [created.id])
    assert.throws(
      () => store.enqueue(taskInput({ input: { mode: 'metadata' } })),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_IDEMPOTENCY_CONFLICT'
    )
    assert.equal(database.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1)
    assert.throws(() => store.list({ limit: 101 }), (error) => error.code === 'TASK_NUMBER_INVALID')
  } finally {
    database.close()
  }
})

test('TaskStore records survive closing and reopening the same SQLite file', nativeTestOptions, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-manager-task-store-'))
  const databasePath = path.join(directory, 'tasks.sqlite')
  let database
  try {
    database = new Database(databasePath)
    applyTaskMigration(database)
    const created = createTaskStore({ database, now: '2026-08-20T01:02:03.000Z' }).enqueue(taskInput()).task
    database.close()
    database = new Database(databasePath)
    const restored = createTaskStore(database).getById(created.id)
    assert.equal(restored.idempotencyKey, created.idempotencyKey)
    assert.equal(restored.subjectContentHash, 'a'.repeat(64))
  } finally {
    if (database?.open) database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
