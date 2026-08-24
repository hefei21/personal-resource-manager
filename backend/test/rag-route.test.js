import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'rag-route-test-data')

const { createRagRouter, normalizeQueryBody } = await import('../src/routes/rag.js')

const ANSWER_ENV_KEYS = [
  'PC_WORKER_ANSWER_PROVIDER',
  'PC_WORKER_ANSWER_MODEL_ID',
  'PC_WORKER_LLM_MODEL_ID',
  'PC_WORKER_ANSWER_MODEL_REVISION',
  'PC_WORKER_LLM_MODEL_REVISION',
  'PC_WORKER_ANSWER_CONTEXT_LIMIT',
  'PC_WORKER_ANSWER_CONTEXT_BYTES',
  'PC_WORKER_ANSWER_MAX_CONTEXT_BYTES',
  'PC_WORKER_ANSWER_MAX_OUTPUT_BYTES',
  'PC_WORKER_ANSWER_OUTPUT_LIMIT_BYTES',
  'PC_WORKER_ANSWER_MAX_EVIDENCE',
  'PC_WORKER_ANSWER_CONFIG_HASH',
  'PC_WORKER_ANSWER_DIMENSIONS',
  'PC_WORKER_ANSWER_INPUT_LIMIT',
  'RAG_ANSWER_PROVIDER',
  'RAG_ANSWER_MODEL_ID',
  'RAG_ANSWER_MODEL_REVISION',
  'RAG_ANSWER_CONTEXT_LIMIT',
  'RAG_ANSWER_MAX_OUTPUT_BYTES',
  'RAG_ANSWER_MAX_EVIDENCE',
  'RAG_ANSWER_CONFIG_HASH',
  'RAG_ANSWER_DIMENSIONS',
  'RAG_ANSWER_INPUT_LIMIT'
]

async function withAnswerEnv(values, callback) {
  const previous = new Map(ANSWER_ENV_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of ANSWER_ENV_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(values)) process.env[key] = String(value)
    return await callback()
  } finally {
    for (const key of ANSWER_ENV_KEYS) {
      if (previous.get(key) === undefined) delete process.env[key]
      else process.env[key] = previous.get(key)
    }
  }
}

function ownerBoundary(req, res, next) {
  const principal = req.get('x-test-principal')
  if (!principal) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal, username: req.get('x-test-owner') || principal }
  next()
}

