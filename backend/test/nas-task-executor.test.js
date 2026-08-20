import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  createTaskProcessorRegistry,
  TaskProcessorRegistry,
  TaskProcessorRegistryError
} from '../src/services/taskProcessorRegistry.js'
import {
  createNasTaskExecutor,
  NasTaskExecutorError
} from '../src/services/nasTaskExecutor.js'
import { createTaskStore } from '../src/services/taskStore.js'

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
    subjectId: 400,
    executionClass: 'disk',
    input: { mode: 'text' },
    ...overrides
  }
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

  run(id) {
    const timer = this.timers.get(id)
    if (!timer) return
    this.timers.delete(id)
    timer.callback()
  }

  idsByDelay(delay) {
    return [...this.timers.entries()]
      .filter(([, timer]) => timer.delay === delay)
      .map(([id]) => id)
  }
}

function makeFakeTask(id, executionClass, overrides = {}) {
  return {
    id,
    taskType: overrides.taskType ?? `task.${executionClass}`,
    processorVersion: overrides.processorVersion ?? `${executionClass}-v1`,
    executionClass,
    leaseToken: `lease-${id}`,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: overrides.maxAttempts ?? 2,
    input: overrides.input ?? { id }
  }
}

class FakeTaskStore {
  constructor(tasks) {
    this.tasks = tasks.map((task) => ({ ...task }))
    this.heartbeats = []
    this.successes = []
    this.failures = []
    this.running = []
  }

  leaseNext(options) {
    const supported = new Set(options.supportedProcessors.map((identity) =>
      `${identity.taskType}\u001f${identity.processorVersion}\u001f${identity.executionClass}`
    ))
    const task = this.tasks.find((candidate) => candidate.status === 'pending' &&
      candidate.executionClass === options.executionClass &&
      supported.has(`${candidate.taskType}\u001f${candidate.processorVersion}\u001f${candidate.executionClass}`))
    if (!task) return null
    task.status = 'leased'
    task.attemptCount += 1
    return Object.freeze({ ...task })
  }

  markRunning(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    task.status = 'running'
    this.running.push(task.id)
    return Object.freeze({ ...task })
  }

  heartbeat(options) {
    this.heartbeats.push({ ...options })
    return Object.freeze({ id: options.id, status: 'running' })
  }

  succeed(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    task.status = 'succeeded'
    this.successes.push({ ...options })
    return Object.freeze({ ...task })
  }

  fail(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    task.status = task.attemptCount < task.maxAttempts ? 'pending' : 'failed'
    this.failures.push({ ...options })
    return Object.freeze({ ...task })
  }

  get(id) {
    return this.tasks.find((task) => task.id === id)
  }
}

test('processor registry freezes route identity and rejects duplicate/conflicting routes', () => {
  const firstHandler = () => 'first'
  const secondHandler = () => 'second'
  const registry = new TaskProcessorRegistry()
  const entry = registry.register({
    taskType: 'document.extract',
    processorVersion: 'extractor-v1',
    executionClass: 'disk',
    handler: firstHandler
  })
  assert.equal(Object.isFrozen(entry), true)
  assert.equal(registry.resolve({
    taskType: 'document.extract',
    processorVersion: 'extractor-v1',
    executionClass: 'disk'
  }).handler, firstHandler)
  assert.throws(
    () => registry.register({ ...entry }),
    (error) => error instanceof TaskProcessorRegistryError && error.code === 'TASK_PROCESSOR_DUPLICATE'
  )
  assert.throws(
    () => registry.register({ ...entry, handler: secondHandler }),
    (error) => error instanceof TaskProcessorRegistryError && error.code === 'TASK_PROCESSOR_CONFLICT'
  )
  assert.deepEqual(registry.getSupportedProcessorIdentities(), [{
    taskType: 'document.extract',
    processorVersion: 'extractor-v1',
    executionClass: 'disk'
  }])
})

