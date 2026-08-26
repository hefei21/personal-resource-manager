import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  createRagQueryRuntime,
  RAG_QUERY_RUNTIME_ERROR_CODES,
  RAG_QUERY_EMBED_WAIT_MS
} from '../src/services/ragQueryRuntime.js'
import { createRagHybridRetriever } from '../src/services/ragHybridRetriever.js'

const MODEL = Object.freeze({
  provider: 'local-provider',
  modelId: 'nomic-embed-text-v1.5',
  modelRevision: 'revision-1',
  dimensions: 3,
  inputLimit: 2048,
  distance: 'cosine',
  normalization: 'l2',
  configHash: 'a'.repeat(64)
})

function hash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function vectorHash(embedding) {
  return hash(JSON.stringify([embedding]))
}

function fakeDatabase({ visible = true } = {}) {
  return {
    prepare(sql) {
      return {
        get() {
          if (!sql.includes('FROM rag_chunks')) return null
          return visible ? {
            chunk_id: 11,
            snapshot_id: 9,
            ordinal: 0,
            body: 'authorized body',
            title: 'title',
            locator_json: JSON.stringify({ route: '/documents', documentId: 7, startLine: 1, endLine: 2 }),
            source_type: 'document',
            source_id: 7,
            source_version_id: 'v1',
            source_content_sha256: 'b'.repeat(64)
          } : null
        }
      }
    }
  }
}

function taskFor(query, { stale = false } = {}) {
  const querySha256 = hash(query)
  const embedding = [0.1, 0.2, 0.3]
  return {
    id: 1,
    status: 'succeeded',
    result: {
      schemaVersion: 1,
      processorVersion: 'v1',
      output: {
        model: MODEL,
        querySha256: stale ? 'c'.repeat(64) : querySha256,
        embedding,
        vectorSha256: vectorHash(embedding)
      }
    }
  }
}

function runtime({ database = fakeDatabase(), task = null, vectorStore = null, workerAvailable = true, modelResolver = null,
  queryText = 'find the document' } = {}) {
  const activeModelResolver = modelResolver ?? (() => ({ embeddingModelId: 3, model: MODEL }))
  const store = vectorStore ?? {
    modelConfig: MODEL,
    async health() { return { available: true } },
    async search() {
      return {
        points: [{
          id: 11,
          score: 0.9,
          payload: {
            chunkId: 11,
            snapshotId: 9,
            sourceType: 'document',
            sourceId: 7,
            sourceVersionId: 'v1'
          }
        }]
      }
    }
  }
  const query = queryText
  return { query, runtime: createRagQueryRuntime({
    database,
    modelResolver: activeModelResolver,
    activeSourcesResolver: () => [{ snapshotId: 9, sourceType: 'document', sourceId: 7, sourceVersionId: 'v1' }],
    taskStore: {
      enqueueExclusiveRun: async () => ({ task: task ?? taskFor(query) })
    },
    vectorStore: store,
    workerAvailable: async () => workerAvailable,
    waitMs: 0
  }) }
}

test('query runtime stays FTS-degraded when model, worker, or Qdrant configuration is incomplete', async () => {
  const missingModel = runtime({ modelResolver: () => null })
  const missingModelResult = await missingModel.runtime.query({ query: missingModel.query, limit: 5 })
  assert.equal(missingModelResult.vectorCandidates.length, 0)
  assert.equal(missingModelResult.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.MODEL_UNAVAILABLE)

  const offline = runtime({ workerAvailable: false })
  const offlineResult = await offline.runtime.query({ query: offline.query, limit: 5 })
  assert.equal(offlineResult.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.WORKER_UNAVAILABLE)

  const mismatch = runtime({ vectorStore: {
    modelConfig: { ...MODEL, configHash: 'd'.repeat(64) },
    async health() { return { available: true } }
  } })
  const mismatchResult = await mismatch.runtime.query({ query: mismatch.query, limit: 5 })
  assert.equal(mismatchResult.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.MODEL_MISMATCH)

  const qdrantFailure = runtime({ vectorStore: {
    modelConfig: MODEL,
    async health() { return { available: true } },
    async search() { throw Object.assign(new Error('qdrant unavailable'), { code: 'RAG_VECTOR_UNAVAILABLE' }) }
  } })
  const qdrantFailureResult = await qdrantFailure.runtime.query({ query: qdrantFailure.query, limit: 5 })
  assert.equal(qdrantFailureResult.vectorCandidates.length, 0)
  assert.equal(qdrantFailureResult.vectorError.code, 'RAG_VECTOR_UNAVAILABLE')
})