async function withServer(router, callback) {
  const app = express()
  app.use(express.json())
  app.use('/api/rag', ownerBoundary, router)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function checks() {
  return {
    authoritativeVisibility: () => true,
    authoritativeActiveSnapshot: () => true
  }
}

function rejectingChecks() {
  return {
    authoritativeVisibility: () => false,
    authoritativeActiveSnapshot: () => true
  }
}

function retrieval() {
  return {
    query: 'RAG query',
    data: [{
      citationId: 'internal-candidate-id',
      chunkId: 41,
      snapshotId: 9,
      sourceType: 'document',
      sourceId: 7,
      sourceVersionId: 'v1',
      sourceContentSha256: 'a'.repeat(64),
      body: 'Complete authorized evidence.',
      title: 'Safe title',
      locator: {
        route: 'documents',
        documentId: 7,
        startLine: 10,
        endLine: 12,
        path: 'C:\\private\\secret.md'
      }
    }],
    total: 1,
    limit: 10,
    offset: 0,
    retrieval: { mode: 'fts', degraded: true, degradedReason: 'vector_unavailable', fusion: 'rrf' }
  }
}

test('normalizes a bounded query and rejects client-controlled evidence/filter knobs', () => {
  assert.deepEqual(normalizeQueryBody({ query: '  资料问题  ', limit: 2 }), { query: '资料问题', limit: 2 })
  assert.deepEqual(normalizeQueryBody({ q: 'same contract' }), { query: 'same contract', limit: 10 })
  assert.throws(() => normalizeQueryBody({ query: 'q', evidence: [] }))
  assert.throws(() => normalizeQueryBody({ query: 'q', filter: { sourceType: 'document' } }))
  assert.throws(() => normalizeQueryBody({ query: 'q', weights: { vector: 100 } }))
})

test('RAG query is Owner-only, uses server evidence, strips internal fields, and returns an opaque run id', async () => {
  const calls = { candidates: [], answers: [] }
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => checks(),
    candidateProvider: async (input) => {
      calls.candidates.push(input)
      return { ftsCandidates: [{ serverCandidate: true }] }
    },
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({
      generate: async (input) => {
        calls.answers.push(input)
        return {
          status: 'queued',
          query: input.query,
          language: 'en',
          answer: null,
          abstained: false,
          reasonCode: 'pending',
          degraded: false,
          citations: [{
            citationId: 'C1',
            title: 'Safe title',
            locator: {
              route: 'documents',
              documentId: 7,
              snapshotId: 9,
              startLine: 10,
              endLine: 12,
              path: 'C:\\private\\secret.md'
            }
          }],
          task: {
            id: 991,
            input: { body: 'do not expose this' },
            leaseToken: 'secret-lease-token'
          }
        }
      }
    }),
    requestIdFactory: () => 'opaque-run-1'
  })

  await withServer(router, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'RAG query' })
    })
    assert.equal(anonymous.status, 401)

    const demo = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'demo' },
      body: JSON.stringify({ query: 'RAG query' })
    })
    assert.equal(demo.status, 403)

    const owner = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'RAG query', evidence: [{ body: 'client supplied evidence' }] })
    })
    assert.equal(owner.status, 400)
    assert.equal(calls.candidates.length, 0)

    const accepted = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'RAG query', limit: 1 })
    })
    assert.equal(accepted.status, 202)
    const body = await accepted.json()
    assert.equal(body.data.status, 'queued')
    assert.equal(body.data.runId, 'opaque-run-1')
    assert.equal(body.data.retrieval.mode, 'fts')
    assert.deepEqual(body.data.citations, [{
      citationId: 'C1',
      title: 'Safe title',
      locator: { citationId: 'C1', route: 'documents', startLine: 10, endLine: 12 }
    }])
    assert.doesNotMatch(JSON.stringify(body), /sourceId|snapshotId|sourceContentSha256|documentId|storageKey|leaseToken|private|secret|991/u)
    assert.equal(calls.candidates.length, 1)
    assert.equal(calls.candidates[0].query, 'RAG query')
    assert.equal(calls.candidates[0].limit, 1)
    assert.equal(Object.hasOwn(calls.candidates[0], 'scope'), false)
    assert.equal(calls.answers.length, 1)
    assert.equal(calls.answers[0].query, 'RAG query')
    assert.equal(calls.answers[0].evidence[0].body, 'Complete authorized evidence.')

    const pending = await fetch(`${baseUrl}/api/rag/queries/opaque-run-1`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(pending.status, 200)
    const pendingBody = await pending.json()
    assert.deepEqual(pendingBody.data, {
      runId: 'opaque-run-1',
      status: 'pending',
      cancellable: false
    })
    assert.doesNotMatch(JSON.stringify(pendingBody), /991|leaseToken|input|hash|path/u)

    const notCancellable = await fetch(`${baseUrl}/api/rag/queries/opaque-run-1/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(notCancellable.status, 409)
    assert.deepEqual(await notCancellable.json(), { code: 'RAG_QUERY_CANCEL_CONFLICT' })
  })
})

test('RAG status is Owner-only and exposes only aggregate capability/degradation state', async () => {
  const database = {
    prepare(sql) {
      return { get: () => sql.includes('sqlite_master') ? { present: 1 } : { count: 3 } }
    }
  }
  const router = createRagRouter({
    databaseProvider: () => database,
    workerAvailable: () => true,
    vectorAvailable: () => false,
    model: { configured: true }
  })

  await withServer(router, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/rag/status`)
    assert.equal(anonymous.status, 401)
    const demo = await fetch(`${baseUrl}/api/rag/status`, { headers: { 'x-test-principal': 'demo' } })
    assert.equal(demo.status, 403)
    const owner = await fetch(`${baseUrl}/api/rag/status`, { headers: { 'x-test-principal': 'owner' } })
    assert.equal(owner.status, 200)
    const body = await owner.json()
    assert.equal(body.data.status, 'degraded')
    assert.equal(body.data.text.status, 'ready')
    assert.equal(body.data.vector.status, 'unavailable')
    assert.equal(body.data.model.status, 'configured')
    assert.equal(body.data.pcWorker.status, 'online')
    assert.equal(body.data.degradedReason, 'vector_unavailable')
    assert.doesNotMatch(JSON.stringify(body), /absolutePath|storageKey|sha256|hash|databaseId|snapshotId|chunkId|leaseToken|991/u)
  })
})

function answerWorkerDatabase(lastSeenAt = new Date().toISOString(), workerStatus = 'active') {
  const capabilities = JSON.stringify({
    processors: [{
      taskType: 'rag.answer.generate',
      processorVersion: 'v1',
      executionClass: 'gpu',
      outputSchemaVersion: 1
    }],
    resources: { cpuLogicalCores: 1, systemMemoryBytes: 1, gpus: [], loadedModels: [] }
  })
  return {
    prepare(sql) {
      if (/FROM pc_workers/u.test(sql)) {
        return {
          all: () => [{ status: workerStatus, protocol_version: 1, last_seen_at: lastSeenAt, capabilities_json: capabilities }]
        }
      }
      return { get: () => ({ present: 1, count: 1 }) }
    }
  }
}

