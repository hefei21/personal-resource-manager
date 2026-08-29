import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'pc-worker-route-test-data')

const { createPcWorkerAgentRouter, createPcWorkerOwnerRouter } = await import('../src/routes/pcWorkers.js')
const { RAG_RERANKER_MODEL } = await import('../src/config/ragReranker.js')
const { createRagArtifactStore } = await import('../src/services/ragArtifactStore.js')

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

test('RAG content extraction stages binary artifacts and completes with metadata only', async () => {
  const input = {
    schemaVersion: 1,
    sourceType: 'document',
    sourceId: 7,
    sourceVersionId: '7',
    sourceContentSha256: sha256,
    contentBytes: content.length,
    format: 'docx'
  }
  const task = {
    id: 43,
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    subjectId: '7',
    subjectContentHash: sha256,
    input,
    status: 'running',
    leaseOwner: `pcw:${worker.id}`,
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    attemptCount: 1
  }
  let succeeded
  let followup
  let followupCount = 0
  const store = {
    getById(id) { return Number(id) === task.id ? task : null },
    succeed({ result }) { succeeded = result; task.status = 'succeeded'; return { id: task.id, status: task.status, progress: 100 } },
    enqueue(input) { followup = input; followupCount += 1; return { task: { id: 44, ...input }, created: true } }
  }
  const sections = [{ ordinal: 0, title: 'Document', text: 'Grounded text.', locator: { paragraphStart: 0, paragraphEnd: 0 } }]
  const artifact = JSON.stringify({ schemaVersion: 1, format: 'docx', sections })
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
  const artifactBytes = Buffer.byteLength(artifact)
  const result = {
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      sourceVersionId: input.sourceVersionId,
      sourceContentSha256: sha256,
      extractorVersion: 'pc-worker-structured-text.v1',
      artifactSha256,
      artifactBytes,
      sectionCount: 1,
      format: 'docx'
    }
  }
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-rag-artifact-'))
  const artifactStore = createRagArtifactStore({ rootPath: artifactRoot })
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => fakeDatabase(),
    runtime: () => ({ getStore: () => store }),
    storageRuntime: () => ({ storageService: { createReadStream: async () => Readable.from(content) } }),
    authenticate: () => worker,
    artifactStore
  }))

  await withServer(app, async (baseUrl) => {
    const leasedInput = await fetch(`${baseUrl}/agent/tasks/43/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
    })
    assert.equal(leasedInput.status, 200)
    assert.deepEqual(Buffer.from(await leasedInput.arrayBuffer()), content)

    input.sourceVersionId = '6'
    const staleVersion = await fetch(`${baseUrl}/agent/tasks/43/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
    })
    assert.equal(staleVersion.status, 409)
    input.sourceVersionId = '7'

    const upload = await fetch(`${baseUrl}/agent/tasks/43/artifact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer access',
        'x-worker-lease': 'lease-secret',
        'content-type': 'application/octet-stream',
        'x-artifact-sha256': artifactSha256,
        'x-artifact-bytes': String(artifactBytes),
        'x-artifact-section-count': '1',
        'x-artifact-format': 'docx'
      },
      body: artifact
    })
    assert.equal(upload.status, 201)
    const retryUpload = await fetch(`${baseUrl}/agent/tasks/43/artifact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer access',
        'x-worker-lease': 'lease-secret',
        'content-type': 'application/octet-stream',
        'x-artifact-sha256': artifactSha256,
        'x-artifact-bytes': String(artifactBytes),
        'x-artifact-section-count': '1',
        'x-artifact-format': 'docx'
      },
      body: artifact
    })
    assert.equal(retryUpload.status, 201)
    const differentArtifact = artifact.replace('Grounded text.', 'Different text.')
    const differentUpload = await fetch(`${baseUrl}/agent/tasks/43/artifact`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer access',
        'x-worker-lease': 'lease-secret',
        'content-type': 'application/octet-stream',
        'x-artifact-sha256': createHash('sha256').update(differentArtifact).digest('hex'),
        'x-artifact-bytes': String(Buffer.byteLength(differentArtifact)),
        'x-artifact-section-count': '1',
        'x-artifact-format': 'docx'
      },
      body: differentArtifact
    })
    assert.equal(differentUpload.status, 409)

    const complete = await fetch(`${baseUrl}/agent/tasks/43/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result })
    })
    assert.equal(complete.status, 200, JSON.stringify(await complete.clone().json()))
    assert.equal(succeeded.output.format, 'docx')
    assert.equal(followup.taskType, 'rag.index.refresh')
    assert.deepEqual(followup.input, {
      source: { type: 'document', id: 7 },
      filter: { sourceType: 'document', sourceIds: [7] },
      rebuild: false
    })
    const repeatedComplete = await fetch(`${baseUrl}/agent/tasks/43/complete`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: 'lease-secret', result })
    })
    assert.equal(repeatedComplete.status, 403)
    assert.equal(followupCount, 1)
    assert.equal(Object.hasOwn(succeeded.output, 'manifest'), false)
    assert.equal((await artifactStore.readCommitted(43)).sections[0].text, 'Grounded text.')
  })
  fs.rmSync(artifactRoot, { recursive: true, force: true })
})

test('RAG extraction streams a newly uploaded legacy document without a resource projection', async () => {
  const input = {
    schemaVersion: 1,
    sourceType: 'document',
    sourceId: 33,
    sourceVersionId: '11',
    sourceContentSha256: sha256,
    contentBytes: content.length,
    format: 'pdf'
  }
  const task = {
    id: 44,
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    subjectId: '33',
    subjectContentHash: sha256,
    input,
    status: 'running',
    leaseOwner: `pcw:${worker.id}`,
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    attemptCount: 1
  }
  const database = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM resource_domain_links link')) return undefined
          if (sql.includes('FROM documents domain_source')) {
            return {
              legacy_version_id: 11,
              legacy_storage_key: `documents/${sha256.slice(0, 2)}/${sha256}`,
              legacy_file_path: null,
              sha256,
              bytes: content.length,
              legacy_version_number: 1
            }
          }
          return undefined
        }
      }
    }
  }
  const contentService = {
    async stat(reference) {
      assert.equal(reference.storage_key, `documents/${sha256.slice(0, 2)}/${sha256}`)
      return { source: 'storage', sha256, bytes: content.length }
    },
    async createReadStream(reference) {
      assert.equal(reference.storage_key, `documents/${sha256.slice(0, 2)}/${sha256}`)
      return { source: 'storage', stream: Readable.from(content) }
    }
  }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => database,
    runtime: () => ({ getStore: () => ({ getById: (id) => Number(id) === task.id ? task : null }) }),
    storageRuntime: () => ({ storageService: { createReadStream: async () => { throw new Error('canonical storage must not be used') } } }),
    documentStorageRuntime: () => ({ contentService }),
    authenticate: () => worker
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/agent/tasks/44/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  })
})

test('RAG extraction streams a newly uploaded legacy EPUB without a resource projection', async () => {
  const sourceVersionId = `current:1:${sha256}`
  const input = {
    schemaVersion: 1,
    sourceType: 'ebook',
    sourceId: 27,
    sourceVersionId,
    sourceContentSha256: sha256,
    contentBytes: content.length,
    format: 'epub'
  }
  const task = {
    id: 45,
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    subjectId: '27',
    subjectContentHash: sha256,
    input,
    status: 'running',
    leaseOwner: `pcw:${worker.id}`,
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    attemptCount: 1
  }
  const database = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('FROM resource_domain_links link')) return undefined
          if (sql.includes('FROM books domain_source')) {
            return {
              legacy_storage_key: `ebooks/${sha256.slice(0, 2)}/${sha256}`,
              legacy_file_path: null,
              sha256,
              bytes: content.length
            }
          }
          return undefined
        }
      }
    }
  }
  const contentService = {
    async stat(reference) {
      assert.equal(reference.storage_key, `ebooks/${sha256.slice(0, 2)}/${sha256}`)
      return { source: 'storage', sha256, bytes: content.length }
    },
    async createReadStream(reference) {
      assert.equal(reference.storage_key, `ebooks/${sha256.slice(0, 2)}/${sha256}`)
      return { source: 'storage', stream: Readable.from(content) }
    }
  }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => database,
    runtime: () => ({ getStore: () => ({ getById: (id) => Number(id) === task.id ? task : null }) }),
    storageRuntime: () => ({
      storageService: { createReadStream: async () => { throw new Error('canonical storage must not be used') } },
      contentService,
      contentServiceFor: (kind) => {
        assert.equal(kind, 'ebooks')
        return contentService
      }
    }),
    authenticate: () => worker
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/agent/tasks/45/input`, {
      headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
  })
})