test('NAS quotas are independent and GPU is never claimable', async () => {
  const tasks = [
    makeFakeTask(1, 'cpu'),
    makeFakeTask(2, 'disk'),
    makeFakeTask(3, 'network'),
    makeFakeTask(4, 'gpu')
  ]
  const store = new FakeTaskStore(tasks)
  const registry = createTaskProcessorRegistry()
  for (const executionClass of ['cpu', 'disk', 'network', 'gpu']) {
    registry.register({
      taskType: `task.${executionClass}`,
      processorVersion: `${executionClass}-v1`,
      executionClass,
      handler: async ({ task }) => ({ taskId: task.id })
    })
  }
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-test',
    quotas: { cpu: 0, disk: 1, network: 1, gpu: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 1000,
    timers
  })
  await executor.runOnce()
  assert.equal(store.get(1).status, 'pending')
  assert.equal(store.get(2).status, 'succeeded')
  assert.equal(store.get(3).status, 'succeeded')
  assert.equal(store.get(4).status, 'pending')
  assert.equal(store.get(1).attemptCount, 0)
  assert.equal(store.get(4).attemptCount, 0)
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor only polls after explicit start and stops future polling', async () => {
  const store = new FakeTaskStore([makeFakeTask(5, 'disk')])
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async () => ({ ok: true })
  }] })
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-poll',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 1000,
    timers
  })
  assert.equal(store.get(5).status, 'pending')
  executor.start()
  const firstPoll = timers.idsByDelay(0)[0]
  assert.ok(firstPoll)
  timers.run(firstPoll)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.get(5).status, 'succeeded')
  const stopPromise = executor.stop({ timeoutMs: 0 })
  await stopPromise
  assert.equal(executor.state, 'stopped')
  assert.equal(timers.idsByDelay(1000).length, 0)
})

test('NAS executor keeps polling while a prior handler is still running', async () => {
  const store = new FakeTaskStore([makeFakeTask(6, 'disk'), makeFakeTask(7, 'disk')])
  let releaseFirst
  const firstPending = new Promise((resolve) => { releaseFirst = resolve })
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async ({ task }) => {
      if (task.id === 6) await firstPending
      return { id: task.id }
    }
  }] })
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-refill',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    pollIntervalMs: 1000,
    timers
  })
  executor.start()
  timers.run(timers.idsByDelay(0)[0])
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.get(6).status, 'running')
  assert.equal(store.get(7).status, 'pending')
  assert.equal(timers.idsByDelay(1000).length, 1)

  releaseFirst()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  timers.run(timers.idsByDelay(1000)[0])
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.get(7).status, 'succeeded')
  await executor.stop({ timeoutMs: 0 })
})

test('stop drains a task whose lease was already in progress', async () => {
  const store = new FakeTaskStore([makeFakeTask(8, 'disk')])
  const leaseNext = store.leaseNext.bind(store)
  let releaseLease
  let announceLease
  const leasePending = new Promise((resolve) => { releaseLease = resolve })
  const leaseStarted = new Promise((resolve) => { announceLease = resolve })
  store.leaseNext = async (options) => {
    announceLease()
    await leasePending
    return leaseNext(options)
  }
  let releaseHandler
  const handlerPending = new Promise((resolve) => { releaseHandler = resolve })
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async () => {
      await handlerPending
      return { ok: true }
    }
  }] })
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-stop-race',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    timers
  })

  const round = executor.runOnce()
  await leaseStarted
  let stopFinished = false
  const stopPromise = executor.stop({ timeoutMs: 50 })
  stopPromise.then(() => { stopFinished = true })
  releaseLease()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.get(8).status, 'running')
  assert.equal(stopFinished, false)

  releaseHandler()
  await round
  const report = await stopPromise
  assert.equal(report.drained, true)
  assert.equal(report.timedOut, false)
  assert.equal(store.get(8).status, 'succeeded')
})

