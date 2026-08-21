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
import { TaskProcessorError } from '../src/services/taskProcessorError.js'
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
    this.progresses = []
    this.successes = []
    this.failures = []
    this.cancellations = []
    this.running = []
    this.recoveries = []
  }

  recoverExpiredLeases() {
    this.recoveries.push(true)
    return { recoveredCount: 0, recoveredIds: [], failedCount: 0, failedIds: [] }
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
    task.leaseOwner = options.owner
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

  getById(id) {
    const task = this.get(id)
    return task ? Object.freeze({ ...task }) : null
  }

  cancel(taskOrOptions) {
    const options = typeof taskOrOptions === 'number' ? { id: taskOrOptions } : taskOrOptions
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    if (task.status === 'pending') {
      assert.equal(Object.hasOwn(options, 'owner'), false)
      assert.equal(Object.hasOwn(options, 'token'), false)
    } else {
      if (task.status !== 'leased' && task.status !== 'running') {
        const error = new Error('invalid task state')
        error.code = 'TASK_INVALID_STATE'
        throw error
      }
      assert.equal(options.owner, task.leaseOwner)
      assert.equal(options.token, task.leaseToken)
    }
    task.status = 'cancelled'
    task.leaseToken = null
    task.leaseOwner = null
    this.cancellations.push({ ...options })
    return Object.freeze({ ...task })
  }

  heartbeat(options) {
    this.heartbeats.push({ ...options })
    return Object.freeze({ id: options.id, status: 'running' })
  }

  updateProgress(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    task.progress = options.progress
    this.progresses.push({ ...options })
    return Object.freeze({ ...task })
  }

  succeed(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    assert.equal(task.status, 'running')
    task.status = 'succeeded'
    this.successes.push({ ...options })
    return Object.freeze({ ...task })
  }

  fail(options) {
    const task = this.tasks.find((candidate) => candidate.id === options.id)
    assert.ok(task)
    assert.equal(task.status, 'running')
    task.status = options.retryAt && task.attemptCount < task.maxAttempts ? 'pending' : 'failed'
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

test('TaskProcessorError exposes a frozen, single-line retry contract', () => {
  const error = new TaskProcessorError({
    code: 'TASK_INPUT_INVALID',
    summary: 'invalid input\nstack details',
    retryable: false
  })
  assert.equal(error.name, 'TaskProcessorError')
  assert.equal(error.code, 'TASK_INPUT_INVALID')
  assert.equal(error.summary, 'invalid input')
  assert.equal(error.message, error.summary)
  assert.equal(error.retryable, false)
  assert.equal(Object.isFrozen(error), true)
  for (const [field, value] of [['code', 'OTHER'], ['summary', 'other'], ['retryable', true]]) {
    assert.throws(() => { error[field] = value }, TypeError)
  }
  const truncated = new TaskProcessorError({
    code: 'TASK_INPUT_INVALID',
    summary: 'x'.repeat(300),
    retryable: true
  })
  assert.equal(truncated.summary.length, 256)
  assert.throws(
    () => new TaskProcessorError({ code: 'bad code', summary: 'invalid', retryable: true }),
    TypeError
  )
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

test('NAS executor recovers leases before claiming and keeps background recovery failures contained', async () => {
  const store = new FakeTaskStore([makeFakeTask(30, 'disk')])
  const events = []
  const originalRecover = store.recoverExpiredLeases.bind(store)
  const originalLease = store.leaseNext.bind(store)
  store.recoverExpiredLeases = () => {
    events.push('recover')
    return originalRecover()
  }
  store.leaseNext = (options) => {
    events.push('lease')
    return originalLease(options)
  }
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
    owner: 'nas-recovery-order',
    quotas: { cpu: 0, disk: 1, network: 0 },
    timers,
    pollIntervalMs: 1000
  })
  await executor.runOnce()
  assert.deepEqual(events.slice(0, 2), ['recover', 'lease'])
  assert.equal(store.recoveries.length, 1)
  await executor.runOnce()
  assert.equal(store.recoveries.length, 1)
  await executor.stop({ timeoutMs: 0 })

  const failingStore = new FakeTaskStore([])
  failingStore.recoverExpiredLeases = () => { throw new Error('recovery unavailable') }
  const failingExecutor = createNasTaskExecutor({
    store: failingStore,
    registry: createTaskProcessorRegistry({ processors: [{
      taskType: 'task.disk',
      processorVersion: 'disk-v1',
      executionClass: 'disk',
      handler: async () => null
    }] }),
    owner: 'nas-recovery-error',
    quotas: { cpu: 0, disk: 0, network: 0 },
    timers: new ManualTimers(),
    pollIntervalMs: 1000
  })
  await assert.rejects(() => failingExecutor.runOnce(), /recovery unavailable/u)
  await failingExecutor.stop({ timeoutMs: 0 })

  const backgroundTimers = new ManualTimers()
  const backgroundStore = new FakeTaskStore([])
  backgroundStore.recoverExpiredLeases = () => { throw new Error('transient recovery failure') }
  const backgroundExecutor = createNasTaskExecutor({
    store: backgroundStore,
    registry: createTaskProcessorRegistry({ processors: [{
      taskType: 'task.disk',
      processorVersion: 'disk-v1',
      executionClass: 'disk',
      handler: async () => null
    }] }),
    owner: 'nas-recovery-background',
    quotas: { cpu: 0, disk: 0, network: 0 },
    timers: backgroundTimers,
    pollIntervalMs: 1000
  })
  backgroundExecutor.start()
  const firstPoll = backgroundTimers.idsByDelay(0)[0]
  backgroundTimers.run(firstPoll)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(backgroundTimers.idsByDelay(1000).length, 1)
  await backgroundExecutor.stop({ timeoutMs: 0 })
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
  assert.equal(typeof context.progress, 'function')
  await context.progress(37.5)
  assert.deepEqual(store.progresses, [{
    id: 10,
    owner: 'nas-heartbeat',
    token: 'lease-10',
    progress: 37.5
  }])
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

test('NAS executor applies domain retry policy and keeps ordinary errors redacted', async () => {
  const store = new FakeTaskStore([
    makeFakeTask(30, 'disk', { maxAttempts: 2 }),
    makeFakeTask(31, 'disk', { maxAttempts: 2 }),
    makeFakeTask(32, 'disk', { maxAttempts: 1 })
  ])
  let retryableAttempts = 0
  const logEvents = []
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async ({ task }) => {
      if (task.id === 30) {
        throw new TaskProcessorError({
          code: 'TASK_INPUT_INVALID',
          summary: 'invalid source at C:\\private\\input.txt\nstack details',
          retryable: false
        })
      }
      if (task.id === 31 && retryableAttempts++ === 0) {
        throw new TaskProcessorError({
          code: 'TASK_TEMPORARY_FAILURE',
          summary: 'temporary processor failure',
          retryable: true
        })
      }
      if (task.id === 32) throw new Error('ordinary failure at /srv/private/source.txt\nstack details')
      return { ok: true }
    }
  }] })
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-domain-errors',
    quotas: { cpu: 0, disk: 1, network: 0 },
    retryDelayMs: 1000,
    clock: () => '2026-08-20T02:00:00.000Z',
    logger: { warn: (event) => logEvents.push(event) }
  })

  await executor.runOnce()
  assert.equal(store.get(30).status, 'failed')
  assert.equal(store.failures[0].errorCode, 'TASK_INPUT_INVALID')
  assert.equal(Object.hasOwn(store.failures[0], 'retryAt'), false)
  assert.doesNotMatch(store.failures[0].errorSummary, /(?:C:\\|\/srv\/|stack)/iu)

  await executor.runOnce()
  assert.equal(store.get(31).status, 'pending')
  assert.equal(store.failures[1].errorCode, 'TASK_TEMPORARY_FAILURE')
  assert.equal(store.failures[1].retryAt, '2026-08-20T02:00:01.000Z')

  await executor.runOnce()
  assert.equal(store.get(31).status, 'succeeded')

  await executor.runOnce()
  assert.equal(store.get(32).status, 'failed')
  assert.equal(store.failures[2].errorCode, 'TASK_PROCESSOR_FAILED')
  assert.doesNotMatch(store.failures[2].errorSummary, /(?:C:\\|\/srv\/|stack)/iu)
  assert.equal(logEvents.length, 3)
  assert.deepEqual(Object.keys(logEvents[0]).sort(), [
    'attempt', 'causeCategory', 'errorCode', 'event', 'retryable',
    'subjectId', 'subjectType', 'taskId', 'taskType'
  ])
  assert.equal(logEvents[0].event, 'task_execution_failed')
  assert.equal(logEvents[0].causeCategory, 'PROCESSOR_OTHER')
  assert.doesNotMatch(JSON.stringify(logEvents), /private|source\.txt|stack|temporary processor failure/iu)
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor surfaces progress store failures and rejects progress after settlement', async () => {
  const store = new FakeTaskStore([makeFakeTask(33, 'disk')])
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async ({ progress }) => {
      await progress(25)
      return { ok: true }
    }
  }] })
  store.updateProgress = () => { throw new Error('progress database unavailable') }
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-progress-error',
    quotas: { cpu: 0, disk: 1, network: 0 },
    heartbeatIntervalMs: 10,
    leaseDurationMs: 100
  })
  await assert.rejects(() => executor.runOnce(), /progress database unavailable/u)
  assert.equal(store.failures.length, 0)
  await executor.stop({ timeoutMs: 0 })

  const retainedContextStore = new FakeTaskStore([makeFakeTask(34, 'disk')])
  let context
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const retainedContextRegistry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async (received) => {
      context = received
      await waiting
      return { ok: true }
    }
  }] })
  const timers = new ManualTimers()
  const retainedContextExecutor = createNasTaskExecutor({
    store: retainedContextStore,
    registry: retainedContextRegistry,
    owner: 'nas-progress-stop',
    quotas: { cpu: 0, disk: 1, network: 0 },
    leaseDurationMs: 100,
    heartbeatIntervalMs: 10,
    timers
  })
  const round = retainedContextExecutor.runOnce()
  await Promise.resolve()
  await Promise.resolve()
  const stopPromise = retainedContextExecutor.stop({ timeoutMs: 100 })
  await context.progress(50)
  release()
  await round
  await stopPromise
  await assert.rejects(() => context.progress(75), /no longer allowed/u)
})

