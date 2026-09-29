import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { createTaskStore } from '../src/services/taskStore.js'
import { createQueryTranslationService } from '../src/services/ragQueryTranslationService.js'
const Database = createRequire(import.meta.url)('better-sqlite3')
const query = 'Click 默认 1 次吗？'
const model = { modelId: 'answer-model', modelRevision: 'v1' }

test('progressive request survives queue residence beyond inference budget and still cancels exactly', async t => {
  const { store, service } = setup(t, { timeoutMs: 20, queueTimeoutMs: 500 })
  const controller = new AbortController()
  const pending = service.translate({ query, signal: controller.signal, waitForCapacity: true })
  const rejected = assert.rejects(pending)
  await delay(60)
  assert.equal(store.getById(1).status, 'pending')
  assert.ok(store.getById(1).input.expiresAt > Date.now())
  controller.abort()
  await rejected
  assert.equal(store.getById(1).status, 'cancelled')
})

test('progressive delayed claim completes without extending Worker inference contract', async t => {
  const { store, service } = setup(t, { timeoutMs: 20, queueTimeoutMs: 500 })
  const pending = service.translate({ query, waitForCapacity: true })
  await delay(60)
  const task = store.leaseNext({ owner: 'worker', executionClasses: ['gpu'] })
  const lease = { id: task.id, owner: task.leaseOwner, token: task.leaseToken }
  store.markRunning(lease)
  const { requestId, querySha256, modelId, modelRevision } = task.input
  store.succeed({ ...lease, result: { schemaVersion: 1, processorVersion: 'v1', output: {
    requestId, querySha256, modelId, modelRevision, status: 'enhanced', queries: [query, 'Does Click default to 1?'] } } })
  assert.equal((await pending).status, 'enhanced')
})
function setup(t, options = {}) {
  const db = new Database(':memory:')
  db.exec(CREATE_TASK_SCHEMA_SQL)
  t.after(() => db.close())
  const store = createTaskStore({ database: db })
  const service = createQueryTranslationService({ enabled: true, taskStore: store, model,
    timeoutMs: 100, pollMs: 5, workerAvailable: () => true, ...options })
  return { store, service, db }
}

test('disabled, English and offline requests never enqueue', async t => {
  for (const options of [{ enabled: false }, { workerAvailable: () => false }, {}]) {
    const { store, service } = setup(t, options)
    const text = Object.keys(options).length ? query : 'What is Click?'
    assert.deepEqual((await service.translate({ query: text })).queries, [text])
    assert.equal(store.count(), 0)
  }
})
test('hung availability is bounded and late availability cannot enqueue', { timeout: 2000 }, async t => {
  let release
  const { store, service } = setup(t, { timeoutMs: 20, workerAvailable: () => new Promise(resolve => { release = resolve }) })
  assert.equal((await service.translate({ query })).status, 'timeout')
  release(true)
  await delay(5)
  assert.equal(store.count(), 0)
})
test('queued task timeout cancels the exact request without a retry', async t => {
  const { store, service } = setup(t, { timeoutMs: 20 })
  assert.equal((await service.translate({ query })).status, 'timeout')
  assert.equal(store.getById(1).status, 'cancelled')
  assert.equal(store.getById(1).maxAttempts, 1)
})
test('same query requests are independent and user cancellation propagates', async t => {
  const { store, service } = setup(t)
  const controller = new AbortController(), reason = new Error('left page')
  const a = service.translate({ query, signal: controller.signal })
  const observed = assert.rejects(a, error => error === reason)
  const b = service.translate({ query })
  await delay(1)
  assert.equal(store.count(), 2)
  controller.abort(reason)
  await observed
  assert.equal(store.getById(1).status, 'cancelled')
  assert.equal(store.getById(2).status, 'pending')
  await b
})
test('running cancellation revokes its lease and late result is rejected', async t => {
  const { store, service } = setup(t)
  const controller = new AbortController()
  const result = service.translate({ query, signal: controller.signal })
  const observed = assert.rejects(result)
  await delay(1)
  const task = store.leaseNext({ owner: 'worker', executionClasses: ['gpu'] })
  const lease = { id: task.id, owner: task.leaseOwner, token: task.leaseToken }
  store.markRunning(lease)
  controller.abort()
  await observed
  assert.equal(store.getById(task.id).status, 'cancelled')
  assert.throws(() => store.succeed({ ...lease, result: {} }), { code: 'TASK_INVALID_STATE' })
})
test('successful task result remains bound to request and is returned without rewriting original', async t => {
  const { store, service } = setup(t)
  const pending = service.translate({ query })
  await delay(1)
  const task = store.leaseNext({ owner: 'worker', executionClasses: ['gpu'] })
  const lease = { id: task.id, owner: task.leaseOwner, token: task.leaseToken }
  store.markRunning(lease)
  const { requestId, querySha256, modelId, modelRevision } = task.input
  store.succeed({ ...lease, result: { schemaVersion: 1, processorVersion: 'v1', output: {
    requestId, querySha256, modelId, modelRevision, status: 'enhanced', queries: [query, 'Does Click default to 1?'] } } })
  assert.deepEqual(await pending, { status: 'enhanced', queries: [query, 'Does Click default to 1?'] })
  assert.equal(store.getById(task.id).status, 'succeeded')
})

test('cleanup failure is observable but cannot block original-query fallback', async t => {
  const { store } = setup(t)
  let attempts = 0, notice
  const service = createQueryTranslationService({ enabled: true, model, timeoutMs: 10,
    workerAvailable: () => true, taskStore: { enqueue: input => store.enqueue(input), getById: id => store.getById(id),
      cancel: () => { attempts++; throw new Error('storage unavailable') } },
    onCleanupError: event => { notice = event; throw new Error('logger unavailable') } })
  assert.deepEqual(await service.translate({ query }), { status: 'timeout', queries: [query] })
  assert.equal(attempts, 2)
  assert.deepEqual(notice, { code: 'TRANSLATION_CLEANUP_DEFERRED', taskId: 1 })
  assert.ok(store.getById(1).input.expiresAt <= Date.now())
})