test('NAS executor heartbeat uses a frozen task context and clears its timer', async () => {
  const store = new FakeTaskStore([makeFakeTask(10, 'disk')])
  const registry = createTaskProcessorRegistry()
  let context
  let release
  const waitForRelease = new Promise((resolve) => { release = resolve })
  registry.register({
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async (received) => {
      context = received
      await waitForRelease
      return { done: true }
    }
  })
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-heartbeat',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    timers
  })
  const round = executor.runOnce()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(Object.isFrozen(context.task), true)
  assert.equal(Object.isFrozen(context), true)
  assert.equal(typeof context.heartbeat, 'function')
  const heartbeatTimer = timers.idsByDelay(10)[0]
  assert.ok(heartbeatTimer)
  timers.run(heartbeatTimer)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.heartbeats.length, 1)
  release()
  await round
  assert.equal(timers.idsByDelay(10).length, 0)
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor stop drains before deadline and timeout leaves lease recovery in charge', async () => {
  const store = new FakeTaskStore([makeFakeTask(20, 'disk')])
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async ({ signal }) => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cooperative abort')), { once: true })
    })
  }] })
  const timers = new ManualTimers()
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-stop',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    drainTimeoutMs: 50,
    timers
  })
  const round = executor.runOnce()
  await Promise.resolve()
  await Promise.resolve()
  let stopFinished = false
  const stopPromise = executor.stop()
  stopPromise.then(() => { stopFinished = true })
  await Promise.resolve()
  assert.equal(stopFinished, false)
  const deadline = timers.idsByDelay(50)[0]
  assert.ok(deadline)
  timers.run(deadline)
  const report = await stopPromise
  assert.equal(report.timedOut, true)
  assert.equal(store.get(20).status, 'running')
  assert.equal(store.successes.length, 0)
  assert.equal(store.failures.length, 0)
  assert.equal(timers.idsByDelay(10).length, 0)
  assert.equal(executor.state, 'stopped')
  void round
})

test('NAS executor rejects invalid heartbeat interval and nonzero GPU quota early', () => {
  const store = new FakeTaskStore([])
  const registry = createTaskProcessorRegistry()
  const base = { store, registry, owner: 'nas-invalid' }
  assert.throws(
    () => createNasTaskExecutor({ ...base, leaseDurationMs: 100, heartbeatIntervalMs: 100 }),
    (error) => error instanceof NasTaskExecutorError && error.code === 'NAS_EXECUTOR_HEARTBEAT_INTERVAL_INVALID'
  )
  assert.throws(
    () => createNasTaskExecutor({ ...base, quotas: { gpu: 1 } }),
    (error) => error instanceof NasTaskExecutorError && error.code === 'NAS_EXECUTOR_QUOTA_INVALID'
  )
})

test('manual runOnce exposes store failures instead of reporting an empty success', async () => {
  const store = new FakeTaskStore([])
  store.leaseNext = () => { throw new Error('database unavailable') }
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async () => null
  }] })
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-store-error',
    quotas: { cpu: 0, disk: 1, network: 0 }
  })
  await assert.rejects(() => executor.runOnce(), /database unavailable/u)
  await executor.stop({ timeoutMs: 0 })
})

