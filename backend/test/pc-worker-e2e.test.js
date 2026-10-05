import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'pc-worker-e2e-data')

const { createPcWorkerAgentRouter, createPcWorkerOwnerRouter } = await import('../src/routes/pcWorkers.js')
const { WorkerApiClient, WorkerApiError } = await import('../../pc-worker/src/apiClient.js')
const { inspectContent } = await import('../../pc-worker/src/contentInspector.js')
const {
  CREATE_PC_WORKER_CREDENTIALS_SQL,
  CREATE_PC_WORKER_ENROLLMENTS_SQL,
  CREATE_PC_WORKERS_SQL
} = await import('../src/config/pcWorkerSchema.js')
const {
  CREATE_CONTENT_OBJECTS_SQL,
  CREATE_RESOURCES_SQL,
  CREATE_RESOURCE_VERSIONS_SQL,
  RESOURCE_VERSION_CURRENT_INDEX_SQL
} = await import('../src/config/resourceModelSchema.js')
const { CREATE_TASK_SCHEMA_SQL } = await import('../src/config/taskSchema.js')
const { createTaskStore } = await import('../src/services/taskStore.js')
const { createRagRerankService } = await import('../src/services/ragRerankService.js')
const { QWEN_RERANKER_MODEL } = await import('../src/config/qwenReranker.js')
const { createRagRerankProcessor, rerankProcessorsForConfig } = await import('../../pc-worker/src/ragRerankProcessor.js')
const { StorageService } = await import('../src/services/storageService.js')

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}
const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

function profile() {
  return {
    displayName: 'E2E Worker',
    protocolVersion: 1,
    agentVersion: '0.1.0',
    platform: 'win32',
    architecture: 'x64',
    capabilities: {
      processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }],
      resources: { cpuLogicalCores: 16, systemMemoryBytes: 64 * 1024 ** 3, gpus: [], loadedModels: [] }
    }
  }
}

function ownerBoundary(req, res, next) {
  if (req.get('x-test-role') !== 'owner') return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: 'owner', isGuest: false }
  return next()
}

async function withServer(app, callback) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await callback(`http://127.0.0.1:${server.address().port}`) } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('pool is leased once only to a capable worker and completes all 150 through real SQLite/HTTP', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  database.exec(`${CREATE_TASK_SCHEMA_SQL};${CREATE_PC_WORKERS_SQL};${CREATE_PC_WORKER_ENROLLMENTS_SQL};${CREATE_PC_WORKER_CREDENTIALS_SQL};`)
  const store = createTaskStore({ database }), runtime = () => ({ getStore: () => store })
  const model = QWEN_RERANKER_MODEL, config = { ...model, baseUrl: 'http://127.0.0.1:19091', apiKey: 'x'.repeat(32) }
  const app = express(); app.use(express.json())
  app.use('/api/pc-workers', ownerBoundary, createPcWorkerOwnerRouter({ database: () => database, runtime }))
  app.use('/api/pc-worker-agent', createPcWorkerAgentRouter({ database: () => database, runtime, rerankerModelProvider: () => model }))
  try { await withServer(app, async baseUrl => {
    const api = new WorkerApiClient({ baseUrl })
    const enroll = async processors => {
      const response = await fetch(`${baseUrl}/api/pc-workers/enrollments`, { method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: '{}' })
      const { data } = await response.json(), p = profile(); p.capabilities.processors = processors
      return api.enroll(data.token, p)
    }
    const advertised = rerankProcessorsForConfig(config)
    const old = await enroll(advertised.filter(p => p.taskType === 'rag.rerank'))
    const current = await enroll(advertised)
    const inputs = Array.from({ length: 150 }, (_, i) => ({ citationId: `C${i}`, body: `text ${i}` }))
    // Queue via the real service but return immediately; consume the same task after completion.
    let clock = 0
    const service = createRagRerankService({ model, workerAvailable: () => true, taskStore: store,
      now: () => clock, sleep: async () => { clock = 3001 } })
    assert.equal((await service.rerankPool({ query: 'q', candidates: inputs })).applied, false)
    assert.equal(await api.claim(old.accessToken), null)
    const leased = await api.claim(current.accessToken)
    assert.equal(leased.taskType, 'rag.rerank.pool'); assert.equal(leased.input.candidates.length, 150)
    await api.start(current.accessToken, leased)
    const sizes = [], processor = createRagRerankProcessor({ config, fetchImpl: async (url, options) => {
      const texts = JSON.parse(options.body).texts; sizes.push(texts.length)
      return { ok: true, json: async () => texts.map((text, index) => ({ index, score: Number(text.slice(5)) })) }
    } })
    await api.complete(current.accessToken, leased, await processor.process(leased))
    assert.equal(store.getById(leased.id).status, 'succeeded')
    assert.deepEqual(sizes, [50, 50, 50])
    const result = await createRagRerankService({ model, workerAvailable: () => true, taskStore: store }).rerankPool({ query: 'q', candidates: inputs })
    assert.equal(result.applied, true); assert.equal(result.candidates[0].citationId, 'C149')
    assert.equal(await api.claim(current.accessToken), null)
  }) } finally { database.close() }
})

