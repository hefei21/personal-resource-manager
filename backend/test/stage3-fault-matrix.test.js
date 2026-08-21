import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { createNasTaskExecutor } from '../src/services/nasTaskExecutor.js'
import { createTaskProcessorRegistry } from '../src/services/taskProcessorRegistry.js'
import { createTaskRuntime } from '../src/services/taskRuntime.js'
import { TaskStoreError, createTaskStore } from '../src/services/taskStore.js'

const require = createRequire(import.meta.url)
const testModuleDirectory = path.dirname(fileURLToPath(import.meta.url))
let Database
let nativeBindingAvailable = true
let nativeProbeDirectory
try {
  Database = require('better-sqlite3')
  nativeProbeDirectory = mkdtempSync(path.join(tmpdir(), 'pr-manager-stage3-native-probe-'))
  const probe = new Database(path.join(nativeProbeDirectory, 'binding-probe.sqlite'))
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
} finally {
  if (nativeProbeDirectory) removeFixture(nativeProbeDirectory)
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 Linux CI must run this matrix' }
function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pr-manager-stage3-fault-matrix-'))
  return Object.freeze({
    directory,
    databasePath: path.join(directory, 'tasks.sqlite')
  })
}

function removeFixture(directory) {
  const resolvedDirectory = path.resolve(directory)
  const resolvedTempRoot = path.resolve(tmpdir())
  assert.ok(resolvedDirectory.startsWith(`${resolvedTempRoot}${path.sep}`))
  rmSync(directory, { recursive: true, force: true })
}