test('NAS executor cancels pending tasks without lease credentials', async () => {
  const store = new FakeTaskStore([makeFakeTask(40, 'disk')])
  const executor = createNasTaskExecutor({
    store,
    registry: createTaskProcessorRegistry(),
    owner: 'nas-cancel-pending',
    quotas: { cpu: 0, disk: 0, network: 0 },
    timers: new ManualTimers()
  })

  const cancelled = await executor.cancelTask(40)
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(store.cancellations, [{ id: 40 }])
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor writes SQLite cancellation before abort and suppresses terminal writes', async () => {
  const store = new FakeTaskStore([makeFakeTask(41, 'disk')])
  const events = []
  const originalCancel = store.cancel.bind(store)
  store.cancel = (options) => {
    events.push('sqlite-cancel')
    return originalCancel(options)
  }
  let context
  let releaseHandler
  const handlerPending = new Promise((resolve) => { releaseHandler = resolve })
  const registry = createTaskProcessorRegistry({ processors: [{
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async (received) => {
      context = received
      received.signal.addEventListener('abort', () => events.push('abort'), { once: true })
      await handlerPending
      return { shouldNotBeWritten: true }
    }
  }] })
  const executor = createNasTaskExecutor({
    store,
    registry,
    owner: 'nas-cancel-active',
    quotas: { cpu: 0, disk: 1, network: 0 },
    timers: new ManualTimers()
  })

  const round = executor.runOnce()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.get(41).status, 'running')
  assert.ok(context)

  const cancelled = await executor.cancelTask(41)
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(events, ['sqlite-cancel', 'abort'])
  await assert.rejects(() => context.progress(50), /no longer allowed/u)

  releaseHandler()
  await round
  assert.equal(store.get(41).status, 'cancelled')
  assert.equal(store.successes.length, 0)
  assert.equal(store.failures.length, 0)
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor cancels an orphan lease using the current store credentials', async () => {
  const task = makeFakeTask(42, 'disk')
  task.status = 'running'
  task.leaseOwner = 'other-worker'
  task.leaseToken = 'orphan-token'
  const store = new FakeTaskStore([task])
  const executor = createNasTaskExecutor({
    store,
    registry: createTaskProcessorRegistry(),
    owner: 'nas-orphan-cancel',
    quotas: { cpu: 0, disk: 0, network: 0 },
    timers: new ManualTimers()
  })

  const cancelled = await executor.cancelTask(42)
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(store.cancellations, [{ id: 42, owner: 'other-worker', token: 'orphan-token' }])
  assert.equal(JSON.stringify(cancelled).includes('orphan-token'), false)
  await executor.stop({ timeoutMs: 0 })
})

