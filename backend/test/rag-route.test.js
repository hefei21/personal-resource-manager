import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'rag-route-test-data')

const {
  createAuthoritativeChecks,
  createRagRouter,
  normalizeCoverageQuery,
  normalizeQueryBody,
  normalizeRagIndexRefreshBody
} = await import('../src/routes/rag.js')

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

function queryRunStore() {
  const rows = new Map()
  return {
    available: true,
    upsert(entry) {
      rows.set(`${entry.ownerScope}:${entry.runId}`, {
        run_id: entry.runId,
        owner_scope: entry.ownerScope,
        task_id: entry.taskKey?.id ?? null,
        task_idempotency_key: entry.taskKey?.idempotencyKey ?? null,
        task_type: 'rag.answer.generate',
        processor_version: 'v1',
        status: entry.status === 'active' ? 'running' : 'pending',
        context_json: entry.contextJson,
        updated_at: new Date().toISOString()
      })
      return true
    },
    get(runId, ownerScope) {
      return rows.get(`${ownerScope}:${runId}`) ?? null
    },
    updateStatus(runId, ownerScope, status) {
      const row = rows.get(`${ownerScope}:${runId}`)
      if (!row) return false
      row.status = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'succeeded'
      return true
    }
  }
}

test('normalizes a bounded query and rejects client-controlled evidence/filter knobs', () => {
  assert.deepEqual(normalizeQueryBody({ query: '  资料问题  ', limit: 2 }), { query: '资料问题', limit: 2 })
  assert.deepEqual(normalizeQueryBody({ q: 'same contract' }), { query: 'same contract', limit: 10 })
  assert.deepEqual(normalizeQueryBody({ query: '第一行\n第二行\t值' }), { query: '第一行\n第二行\t值', limit: 10 })
  assert.deepEqual(normalizeQueryBody({ query: '章节数', source: { type: 'ebook', id: 23 } }), {
    query: '章节数',
    limit: 10,
    source: { sourceType: 'ebook', sourceId: 23 }
  })
  assert.throws(() => normalizeQueryBody({ query: 'bad\u0001query' }))
  assert.throws(() => normalizeQueryBody({ query: 'q', evidence: [] }))
  assert.throws(() => normalizeQueryBody({ query: 'q', filter: { sourceType: 'document' } }))
  assert.throws(() => normalizeQueryBody({ query: 'q', weights: { vector: 100 } }))
  assert.throws(() => normalizeQueryBody({ query: 'q', source: { type: 'ebook', id: 0 } }))
  assert.throws(() => normalizeQueryBody({ query: 'q', source: { type: 'ebook', id: 1, path: '/private' } }))
  assert.deepEqual(normalizeCoverageQuery({ type: 'ebook', limit: '20', offset: '0' }), {
    type: 'ebook', limit: 20, offset: 0
  })
  assert.equal(normalizeCoverageQuery({ type: 'audio' }), null)
})

test('default final visibility binds document candidates to sourceVersionId and version recycle state', () => {
  let versionTrashed = true
  const database = {
    prepare(sql) {
      return {
        get(...parameters) {
          if (sql.includes('sqlite_master')) return { present: 1 }
          assert.match(sql, /document_versions/u)
          assert.match(sql, /document_version/u)
          assert.ok(parameters.includes(42))
          return versionTrashed ? null : { visible: 1 }
        }
      }
    }
  }
  const checks = createAuthoritativeChecks(database)
  const candidate = { sourceType: 'document', sourceId: 7, sourceVersionId: '42' }
  assert.equal(checks.authoritativeVisibility(candidate), false)
  versionTrashed = false
  assert.equal(checks.authoritativeVisibility(candidate), true)
  assert.equal(checks.authoritativeVisibility({ ...candidate, sourceVersionId: 'current:2:hash' }), false)
})