test('SQLite NAS executor filters unknown/GPU, succeeds, retries, and terminally fails', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  let now = '2026-08-20T02:00:00.000Z'
  let tokenNumber = 0
  try {
    applyTaskMigration(database)
    const store = createTaskStore({
      database,
      now: () => now,
      tokenFactory: () => `sqlite-executor-${++tokenNumber}`
    })
    const registry = createTaskProcessorRegistry()
    let retryAttempts = 0
    registry.register({
      taskType: 'document.extract',
      processorVersion: 'extractor-v1',
      executionClass: 'disk',
      handler: async ({ task }) => {
        if (task.subjectId === '401') {
          retryAttempts += 1
          if (retryAttempts === 1) throw new Error('failed at C:\\private\\source.txt')
        }
        if (task.subjectId === '404') throw new Error('terminal failure at /srv/private/source.txt')
        return { subjectId: task.subjectId }
      }
    })
    registry.register({
      taskType: 'gpu.extract',
      processorVersion: 'gpu-v1',
      executionClass: 'gpu',
      handler: async () => ({ gpu: true })
    })
    const successful = store.enqueue(taskInput({ subjectId: 400 })).task
    const retrying = store.enqueue(taskInput({ subjectId: 401, maxAttempts: 2 })).task
    const gpu = store.enqueue(taskInput({
      taskType: 'gpu.extract',
      processorVersion: 'gpu-v1',
      subjectId: 402,
      executionClass: 'gpu'
    })).task
    const unknown = store.enqueue(taskInput({
      taskType: 'unknown.extract',
      processorVersion: 'unknown-v1',
      subjectId: 403
    })).task
    const terminal = store.enqueue(taskInput({
      subjectId: 404,
      maxAttempts: 1,
      availableAt: '2026-08-20T02:00:01.000Z'
    })).task
    const executor = createNasTaskExecutor({
      store,
      registry,
      owner: 'nas-sqlite',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 1000,
      heartbeatIntervalMs: 100,
      retryDelayMs: 1000,
      clock: () => now,
      pollIntervalMs: 1000
    })
    await executor.runOnce()
    assert.equal(store.getById(gpu.id).status, 'pending')
    assert.equal(store.getById(gpu.id).attemptCount, 0)
    assert.equal(store.getById(unknown.id).status, 'pending')
    assert.equal(store.getById(unknown.id).attemptCount, 0)
    now = '2026-08-20T02:00:01.000Z'
    await executor.runOnce()
    assert.equal(store.getById(successful.id).status, 'succeeded')
    assert.equal(store.getById(retrying.id).status, 'pending')
    assert.equal(store.getById(retrying.id).attemptCount, 1)
    assert.equal(store.getById(terminal.id).status, 'pending')
    await executor.runOnce()
    assert.equal(store.getById(terminal.id).status, 'failed')
    assert.equal(store.getById(terminal.id).attemptCount, 1)
    assert.equal(store.getById(terminal.id).errorCode, 'TASK_PROCESSOR_FAILED')
    assert.doesNotMatch(store.getById(terminal.id).errorSummary, /(?:C:\\|\/srv\/|stack)/iu)
    now = '2026-08-20T02:00:02.000Z'
    await executor.runOnce()
    assert.equal(store.getById(retrying.id).status, 'succeeded')
    assert.equal(store.getById(retrying.id).attemptCount, 2)
    assert.equal(store.getById(retrying.id).errorCode, null)
    await executor.stop({ timeoutMs: 0 })
  } finally {
    database.close()
  }
})

test('SQLite NAS executor timeout leaves a running lease for expiry recovery', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  let now = '2026-08-20T02:00:00.000Z'
  try {
    applyTaskMigration(database)
    const store = createTaskStore({
      database,
      now: () => now,
      tokenFactory: () => 'sqlite-timeout-token'
    })
    const task = store.enqueue(taskInput({ subjectId: 410, maxAttempts: 2 })).task
    const registry = createTaskProcessorRegistry({ processors: [{
      taskType: 'document.extract',
      processorVersion: 'extractor-v1',
      executionClass: 'disk',
      handler: async () => await new Promise(() => {})
    }] })
    const timers = new ManualTimers()
    const executor = createNasTaskExecutor({
      store,
      registry,
      owner: 'nas-timeout',
      quotas: { cpu: 0, disk: 1, network: 0 },
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      timers,
      clock: () => now
    })
    const round = executor.runOnce()
    await Promise.resolve()
    await Promise.resolve()
    const stopPromise = executor.stop({ timeoutMs: 50 })
    const deadline = timers.idsByDelay(50)[0]
    assert.ok(deadline)
    timers.run(deadline)
    const report = await stopPromise
    assert.equal(report.timedOut, true)
    assert.equal(store.getById(task.id).status, 'running')
    now = '2026-08-20T02:00:00.100Z'
    const recovered = store.recoverExpiredLeases()
    assert.deepEqual(recovered.recoveredIds, [task.id])
    assert.equal(store.getById(task.id).status, 'pending')
    assert.equal(store.getById(task.id).attemptCount, 1)
    void round
  } finally {
    database.close()
  }
})