test('NAS executor preserves the natural terminal winner and rejects repeated terminal cancellation', async () => {
  const store = new FakeTaskStore([makeFakeTask(43, 'disk')])
  let releaseHandler
  const handlerPending = new Promise((resolve) => { releaseHandler = resolve })
  const executor = createNasTaskExecutor({
    store,
    registry: createTaskProcessorRegistry({ processors: [{
      taskType: 'task.disk',
      processorVersion: 'disk-v1',
      executionClass: 'disk',
      handler: async () => {
        await handlerPending
        return { natural: true }
      }
    }] }),
    owner: 'nas-cancel-race',
    quotas: { cpu: 0, disk: 1, network: 0 },
    timers: new ManualTimers()
  })

  const round = executor.runOnce()
  await Promise.resolve()
  await Promise.resolve()
  releaseHandler()
  await round
  assert.equal(store.get(43).status, 'succeeded')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => executor.cancelTask(43),
      (error) => error.code === 'TASK_CANCEL_CONFLICT'
    )
  }
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
  const missingProgressStore = new FakeTaskStore([])
  missingProgressStore.updateProgress = undefined
  assert.throws(
    () => createNasTaskExecutor({ ...base, store: missingProgressStore }),
    (error) => error instanceof NasTaskExecutorError && error.code === 'NAS_EXECUTOR_STORE_INVALID'
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
    const restartedExecutor = createNasTaskExecutor({
      store,
      registry,
      owner: 'nas-timeout-restarted',
      quotas: { cpu: 0, disk: 0, network: 0 },
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      clock: () => now
    })
    await restartedExecutor.runOnce()
    assert.equal(store.getById(task.id).status, 'pending')
    assert.equal(store.getById(task.id).attemptCount, 1)
    await restartedExecutor.stop({ timeoutMs: 0 })
    void round
  } finally {
    database.close()
  }
})
