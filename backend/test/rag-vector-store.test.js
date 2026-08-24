import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  QWEN3_EMBEDDING_06B_CANDIDATE_CONFIG,
  RAG_VECTOR_ERROR_CODES,
  RagVectorStoreError,
  createRagVectorStore
} from '../src/services/ragVectorStore.js'

const BASE_URL = 'http://qdrant.test:6333'
const COLLECTION = 'rag_vectors'
const QWEN_CONFIG = QWEN3_EMBEDDING_06B_CANDIDATE_CONFIG

function configWithHash(config) {
  return Object.freeze({
    ...config,
    configHash: crypto.createHash('sha256').update(JSON.stringify(config), 'utf8').digest('hex')
  })
}

const NOMIC_CONFIG = configWithHash({
  provider: 'local-openai-compatible',
  modelId: 'nomic-embed-text-v1.5',
  modelRevision: 'nomic-test-revision-1',
  dimensions: 768,
  inputLimit: 2048,
  distance: 'cosine',
  normalization: 'l2'
})

function jsonResponse(status, payload) {
  return {
    status,
    async json() {
      return payload
    }
  }
}

function fakeFetch(handler) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const call = {
      url,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal
    }
    calls.push(call)
    return handler(call, calls.length)
  }
  return { fetch, calls }
}

function createStore(fetch, options = {}) {
  return createRagVectorStore({
    fetch,
    baseUrl: BASE_URL,
    collection: COLLECTION,
    modelConfig: QWEN_CONFIG,
    ...options
  })
}

function vector(modelConfig = QWEN_CONFIG, first = 1) {
  return Array.from({ length: modelConfig.dimensions }, (_, index) => index === 0 ? first : 0)
}

function vectorSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function pointInput({
  chunkId = 11,
  snapshotId = 7,
  sourceType = 'document',
  sourceId = 1,
  sourceVersionId = 'v1',
  embedding = vector(QWEN_CONFIG)
} = {}) {
  return { chunkId, snapshotId, sourceType, sourceId, sourceVersionId, vector: embedding }
}

function pointPayload(input, modelConfig = QWEN_CONFIG, { lifecycle = 'active', sourceId = input.sourceId } = {}) {
  return {
    chunkId: input.chunkId,
    snapshotId: input.snapshotId,
    sourceType: input.sourceType,
    sourceId,
    sourceVersionId: input.sourceVersionId,
    modelId: modelConfig.modelId,
    modelRevision: modelConfig.modelRevision,
    modelConfigHash: modelConfig.configHash,
    vectorSha256: vectorSha256(input.vector),
    lifecycle
  }
}

function collectionPayload(modelConfig = QWEN_CONFIG, pointsCount = 0) {
  return {
    result: {
      status: 'green',
      points_count: pointsCount,
      config: {
        params: {
          vectors: {
            size: modelConfig.dimensions,
            distance: modelConfig.distance === 'cosine' ? 'Cosine' : modelConfig.distance === 'dot' ? 'Dot' : 'Euclid'
          }
        }
      }
    },
    status: 'ok'
  }
}

function mutationPayload() {
  return { result: { status: 'acknowledged', operation_id: 41 }, status: 'ok' }
}

function errorCode(error) {
  return error instanceof RagVectorStoreError ? error.code : error?.code
}