test('RAG query is Owner-only, uses server evidence, strips internal fields, and returns an opaque run id', async () => {
  const calls = { candidates: [], answers: [] }
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    queryRunStore: queryRunStore(),
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

test('optional reranker reorders only authorized evidence and the route rechecks visibility', async () => {
  const first = retrieval().data[0]
  const second = {
    ...first,
    citationId: 'internal-candidate-id-2',
    chunkId: 42,
    body: 'Second authorized evidence.'
  }
  const phases = []
  let answerEvidence = []
  const router = createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    authoritativeChecksFactory: () => ({
      authoritativeVisibility: (_candidate, context) => { phases.push(context.phase); return true },
      authoritativeActiveSnapshot: () => true
    }),
    candidateProvider: async () => ({ ftsCandidates: [] }),
    hybridRetrieverFactory: () => ({
      retrieve: async () => ({
        ...retrieval(),
        data: [first, second],
        total: 2,
        retrieval: { mode: 'hybrid', degraded: false, fusion: 'rrf' }
      })
    }),
    rerankerService: {
      rerank: async ({ candidates }) => ({ candidates: [...candidates].reverse(), applied: true, degraded: false, reason: null })
    },
    answerServiceFactory: () => ({
      generate: async ({ query, evidence }) => {
        answerEvidence = evidence
        return { status: 'degraded', query, language: 'en', answer: null, abstained: true, reasonCode: 'test', degraded: true, degradedReason: 'test', citations: [] }
      }
    }),
    taskStoreProvider: () => null
  })

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'RAG query' })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(answerEvidence.map((item) => item.chunkId), [42, 41])
    assert.equal(body.data.retrieval.reranker.status, 'applied')
    assert.equal(phases.includes('route_post_rerank'), true)
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
    assert.equal(body.data.capabilities.answer.status, 'ready')
    assert.equal(body.data.capabilities.embedding.status, 'not_configured')
    assert.equal(body.data.capabilities.reranker.status, 'not_configured')
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
      queryRunStore: queryRunStore(),
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
      assert.equal(body.data.pcWorker.reason, 'heartbeat_stale')
      assert.equal(body.data.capabilities.answer.status, 'worker_offline')
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
      const body = await response.json()
      assert.equal(body.data.pcWorker.status, 'offline')
      assert.equal(body.data.pcWorker.reason, 'not_registered')
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
    queryRunStore: queryRunStore(),
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

test('persisted run mapping survives router reconstruction for the same Owner', async () => {
  const persistentRuns = queryRunStore()
  let task = {
    id: 501,
    idempotencyKey: 'rebuild-answer-501',
    status: 'pending',
    taskType: 'rag.answer.generate',
    processorVersion: 'v1',
    input: { private: 'not public' }
  }
  const taskStore = {
    getById(id) {
      assert.equal(id, 501)
      return task
    },
    cancel(id) {
      assert.equal(id, 501)
      task = { ...task, status: 'cancelled' }
      return task
    }
  }
  const makeRouter = () => createRagRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    queryRunStore: persistentRuns,
    authoritativeChecksFactory: () => checks(),
    taskStoreProvider: () => taskStore,
    candidateProvider: async () => ({ ftsCandidates: [{ serverCandidate: true }] }),
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({
      generate: async ({ query }) => ({ status: 'queued', query, citations: [], task })
    }),
    requestIdFactory: () => 'rebuild-run-1'
  })

  await withServer(makeRouter(), async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: 'rebuild me' })
    })
    assert.equal(accepted.status, 202)
  })

  await withServer(makeRouter(), async (baseUrl) => {
    const restored = await fetch(`${baseUrl}/api/rag/queries/rebuild-run-1`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).data.status, 'pending')
    const cancelled = await fetch(`${baseUrl}/api/rag/queries/rebuild-run-1/cancel`, {
      method: 'POST',
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(cancelled.status, 200)
    assert.equal((await cancelled.json()).data.status, 'cancelled')
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

test('normalizes the Owner RAG refresh input and rejects unscoped controls', () => {
  assert.deepEqual(normalizeRagIndexRefreshBody({
    source: { type: 'document', id: 7 },
    filter: { sourceIds: [7] },
    rebuild: true
  }), {
    source: { type: 'document', id: 7 },
    filter: { sourceIds: [7] },
    rebuild: true
  })
  assert.deepEqual(normalizeRagIndexRefreshBody({}), {
    source: { type: 'all', id: null },
    rebuild: false
  })
  assert.throws(() => normalizeRagIndexRefreshBody({ source: { type: 'document', id: 7 }, path: '/tmp/a.md' }))
  assert.throws(() => normalizeRagIndexRefreshBody({ modelUrl: 'http://127.0.0.1:1234' }))
})

test('Owner RAG refresh enqueues a persistent task with a mutex and rejects conflicts', async () => {
  const requests = []
  let activeConflict = false
  const task = {
    id: 12,
    taskType: 'rag.index.refresh',
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType: 'rag-index',
    subjectId: 'owner',
    subjectVersionId: 'refresh-route-1',
    status: 'pending',
    progress: 0,
    attemptCount: 0,
    maxAttempts: 3,
    input: { source: { type: 'document', id: 7 }, filter: { sourceIds: [7] }, rebuild: true },
    result: null,
    errorCode: null,
    availableAt: '2026-08-25T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z'
  }
  const store = {
    enqueueExclusiveRun(request, options) {
      requests.push({ request, options })
      return activeConflict ? { activeConflict: true, outcome: 'active-conflict', task } : { task, created: true }
    }
  }
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    taskRuntimeProvider: () => ({ getStore: () => store }),
    requestIdFactory: () => 'refresh-route-1'
  })

  await withServer(router, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/rag/index/refresh`, { method: 'POST', body: '{}' })
    assert.equal(anonymous.status, 401)
    const invalid = await fetch(`${baseUrl}/api/rag/index/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ source: { type: 'document', id: 7 }, path: '/private/a.md' })
    })
    assert.equal(invalid.status, 400)
    const accepted = await fetch(`${baseUrl}/api/rag/index/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ source: { type: 'document', id: 7 }, filter: { sourceIds: [7] }, rebuild: true })
    })
    assert.equal(accepted.status, 202)
    assert.equal((await accepted.json()).data.taskType, 'rag.index.refresh')
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].options, { mutexTaskTypes: ['rag.index.refresh'] })
    assert.deepEqual(requests[0].request.input, task.input)
    activeConflict = true
    const conflict = await fetch(`${baseUrl}/api/rag/index/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' }, body: '{}'
    })
    assert.equal(conflict.status, 409)
  })
})

