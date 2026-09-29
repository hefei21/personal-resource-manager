import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createQueryTranslationProcessor } from '../src/ragQueryTranslationProcessor.js'
import { PcWorker } from '../src/worker.js'
const config = { baseUrl: 'http://127.0.0.1:1234', modelId: 'answer-model', modelRevision: 'v1',
  provider: 'local', contextLimit: 32768, maxOutputBytes: 8192, timeoutMs: 2000 }
const query = 'Click 默认 1 次吗？'
const task = { taskType: 'rag.query.translate', processorVersion: 'v1', executionClass: 'gpu', input: {
  schemaVersion: 1, requestId: 'request-1', query, querySha256: createHash('sha256').update(query).digest('hex'),
  modelId: config.modelId, modelRevision: config.modelRevision, expiresAt: 1 } }
test('translation capability is absent by default', () => {
  assert.equal(createQueryTranslationProcessor({ config }).capability, null)
})
test('processor uses relative start budget, not NAS wall time, and binds result identity', async () => {
  let calls = 0
  const processor = createQueryTranslationProcessor({ enabled: true, config, fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ queries: ['Does Click default to 1?'] }) } }] }))
  } })
  assert.equal((await processor.process(task)).output.status, 'timeout')
  assert.equal(calls, 0)
  const result = await processor.process(task, { remainingMs: 1000 })
  assert.equal(result.output.status, 'enhanced')
  assert.equal(result.output.requestId, task.input.requestId)
  await assert.rejects(processor.process({ ...task, input: { ...task.input, modelId: 'wrong' } }, { remainingMs: 1000 }))
  assert.equal(calls, 1)
})

test('Worker declares opt-in capability, dispatches translation and deducts the start round trip', async () => {
  let calls = 0, delay = 0, budget = 1000, completed
  const worker = new PcWorker({ config: { answer: config, queryTranslationEnabled: true, heartbeatIntervalMs: 20000 },
    logger: { info() {}, warn() {} },
    modelReadinessFactory: () => ({ refresh: async () => false, isReady: () => true }),
    api: { start: async () => { await new Promise(resolve => setTimeout(resolve, delay)); return { remainingMs: budget } },
      complete: async (_token, _task, result) => { completed = result }, fail: async () => { assert.fail('unexpected failure') } },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ queries: ['Does Click default to 1?'] }) } }] })) }
  })
  worker.state = { accessToken: 'synthetic', accessExpiresAt: new Date(Date.now() + 3600000).toISOString() }
  worker.profile = { capabilities: { processors: [] } }
  assert.ok(worker.profileWithConfiguredProcessors(worker.profile).capabilities.processors.some(p => p.taskType === task.taskType))
  await worker.execute(task)
  assert.equal(completed.output.status, 'enhanced')
  delay = 25; budget = 10
  await worker.execute(task)
  assert.equal(completed.output.status, 'timeout')
  assert.equal(calls, 1)
})
