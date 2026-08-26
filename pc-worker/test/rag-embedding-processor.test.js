import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  createRagEmbeddingProcessor,
  embeddingProcessorsForConfig,
  RAG_EMBEDDING_TASK_TYPE,
  RAG_QUERY_EMBED_TASK_TYPE
} from '../src/ragEmbeddingProcessor.js'

const config = {
  baseUrl: 'http://127.0.0.1:1234',
  provider: 'local-provider',
  modelId: 'embedding-model',
  modelRevision: 'rev-1',
  dimensions: 3,
  inputLimit: 2048,
  maxBatchItems: 4,
  maxInputBytes: 1024 * 1024,
  timeoutMs: 2_000,
  configHash: 'a'.repeat(64),
  apiKey: null
}

const model = {
  provider: config.provider,
  modelId: config.modelId,
  modelRevision: config.modelRevision,
  dimensions: config.dimensions,
  inputLimit: config.inputLimit,
  configHash: config.configHash
}

function task(type = RAG_EMBEDDING_TASK_TYPE) {
  if (type === RAG_QUERY_EMBED_TASK_TYPE) {
    return {
      taskType: type,
      processorVersion: 'v1',
      executionClass: 'gpu',
      input: { schemaVersion: 1, querySha256: 'b'.repeat(64), query: '检索问题', model }
    }
  }
  return {
    taskType: type,
    processorVersion: 'v1',
    executionClass: 'gpu',
    input: {
      schemaVersion: 1,
      snapshotId: 7,
      sourceType: 'document',
      sourceId: 9,
      sourceVersionId: '11',
      sourceContentSha256: 'c'.repeat(64),
      contentBytes: 12,
      model,
      chunks: [
        { chunkId: 101, ordinal: 0, chunkSha256: 'd'.repeat(64), body: '第一段' },
        { chunkId: 102, ordinal: 1, chunkSha256: 'e'.repeat(64), body: '第二段' }
      ]
    }
  }
}

function responseFor(body, modelName = config.modelId, vectors = Array.from({ length: Array.isArray(body.input) ? body.input.length : 1 }, (_, index) => [index + 0.1, index + 0.2, index + 0.3])) {
  return {
    ok: true,
    json: async () => ({
      model: modelName,
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding }))
    })
  }
}

test('batch and query processors call the configured OpenAI-compatible endpoint and return vector hashes', async () => {
  const requests = []
  const processor = createRagEmbeddingProcessor({
    config,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      requests.push({ url, body, signal: options.signal })
      return responseFor(body)
    }
  })
  const batchResult = await processor.process(task())
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/embeddings')
  assert.deepEqual(requests[0].body.input, ['第一段', '第二段'])
  assert.equal(requests[0].body.model, config.modelId)
  assert.equal(batchResult.output.vectors.length, 2)
  assert.match(batchResult.output.vectorSha256, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(batchResult), /第一段|第二段/u)

  const queryResult = await processor.process(task(RAG_QUERY_EMBED_TASK_TYPE))
  assert.equal(requests[1].body.input, '检索问题')
  assert.equal(queryResult.output.embedding.length, 3)
  assert.match(queryResult.output.vectorSha256, /^[a-f0-9]{64}$/u)
})