function openTaskDatabase(databasePath) {
  const database = new Database(databasePath)
  const taskSchemaExists = database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'tasks'
  `).get()
  if (!taskSchemaExists) database.exec(CREATE_TASK_SCHEMA_SQL)
  return database
}

async function stopExecutor(executor) {
  if (executor && executor.state !== 'stopped') await executor.stop({ timeoutMs: 0 })
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return Object.freeze({ promise, resolve })
}

async function waitForCondition(predicate, turns = 20) {
  for (let attempt = 0; attempt < turns; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('controlled event sequence did not complete')
}

class ManualTimers {
  nextId = 1
  timers = new Map()

  setTimeout(callback, delay) {
    const id = this.nextId++
    this.timers.set(id, { callback, delay })
    return id
  }

  clearTimeout(id) {
    this.timers.delete(id)
  }
}

function taskInput(overrides = {}) {
  return {
    taskType: 'stage3.matrix',
    processorVersion: 'matrix-v1',
    subjectType: 'document',
    subjectId: 'stage3-document',
    subjectVersionId: 'version-1',
    subjectContentSha256: 'a'.repeat(64),
    executionClass: 'disk',
    input: { mode: 'text' },
    ...overrides
  }
}

test('Stage 3.5A fault matrix: file-backed task identity/input survive process restart and execute to succeeded', nativeTestOptions, async () => {
  const fixture = createFixture()
  let database
  let executor
  let now = '2026-08-20T03:00:00.000Z'
  try {
    database = openTaskDatabase(fixture.databasePath)
    const firstStore = createTaskStore({
      database,
      now: () => now,
      tokenFactory: () => 'restart-token-a'
    })
    const expectedInput = { mode: 'restart', payload: { page: 1 } }
    const created = firstStore.enqueue(taskInput({
      subjectId: 'restart-document',
      subjectVersionId: 'restart-version',
      subjectContentSha256: 'b'.repeat(64),
      input: expectedInput
    })).task

    database.close()
    database = openTaskDatabase(fixture.databasePath)
    const restartedStore = createTaskStore({
      database,
      now: () => now,
      tokenFactory: () => 'restart-token-b'
    })
    const restored = restartedStore.getById(created.id)
    assert.equal(restartedStore.count(), 1)
    assert.equal(restored.idempotencyKey, created.idempotencyKey)
    assert.equal(restored.taskType, 'stage3.matrix')
    assert.equal(restored.processorVersion, 'matrix-v1')
    assert.equal(restored.subjectType, 'document')
    assert.equal(restored.subjectId, 'restart-document')
    assert.equal(restored.subjectVersionId, 'restart-version')
    assert.equal(restored.subjectContentHash, 'b'.repeat(64))
    assert.deepEqual(restored.input, expectedInput)
    assert.equal(restored.status, 'pending')
    assert.equal(restored.attemptCount, 0)

    const registry = createTaskProcessorRegistry({ processors: [{
      taskType: 'stage3.matrix',
      processorVersion: 'matrix-v1',
      executionClass: 'disk',
      handler: async ({ task }) => ({ restartedTaskId: task.id })
    }] })
    executor = createNasTaskExecutor({
      store: restartedStore,
      registry,
      owner: 'restart-worker',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock: () => now
    })
    const round = await executor.runOnce()
    assert.equal(round.succeeded, 1)
    const succeeded = restartedStore.getById(created.id)
    assert.equal(succeeded.status, 'succeeded')
    assert.equal(succeeded.attemptCount, 1)
    assert.deepEqual(succeeded.result, { restartedTaskId: created.id })
  } finally {
    await stopExecutor(executor)
    if (database?.open) database.close()
    removeFixture(fixture.directory)
  }
})

test('Stage 3.5A fault matrix: repeated full-meaning enqueue is idempotent across reopen with one side effect and stable input conflict', nativeTestOptions, async () => {
  const fixture = createFixture()
  let database
  let executor
  let now = '2026-08-20T03:10:00.000Z'
  let sideEffectCount = 0
  try {
    database = openTaskDatabase(fixture.databasePath)
    const firstStore = createTaskStore({ database, now: () => now, tokenFactory: () => 'idempotency-token-a' })
    const identity = taskInput({ subjectId: 'idempotent-document' })
    const first = firstStore.enqueue({
      ...identity,
      input: { mode: 'text', pages: [1, 2] }
    })
    const repeated = firstStore.enqueue({
      ...identity,
      input: { pages: [1, 2], mode: 'text' }
    })
    assert.equal(first.created, true)
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, first.task.id)
    assert.equal(firstStore.count(), 1)

    database.close()
    database = openTaskDatabase(fixture.databasePath)
    const reopenedStore = createTaskStore({ database, now: () => now, tokenFactory: () => 'idempotency-token-b' })
    const reopened = reopenedStore.getByIdempotencyKey(first.task.idempotencyKey)
    assert.equal(reopened.id, first.task.id)
    assert.deepEqual(reopened.input, { mode: 'text', pages: [1, 2] })
    assert.equal(reopened.status, 'pending')
    assert.equal(reopened.attemptCount, 0)
    assert.equal(reopenedStore.count(), 1)

    const registry = createTaskProcessorRegistry({ processors: [{
      taskType: 'stage3.matrix',
      processorVersion: 'matrix-v1',
      executionClass: 'disk',
      handler: async () => {
        sideEffectCount += 1
        return { sideEffectCount }
      }
    }] })
    executor = createNasTaskExecutor({
      store: reopenedStore,
      registry,
      owner: 'idempotency-worker',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock: () => now
    })
    const round = await executor.runOnce()
    assert.equal(round.succeeded, 1)
    assert.equal(sideEffectCount, 1)
    assert.equal(reopenedStore.getById(first.task.id).status, 'succeeded')
    assert.equal(reopenedStore.getById(first.task.id).attemptCount, 1)

    database.close()
    database = openTaskDatabase(fixture.databasePath)
    const finalStore = createTaskStore({ database, now: () => now, tokenFactory: () => 'idempotency-token-c' })
    assert.equal(finalStore.count(), 1)
    assert.equal(finalStore.getById(first.task.id).status, 'succeeded')
    assert.throws(
      () => finalStore.enqueue({ ...identity, input: { mode: 'different' } }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_IDEMPOTENCY_CONFLICT'
    )
    assert.equal(finalStore.count(), 1)
    assert.equal(sideEffectCount, 1)
  } finally {
    await stopExecutor(executor)
    if (database?.open) database.close()
    removeFixture(fixture.directory)
  }
})

test('Stage 3.5A fault matrix: expired worker lease is recovered by a new executor, increments attempt exactly once, and rejects the old token', nativeTestOptions, async () => {
  const fixture = createFixture()
  let databaseA
  let databaseB
  let executor
  let now = '2026-08-20T03:20:00.000Z'
  let sideEffectCount = 0
  try {
    databaseA = openTaskDatabase(fixture.databasePath)
    const storeA = createTaskStore({
      database: databaseA,
      now: () => now,
      tokenFactory: () => 'worker-a-token'
    })
    const task = storeA.enqueue(taskInput({
      subjectId: 'lease-recovery-document',
      maxAttempts: 2
    })).task
    const leaseA = storeA.leaseNext({ owner: 'worker-a', leaseDurationMs: 1_000 })
    const runningA = storeA.markRunning({ id: task.id, owner: 'worker-a', token: leaseA.leaseToken })
    assert.equal(runningA.status, 'running')
    assert.equal(runningA.attemptCount, 1)
    const staleToken = leaseA.leaseToken

    databaseA.close()
    databaseB = openTaskDatabase(fixture.databasePath)
    now = '2026-08-20T03:20:01.000Z'
    const storeB = createTaskStore({
      database: databaseB,
      now: () => now,
      tokenFactory: () => 'worker-b-token'
    })
    let recoveryReport
    const originalRecover = storeB.recoverExpiredLeases.bind(storeB)
    storeB.recoverExpiredLeases = (...args) => {
      recoveryReport = originalRecover(...args)
      return recoveryReport
    }
    const originalMarkRunning = storeB.markRunning.bind(storeB)
    let staleWriteCheckRan = false
    storeB.markRunning = (...args) => {
      const running = originalMarkRunning(...args)
      if (running?.id === task.id) {
        staleWriteCheckRan = true
        assert.throws(
          () => storeB.succeed({ id: task.id, owner: 'worker-a', token: staleToken, result: { stale: true } }),
          (error) => error instanceof TaskStoreError && error.code === 'TASK_LEASE_MISMATCH'
        )
      }
      return running
    }
    const registry = createTaskProcessorRegistry({ processors: [{
      taskType: 'stage3.matrix',
      processorVersion: 'matrix-v1',
      executionClass: 'disk',
      handler: async () => {
        sideEffectCount += 1
        return { recovered: true }
      }
    }] })
    executor = createNasTaskExecutor({
      store: storeB,
      registry,
      owner: 'worker-b',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock: () => now
    })
    const round = await executor.runOnce()
    assert.deepEqual(recoveryReport, {
      recoveredCount: 1,
      recoveredIds: [task.id],
      failedCount: 0,
      failedIds: []
    })
    assert.equal(staleWriteCheckRan, true)
    assert.equal(round.succeeded, 1)
    const recovered = storeB.getById(task.id)
    assert.equal(recovered.status, 'succeeded')
    assert.equal(recovered.attemptCount, 2)
    assert.equal(sideEffectCount, 1)
    assert.equal(storeB.count(), 1)
  } finally {
    await stopExecutor(executor)
    if (databaseA?.open) databaseA.close()
    if (databaseB?.open) databaseB.close()
    removeFixture(fixture.directory)
  }
})

test('Stage 3.5A fault matrix: CPU/disk/network quotas allow cross-class parallelism, cap same-class work, and never claim GPU', nativeTestOptions, async () => {
  const fixture = createFixture()
  let database
  let executor
  const release = deferred()
  let round
  const executionClasses = ['cpu', 'disk', 'network']
  const activeByClass = Object.fromEntries([...executionClasses, 'gpu'].map((executionClass) => [executionClass, 0]))
  const maxByClass = Object.fromEntries([...executionClasses, 'gpu'].map((executionClass) => [executionClass, 0]))
  const completedByClass = Object.fromEntries([...executionClasses, 'gpu'].map((executionClass) => [executionClass, 0]))
  let activeTotal = 0
  let maxActiveTotal = 0
  let startedCount = 0
  let tokenNumber = 0
  try {
    database = openTaskDatabase(fixture.databasePath)
    const store = createTaskStore({
      database,
      now: () => '2026-08-20T03:30:00.000Z',
      tokenFactory: () => `quota-token-${++tokenNumber}`
    })
    const registry = createTaskProcessorRegistry({ processors: executionClasses.map((executionClass) => ({
      taskType: `stage3.${executionClass}`,
      processorVersion: 'quota-v1',
      executionClass,
      handler: async ({ task }) => {
        activeByClass[executionClass] += 1
        activeTotal += 1
        startedCount += 1
        maxByClass[executionClass] = Math.max(maxByClass[executionClass], activeByClass[executionClass])
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal)
        try {
          await release.promise
          completedByClass[executionClass] += 1
          return { taskId: task.id, executionClass }
        } finally {
          activeByClass[executionClass] -= 1
          activeTotal -= 1
        }
      }
    })).concat({
      taskType: 'stage3.gpu',
      processorVersion: 'quota-v1',
      executionClass: 'gpu',
      handler: async () => {
        completedByClass.gpu += 1
        return { shouldNotRun: true }
      }
    }) })
    const tasksByClass = {}
    for (const executionClass of [...executionClasses, 'gpu']) {
      tasksByClass[executionClass] = [1, 2].map((ordinal) => store.enqueue(taskInput({
        taskType: `stage3.${executionClass}`,
        processorVersion: 'quota-v1',
        subjectType: 'quota-test',
        subjectId: `${executionClass}-${ordinal}`,
        executionClass,
        input: { executionClass, ordinal }
      })).task)
    }

    executor = createNasTaskExecutor({
      store,
      registry,
      owner: 'quota-worker',
      quotas: { cpu: 1, disk: 1, network: 1 },
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock: () => '2026-08-20T03:30:00.000Z'
    })
    round = executor.runOnce()
    await waitForCondition(() => startedCount >= executionClasses.length)
    assert.equal(activeTotal, 3)
    assert.equal(maxActiveTotal, 3)
    assert.deepEqual(maxByClass, { cpu: 1, disk: 1, network: 1, gpu: 0 })
    assert.equal(store.getById(tasksByClass.gpu[0].id).status, 'pending')
    assert.equal(store.getById(tasksByClass.gpu[0].id).attemptCount, 0)
    assert.equal(store.getById(tasksByClass.gpu[1].id).status, 'pending')
    assert.equal(store.getById(tasksByClass.gpu[1].id).attemptCount, 0)

    release.resolve()
    const summary = await round
    assert.equal(summary.succeeded, 3)
    for (const executionClass of executionClasses) {
      assert.equal(completedByClass[executionClass], 1)
      assert.equal(store.getById(tasksByClass[executionClass][0].id).status, 'succeeded')
      assert.equal(store.getById(tasksByClass[executionClass][0].id).attemptCount, 1)
      assert.equal(store.getById(tasksByClass[executionClass][1].id).status, 'pending')
      assert.equal(store.getById(tasksByClass[executionClass][1].id).attemptCount, 0)
    }
    assert.equal(completedByClass.gpu, 0)
    assert.equal(store.count(), 8)
  } finally {
    release.resolve()
    if (round) await round.catch(() => {})
    await stopExecutor(executor)
    if (database?.open) database.close()
    removeFixture(fixture.directory)
  }
})

test('Stage 3.5A fault matrix: real SQLite cancellation wins over a late handler result and records SQLite-before-abort order', nativeTestOptions, async () => {
  const fixture = createFixture()
  let database
  let executor
  let round
  const handlerRelease = deferred()
  const events = []
  let handlerContext
  let handlerSideEffectCount = 0
  try {
    database = openTaskDatabase(fixture.databasePath)
    const store = createTaskStore({
      database,
      now: () => '2026-08-20T03:40:00.000Z',
      tokenFactory: () => 'cancel-token'
    })
    const task = store.enqueue(taskInput({ subjectId: 'cancel-document' })).task
    const originalCancel = store.cancel.bind(store)
    store.cancel = (...args) => {
      events.push('sqlite-cancel')
      return originalCancel(...args)
    }
    const registry = createTaskProcessorRegistry({ processors: [{
      taskType: 'stage3.matrix',
      processorVersion: 'matrix-v1',
      executionClass: 'disk',
      handler: async (context) => {
        context.signal.addEventListener('abort', () => events.push('abort'), { once: true })
        handlerContext = context
        await handlerRelease.promise
        handlerSideEffectCount += 1
        return { late: true }
      }
    }] })
    executor = createNasTaskExecutor({
      store,
      registry,
      owner: 'cancel-worker',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      clock: () => '2026-08-20T03:40:00.000Z'
    })
    round = executor.runOnce()
    await waitForCondition(() => handlerContext !== undefined)
    const context = handlerContext
    assert.equal(context.task.id, task.id)
    const cancelled = await executor.cancelTask(task.id)
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(events, ['sqlite-cancel', 'abort'])

    handlerRelease.resolve()
    await round
    const finalTask = store.getById(task.id)
    assert.equal(finalTask.status, 'cancelled')
    assert.equal(finalTask.attemptCount, 1)
    assert.equal(finalTask.result, null)
    assert.equal(finalTask.errorCode, null)
    assert.equal(handlerSideEffectCount, 1)
    assert.equal(store.count(), 1)
  } finally {
    handlerRelease.resolve()
    if (round) await round.catch(() => {})
    await stopExecutor(executor)
    if (database?.open) database.close()
    removeFixture(fixture.directory)
  }
})

test('Stage 3.5A fault matrix: runtime starts from SQLite without Redis availability or network startup', nativeTestOptions, async () => {
  const fixture = createFixture()
  let database
  let runtime
  try {
    const runtimeSource = readFileSync(path.join(testModuleDirectory, '..', 'src', 'services', 'taskRuntime.js'), 'utf8')
    assert.doesNotMatch(runtimeSource, /\b(?:redis|ioredis|createClient)\b/iu)
    assert.match(runtimeSource, /taskStore\.js/u)

    database = openTaskDatabase(fixture.databasePath)
    const timers = new ManualTimers()
    runtime = createTaskRuntime({
      database,
      owner: 'sqlite-runtime',
      registry: createTaskProcessorRegistry(),
      executorOptions: {
        quotas: { cpu: 0, disk: 0, network: 0 },
        timers
      }
    })
    runtime.start()
    assert.equal(runtime.state, 'running')
    assert.equal(runtime.getExecutor().state, 'running')
    assert.equal(runtime.getStore().count(), 0)
    assert.equal(runtime.status().registeredProcessorCount, 0)
  } finally {
    if (runtime) await runtime.stop({ timeoutMs: 0 })
    if (database?.open) database.close()
    removeFixture(fixture.directory)
  }
})