test('query runtime validates the active model, queues query embedding, and returns Qdrant candidates with a resolver', async () => {
  const { query, runtime: service } = runtime()
  const result = await service.query({ query, limit: 5 })
  assert.equal(result.vectorError, undefined)
  assert.equal(result.vectorCandidates.length, 1)
  assert.equal(result.vectorCandidates[0].chunkId, 11)
  assert.equal(Object.hasOwn(result.vectorCandidates[0], 'body'), false)
  const hydrated = await result.candidateResolver({ channel: 'vector', ...result.vectorCandidates[0] })
  assert.equal(hydrated.body, 'authorized body')
  assert.equal(hydrated.locator.route, '/documents')

  const retriever = createRagHybridRetriever({
    authoritativeVisibility: () => true,
    authoritativeActiveSnapshot: () => true,
    candidateResolver: result.candidateResolver,
    config: { ftsWeight: 0.75, vectorWeight: 0.25, maxPerSource: 2 }
  })
  const retrieval = await retriever.retrieve({
    query,
    ftsCandidates: [],
    vectorCandidates: result.vectorCandidates,
    limit: 5
  })
  assert.equal(retrieval.retrieval.mode, 'hybrid')
  assert.equal(retrieval.retrieval.degraded, false)
  assert.equal(retrieval.data[0].body, 'authorized body')
})

test('query runtime preserves ordinary multiline query whitespace across task identity', async () => {
  const { query, runtime: service } = runtime({ queryText: 'find the document\nsecond constraint\tvalue' })
  const result = await service.query({ query, limit: 5 })
  assert.equal(result.vectorError, undefined)
  assert.equal(result.vectorCandidates.length, 1)
})

