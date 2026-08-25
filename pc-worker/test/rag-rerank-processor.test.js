import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  createRagRerankProcessor,
  RAG_RERANK_CONFIG_HASH,
  RAG_RERANK_MODEL_ID,
  RAG_RERANK_MODEL_REVISION,
  RAG_RERANK_PROVIDER,
  rerankProcessorsForConfig
} from '../src/ragRerankProcessor.js'

const config = {
  baseUrl: 'http://127.0.0.1:19090',
  endpoint: 'http://127.0.0.1:19090/rerank',
  provider: RAG_RERANK_PROVIDER,
  modelId: RAG_RERANK_MODEL_ID,
  modelRevision: RAG_RERANK_MODEL_REVISION,
  dimensions: 1,
  inputLimit: 512,
  configHash: RAG_RERANK_CONFIG_HASH,
  timeoutMs: 2_000
}

const model = {
  provider: RAG_RERANK_PROVIDER,
  modelId: RAG_RERANK_MODEL_ID,
  modelRevision: RAG_RERANK_MODEL_REVISION,
  dimensions: 1,
  inputLimit: 512,
  configHash: RAG_RERANK_CONFIG_HASH
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function candidateSetSha256(candidates) {
  return sha256(JSON.stringify(candidates.map((candidate, index) => ({
    index,
    candidateId: candidate.candidateId,
    textSha256: sha256(candidate.text.normalize('NFKC').trim()),
    ...(candidate.score === undefined ? {} : { score: candidate.score })
  }))))
}

function task(overrides = {}) {
  const query = '如何恢复索引？'
  const candidates = [
    { candidateId: 'C1', text: '先检查索引状态。', score: 0.5 },
    { candidateId: 'C2', text: '恢复失败任务并重建索引。', score: 0.4 },
    { candidateId: 'C3', text: '确认数据库快照后再切换。', score: 0.3 }
  ]
  return {
    taskType: 'rag.rerank',
    processorVersion: 'v1',
    executionClass: 'gpu',
    input: {
      schemaVersion: 1,
      querySha256: sha256(query.normalize('NFKC').trim()),
      candidateSetSha256: candidateSetSha256(candidates),
      query,
      model,
      candidates
    },
    ...overrides
  }
}

function response(payload) {
  return { ok: true, headers: new Headers({ 'content-length': String(JSON.stringify(payload).length) }), json: async () => payload }
}

test('reranker posts the pinned TEI contract and returns a complete stable permutation', async () => {
  const calls = []
  const processor = createRagRerankProcessor({
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return response([
        { index: 1, score: 0.8 },
        { index: 0, score: 0.8 },
        { index: 2, score: -0.1 }
      ])
    }
  })
  const result = await processor.process(task())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, config.endpoint)
  assert.deepEqual(calls[0].body, {
    query: task().input.query.normalize('NFKC').trim(),
    texts: task().input.candidates.map(({ text }) => text.normalize('NFKC').trim()),
    raw_scores: true
  })
  assert.equal(Object.hasOwn(calls[0].body, 'documents'), false)
  assert.deepEqual(result.output.model, model)
  assert.equal(result.output.querySha256, task().input.querySha256)
  assert.equal(result.output.candidateSetSha256, task().input.candidateSetSha256)
  assert.deepEqual(result.output.candidates, [
    { candidateId: 'C1', score: 0.8 },
    { candidateId: 'C2', score: 0.8 },
    { candidateId: 'C3', score: -0.1 }
  ])
})

test('reranker capability carries the pinned model identity', () => {
  const capabilities = rerankProcessorsForConfig(config)
  assert.equal(capabilities.length, 1)
  assert.deepEqual(capabilities[0].model, model)
})

test('reranker rejects a query hash mismatch before calling TEI', async () => {
  let calls = 0
  const processor = createRagRerankProcessor({ config, fetchImpl: async () => { calls += 1; return response([]) } })
  const invalid = task()
  invalid.input.querySha256 = 'a'.repeat(64)
  await assert.rejects(processor.process(invalid), (error) => error.code === 'WORKER_RERANK_INPUT_INVALID')
  assert.equal(calls, 0)
})

test('reranker rejects a candidate-set hash mismatch before calling TEI', async () => {
  let calls = 0
  const processor = createRagRerankProcessor({ config, fetchImpl: async () => { calls += 1; return response([]) } })
  const invalid = task()
  invalid.input.candidateSetSha256 = 'a'.repeat(64)
  await assert.rejects(processor.process(invalid), (error) => error.code === 'WORKER_RERANK_INPUT_INVALID')
  assert.equal(calls, 0)
})

test('reranker rejects wrong model identity and incomplete or invented responses', async () => {
  const invalidModel = task()
  invalidModel.input.model = { ...model, modelId: 'BAAI/other' }
  const processor = createRagRerankProcessor({ config, fetchImpl: async () => response([]) })
  await assert.rejects(processor.process(invalidModel), (error) => error.code === 'WORKER_RERANK_MODEL_MISMATCH')

  for (const payload of [
    [{ index: 0, score: 1 }, { index: 1, score: 0 }],
    [{ index: 0, score: 1 }, { index: 1, score: 0 }, { index: 9, score: 0 }],
    [{ index: 0, score: Number.NaN }, { index: 1, score: 0 }, { index: 2, score: 0 }]
  ]) {
    const invalid = createRagRerankProcessor({ config, fetchImpl: async () => response(payload) })
    await assert.rejects(invalid.process(task()), (error) => error.code.startsWith('WORKER_RERANK_RESPONSE_'))
  }
})

test('reranker rejects response fields outside the TEI index-score contract', async () => {
  const textMismatch = createRagRerankProcessor({
    config,
    fetchImpl: async () => response([
      { index: 0, text: '伪造文本', score: 1 }, { index: 1, score: 0 }, { index: 2, score: 0 }
    ])
  })
  await assert.rejects(textMismatch.process(task()), (error) => error.code === 'WORKER_RERANK_RESPONSE_INVALID')

  const privateFields = createRagRerankProcessor({
    config,
    fetchImpl: async () => response({
      candidateSetSha256: 'd'.repeat(64),
      scores: [{ index: 0, score: 1 }, { index: 1, score: 0 }, { index: 2, score: 0 }]
    })
  })
  await assert.rejects(privateFields.process(task()), (error) => error.code === 'WORKER_RERANK_RESPONSE_INVALID')
})
