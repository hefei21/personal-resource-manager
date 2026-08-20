import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  TaskRuntime,
  TaskRuntimeError
} from '../src/services/taskRuntime.js'

function fakeDatabase() {
  return {
    prepare() {},
    transaction(callback) { return callback }
  }
}

function runtimeDependencies() {
  const calls = { store: 0, executor: 0, starts: 0, stops: 0, registry: null }
  const store = Object.freeze({ name: 'task-store-capability' })
  const executor = {
    state: 'idle',
    activeCount: 0,
    start() {
      calls.starts += 1
      this.state = 'running'
      return this
    },
    stop() {
      calls.stops += 1
      this.state = 'stopped'
      return Promise.resolve({ status: 'stopped', drained: true, timedOut: false, active: 0 })
    }
  }
  return {
    calls,
    store,
    executor,
    storeFactory: () => {
      calls.store += 1
      return store
    },
    executorFactory: ({ registry }) => {
      calls.executor += 1
      calls.registry = registry
      return executor
    }
  }
}

test('TaskRuntime freezes registration, starts only with a database, and drains idempotently', async () => {
  const dependencies = runtimeDependencies()
  const runtime = new TaskRuntime({
    storeFactory: dependencies.storeFactory,
    executorFactory: dependencies.executorFactory,
    owner: 'runtime-test'
  })
  assert.deepEqual(runtime.status(), {
    state: 'idle',
    acceptingRegistrations: true,
    registeredProcessorCount: 0,
    executorState: null,
    activeCount: 0
  })
  assert.throws(
    () => runtime.start(),
    (error) => error instanceof TaskRuntimeError && error.code === 'TASK_RUNTIME_DATABASE_REQUIRED'
  )
  runtime.registerProcessor({
    taskType: 'task.disk',
    processorVersion: 'disk-v1',
    executionClass: 'disk',
    handler: async () => null
  })
  runtime.start(fakeDatabase())
  assert.equal(dependencies.calls.store, 1)
  assert.equal(dependencies.calls.executor, 1)
  assert.equal(dependencies.calls.starts, 1)
  assert.equal(runtime.start(fakeDatabase()), runtime)
  assert.equal(dependencies.calls.starts, 1)
  assert.equal(runtime.getStore(), dependencies.store)
  assert.equal(runtime.getExecutor(), dependencies.executor)
  assert.equal(typeof dependencies.calls.registry.register, 'undefined')
  assert.equal(runtime.status().state, 'running')
  assert.equal(runtime.status().registeredProcessorCount, 1)
  assert.throws(
    () => runtime.registerProcessor({
      taskType: 'task.other',
      processorVersion: 'v1',
      executionClass: 'cpu',
      handler: async () => null
    }),
    (error) => error instanceof TaskRuntimeError && error.code === 'TASK_RUNTIME_REGISTRATION_FROZEN'
  )

  const firstStop = runtime.stop({ timeoutMs: 0 })
  assert.equal(firstStop, runtime.stop({ timeoutMs: 100 }))
  await firstStop
  assert.equal(dependencies.calls.stops, 1)
  assert.equal(runtime.state, 'stopped')
  assert.deepEqual(await runtime.drain(), {
    status: 'stopped',
    drained: true,
    timedOut: false,
    active: 0
  })
  assert.throws(() => runtime.getStore(), { code: 'TASK_RUNTIME_NOT_RUNNING' })
  assert.throws(() => runtime.getExecutor(), { code: 'TASK_RUNTIME_NOT_RUNNING' })
})

test('empty TaskRuntime registry starts without claiming unknown or GPU work', async () => {
  const dependencies = runtimeDependencies()
  const runtime = new TaskRuntime({
    storeFactory: dependencies.storeFactory,
    executorFactory: dependencies.executorFactory
  })
  runtime.start({ database: fakeDatabase() })
  assert.deepEqual(dependencies.calls.registry.getSupportedProcessorIdentities(), [])
  assert.equal(runtime.status().registeredProcessorCount, 0)
  await runtime.stop({ timeoutMs: 0 })
})

test('TaskRuntime cleans up a partially started executor and validates start options', async () => {
  let stops = 0
  const runtime = new TaskRuntime({
    storeFactory: () => Object.freeze({}),
    executorFactory: () => ({
      start() { throw new Error('start failed') },
      stop() { stops += 1; return Promise.resolve({ drained: true, timedOut: false, active: 0 }) }
    })
  })
  assert.throws(
    () => runtime.start({ database: fakeDatabase(), unsupported: true }),
    (error) => error instanceof TaskRuntimeError && error.code === 'TASK_RUNTIME_INPUT_INVALID'
  )
  assert.throws(
    () => runtime.start({ database: fakeDatabase() }),
    (error) => error instanceof TaskRuntimeError && error.code === 'TASK_RUNTIME_START_FAILED'
  )
  await Promise.resolve()
  assert.equal(stops, 1)
  assert.equal(runtime.state, 'failed')
})

test('task runtime exposes no database through status and index starts after initDatabase', () => {
  const runtime = new TaskRuntime({
    storeFactory: () => Object.freeze({}),
    executorFactory: () => ({
      state: 'idle',
      activeCount: 0,
      start() { this.state = 'running' },
      stop() { this.state = 'stopped'; return Promise.resolve({ drained: true, timedOut: false, active: 0 }) }
    })
  })
  runtime.start(fakeDatabase())
  assert.equal(Object.hasOwn(runtime.status(), 'database'), false)
  assert.equal(Object.hasOwn(runtime.status(), 'dbPath'), false)

  const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/\r\n?/gu, '\n')
  const initCall = indexSource.indexOf('const database = initDatabase()')
  const runtimeStart = indexSource.indexOf('startTaskRuntime({ database })', initCall)
  const listenCall = indexSource.indexOf('app.listen(', runtimeStart)
  const stopRuntime = indexSource.indexOf('await stopTaskRuntime()')
  const closeRedis = indexSource.indexOf('await closeRedis()', stopRuntime)
  const secondStopRuntime = indexSource.indexOf('await stopTaskRuntime()', stopRuntime + 1)
  const secondCloseRedis = indexSource.indexOf('await closeRedis()', secondStopRuntime)
  assert.ok(initCall >= 0)
  assert.ok(runtimeStart > initCall)
  assert.ok(listenCall > runtimeStart)
  assert.ok(stopRuntime >= 0)
  assert.ok(closeRedis > stopRuntime)
  assert.ok(secondStopRuntime > closeRedis)
  assert.ok(secondCloseRedis > secondStopRuntime)
})