test('real SQLite and storage complete the Worker lifecycle without exposing paths', nativeTestOptions, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-e2e-'))
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    database.exec(`
      ${CREATE_RESOURCES_SQL};
      ${CREATE_CONTENT_OBJECTS_SQL};
      ${CREATE_RESOURCE_VERSIONS_SQL};
      ${RESOURCE_VERSION_CURRENT_INDEX_SQL};
      ${CREATE_TASK_SCHEMA_SQL};
      ${CREATE_PC_WORKERS_SQL};
      ${CREATE_PC_WORKER_ENROLLMENTS_SQL};
      ${CREATE_PC_WORKER_CREDENTIALS_SQL};
    `)
    const storageService = new StorageService({ rootPath: path.join(directory, 'storage') })
    const content = Buffer.from('stage 5 real e2e\n', 'utf8')
    const staged = await storageService.stageFromStream(Readable.from(content))
    const committed = await storageService.commitStaged({
      token: staged.token,
      kind: 'documents',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes
    })
    const resourceId = Number(database.prepare(`INSERT INTO resources (resource_type, title) VALUES ('document', 'E2E Fixture')`).run().lastInsertRowid)
    const contentObjectId = Number(database.prepare(`
      INSERT INTO content_objects (sha256, bytes, managed_storage_key) VALUES (?, ?, ?)
    `).run(committed.sha256, committed.bytes, committed.storageKey).lastInsertRowid)
    const resourceVersionId = Number(database.prepare(`
      INSERT INTO resource_versions (resource_id, content_object_id, version_number) VALUES (?, ?, 1)
    `).run(resourceId, contentObjectId).lastInsertRowid)
    const store = createTaskStore({ database })
    const runtime = () => ({ getStore: () => store })
    const app = express()
    app.use(express.json())
    app.use('/api/pc-workers', ownerBoundary, createPcWorkerOwnerRouter({ database: () => database, runtime }))
    app.use('/api/pc-worker-agent', createPcWorkerAgentRouter({
      database: () => database,
      runtime,
      storageRuntime: () => ({ storageService })
    }))

    await withServer(app, async (baseUrl) => {
      const targets = await fetch(`${baseUrl}/api/pc-workers/content-inspection-targets`, {
        headers: { 'x-test-role': 'owner' }
      })
      assert.equal(targets.status, 200)
      const targetsBody = await targets.json()
      assert.equal(targetsBody.data[0].resourceVersionId, resourceVersionId)
      assert.doesNotMatch(JSON.stringify(targetsBody), /managed_storage_key|storage\/objects|pc-worker-e2e/u)

      const enrollmentResponse = await fetch(`${baseUrl}/api/pc-workers/enrollments`, {
        method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: '{}'
      })
      assert.equal(enrollmentResponse.status, 201)
      const enrollment = (await enrollmentResponse.json()).data
      const api = new WorkerApiClient({ baseUrl })
      const credentials = await api.enroll(enrollment.token, profile())

      const enqueue = await fetch(`${baseUrl}/api/pc-workers/content-inspection-tasks`, {
        method: 'POST',
        headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
        body: JSON.stringify({ resourceVersionId })
      })
      assert.equal(enqueue.status, 202)
      const task = await api.claim(credentials.accessToken)
      assert.equal(task.input.sha256, committed.sha256)
      await api.start(credentials.accessToken, task)
      const input = await api.input(credentials.accessToken, task)
      const result = await inspectContent(input.body, {
        sha256: task.input.sha256,
        bytes: Number(input.headers.get('content-length'))
      })
      await api.complete(credentials.accessToken, task, result)
      assert.equal(store.getById(task.id).status, 'succeeded')
      assert.equal(store.getById(task.id).result.output.sha256, committed.sha256)

      const revoke = await fetch(`${baseUrl}/api/pc-workers/${credentials.worker.id}/revoke`, {
        method: 'POST', headers: { 'x-test-role': 'owner' }
      })
      assert.equal(revoke.status, 200)
      await assert.rejects(
        api.claim(credentials.accessToken),
        (error) => error instanceof WorkerApiError && error.status === 401 && error.code === 'PC_WORKER_AUTH_INVALID'
      )
    })
  } finally {
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