test('complete answer env plus a fresh capable PC Worker enables the default answer service to enqueue', async () => {
  const taskRequests = []
  const taskStore = {
    async enqueueExclusiveRun(request) {
      taskRequests.push(request)
      return {
        task: {
          id: 88,
          idempotencyKey: 'answer-task-88',
          status: 'pending',
          progress: 0,
          ...request
        }
      }
    }
  }
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({
    provider: 'openai-compatible',
    modelId: 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k',
    modelRevision: 'Q6_K',
    contextLimit: 32768,
    maxOutputBytes: 65536,
    maxEvidenceItems: 16
  })).digest('hex')

  await withAnswerEnv({
    PC_WORKER_ANSWER_PROVIDER: 'openai-compatible',
    PC_WORKER_ANSWER_MODEL_ID: 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k',
    PC_WORKER_ANSWER_MODEL_REVISION: 'Q6_K',
    PC_WORKER_ANSWER_CONTEXT_LIMIT: 32768,
    PC_WORKER_ANSWER_MAX_OUTPUT_BYTES: 65536,
    PC_WORKER_ANSWER_MAX_EVIDENCE: 16
  }, async () => {
    const router = createRagRouter({
      databaseProvider: () => answerWorkerDatabase(),
      authoritativeChecksFactory: () => checks(),
      taskStoreProvider: () => taskStore,
      candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
      hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
      requestIdFactory: () => 'env-run-1'
    })

    await withServer(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rag/queries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
        body: JSON.stringify({ query: 'configured model' })
      })
      assert.equal(response.status, 202)
      const body = await response.json()
      assert.equal(body.data.status, 'queued')
      assert.equal(body.data.runId, 'env-run-1')
      assert.equal(taskRequests.length, 1)
      assert.deepEqual(taskRequests[0].input.model, {
        provider: 'openai-compatible',
        modelId: 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k',
        modelRevision: 'Q6_K',
        dimensions: 1,
        inputLimit: 32768,
        configHash: expectedHash
      })
      assert.doesNotMatch(JSON.stringify(body), /apiKey|secret|endpoint|leaseToken|taskType|88/u)
    })
  })
})

test('missing answer model configuration remains a stable citation-only degradation and never enqueues', async () => {
  let enqueueCalls = 0
  const taskStore = {
    enqueueExclusiveRun() {
      enqueueCalls += 1
      throw new Error('must not enqueue')
    }
  }
  await withAnswerEnv({}, async () => {
    const router = createRagRouter({
      databaseProvider: () => answerWorkerDatabase(),
      authoritativeChecksFactory: () => checks(),
      taskStoreProvider: () => taskStore,
      candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
      hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() })
    })

    await withServer(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rag/queries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
        body: JSON.stringify({ query: 'unconfigured model' })
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.data.status, 'degraded')
      assert.equal(body.data.reasonCode, 'model_unavailable')
      assert.equal(body.data.citations.length, 1)
      assert.equal(enqueueCalls, 0)
      assert.doesNotMatch(JSON.stringify(body), /apiKey|secret|endpoint|taskType|88/u)
    })
  })
})

test('answer Worker availability requires active status, protocol v1, answer capability, and a <=120s last-seen timestamp', async () => {
  await withAnswerEnv({
    PC_WORKER_ANSWER_MODEL_ID: 'answer-model',
    PC_WORKER_ANSWER_MODEL_REVISION: 'revision-1',
    PC_WORKER_ANSWER_CONTEXT_LIMIT: 32768,
    PC_WORKER_ANSWER_MAX_OUTPUT_BYTES: 65536
  }, async () => {
    const staleRouter = createRagRouter({
      databaseProvider: () => answerWorkerDatabase(new Date(Date.now() - 120_001).toISOString()),
      vectorAvailable: () => false
    })
    await withServer(staleRouter, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rag/status`, {
        headers: { 'x-test-principal': 'owner' }
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.data.pcWorker.status, 'offline')
      assert.equal(body.data.degradedReason, 'worker_offline')
    })

    const revokedRouter = createRagRouter({
      databaseProvider: () => answerWorkerDatabase(new Date().toISOString(), 'revoked'),
      vectorAvailable: () => false
    })
    await withServer(revokedRouter, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rag/status`, {
        headers: { 'x-test-principal': 'owner' }
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).data.pcWorker.status, 'offline')
    })
  })
})