test('query runtime rejects stale query results and active snapshot drift before using vectors', async () => {
  const stale = runtime({ task: taskFor('find the document', { stale: true }) })
  const staleResult = await stale.runtime.query({ query: stale.query })
  assert.equal(staleResult.vectorCandidates.length, 0)
  assert.equal(staleResult.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.RESULT_INVALID)

  let calls = 0
  const drift = runtime({ modelResolver: () => {
    calls += 1
    return calls === 1 ? { embeddingModelId: 3, model: MODEL } : { embeddingModelId: 4, model: { ...MODEL, configHash: 'e'.repeat(64) } }
  } })
  const driftResult = await drift.runtime.query({ query: drift.query })
  assert.equal(driftResult.vectorCandidates.length, 0)
  assert.equal(driftResult.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
})

test('query runtime fail-closes a candidate that is no longer visible in the active snapshot', async () => {
  const { query, runtime: service } = runtime({ database: fakeDatabase({ visible: false }) })
  const result = await service.query({ query })
  assert.equal(result.vectorCandidates.length, 0)
  assert.equal(result.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
})

test('query retry uses one durable terminal retry budget and never reopens the fixed task', async () => {
  const query = 'recover one failed query embedding'
  const failed = { id: 41, status: 'failed', result: null }
  const recovered = { ...taskFor(query), id: 42 }
  let retryCalls = 0
  const service = createRagQueryRuntime({
    database: fakeDatabase(),
    modelResolver: () => ({ embeddingModelId: 3, model: MODEL }),
    activeSourcesResolver: () => [{ snapshotId: 9, sourceType: 'document', sourceId: 7, sourceVersionId: 'v1' }],
    taskStore: {
      enqueueExclusiveRun: async () => ({ task: failed }),
      retryTerminalTask: async (options) => {
        retryCalls += 1
        assert.deepEqual(options, { id: 41, maxRetries: 1 })
        return { task: recovered, created: retryCalls === 1, retryCount: 1, exhausted: false }
      },
      requeue: () => assert.fail('query runtime must not call legacy requeue')
    },
    vectorStore: {
      modelConfig: MODEL,
      async health() { return { available: true } },
      async search() {
        return {
          points: [{
            id: 11,
            score: 0.9,
            payload: {
              chunkId: 11,
              snapshotId: 9,
              sourceType: 'document',
              sourceId: 7,
              sourceVersionId: 'v1'
            }
          }]
        }
      }
    },
    workerAvailable: async () => true,
    waitMs: 0
  })

  const first = await service.query({ query })
  assert.equal(first.vectorError, undefined)
  assert.equal(first.vectorCandidates.length, 1)
  assert.equal(retryCalls, 1)

  const second = await service.query({ query })
  assert.equal(second.vectorError, undefined)
  assert.equal(retryCalls, 2)
})

test('query retry degrades when the durable retry budget is exhausted', async () => {
  const query = 'exhausted query retry'
  const failed = { id: 51, status: 'failed', result: null }
  const exhausted = { id: 52, status: 'failed', result: null }
  const service = createRagQueryRuntime({
    database: fakeDatabase(),
    modelResolver: () => ({ embeddingModelId: 3, model: MODEL }),
    activeSourcesResolver: () => [{ snapshotId: 9, sourceType: 'document', sourceId: 7, sourceVersionId: 'v1' }],
    taskStore: {
      enqueueExclusiveRun: async () => ({ task: failed }),
      retryTerminalTask: async () => ({ task: exhausted, created: false, retryCount: 1, exhausted: true })
    },
    vectorStore: {
      modelConfig: MODEL,
      async health() { return { available: true } },
      async search() {
        return {
          points: [{
            id: 11,
            score: 0.9,
            payload: {
              chunkId: 11,
              snapshotId: 9,
              sourceType: 'document',
              sourceId: 7,
              sourceVersionId: 'v1'
            }
          }]
        }
      }
    },
    workerAvailable: async () => true,
    waitMs: 0,
    retryTerminal: true,
    terminalRetryBudget: 1
  })

  const result = await service.query({ query })
  assert.equal(result.vectorCandidates.length, 0)
  assert.equal(result.vectorError.code, RAG_QUERY_RUNTIME_ERROR_CODES.TASK_FAILED)
})

test('query embedding wait budget covers the default five-second Worker polling interval', async () => {
  assert.ok(RAG_QUERY_EMBED_WAIT_MS >= 7_000)
  let clock = 0
  let reads = 0
  const task = taskFor('polling query')
  task.status = 'pending'
  const service = createRagQueryRuntime({
    database: fakeDatabase(),
    modelResolver: () => ({ embeddingModelId: 3, model: MODEL }),
    activeSourcesResolver: () => [{ snapshotId: 9, sourceType: 'document', sourceId: 7, sourceVersionId: 'v1' }],
    taskStore: {
      enqueueExclusiveRun: async () => ({ task }),
      getById: () => {
        reads += 1
        if (reads >= 1) task.status = 'succeeded'
        return task
      }
    },
    vectorStore: {
      modelConfig: MODEL,
      async health() { return { available: true } },
      async search() { return { points: [] } }
    },
    workerAvailable: async () => true,
    now: () => clock,
    sleep: async () => { clock += 5_000 }
  })
  const result = await service.query({ query: 'polling query' })
  assert.equal(reads > 0, true)
  assert.equal(result.vectorError?.code, RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
})