test('requires modelConfig and keeps Qwen1024 and Nomic768 instances isolated', async () => {
  const noopFetch = async () => jsonResponse(200, mutationPayload())
  assert.throws(
    () => createRagVectorStore({ fetch: noopFetch, baseUrl: BASE_URL, collection: COLLECTION }),
    (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.CONFIG_INVALID
  )
  assert.throws(
    () => createStore(noopFetch, { modelConfig: { ...QWEN_CONFIG, configHash: 'a'.repeat(64) } }),
    (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.CONFIG_INVALID
  )
  assert.throws(
    () => createStore(noopFetch, { modelConfig: { ...QWEN_CONFIG, unexpected: true } }),
    (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.CONFIG_INVALID
  )
  assert.equal(Object.isFrozen(QWEN_CONFIG), true)
  assert.equal(QWEN_CONFIG.dimensions, 1024)
  assert.equal(NOMIC_CONFIG.dimensions, 768)

  const qwenFake = fakeFetch(() => jsonResponse(200, mutationPayload()))
  const nomicFake = fakeFetch(() => jsonResponse(200, mutationPayload()))
  const qwenStore = createStore(qwenFake.fetch, { modelConfig: QWEN_CONFIG })
  const nomicStore = createStore(nomicFake.fetch, { modelConfig: NOMIC_CONFIG, collection: 'nomic_vectors' })
  const qwenInput = pointInput({ embedding: vector(QWEN_CONFIG) })
  const nomicInput = pointInput({ embedding: vector(NOMIC_CONFIG), sourceVersionId: 'nomic-v1' })

  await qwenStore.upsertBatch([qwenInput])
  await nomicStore.upsertBatch([nomicInput])

  assert.equal(qwenStore.collectionSchema.size, 1024)
  assert.equal(nomicStore.collectionSchema.size, 768)
  assert.equal(qwenFake.calls[0].body.points[0].vector.length, 1024)
  assert.equal(nomicFake.calls[0].body.points[0].vector.length, 768)
  assert.equal(qwenFake.calls[0].body.points[0].payload.modelId, QWEN_CONFIG.modelId)
  assert.equal(nomicFake.calls[0].body.points[0].payload.modelId, NOMIC_CONFIG.modelId)
  assert.notEqual(qwenFake.calls[0].body.points[0].payload.modelConfigHash, nomicFake.calls[0].body.points[0].payload.modelConfigHash)
})

test('creates and verifies the fixed Qwen 1024-dimensional Cosine collection', async () => {
  const fake = fakeFetch((call, count) => {
    const pathname = new URL(call.url).pathname
    if (call.method === 'GET' && count === 1) return jsonResponse(404, { status: 'error' })
    if (call.method === 'PUT' && pathname.endsWith(`/collections/${COLLECTION}`)) {
      assert.deepEqual(call.body, {
        vectors: { size: 1024, distance: 'Cosine' },
        on_disk_payload: true
      })
      return jsonResponse(200, mutationPayload())
    }
    assert.equal(call.method, 'GET')
    return jsonResponse(200, collectionPayload(QWEN_CONFIG, 0))
  })
  const store = createStore(fake.fetch)

  const result = await store.ensureCollection()

  assert.equal(result.created, true)
  assert.equal(result.schema.size, 1024)
  assert.equal(result.schema.distance, 'Cosine')
  assert.equal(fake.calls.length, 3)
  assert.equal(store.modelConfig.modelId, 'Qwen/Qwen3-Embedding-0.6B')
  assert.equal(store.modelConfig.dimensions, 1024)
})

test('upserts a bounded batch with identity-only payload and computed vector hash', async () => {
  const fake = fakeFetch(() => jsonResponse(200, mutationPayload()))
  const store = createStore(fake.fetch)
  const input = pointInput()

  const result = await store.upsertBatch([input])

  assert.deepEqual(result, { collection: COLLECTION, upserted: 1, degraded: false })
  const call = fake.calls[0]
  assert.equal(new URL(call.url).pathname, `/collections/${COLLECTION}/points`)
  assert.equal(new URL(call.url).search, '?wait=true')
  assert.equal(call.body.points.length, 1)
  assert.equal(call.body.points[0].id, input.chunkId)
  assert.equal(call.body.points[0].vector.length, 1024)
  assert.deepEqual(call.body.points[0].payload, {
    ...pointPayload(input),
    vectorSha256: vectorSha256(input.vector)
  })
  assert.equal('body' in call.body.points[0].payload, false)
})

test('search builds a server-owned active snapshot/source filter and rejects client filter injection', async () => {
  const input = pointInput()
  const fake = fakeFetch((call) => jsonResponse(200, {
    result: { points: [{ id: input.chunkId, score: 0.91, payload: pointPayload(input) }] },
    status: 'ok'
  }))
  const store = createStore(fake.fetch)
  const sourceAllowlist = [
    { sourceType: 'document', sourceId: 1, sourceVersionId: 'v1' },
    { sourceType: 'ebook', sourceId: 2 }
  ]

  const result = await store.search(vector(), {
    activeSnapshotId: 7,
    sourceAllowlist,
    topK: 5,
    overfetch: 2
  })

  assert.equal(result.points.length, 1)
  assert.equal(result.points[0].chunkId, input.chunkId)
  const request = fake.calls[0]
  assert.equal(request.body.limit, 10)
  assert.equal(request.body.with_payload, true)
  assert.equal(request.body.with_vector, false)
  const filter = request.body.filter
  const snapshotCondition = filter.must.find((condition) => condition.key === 'snapshotId')
  const lifecycleCondition = filter.must.find((condition) => condition.key === 'lifecycle')
  const sourceCondition = filter.must.find((condition) => Array.isArray(condition.should))
  assert.deepEqual(snapshotCondition, { key: 'snapshotId', match: { value: 7 } })
  assert.deepEqual(lifecycleCondition, { key: 'lifecycle', match: { value: 'active' } })
  assert.equal(sourceCondition.should.length, 2)
  assert.deepEqual(sourceCondition.should[0], {
    must: [
      { key: 'sourceType', match: { value: 'document' } },
      { key: 'sourceId', match: { value: 1 } },
      { key: 'sourceVersionId', match: { value: 'v1' } }
    ]
  })
  assert.equal('filter' in request.body, true)

  await store.search(vector(), {
    activeSnapshotSources: [
      { snapshotId: 7, sourceType: 'document', sourceId: 1, sourceVersionId: 'v1' },
      { snapshotId: 8, sourceType: 'ebook', sourceId: 2, sourceVersionId: 'v2' }
    ]
  })
  const pairFilter = fake.calls[1].body.filter
  const pairSources = pairFilter.must.find((condition) => Array.isArray(condition.should)).should
  assert.deepEqual(pairSources[0].must[0], { key: 'snapshotId', match: { value: 7 } })
  assert.deepEqual(pairSources[1].must[0], { key: 'snapshotId', match: { value: 8 } })

  await assert.rejects(
    store.search(vector(), {
      activeSnapshotId: 7,
      sourceAllowlist,
      filter: { must: [] }
    }),
    (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.FILTER_FORBIDDEN
  )
  assert.equal(fake.calls.length, 2)
})

test('rejects a provider response that violates active snapshot or source allowlist', async () => {
  const input = pointInput()
  const fake = fakeFetch(() => jsonResponse(200, {
    result: { points: [{ id: input.chunkId, score: 0.9, payload: pointPayload(input, QWEN_CONFIG, { sourceId: 999 }) }] },
    status: 'ok'
  }))
  const store = createStore(fake.fetch)

  await assert.rejects(
    store.search(vector(), {
      activeSnapshotId: input.snapshotId,
      sourceAllowlist: [{ sourceType: input.sourceType, sourceId: input.sourceId }]
    }),
    (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.RESPONSE_FILTER_VIOLATION &&
      !String(error).includes('999')
  )
})

test('supports health, count, snapshot and snapshot-scoped deletion without content payloads', async () => {
  const fake = fakeFetch((call) => {
    const parsed = new URL(call.url)
    if (parsed.pathname === '/healthz') return jsonResponse(200, { title: 'qdrant', version: '1.19.0' })
    if (parsed.pathname.endsWith('/snapshots')) {
      return jsonResponse(200, { result: { name: 'snapshot-1', size: 440832, checksum: 'a'.repeat(64) }, status: 'ok' })
    }
    if (parsed.pathname.endsWith('/points/delete')) return jsonResponse(200, mutationPayload())
    return jsonResponse(200, collectionPayload(QWEN_CONFIG, 12))
  })
  const store = createStore(fake.fetch)

  const health = await store.health()
  const count = await store.count()
  const deleted = await store.deleteBySnapshot(7)
  const snapshot = await store.snapshot()

  assert.equal(health.available, true)
  assert.equal(health.pointsCount, 12)
  assert.equal(count.pointsCount, 12)
  assert.equal(deleted.snapshotId, 7)
  assert.deepEqual(snapshot, {
    collection: COLLECTION,
    name: 'snapshot-1',
    size: 440832,
    checksum: 'a'.repeat(64),
    degraded: false
  })
  const deleteCall = fake.calls.find((call) => new URL(call.url).pathname.endsWith('/points/delete'))
  assert.deepEqual(deleteCall.body.filter, {
    must: [
      { key: 'snapshotId', match: { value: 7 } },
      { key: 'modelId', match: { value: QWEN_CONFIG.modelId } },
      { key: 'modelConfigHash', match: { value: QWEN_CONFIG.configHash } }
    ]
  })
  assert.equal('vector' in deleteCall.body, false)
})

test('fails closed on invalid vectors, IDs, batches, hashes and response shapes', async () => {
  const fake = fakeFetch(() => jsonResponse(200, { result: { points: [] }, status: 'ok' }))
  const store = createStore(fake.fetch)
  const input = pointInput()

  await assert.rejects(store.search(new Array(1023).fill(0), {
    activeSnapshotId: 7,
    sourceAllowlist: [{ sourceType: 'document', sourceId: 1 }]
  }), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.VECTOR_DIMENSIONS_INVALID)
  await assert.rejects(store.search([Number.NaN, ...new Array(1023).fill(0)], {
    activeSnapshotId: 7,
    sourceAllowlist: [{ sourceType: 'document', sourceId: 1 }]
  }), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.VECTOR_INVALID)
  await assert.rejects(store.upsertBatch(new Array(257).fill(input)), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.BATCH_INVALID)
  await assert.rejects(store.upsertBatch([{ ...input, chunkId: 0 }]), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.ID_INVALID)
  await assert.rejects(store.upsertBatch([{ ...input, vectorSha256: 'b'.repeat(64) }]), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.INPUT_INVALID)
  await assert.rejects(store.search(vector(), {
    activeSnapshotId: 7,
    sourceAllowlist: [{ sourceType: 'unknown', sourceId: 1 }]
  }), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.SOURCE_INVALID)

  const malformed = createStore(fakeFetch(() => jsonResponse(200, { result: {}, status: 'ok' })).fetch)
  await assert.rejects(malformed.search(vector(), {
    activeSnapshotId: 7,
    sourceAllowlist: [{ sourceType: 'document', sourceId: 1 }]
  }), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID)
})

test('maps unavailable, timeout and cancellation to stable degradable errors and recovers', async () => {
  const unavailableStore = createStore(fakeFetch(async () => {
    throw new Error('provider response contained private text')
  }).fetch)
  await assert.rejects(unavailableStore.health(), (error) => {
    assert.equal(errorCode(error), RAG_VECTOR_ERROR_CODES.UNAVAILABLE)
    assert.equal(error.degraded, true)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(String(error), /private text/u)
    return true
  })

  const timeoutStore = createStore(fakeFetch(() => new Promise(() => {})).fetch, { timeoutMs: 5 })
  await assert.rejects(timeoutStore.health(), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.TIMEOUT && error.degraded)

  const controller = new AbortController()
  controller.abort()
  const cancelledFake = fakeFetch(() => jsonResponse(200, { title: 'unexpected' }))
  const cancelledStore = createStore(cancelledFake.fetch)
  await assert.rejects(cancelledStore.health({ signal: controller.signal }), (error) => {
    assert.equal(errorCode(error), RAG_VECTOR_ERROR_CODES.CANCELLED)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(cancelledFake.calls.length, 0)

  let attempts = 0
  const recoveringFake = fakeFetch((call) => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary unavailable')
    if (new URL(call.url).pathname === '/healthz') return jsonResponse(200, { title: 'qdrant' })
    return jsonResponse(200, collectionPayload(QWEN_CONFIG, 0))
  })
  const recoveringStore = createStore(recoveringFake.fetch)
  await assert.rejects(recoveringStore.health(), (error) => errorCode(error) === RAG_VECTOR_ERROR_CODES.UNAVAILABLE)
  const recovered = await recoveringStore.health()
  assert.equal(recovered.available, true)
  assert.equal(recovered.degraded, false)
})