test('Owner source status passes only the allowlisted source identity and hides internals', async () => {
  const seen = []
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => ({ authoritativeVisibility: ({ sourceType, sourceId }) => {
      seen.push([sourceType, sourceId])
      return sourceType === 'document' && sourceId === 7
    } }),
    sourceStatusProvider: ({ sourceType, sourceId }) => sourceType === 'document' && sourceId === 7
      ? {
          source: { type: sourceType, id: sourceId },
          sourceState: { status: 'ready' },
          snapshot: { id: 9, status: 'ready', chunkCount: 2 },
          chunks: { status: 'ready', count: 2 },
          embedding: { status: 'pending', models: [{ modelId: 'nomic', status: 'pending', vectorCount: 0 }] }
        }
      : null
  })
  await withServer(router, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/rag/sources/document/7/status`)
    assert.equal(anonymous.status, 401)
    const invalid = await fetch(`${baseUrl}/api/rag/sources/not-a-source/7/status`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(invalid.status, 400)
    const missing = await fetch(`${baseUrl}/api/rag/sources/document/8/status`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(missing.status, 404)
    const owner = await fetch(`${baseUrl}/api/rag/sources/document/7/status`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(owner.status, 200)
    const body = await owner.json()
    assert.equal(body.data.snapshot.status, 'ready')
    assert.equal(body.data.chunks.count, 2)
    assert.equal(body.data.embedding.status, 'pending')
    assert.deepEqual(seen, [['document', 8], ['document', 7]])
    assert.doesNotMatch(JSON.stringify(body), /absolutePath|storageKey|modelUrl|collection|secret|token/iu)
  })
})

test('Owner coverage is bounded, authenticated, and returns only projected source state', async () => {
  const seen = []
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => ({ authoritativeVisibility: () => true }),
    coverageProvider: (input) => {
      seen.push({ type: input.type, limit: input.limit, offset: input.offset })
      return {
        summary: { total: 1, indexed: 0, ready: 0, partial: 0, pending: 0, stale: 0, failed: 0, missing: 1 },
        data: [{
          source: { type: 'ebook', id: 23, title: 'Owner ebook' },
          status: 'missing',
          chunkCount: 0,
          embeddingStatus: 'missing'
        }],
        total: 1,
        limit: input.limit,
        offset: input.offset
      }
    }
  })
  await withServer(router, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/rag/coverage`)).status, 401)
    assert.equal((await fetch(`${baseUrl}/api/rag/coverage?type=audio`, {
      headers: { 'x-test-principal': 'owner' }
    })).status, 400)
    const response = await fetch(`${baseUrl}/api/rag/coverage?type=ebook&limit=20`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.data[0].source.title, 'Owner ebook')
    assert.equal(body.data.data[0].status, 'missing')
    assert.deepEqual(seen, [{ type: 'ebook', limit: 20, offset: 0 }])
    assert.doesNotMatch(JSON.stringify(body), /path|hash|secret|token/iu)
  })
})

