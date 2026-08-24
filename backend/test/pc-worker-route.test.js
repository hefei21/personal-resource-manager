import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'pc-worker-route-test-data')

const { createPcWorkerAgentRouter, createPcWorkerOwnerRouter } = await import('../src/routes/pcWorkers.js')

const content = Buffer.from('hello\nworker\n', 'utf8')
const sha256 = createHash('sha256').update(content).digest('hex')
const worker = {
  id: 'pcw-00000000-0000-4000-8000-000000000001',
  displayName: 'Worker',
  status: 'active',
  capabilities: {
    processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }],
    resources: { cpuLogicalCores: 16, systemMemoryBytes: 64 * 1024 ** 3, gpus: [], loadedModels: [] }
  }
}

function taskFixture() {
  return {
    id: 41,
    taskType: 'content.inspect',
    processorVersion: 'v1',
    subjectType: 'resource-version',
    subjectId: '7',
    subjectVersionId: '9',
    subjectContentHash: sha256,
    executionClass: 'gpu',
    input: { schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9 },
    status: 'pending',
    progress: 0,
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    result: null,
    availableAt: '2026-08-23T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    errorCode: null
  }
}

function fakeStore() {
  const task = taskFixture()
  return {
    task,
    enqueue(input) {
      Object.assign(task, {
        taskType: input.taskType,
        processorVersion: input.processorVersion,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectVersionId: input.subjectVersionId,
        subjectContentHash: input.subjectContentSha256,
        executionClass: input.executionClass,
        input: input.input
      })
      return { task, created: true }
    },
    leaseNext(options) {
      if (task.status !== 'pending') return null
      task.status = 'leased'
      task.leaseOwner = options.owner
      task.leaseToken = 'lease-secret'
      task.leaseExpiresAt = '2999-01-01T00:00:00.000Z'
      task.attemptCount += 1
      return task
    },
    getById(id) { return Number(id) === task.id ? task : null },
    markRunning({ owner, token }) {
      if (owner !== task.leaseOwner || token !== task.leaseToken) throw Object.assign(new Error(), { code: 'TASK_LEASE_MISMATCH' })
      task.status = 'running'
      return task
    },
    heartbeat() { return task },
    updateProgress({ progress }) { task.progress = progress; return task },
    succeed({ result }) {
      task.status = 'succeeded'
      task.progress = 100
      task.result = result
      task.leaseOwner = null
      task.leaseToken = null
      return task
    },
    fail() { return { task, retryScheduled: false } }
  }
}

function fakeDatabase() {
  const row = {
    resource_version_id: 7,
    resource_id: 3,
    resource_type: 'document',
    title: 'Fixture',
    version_number: 1,
    content_object_id: 9,
    sha256,
    bytes: content.length,
    managed_storage_key: `documents/${sha256.slice(0, 2)}/${sha256}`,
    lifecycle_status: 'active'
  }
  return {
    prepare() {
      return {
        get() { return row },
        all() { return [row] }
      }
    }
  }
}

async function withServer(app, callback) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function inspectionResult(overrides = {}) {
  return {
    schemaVersion: 1,
    processorVersion: 'v1',
    implementation: { name: 'builtin-content-inspector', version: '1' },
    input: { sha256, bytes: content.length },
    output: {
      sha256,
      bytes: content.length,
      nulBytes: 0,
      lineFeedBytes: 2,
      carriageReturnBytes: 0,
      utf8Valid: true,
      ...overrides
    }
  }
}

