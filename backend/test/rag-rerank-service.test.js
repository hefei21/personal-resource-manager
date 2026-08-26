import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRagRerankService,
  RAG_RERANK_TASK_TYPE,
  RAG_RERANK_WAIT_MS
} from '../src/services/ragRerankService.js'

const model = Object.freeze({
  provider: 'hugging-face-tei',
  modelId: 'BAAI/bge-reranker-v2-m3',
  modelRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
  dimensions: 1,
  inputLimit: 512,
  configHash: '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'
})

function candidates() {
  return [
    { citationId: 'C1', body: 'first evidence', score: 0.8 },
    { citationId: 'C2', body: 'second evidence', score: 0.7 }
  ]
}

function successfulStore(projectResult = (input) => [
  { candidateId: input.candidates[1].candidateId, score: 0.9 },
  { candidateId: input.candidates[0].candidateId, score: 0.2 }
]) {
  const requests = []
  return {
    requests,
    async enqueueExclusiveRun(request) {
      requests.push(request)
      return {
        task: {
          id: 7,
          status: 'succeeded',
          result: {
            schemaVersion: 1,
            processorVersion: 'v1',
            output: {
              model: request.input.model,
              querySha256: request.input.querySha256,
              candidateSetSha256: request.input.candidateSetSha256,
              candidates: projectResult(request.input)
            }
          }
        }
      }
    }
  }
}

test('reranks the complete authorized candidate set and binds task identity', async () => {
  const store = successfulStore()
  const service = createRagRerankService({ taskStore: store, workerAvailable: async () => true, model })
  const input = candidates()
  const result = await service.rerank({ query: 'How to recover?', candidates: input })

  assert.equal(result.applied, true)
  assert.deepEqual(result.candidates.map((item) => item.citationId), ['C2', 'C1'])
  assert.equal(store.requests[0].taskType, RAG_RERANK_TASK_TYPE)
  assert.equal(store.requests[0].subjectContentSha256, store.requests[0].input.candidateSetSha256)
  assert.equal(store.requests[0].input.candidates.every((item) => !Object.hasOwn(item, 'citationId')), true)
})

test('accepts multiline retrieved evidence when projecting a rerank task', async () => {
  const store = successfulStore()
  const service = createRagRerankService({ taskStore: store, workerAvailable: async () => true, model })
  const input = [
    { citationId: 'C1', body: 'first paragraph\nsecond paragraph\tvalue', score: 0.8 },
    { citationId: 'C2', body: 'second evidence', score: 0.7 }
  ]

  const result = await service.rerank({ query: 'How to recover?', candidates: input })

  assert.equal(result.applied, true)
  assert.equal(store.requests[0].input.candidates[0].text, 'first paragraph\nsecond paragraph\tvalue')
})

test('offline or disabled reranker preserves Hybrid order without enqueueing', async () => {
  let enqueueCalls = 0
  const store = { enqueue: async () => { enqueueCalls += 1 } }
  const input = candidates()
  const offline = createRagRerankService({ taskStore: store, workerAvailable: async () => false, model })
  const offlineResult = await offline.rerank({ query: 'query', candidates: input })
  assert.equal(offlineResult.applied, false)
  assert.equal(offlineResult.reason, 'reranker_offline')
  assert.deepEqual(offlineResult.candidates, input)

  const disabled = createRagRerankService({ taskStore: store, workerAvailable: async () => true, model, enabled: false })
  const disabledResult = await disabled.rerank({ query: 'query', candidates: input })
  assert.equal(disabledResult.reason, 'reranker_disabled')
  assert.equal(enqueueCalls, 0)
})

test('dropped, invented, or stale results fail open to the original order', async () => {
  const input = candidates()
  const dropped = createRagRerankService({
    taskStore: successfulStore(() => [{ candidateId: 'C1', score: 1 }]),
    workerAvailable: async () => true,
    model
  })
  const result = await dropped.rerank({ query: 'query', candidates: input })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'reranker_failed')
  assert.deepEqual(result.candidates, input)
})

test('cold reranker work is queued but the synchronous query budget stays bounded', async () => {
  let elapsed = 0
  let request
  const pending = { id: 81, status: 'pending', result: null }
  const store = {
    async enqueueExclusiveRun(value) { request = value; return { task: pending } },
    getById() { return pending }
  }
  const service = createRagRerankService({
    taskStore: store,
    workerAvailable: async () => true,
    model,
    now: () => elapsed,
    sleep: async (milliseconds) => { elapsed += milliseconds }
  })

  const result = await service.rerank({ query: 'cold query', candidates: candidates() })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'reranker_timeout')
  assert.equal(elapsed, RAG_RERANK_WAIT_MS)
  assert.ok(elapsed <= 250)
  assert.equal(pending.status, 'pending')

  pending.status = 'succeeded'
  pending.result = {
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model: request.input.model,
      querySha256: request.input.querySha256,
      candidateSetSha256: request.input.candidateSetSha256,
      candidates: [...request.input.candidates].reverse().map(({ candidateId }, index) => ({ candidateId, score: 1 - index }))
    }
  }
  const warmed = await service.rerank({ query: 'cold query', candidates: candidates() })
  assert.equal(warmed.applied, true)
  assert.deepEqual(warmed.candidates.map((item) => item.citationId), ['C2', 'C1'])
  assert.equal(warmed.task, pending)
})