test('tracked query status/cancel is Owner-scoped and uses TaskStore for pending work', async () => {
  let task = {
    id: 77,
    idempotencyKey: 'internal-idempotency-key',
    status: 'pending',
    progress: 12,
    taskType: 'rag.answer.generate',
    processorVersion: 'v1',
    input: { private: 'must not return' },
    result: null
  }
  const store = {
    getById(id) {
      assert.equal(id, 77)
      return task
    },
    cancel(id) {
      assert.equal(id, 77)
      task = { ...task, status: 'cancelled', progress: 12 }
      return task
    }
  }
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => checks(),
    taskStoreProvider: () => store,
    candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({
      generate: async ({ query }) => ({
        status: 'queued',
        query,
        citations: [],
        task
      })
    }),
    requestIdFactory: () => 'run-cancel-1'
  })

  await withServer(router, async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner', 'x-test-owner': 'alice' },
      body: JSON.stringify({ query: 'cancel me' })
    })
    assert.equal(accepted.status, 202)

    const otherOwner = await fetch(`${baseUrl}/api/rag/queries/run-cancel-1`, {
      headers: { 'x-test-principal': 'owner', 'x-test-owner': 'bob' }
    })
    assert.equal(otherOwner.status, 404)

    const pending = await fetch(`${baseUrl}/api/rag/queries/run-cancel-1`, {
      headers: { 'x-test-principal': 'owner', 'x-test-owner': 'alice' }
    })
    assert.equal(pending.status, 200)
    assert.deepEqual((await pending.json()).data, {
      runId: 'run-cancel-1',
      status: 'pending',
      cancellable: true,
      progress: 12
    })

    const cancelled = await fetch(`${baseUrl}/api/rag/queries/run-cancel-1/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': 'owner', 'x-test-owner': 'alice' }
    })
    assert.equal(cancelled.status, 200)
    assert.deepEqual((await cancelled.json()).data, {
      runId: 'run-cancel-1',
      status: 'cancelled',
      cancellable: false,
      abstained: true,
      reasonCode: 'cancelled',
      degraded: false,
      citations: []
    })

    const final = await fetch(`${baseUrl}/api/rag/queries/run-cancel-1`, {
      headers: { 'x-test-principal': 'owner', 'x-test-owner': 'alice' }
    })
    assert.equal(final.status, 200)
    assert.equal((await final.json()).data.status, 'cancelled')
    const conflict = await fetch(`${baseUrl}/api/rag/queries/run-cancel-1/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': 'owner', 'x-test-owner': 'alice' }
    })
    assert.equal(conflict.status, 409)
    assert.deepEqual(await conflict.json(), { code: 'RAG_QUERY_CANCEL_CONFLICT' })
  })
})

test('model/worker degradation stays a citation-only response without exposing task internals', async () => {
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => checks(),
    candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({
      generate: async () => ({
        status: 'degraded',
        query: 'RAG query',
        language: 'en',
        answer: null,
        abstained: true,
        reasonCode: 'model_timeout',
        degraded: true,
        degradedReason: 'model_timeout',
        citations: [{ citationId: 'C1', title: 'Safe title', locator: { route: 'documents', startLine: 10, endLine: 12 } }],
        task: { id: 4, leaseToken: 'do-not-return' }
      })
    })
  })

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'RAG query' })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.status, 'degraded')
    assert.equal(body.data.degradedReason, 'model_timeout')
    assert.equal(body.data.abstained, true)
    assert.deepEqual(body.data.citations, [{
      citationId: 'C1',
      title: 'Safe title',
      locator: { citationId: 'C1', route: 'documents', startLine: 10, endLine: 12 }
    }])
    assert.doesNotMatch(JSON.stringify(body), /leaseToken|task|private|sourceContentSha256|snapshotId/u)
  })
})

test('the route abstains before calling the model when retrieval has no authorized evidence', async () => {
  let modelCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => checks(),
    candidateProvider: async () => ({ ftsCandidates: [] }),
    hybridRetrieverFactory: () => ({
      retrieve: async () => ({
        data: [],
        total: 0,
        limit: 10,
        offset: 0,
        retrieval: { mode: 'fts', degraded: true, degradedReason: 'vector_unavailable', fusion: 'rrf' }
      })
    }),
    answerServiceFactory: () => ({
      generate: async () => {
        modelCalls += 1
        return { status: 'queued', citations: [] }
      }
    })
  })

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'no evidence' })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.status, 'abstained')
    assert.equal(body.data.reasonCode, 'no_evidence')
    assert.deepEqual(body.data.citations, [])
    assert.equal(modelCalls, 0)
  })
})

test('final route authorization drops stale or revoked candidates before answer generation', async () => {
  let modelCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => rejectingChecks(),
    candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({
      generate: async () => {
        modelCalls += 1
        return { status: 'queued', citations: [] }
      }
    })
  })

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'revoked source' })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.status, 'abstained')
    assert.equal(body.data.reasonCode, 'no_evidence')
    assert.equal(modelCalls, 0)
  })
})