test('exact source scope is forwarded and unrelated retrieval evidence is rejected', async () => {
  const calls = []
  let answerCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => checks(),
    sourceStatusProvider: () => ({
      sourceState: { status: 'ready' },
      snapshot: { status: 'ready' },
      chunks: { status: 'ready', count: 2 },
      embedding: { status: 'ready', models: [] }
    }),
    structuredAnswerProvider: () => null,
    candidateProvider: (input) => {
      calls.push(input.source)
      return { ftsCandidates: [] }
    },
    hybridRetrieverFactory: () => ({ retrieve: async () => retrieval() }),
    answerServiceFactory: () => ({ generate: async () => { answerCalls += 1 } })
  })
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: '只问这本书', source: { type: 'ebook', id: 23 } })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.abstained, true)
    assert.equal(body.data.reasonCode, 'no_evidence')
    assert.deepEqual(calls, [{ sourceType: 'ebook', sourceId: 23 }])
    assert.equal(answerCalls, 0)
  })
})

test('exact source fails closed before retrieval when its RAG index is missing', async () => {
  let candidateCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => checks(),
    sourceStatusProvider: () => ({
      sourceState: { status: 'missing' },
      chunks: { status: 'missing', count: 0 },
      embedding: { status: 'missing', models: [] }
    }),
    structuredAnswerProvider: () => null,
    candidateProvider: () => { candidateCalls += 1; return { ftsCandidates: [] } }
  })
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: '这本书讲了什么', source: { type: 'ebook', id: 23 } })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.abstained, true)
    assert.equal(body.data.reasonCode, 'source_not_indexed')
    assert.equal(candidateCalls, 0)
  })
})

test('structured source facts bypass retrieval and model generation', async () => {
  let candidateCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => checks(),
    sourceStatusProvider: () => ({ sourceState: { status: 'missing' }, chunks: { count: 0 } }),
    structuredAnswerProvider: ({ query, source }) => ({
      status: 'complete', query, language: 'zh', answer: '《目标书》当前可读取的正文共 26 章。',
      abstained: false, reasonCode: 'structured_fact', degraded: false,
      citations: [{ citationId: 'C1', title: '目标书', openUrl: `/books?bookId=${source.sourceId}` }]
    }),
    candidateProvider: () => { candidateCalls += 1; return { ftsCandidates: [] } }
  })
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: '正文一共多少章', source: { type: 'ebook', id: 23 } })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data.answer, '《目标书》当前可读取的正文共 26 章。')
    assert.equal(body.data.reasonCode, 'structured_fact')
    assert.equal(candidateCalls, 0)
  })
})

test('a uniquely inferred title scope reaches structured facts without unrelated retrieval', async () => {
  let candidateCalls = 0
  const router = createRagRouter({
    databaseProvider: () => ({ database: true }),
    authoritativeChecksFactory: () => checks(),
    querySourceResolver: () => ({
      source: { sourceType: 'ebook', sourceId: 23 },
      inferred: true
    }),
    sourceStatusProvider: () => ({ sourceState: { status: 'missing' }, chunks: { count: 0 } }),
    structuredAnswerProvider: ({ source }) => ({
      status: 'complete', language: 'zh', answer: `已绑定电子书 ${source.sourceId}。`,
      abstained: false, reasonCode: 'structured_fact', degraded: false, citations: []
    }),
    candidateProvider: () => { candidateCalls += 1; return { ftsCandidates: [] } }
  })
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/rag/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'owner' },
      body: JSON.stringify({ query: '无职转生正文一共多少章' })
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data.answer, '已绑定电子书 23。')
    assert.equal(candidateCalls, 0)
  })
})