test('processor rejects task-injected endpoint, model mismatch, wrong count/dimensions, and non-finite values', async () => {
  let called = false
  const processor = createRagEmbeddingProcessor({
    config,
    fetchImpl: async (_url, options) => {
      called = true
      return responseFor(JSON.parse(options.body))
    }
  })
  const injected = task()
  injected.input.endpoint = 'https://attacker.invalid/v1/embeddings'
  await assert.rejects(processor.process(injected), (error) => error.code === 'WORKER_EMBEDDING_INPUT_INVALID')
  assert.equal(called, false)

  const wrongModel = task()
  wrongModel.input.model = { ...model, modelRevision: 'other-revision' }
  await assert.rejects(processor.process(wrongModel), (error) => error.code === 'WORKER_EMBEDDING_MODEL_MISMATCH')

  const wrongCount = task()
  await assert.rejects(createRagEmbeddingProcessor({
    config,
    fetchImpl: async (_url, options) => responseFor(JSON.parse(options.body), config.modelId, [[0.1, 0.2, 0.3]])
  }).process(wrongCount), (error) => error.code === 'WORKER_EMBEDDING_RESPONSE_INVALID')

  const wrongDimensions = task()
  await assert.rejects(createRagEmbeddingProcessor({
    config,
    fetchImpl: async (_url, options) => responseFor(JSON.parse(options.body), config.modelId, [[0.1, 0.2]])
  }).process(wrongDimensions), (error) => error.code === 'WORKER_EMBEDDING_RESPONSE_INVALID')

  const nonFinite = task()
  await assert.rejects(createRagEmbeddingProcessor({
    config,
    fetchImpl: async (_url, options) => responseFor(JSON.parse(options.body), config.modelId, [[0.1, Number.NaN, 0.3], [0.4, 0.5, 0.6]])
  }).process(nonFinite), (error) => error.code === 'WORKER_EMBEDDING_RESPONSE_INVALID' || error.code === 'WORKER_EMBEDDING_RESULT_INVALID')
})

test('processor reports stable endpoint errors and cancellation without response content', async () => {
  const unavailable = createRagEmbeddingProcessor({ config, fetchImpl: async () => { throw new Error('network body must not escape') } })
  await assert.rejects(unavailable.process(task()), (error) => error.code === 'WORKER_EMBEDDING_UNAVAILABLE')

  const controller = new AbortController()
  controller.abort()
  const cancelled = createRagEmbeddingProcessor({
    config,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  await assert.rejects(cancelled.process(task(), { signal: controller.signal }), (error) => error.code === 'WORKER_PROCESSOR_CANCELLED')

  const timeout = createRagEmbeddingProcessor({
    config: { ...config, timeoutMs: 10 },
    fetchImpl: async () => new Promise(() => {})
  })
  await assert.rejects(timeout.process(task()), (error) => error.code === 'WORKER_EMBEDDING_TIMEOUT')
})

test('processor rejects incomplete source identity and optional model identity drift', async () => {
  const processor = createRagEmbeddingProcessor({ config, fetchImpl: async (_url, options) => responseFor(JSON.parse(options.body)) })
  const partialSource = task()
  delete partialSource.input.sourceContentSha256
  await assert.rejects(processor.process(partialSource), (error) => error.code === 'WORKER_EMBEDDING_INPUT_INVALID')

  const driftedModel = task()
  driftedModel.input.model = { ...model, distance: 'dot' }
  await assert.rejects(processor.process(driftedModel), (error) => error.code === 'WORKER_EMBEDDING_MODEL_MISMATCH')
})

test('incomplete local configuration does not declare or execute embedding processors', async () => {
  const processor = createRagEmbeddingProcessor({ config: null, fetchImpl: async () => { throw new Error('must not call') } })
  assert.equal(processor.configured, false)
  assert.equal(processor.supports(RAG_EMBEDDING_TASK_TYPE), false)
  assert.equal(processor.supports(RAG_QUERY_EMBED_TASK_TYPE), false)
  await assert.rejects(processor.process(task()), (error) => error.code === 'WORKER_EMBEDDING_NOT_CONFIGURED')
})

test('embedding capability advertises the complete strict local model identity', () => {
  const capabilities = embeddingProcessorsForConfig(config)
  assert.equal(capabilities.length, 2)
  for (const capability of capabilities) {
    assert.deepEqual(capability.model, model)
    assert.equal(Object.isFrozen(capability.model), true)
  }
  assert.deepEqual(embeddingProcessorsForConfig({ ...config, dimensions: undefined }), [])
  assert.deepEqual(embeddingProcessorsForConfig({ ...config, configHash: undefined }), [])
})

test('vector hash is deterministic for the returned ordered vectors', async () => {
  const processor = createRagEmbeddingProcessor({ config, fetchImpl: async (_url, options) => responseFor(JSON.parse(options.body)) })
  const result = await processor.process(task())
  const expected = crypto.createHash('sha256').update(JSON.stringify(result.output.vectors.map((vector) => vector.embedding))).digest('hex')
  assert.equal(result.output.vectorSha256, expected)
})
