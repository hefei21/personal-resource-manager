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
  assert.throws(
    () => store.leaseNext({ owner: 'worker-a', leaseDurationMs: 0 }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_DURATION_INVALID'
  )
  assert.throws(
    () => store.leaseNext({ owner: 'worker-a', now: 'not-a-timestamp' }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_TIMESTAMP_INVALID'
  )
  assert.throws(
    () => store.succeed({ id: 1, owner: 'worker-a', token: 'lease-token', result: circular }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_JSON_INVALID'
  )
  assert.throws(
    () => store.enqueue(taskInput({ availableAt: '2026-08-20T01:02:03Z' })),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_TIMESTAMP_INVALID'
  )
  assert.throws(
    () => store.leaseNext({ owner: 'worker-1', leaseDurationMs: 0 }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_DURATION_INVALID'
  )
  assert.throws(
    () => store.leaseNext({ owner: 'worker-1', leaseDurationMs: 1000, now: 'not-a-time' }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_TIMESTAMP_INVALID'
  )
  assert.throws(
    () => store.succeed({ id: 1, owner: 'worker-1', token: 'lease-token', result: undefined }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_JSON_INVALID'
  )
  assert.throws(
    () => store.leaseNext({ owner: 'worker id', leaseDurationMs: 1000 }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_CREDENTIALS_INVALID'
  )
  assert.throws(
    () => store.fail({ id: 1, owner: 'worker-1', token: 'lease-token', errorCode: 'bad code', errorSummary: 'failure' }),
    (error) => error instanceof TaskStoreError && error.code === 'TASK_ERROR_INVALID'
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

test('leaseNext applies readiness, priority, available time, and execution-class filters', nativeTestOptions, () => {
  const database = new Database(':memory:')
  let tokenNumber = 0
  try {
    applyTaskMigration(database)
    const now = '2026-08-20T02:00:00.000Z'
    const store = createTaskStore({
      database,
      now,
      tokenFactory: () => `lease-token-${++tokenNumber}`
    })
    const future = store.enqueue(taskInput({
      subjectId: 101,
      executionClass: 'disk',
      priority: 100,
      availableAt: '2026-08-20T03:00:00.000Z'
    })).task
    const firstReady = store.enqueue(taskInput({
      subjectId: 102,
      executionClass: 'disk',
      priority: 5,
      availableAt: '2026-08-20T01:59:00.000Z'
    })).task
    const secondReady = store.enqueue(taskInput({
      subjectId: 103,
      executionClass: 'disk',
      priority: 5,
      availableAt: '2026-08-20T02:00:00.000Z'
    })).task
    const cpuReady = store.enqueue(taskInput({
      subjectId: 104,
      executionClass: 'cpu',
      priority: 500,
      availableAt: '2026-08-20T01:00:00.000Z'
    })).task

    const firstLease = store.leaseNext({ owner: 'worker-disk', leaseDurationMs: 5000, executionClass: 'disk' })
    assert.equal(firstLease.id, firstReady.id)
    assert.equal(firstLease.attemptCount, 1)
    assert.equal(firstLease.status, 'leased')
    assert.equal(firstLease.leaseOwner, 'worker-disk')
    assert.match(firstLease.leaseToken, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)

    const secondLease = store.leaseNext({ owner: 'worker-disk', leaseDurationMs: 5000, executionClasses: ['disk'] })
    assert.equal(secondLease.id, secondReady.id)
    assert.equal(store.getById(future.id).status, 'pending')

    const cpuLease = store.leaseNext({ owner: 'worker-cpu', leaseDurationMs: 5000, executionClass: 'cpu' })
    assert.equal(cpuLease.id, cpuReady.id)
    assert.equal(store.leaseNext({ owner: 'worker-disk', leaseDurationMs: 5000, executionClass: 'disk' }), null)
  } finally {
    database.close()
  }
})

test('two SQLite connections cannot lease the same pending task', nativeTestOptions, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-manager-task-competition-'))
  const databasePath = path.join(directory, 'tasks.sqlite')
  let firstDatabase
  let secondDatabase
  try {
    firstDatabase = new Database(databasePath)
    applyTaskMigration(firstDatabase)
    secondDatabase = new Database(databasePath)
    applyTaskMigration(secondDatabase)
    const firstStore = createTaskStore({
      database: firstDatabase,
      now: '2026-08-20T02:00:00.000Z',
      tokenFactory: () => 'first-connection-token'
    })
    const secondStore = createTaskStore({
      database: secondDatabase,
      now: '2026-08-20T02:00:00.000Z',
      tokenFactory: () => 'second-connection-token'
    })
    const task = firstStore.enqueue(taskInput({ subjectId: 105 })).task
    const firstLease = firstStore.leaseNext({ owner: 'worker-a', leaseDurationMs: 5000 })
    const secondLease = secondStore.leaseNext({ owner: 'worker-b', leaseDurationMs: 5000 })
    assert.equal(firstLease.id, task.id)
    assert.equal(secondLease, null)
    assert.equal(secondStore.getById(task.id).leaseOwner, 'worker-a')
  } finally {
    if (secondDatabase?.open) secondDatabase.close()
    if (firstDatabase?.open) firstDatabase.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('lease credentials and expiry protect markRunning and heartbeat', nativeTestOptions, () => {
  const database = new Database(':memory:')
  let now = '2026-08-20T02:00:00.000Z'
  try {
    applyTaskMigration(database)
    const store = createTaskStore({ database, now: () => now, tokenFactory: () => 'protected-token' })
    const task = store.enqueue(taskInput({ subjectId: 106 })).task
    const lease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 })
    assert.equal(lease.id, task.id)
    assert.throws(
      () => store.markRunning({ id: task.id, owner: 'worker-b', token: lease.leaseToken }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_MISMATCH'
    )
    assert.equal(store.getById(task.id).status, 'leased')

    now = '2026-08-20T02:00:00.100Z'
    const nonShortened = store.heartbeat({
      id: task.id,
      owner: 'worker-a',
      token: lease.leaseToken,
      leaseDurationMs: 100
    })
    assert.equal(nonShortened.leaseExpiresAt, '2026-08-20T02:00:01.000Z')

    now = '2026-08-20T02:00:01.000Z'
    assert.throws(
      () => store.markRunning({ id: task.id, owner: 'worker-a', token: lease.leaseToken }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_EXPIRED'
    )
    assert.throws(
      () => store.heartbeat({ id: task.id, owner: 'worker-a', token: lease.leaseToken, leaseDurationMs: 1000 }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_EXPIRED'
    )
    assert.equal(store.getById(task.id).status, 'leased')
  } finally {
    database.close()
  }
})

test('success requires the running lease and stores canonical JSON result', nativeTestOptions, () => {
  const database = new Database(':memory:')
  let now = '2026-08-20T02:00:00.000Z'
  try {
    applyTaskMigration(database)
    const store = createTaskStore({ database, now: () => now, tokenFactory: () => 'success-token' })
    const task = store.enqueue(taskInput({ subjectId: 107 })).task
    const lease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 })
    const running = store.markRunning({ id: task.id, owner: 'worker-a', token: lease.leaseToken })
    assert.equal(running.status, 'running')
    now = '2026-08-20T02:00:00.500Z'
    const renewed = store.heartbeat({
      id: task.id,
      owner: 'worker-a',
      token: lease.leaseToken,
      leaseDurationMs: 5000
    })
    assert.equal(renewed.leaseExpiresAt, '2026-08-20T02:00:05.500Z')
    const succeeded = store.succeed({
      id: task.id,
      owner: 'worker-a',
      token: lease.leaseToken,
      result: { z: 1, a: ['done'] }
    })
    assert.equal(succeeded.status, 'succeeded')
    assert.equal(succeeded.progress, 100)
    assert.deepEqual(succeeded.result, { a: ['done'], z: 1 })
    assert.equal(succeeded.leaseToken, null)
    assert.equal(succeeded.leaseOwner, null)
    assert.equal(succeeded.leaseExpiresAt, null)
    assert.equal(succeeded.heartbeatAt, null)
    assert.equal(succeeded.finishedAt, now)
    assert.throws(
      () => store.succeed({ id: task.id, owner: 'worker-a', token: lease.leaseToken, result: { duplicate: true } }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_INVALID_STATE'
    )
  } finally {
    database.close()
  }
})

test('fail schedules a legal retry and then terminates at max attempts', nativeTestOptions, () => {
  const database = new Database(':memory:')
  let now = '2026-08-20T02:00:00.000Z'
  let tokenNumber = 0
  try {
    applyTaskMigration(database)
    const store = createTaskStore({
      database,
      now: () => now,
      tokenFactory: () => `retry-token-${++tokenNumber}`
    })
    const task = store.enqueue(taskInput({ subjectId: 108, maxAttempts: 2 })).task
    const firstLease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 })
    const firstFailure = store.fail({
      id: task.id,
      owner: 'worker-a',
      token: firstLease.leaseToken,
      errorCode: 'TRANSIENT_FAILURE',
      errorSummary: 'temporary backend failure',
      retryAt: '2026-08-20T02:00:10.000Z'
    })
    assert.equal(firstFailure.retryScheduled, true)
    assert.equal(firstFailure.task.status, 'pending')
    assert.equal(firstFailure.task.attemptCount, 1)
    assert.equal(firstFailure.task.availableAt, '2026-08-20T02:00:10.000Z')
    assert.equal(firstFailure.task.errorCode, 'TRANSIENT_FAILURE')
    assert.equal(firstFailure.task.leaseToken, null)

    now = '2026-08-20T02:00:10.000Z'
    const secondLease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 })
    assert.equal(secondLease.attemptCount, 2)
    const terminalFailure = store.fail({
      id: task.id,
      owner: 'worker-a',
      token: secondLease.leaseToken,
      errorCode: 'PERMANENT_FAILURE',
      errorSummary: 'attempt budget exhausted'
    })
    assert.equal(terminalFailure.retryScheduled, false)
    assert.equal(terminalFailure.task.status, 'failed')
    assert.equal(terminalFailure.task.attemptCount, 2)
    assert.equal(terminalFailure.task.finishedAt, now)
    assert.equal(store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 }), null)
  } finally {
    database.close()
  }
})

test('cancel handles pending and active tasks while rejecting terminal repeats', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    applyTaskMigration(database)
    const store = createTaskStore({ database, now: '2026-08-20T02:00:00.000Z', tokenFactory: () => 'cancel-token' })
    const pending = store.enqueue(taskInput({ subjectId: 109 })).task
    const cancelledPending = store.cancel(pending.id)
    assert.equal(cancelledPending.status, 'cancelled')
    assert.equal(cancelledPending.finishedAt, '2026-08-20T02:00:00.000Z')

    const active = store.enqueue(taskInput({ subjectId: 110 })).task
    const lease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 5000 })
    assert.equal(lease.id, active.id)
    assert.throws(
      () => store.cancel({ id: active.id, owner: 'worker-b', token: lease.leaseToken }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_MISMATCH'
    )
    const cancelledActive = store.cancel({ id: active.id, owner: 'worker-a', token: lease.leaseToken })
    assert.equal(cancelledActive.status, 'cancelled')
    assert.equal(cancelledActive.leaseToken, null)
    assert.throws(
      () => store.cancel(active.id),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_INVALID_STATE'
    )
  } finally {
    database.close()
  }
})

test('expired leased/running tasks recover across a close and reopen', nativeTestOptions, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-manager-task-recovery-'))
  const databasePath = path.join(directory, 'tasks.sqlite')
  let database
  let now = '2026-08-20T02:00:00.000Z'
  try {
    database = new Database(databasePath)
    applyTaskMigration(database)
    const store = createTaskStore({ database, now: () => now, tokenFactory: () => `recovery-${now}` })
    const recoverable = store.enqueue(taskInput({ subjectId: 111, maxAttempts: 2 })).task
    const exhausted = store.enqueue(taskInput({ subjectId: 112, maxAttempts: 1 })).task
    const unclaimed = store.enqueue(taskInput({ subjectId: 113 })).task
    const recoverableLease = store.leaseNext({ owner: 'worker-a', leaseDurationMs: 1000 })
    const exhaustedLease = store.leaseNext({ owner: 'worker-b', leaseDurationMs: 1000 })
    assert.equal(recoverableLease.id, recoverable.id)
    assert.equal(exhaustedLease.id, exhausted.id)
    store.markRunning({ id: recoverable.id, owner: 'worker-a', token: recoverableLease.leaseToken })

    now = '2026-08-20T02:00:01.000Z'
    const report = store.recoverExpiredLeases()
    assert.equal(Object.isFrozen(report), true)
    assert.equal(Object.isFrozen(report.recoveredIds), true)
    assert.deepEqual(report.recoveredIds, [recoverable.id])
    assert.deepEqual(report.failedIds, [exhausted.id])
    assert.equal(report.recoveredCount, 1)
    assert.equal(report.failedCount, 1)
    assert.equal(store.getById(unclaimed.id).status, 'pending')
    assert.equal(store.getById(exhausted.id).errorCode, 'TASK_LEASE_EXPIRED')
    assert.equal(store.getById(exhausted.id).errorSummary, store.getById(recoverable.id).errorSummary)

    database.close()
    database = new Database(databasePath)
    const reopenedStore = createTaskStore({ database, now: () => now, tokenFactory: () => 'reopened-token' })
    const restored = reopenedStore.getById(recoverable.id)
    assert.equal(restored.status, 'pending')
    assert.equal(restored.attemptCount, 1)
    const olderPendingLease = reopenedStore.leaseNext({ owner: 'worker-c', leaseDurationMs: 1000 })
    assert.equal(olderPendingLease.id, unclaimed.id)
    assert.equal(olderPendingLease.attemptCount, 1)
    const reLease = reopenedStore.leaseNext({ owner: 'worker-d', leaseDurationMs: 1000 })
    assert.equal(reLease.id, recoverable.id)
    assert.equal(reLease.attemptCount, 2)
    assert.equal(reopenedStore.getById(exhausted.id).status, 'failed')
    assert.deepEqual(reopenedStore.recoverExpiredLeases(), {
      recoveredCount: 0,
      recoveredIds: [],
      failedCount: 0,
      failedIds: []
    })
  } finally {
    if (database?.open) database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