for (const fixture of [
  {
    label: 'document',
    sourceType: 'document',
    sourceId: 46,
    sourceVersionId: '11',
    resourceVersionId: 146,
    filePath: 'legacy/projected.pdf',
    format: 'pdf'
  },
  {
    label: 'ebook',
    sourceType: 'ebook',
    sourceId: 47,
    sourceVersionId: '147',
    resourceVersionId: 147,
    filePath: 'legacy/projected.epub',
    format: 'epub'
  }
]) {
  test(`RAG extraction streams a projected legacy ${fixture.label} without a managed content key`, async () => {
    const input = {
      schemaVersion: 1,
      sourceType: fixture.sourceType,
      sourceId: fixture.sourceId,
      sourceVersionId: fixture.sourceVersionId,
      sourceContentSha256: sha256,
      contentBytes: content.length,
      format: fixture.format
    }
    const task = {
      id: fixture.resourceVersionId,
      taskType: 'rag.content.extract',
      processorVersion: 'v1',
      executionClass: 'cpu',
      subjectId: `${fixture.sourceType}:${fixture.sourceId}`,
      subjectContentHash: sha256,
      input,
      status: 'running',
      leaseOwner: `pcw:${worker.id}`,
      leaseToken: 'lease-secret',
      leaseExpiresAt: '2999-01-01T00:00:00.000Z',
      attemptCount: 1
    }
    const database = {
      prepare(sql) {
        return {
          get() {
            if (sql.includes('FROM resource_domain_links link')) {
              return {
                resource_version_id: fixture.resourceVersionId,
                resource_id: fixture.resourceVersionId + 1000,
                content_object_id: fixture.resourceVersionId + 2000,
                sha256,
                bytes: content.length,
                managed_storage_key: null,
                lifecycle_status: 'active'
              }
            }
            if (fixture.sourceType === 'document' && sql.includes('FROM documents domain_source')) {
              return {
                legacy_version_id: 11,
                legacy_storage_key: null,
                legacy_file_path: fixture.filePath,
                sha256: null,
                bytes: null,
                legacy_version_number: 1
              }
            }
            if (fixture.sourceType === 'ebook' && sql.includes('FROM books domain_source')) {
              return {
                legacy_storage_key: null,
                legacy_file_path: fixture.filePath,
                sha256: null,
                bytes: null
              }
            }
            return undefined
          }
        }
      }
    }
    const contentService = {
      async stat(reference) {
        assert.equal(reference.file_path, fixture.filePath)
        assert.equal(reference.content_sha256, sha256)
        assert.equal(reference.content_bytes, content.length)
        return { source: 'legacy', bytes: content.length }
      },
      async createReadStream(reference) {
        assert.equal(reference.file_path, fixture.filePath)
        return { source: 'legacy', stream: Readable.from(content) }
      }
    }
    const app = express()
    app.use(express.json())
    app.use('/agent', createPcWorkerAgentRouter({
      database: () => database,
      runtime: () => ({ getStore: () => ({ getById: (id) => Number(id) === task.id ? task : null }) }),
      storageRuntime: () => ({
        storageService: { createReadStream: async () => { throw new Error('managed storage must not be used') } },
        contentService,
        contentServiceFor: (kind) => {
          assert.equal(kind, 'ebooks')
          return contentService
        }
      }),
      documentStorageRuntime: () => ({ contentService }),
      authenticate: () => worker
    }))
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/agent/tasks/${task.id}/input`, {
        headers: { authorization: 'Bearer access', 'x-worker-lease': 'lease-secret' }
      })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json().catch(() => null)))
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content)
      assert.equal(response.headers.get('x-content-sha256'), sha256)
    })
  })
}

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
    authenticate: () => worker,
    embeddingRuntimeFactory: () => ({
      applyWorkerResult: async () => ({ applied: true, status: 'active' })
    })
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

test('Worker claim derives CPU execution classes for content extraction', async () => {
  const claimWorker = {
    ...worker,
    capabilities: {
      ...worker.capabilities,
      processors: [{ taskType: 'rag.content.extract', processorVersion: 'v1', executionClass: 'cpu', outputSchemaVersion: 1 }]
    }
  }
  const task = {
    ...taskFixture(),
    id: 77,
    taskType: 'rag.content.extract',
    executionClass: 'cpu',
    input: {
      schemaVersion: 1,
      sourceType: 'document',
      sourceId: 7,
      sourceVersionId: 'version-7',
      sourceContentSha256: sha256,
      contentBytes: content.length,
      format: 'docx'
    }
  }
  let leaseOptions
  const store = {
    leaseNext(options) {
      leaseOptions = options
      return { ...task, status: 'leased', leaseOwner: options.owner, leaseToken: 'lease-cpu' }
    },
    fail() {}
  }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => fakeDatabase(),
    runtime: () => ({ getStore: () => store }),
    authenticate: () => claimWorker,
    embeddingModelProvider: () => null
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/agent/tasks/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(response.status, 200)
    assert.deepEqual(leaseOptions.executionClasses, ['cpu'])
    assert.equal(Object.hasOwn(leaseOptions, 'executionClass'), false)
    assert.deepEqual(leaseOptions.supportedProcessors, [{
      taskType: 'rag.content.extract', processorVersion: 'v1', executionClass: 'cpu'
    }])
  })
})

test('Worker claim independently binds Nomic embedding and BGE reranker capabilities', async () => {
  const embeddingModel = {
    provider: 'lm-studio',
    modelId: 'text-embedding-nomic-embed-text-v1.5',
    modelRevision: 'gguf-sha256-d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
    dimensions: 768,
    inputLimit: 2048,
    distance: 'cosine',
    normalization: 'l2',
    configHash: '7d93077b98e4a05746f0de951f9156d9671de74a446a4312b2baaa092eabbdad'
  }
  const claimWorker = {
    ...worker,
    capabilities: {
      ...worker.capabilities,
      processors: [
        ...worker.capabilities.processors,
        {
          taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1,
          model: Object.fromEntries(['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'configHash'].map((key) => [key, embeddingModel[key]]))
        },
        {
          taskType: 'rag.query.embed', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1,
          model: Object.fromEntries(['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'configHash'].map((key) => [key, embeddingModel[key]]))
        },
        { taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1, model: RAG_RERANKER_MODEL }
      ]
    }
  }
  const database = {
    prepare(sql) {
      return {
        get(name) {
          if (sql.includes('sqlite_master')) return { 1: name }
          if (sql.includes('rag_embedding_models')) {
            return {
              embedding_model_id: 19,
              provider: embeddingModel.provider,
              model_id: embeddingModel.modelId,
              model_revision: embeddingModel.modelRevision,
              dimensions: embeddingModel.dimensions,
              input_limit: embeddingModel.inputLimit,
              distance: embeddingModel.distance,
              normalization: embeddingModel.normalization,
              config_hash: embeddingModel.configHash,
              status: 'active'
            }
          }
          return null
        }
      }
    }
  }
  let leaseOptions
  const store = {
    leaseNext(options) { leaseOptions = options; return null }
  }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => database,
    runtime: () => ({ getStore: () => store }),
    authenticate: () => claimWorker,
    embeddingModelProvider: () => ({ embeddingModelId: 19, model: embeddingModel }),
    rerankerModelProvider: () => RAG_RERANKER_MODEL
  }))

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/agent/tasks/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(response.status, 204)
    assert.deepEqual(leaseOptions.supportedProcessors, [
      { taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu' },
      { taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu' },
      { taskType: 'rag.query.embed', processorVersion: 'v1', executionClass: 'gpu' },
      { taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu' }
    ])
  })
})

test('Worker claim keeps configured reranker when no embedding model is active', async () => {
  const rerankerEnvironment = {
    RAG_RERANKER_ENABLED: 'true',
    RAG_RERANKER_PROVIDER: RAG_RERANKER_MODEL.provider,
    RAG_RERANKER_MODEL_ID: RAG_RERANKER_MODEL.modelId,
    RAG_RERANKER_MODEL_REVISION: RAG_RERANKER_MODEL.modelRevision,
    RAG_RERANKER_DIMENSIONS: String(RAG_RERANKER_MODEL.dimensions),
    RAG_RERANKER_INPUT_LIMIT: String(RAG_RERANKER_MODEL.inputLimit),
    RAG_RERANKER_CONFIG_HASH: RAG_RERANKER_MODEL.configHash
  }
  const previousEnvironment = Object.fromEntries(Object.keys(rerankerEnvironment).map((key) => [key, process.env[key]]))
  Object.assign(process.env, rerankerEnvironment)
  const claimWorker = {
    ...worker,
    capabilities: {
      ...worker.capabilities,
      processors: [
        {
          taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1,
          model: {
            provider: 'lm-studio',
            modelId: 'text-embedding-nomic-embed-text-v1.5',
            modelRevision: 'gguf-sha256-d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
            dimensions: 768,
            inputLimit: 2048,
            configHash: '7d93077b98e4a05746f0de951f9156d9671de74a446a4312b2baaa092eabbdad'
          }
        },
        { taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1, model: RAG_RERANKER_MODEL }
      ]
    }
  }
  let leaseOptions
  const store = { leaseNext(options) { leaseOptions = options; return null } }
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => fakeDatabase(),
    runtime: () => ({ getStore: () => store }),
    authenticate: () => claimWorker
  }))

  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/agent/tasks/claim`, {
        method: 'POST',
        headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
        body: '{}'
      })
      assert.equal(response.status, 204)
      assert.deepEqual(leaseOptions.supportedProcessors, [
        { taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu' }
      ])
    })
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