test('Worker agent flow binds bearer identity, lease, content and result', async () => {
  const store = fakeStore()
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => fakeDatabase(),
    runtime: () => ({ getStore: () => store }),
    storageRuntime: () => ({ storageService: { createReadStream: async () => Readable.from(content) } }),
    enroll: () => ({ worker, accessToken: 'access', refreshToken: 'refresh' }),
    refresh: () => ({ worker, accessToken: 'access-2', refreshToken: 'refresh-2' }),
    authenticate: (_database, token) => {
      if (token !== 'access') throw Object.assign(new Error(), { code: 'PC_WORKER_AUTH_INVALID' })
      return worker
    },
    updateProfile: () => worker
  }))

  await withServer(app, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/agent/tasks/claim`, { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } })
    assert.equal(unauthorized.status, 401)

    const claim = await fetch(`${baseUrl}/agent/tasks/claim`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' }, body: '{}'
    })
    assert.equal(claim.status, 200)
    const claimed = (await claim.json()).data
    assert.equal(claimed.leaseToken, 'lease-secret')
    assert.doesNotMatch(JSON.stringify(claimed), /managed_storage_key|documents\//u)

    const start = await fetch(`${baseUrl}/agent/tasks/41/start`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret' })
    })
    assert.equal(start.status, 200)

    const forbiddenInput = await fetch(`${baseUrl}/agent/tasks/41/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'wrong' }
    })
    assert.equal(forbiddenInput.status, 403)

    const input = await fetch(`${baseUrl}/agent/tasks/41/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
    })
    assert.equal(input.status, 200)
    assert.deepEqual(Buffer.from(await input.arrayBuffer()), content)
    assert.equal(input.headers.get('x-content-sha256'), sha256)

    const mismatch = await fetch(`${baseUrl}/agent/tasks/41/complete`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result: inspectionResult({ sha256: 'c'.repeat(64) }) })
    })
    assert.equal(mismatch.status, 409)
    assert.equal(store.task.status, 'running')

    const complete = await fetch(`${baseUrl}/agent/tasks/41/complete`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result: inspectionResult() })
    })
    assert.equal(complete.status, 200)
    assert.equal(store.task.status, 'succeeded')
  })
})

test('Owner route requires Owner and enqueues only managed content identifiers', async () => {
  const store = fakeStore()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (req.get('x-test-role')) req.user = { principal: req.get('x-test-role') }
    next()
  })
  app.use('/workers', createPcWorkerOwnerRouter({
    database: () => fakeDatabase(),
    runtime: () => ({ getStore: () => store }),
    createEnrollment: () => ({ token: 'shown-once', expiresAt: '2026-08-23T00:10:00.000Z' }),
    workerList: () => [worker],
    workerRevoke: () => worker
  }))

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/workers`)).status, 401)
    const targets = await fetch(`${baseUrl}/workers/content-inspection-targets?limit=10`, {
      headers: { 'x-test-role': 'owner' }
    })
    assert.equal(targets.status, 200)
    const targetBody = await targets.json()
    assert.deepEqual(targetBody.data, [{
      resourceVersionId: 7,
      resourceId: 3,
      resourceType: 'document',
      title: 'Fixture',
      versionNumber: 1,
      sha256,
      bytes: content.length
    }])
    assert.doesNotMatch(JSON.stringify(targetBody), /managed_storage_key|documents\//u)
    const queued = await fetch(`${baseUrl}/workers/content-inspection-tasks`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ resourceVersionId: 7 })
    })
    assert.equal(queued.status, 202)
    const body = await queued.json()
    assert.equal(body.data.subject.id, '7')
    assert.doesNotMatch(JSON.stringify(body), /managed_storage_key|leaseToken|leaseOwner/u)
  })
})

test('RAG embedding completion is catalog-normalized and stale snapshots are rejected', async () => {
  const model = {
    provider: 'local-provider',
    modelId: 'embedding-model',
    modelRevision: 'rev-1',
    dimensions: 3,
    inputLimit: 2048,
    distance: 'cosine',
    normalization: 'l2',
    configHash: 'a'.repeat(64)
  }
  const input = {
    schemaVersion: 1,
    snapshotId: 17,
    sourceType: 'document',
    sourceId: 7,
    sourceVersionId: '11',
    sourceContentSha256: 'b'.repeat(64),
    model,
    chunks: [{ chunkId: 101, ordinal: 0, chunkSha256: 'c'.repeat(64), body: '证据正文' }]
  }
  const task = {
    id: 42,
    taskType: 'rag.embedding.generate',
    processorVersion: 'v1',
    executionClass: 'gpu',
    subjectId: '7',
    subjectContentSha256: input.sourceContentSha256,
    input,
    status: 'running',
    leaseOwner: `pcw:${worker.id}`,
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    attemptCount: 1
  }
  let succeeded
  const store = {
    getById(id) { return Number(id) === task.id ? task : null },
    succeed({ result }) { succeeded = result; task.status = 'succeeded'; return { id: task.id, status: task.status, progress: 100 } }
  }
  const database = {
    prepare(sql) {
      return {
        get() {
          if (!sql.includes('rag_source_snapshots')) return null
          return {
            id: 17,
            source_type: 'document',
            source_id: 7,
            source_version_id: '11',
            source_content_sha256: 'b'.repeat(64)
          }
        }
      }
    }
  }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => database,
    runtime: () => ({ getStore: () => store }),
    authenticate: () => worker
  }))
  const result = {
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model,
      snapshotId: 17,
      sourceVersionId: '11',
      sourceContentSha256: 'b'.repeat(64),
      vectors: [{ chunkId: 101, chunkSha256: 'c'.repeat(64), embedding: [0.1, 0.2, 0.3] }],
      vectorSha256: createHash('sha256').update(JSON.stringify([[0.1, 0.2, 0.3]])).digest('hex')
    }
  }
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/agent/tasks/42/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result })
    })
    assert.equal(response.status, 200)
    assert.equal(succeeded.output.vectors[0].chunkId, 101)

    database.prepare = (sql) => ({
      get() {
        if (!sql.includes('rag_source_snapshots')) return null
        return {
          id: 17,
          source_type: 'document',
          source_id: 7,
          source_version_id: '11',
          source_content_sha256: 'd'.repeat(64)
        }
      }
    })
    task.status = 'running'
    const stale = await fetch(`${baseUrl}/agent/tasks/42/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result })
    })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).code, 'PC_WORKER_RESULT_STALE')
  })
})
