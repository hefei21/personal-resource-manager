import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import express from 'express'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { RAG_INDEX_MIGRATIONS } from '../src/config/ragIndexSchema.js'
import { RAG_EMBEDDING_MIGRATIONS } from '../src/config/ragEmbeddingSchema.js'
import { computeRagVectorConfigHash } from '../src/config/ragVector.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'rag-embedding-runtime-test-data')

const { createPcWorkerAgentRouter } = await import('../src/routes/pcWorkers.js')
const {
  createRagEmbeddingRuntime,
  reconcileRagEmbeddingRuntime,
  startRagEmbeddingReconcileLoop
} = await import('../src/services/ragEmbeddingRuntime.js')
const { ensureRagActiveEmbeddingModel } = await import('../src/services/ragQueryRuntime.js')
const { createRagIndexTaskProcessor } = await import('../src/services/ragIndexTaskProcessor.js')

const MODEL_HASH = 'a'.repeat(64)
const SOURCE_HASH = 'b'.repeat(64)
const CHUNK_HASH = 'c'.repeat(64)

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
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
const migrationRegistry = createMigrationRegistry([...RAG_INDEX_MIGRATIONS, ...RAG_EMBEDDING_MIGRATIONS])

function migrate(database) {
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry: migrationRegistry,
    plan: createMigrationPlan(migrationRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function activeModelRow(overrides = {}) {
  return {
    embedding_model_id: 9,
    provider: 'lmstudio',
    model_id: 'nomic-embed-text-v1.5-GGUF',
    model_revision: 'q4_k_m',
    dimensions: 768,
    distance: 'cosine',
    normalization: 'l2',
    input_limit: 8192,
    config_hash: MODEL_HASH,
    status: 'active',
    ...overrides
  }
}

function runtimeDatabase(row = activeModelRow()) {
  const tables = new Set([
    'rag_embedding_models', 'rag_source_snapshots', 'rag_source_state', 'rag_chunks',
    'rag_chunk_embeddings', 'rag_snapshot_embedding_state'
  ])
  return {
    prepare(sql) {
      if (sql.includes('sqlite_master')) return { get: (name) => tables.has(name) ? { name } : null }
      if (sql.includes('FROM rag_embedding_models')) return { get: () => row }
      return { get: () => null, all: () => [] }
    }
  }
}

function vectorConfig(overrides = {}) {
  return {
    enabled: true,
    baseUrl: 'http://127.0.0.1:6333',
    collection: 'rag_test',
    timeoutMs: 100,
    modelConfig: {
      provider: 'lmstudio',
      modelId: 'nomic-embed-text-v1.5-GGUF',
      modelRevision: 'q4_k_m',
      dimensions: 768,
      distance: 'cosine',
      normalization: 'l2',
      inputLimit: 8192,
      configHash: MODEL_HASH
    },
    ...overrides
  }
}

test('embedding runtime stays disabled until the fixed vector contract and active identity agree', () => {
  const database = runtimeDatabase()
  assert.equal(createRagEmbeddingRuntime({ database, vectorConfig: { enabled: false } }), null)
  assert.equal(createRagEmbeddingRuntime({
    database,
    vectorConfig: vectorConfig({ modelConfig: { ...vectorConfig().modelConfig, modelId: 'other-model' } })
  }), null)

  let received
  const runtime = createRagEmbeddingRuntime({
    database,
    vectorConfig: vectorConfig(),
    vectorStore: { modelConfig: vectorConfig().modelConfig },
    coordinatorFactory(options) {
      received = options
      return {
        enqueueBatch: async () => ({ status: 'offline' }),
        applyWorkerResult: async () => ({ applied: true }),
        reconcile: async () => ({ recovered: 0, stale: 0, missing: 0, enqueued: [] })
      }
    }
  })
  assert.equal(runtime.embeddingModelId, 9)
  assert.equal(received.workerAvailable({ taskType: 'rag.embedding.generate' }).available, false)
})

test('text refresh enqueues active-model embedding work without making FTS fail offline', async () => {
  const calls = []
  const taskStore = {}
  const result = {
    status: 'partial',
    sources: [
      { sourceType: 'document', sourceId: 1, snapshotId: 11, status: 'text_ready' },
      { sourceType: 'ebook', sourceId: 2, snapshotId: 12, status: 'partial' },
      { sourceType: 'document', sourceId: 3, snapshotId: 13, status: 'failed' }
    ]
  }
  const processor = createRagIndexTaskProcessor({
    database: {},
    serviceFactory: () => ({ refresh: async () => result }),
    taskStoreProvider: () => taskStore,
    embeddingRuntimeFactory: () => ({
      embeddingModelId: 9,
      enqueueBatch: async (options) => {
        calls.push(options)
        return { status: 'offline', task: null }
      }
    })
  })
  const output = await processor({
    task: {
      taskType: 'rag.index.refresh',
      input: { source: { type: 'all' }, rebuild: false }
    }
  })
  assert.deepEqual(output, result)
  assert.deepEqual(calls, [
    { snapshotId: 11, embeddingModelId: 9, retryFailed: true },
    { snapshotId: 12, embeddingModelId: 9, retryFailed: true }
  ])
})

function workerTask(worker) {
  const model = {
    provider: 'lmstudio', modelId: 'nomic-embed-text-v1.5-GGUF', modelRevision: 'q4_k_m',
    dimensions: 32, inputLimit: 2048, distance: 'cosine', normalization: 'l2', configHash: MODEL_HASH
  }
  const input = {
    schemaVersion: 1, snapshotId: 17, sourceType: 'document', sourceId: 7,
    sourceVersionId: '11', sourceContentSha256: SOURCE_HASH, contentBytes: 4,
    model, chunks: [{ chunkId: 101, ordinal: 0, chunkSha256: CHUNK_HASH, body: '证据正文' }]
  }
  return {
    id: 42, taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu',
    subjectId: '17:9', subjectContentSha256: SOURCE_HASH, input, status: 'running',
    leaseOwner: `pcw:${worker.id}`, leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z', attemptCount: 1
  }
}

function workerResult(task) {
  const embedding = Array.from({ length: 32 }, (_, index) => index / 100)
  return {
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model: task.input.model,
      snapshotId: task.input.snapshotId,
      sourceVersionId: task.input.sourceVersionId,
      sourceContentSha256: task.input.sourceContentSha256,
      vectors: [{ chunkId: 101, chunkSha256: CHUNK_HASH, embedding }],
      vectorSha256: crypto.createHash('sha256').update(JSON.stringify([embedding])).digest('hex')
    }
  }
}

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  try { await callback(`http://127.0.0.1:${server.address().port}`) } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('Worker completion applies the embedding coordinator before task success and fails closed on write/stale results', async () => {
  const worker = { id: 'worker-1' }
  const task = workerTask(worker)
  const database = {
    prepare(sql) {
      if (sql.includes('rag_source_snapshots')) return {
        get: () => ({ id: 17, source_type: 'document', source_id: 7, source_version_id: '11', source_content_sha256: SOURCE_HASH })
      }
      return { get: () => null }
    }
  }
  const events = []
  const store = {
    getById: () => task,
    succeed() {
      events.push('succeed')
      task.status = 'succeeded'
      return { id: task.id, status: task.status, progress: 100 }
    }
  }
  let mode = 'success'
  const app = express()
  app.use(express.json())
  app.use('/agent', createPcWorkerAgentRouter({
    database: () => database,
    runtime: () => ({ getStore: () => store }),
    authenticate: () => worker,
    embeddingRuntimeFactory: () => ({
      applyWorkerResult: async () => {
        events.push('apply')
        if (mode === 'failure') throw Object.assign(new Error('qdrant down'), { code: 'RAG_VECTOR_UNAVAILABLE' })
        return mode === 'stale' ? { applied: false, status: 'stale' } : { applied: true, status: 'active' }
      }
    })
  }))
  const result = workerResult(task)
  await withServer(app, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/agent/tasks/42/complete`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: task.leaseToken, result })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(events, ['apply', 'succeed'])

    task.status = 'running'
    mode = 'failure'
    response = await fetch(`${baseUrl}/agent/tasks/42/complete`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: task.leaseToken, result })
    })
    assert.equal(response.status, 503)
    assert.deepEqual(events, ['apply', 'succeed', 'apply'])

    task.status = 'running'
    mode = 'stale'
    response = await fetch(`${baseUrl}/agent/tasks/42/complete`, {
      method: 'POST', headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: task.leaseToken, result })
    })
    assert.equal(response.status, 409)
    assert.deepEqual(events, ['apply', 'succeed', 'apply', 'apply'])
  })
})

test('startup reconcile delegates pending recovery and bounded resume to the same runtime', async () => {
  const calls = []
  const report = await reconcileRagEmbeddingRuntime({
    database: {},
    taskStore: {},
    runtimeFactory: () => ({
      reconcile: async (options) => {
        calls.push(options)
        return { recovered: 2, stale: 1, missing: 1, enqueued: [{ id: 3 }] }
      }
    })
  })
  assert.deepEqual(calls, [{ enqueue: true, maxBatches: 1 }])
  assert.deepEqual(report, { recovered: 2, stale: 1, missing: 1, enqueued: [{ id: 3 }] })
  assert.deepEqual(await reconcileRagEmbeddingRuntime({ database: {}, taskStore: {}, runtimeFactory: () => null }), { status: 'disabled' })
})

test('embedding runtime ensures Qdrant before reconcile and retries a failed ensure', async () => {
  let ensureCalls = 0
  const database = runtimeDatabase()
  const vectorStore = {
    modelConfig: vectorConfig().modelConfig,
    async ensureCollection() {
      ensureCalls += 1
      if (ensureCalls === 1) throw Object.assign(new Error('schema mismatch'), { code: 'RAG_VECTOR_SCHEMA_MISMATCH' })
      return { created: false }
    }
  }
  const events = []
  const runtime = createRagEmbeddingRuntime({
    database,
    vectorConfig: vectorConfig(),
    vectorStore,
    workerAvailable: () => false,
    coordinatorFactory: () => ({
      reconcile: async () => { events.push('reconcile'); return { recovered: 0, stale: 0, missing: 0, enqueued: [] } },
      enqueueBatch: async () => ({ status: 'offline' }),
      applyWorkerResult: async () => ({ applied: true })
    })
  })
  await assert.rejects(runtime.reconcile(), (error) => error.code === 'RAG_VECTOR_SCHEMA_MISMATCH')
  assert.deepEqual(events, [])
  await runtime.reconcile()
  assert.equal(ensureCalls, 2)
  assert.deepEqual(events, ['reconcile'])
})

test('embedding reconcile loop is unref-able, closable, bounded and error-isolated', async () => {
  let calls = 0
  const loop = startRagEmbeddingReconcileLoop({
    database: {},
    enabled: true,
    intervalMs: 60_000,
    runtimeFactory: () => ({
      reconcile: async () => {
        calls += 1
        throw Object.assign(new Error('qdrant down'), { code: 'RAG_VECTOR_UNAVAILABLE' })
      }
    }),
    logger: { warn() {} }
  })
  assert.equal(loop.active, true)
  const result = await loop.runNow()
  assert.deepEqual(result, { status: 'degraded', errorCode: 'RAG_VECTOR_UNAVAILABLE' })
  assert.equal(calls, 1)
  loop.stop()
  assert.deepEqual(await loop.runNow(), { status: 'stopped' })
})

test('enabled hash-bound config transactionally activates one model and backfills active snapshots', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const sourceHash = 'b'.repeat(64)
    const chunkerHash = 'c'.repeat(64)
    const snapshotId = Number(database.prepare(`
      INSERT INTO rag_source_snapshots (
        source_type, source_id, source_version_id, source_content_sha256,
        extractor_version, chunker_version, chunker_config_hash, status, chunk_count
      ) VALUES ('document', 1, 'v1', ?, 'extractor-v1', 'chunker-v1', ?, 'text_ready', 0)
    `).run(sourceHash, chunkerHash).lastInsertRowid)
    database.prepare(`
      INSERT INTO rag_source_state (
        source_type, source_id, active_snapshot_id, last_attempt_snapshot_id, status
      ) VALUES ('document', 1, ?, ?, 'active')
    `).run(snapshotId, snapshotId)
    const modelConfig = {
      provider: 'lmstudio', modelId: 'nomic-embed-text-v1.5-GGUF', modelRevision: 'gguf-r1',
      dimensions: 768, inputLimit: 8192, distance: 'cosine', normalization: 'l2'
    }
    const config = vectorConfig({
      modelConfig: { ...modelConfig, configHash: computeRagVectorConfigHash(modelConfig) }
    })
    const active = ensureRagActiveEmbeddingModel(database, config)
    assert.equal(active.model.modelId, modelConfig.modelId)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_embedding_models WHERE status = \'active\'').get().count, 1)
    assert.deepEqual(database.prepare(`
      SELECT status FROM rag_snapshot_embedding_state WHERE snapshot_id = ? AND embedding_model_id = ?
    `).get(snapshotId, active.embeddingModelId), { status: 'pending' })

    const repeated = ensureRagActiveEmbeddingModel(database, config)
    assert.equal(repeated.embeddingModelId, active.embeddingModelId)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_embedding_models').get().count, 1)

    database.prepare(`
      INSERT INTO rag_embedding_models (
        provider, model_id, model_revision, dimensions, distance,
        normalization, input_limit, config_hash, status
      ) VALUES ('lmstudio', 'other-model', 'r1', 768, 'cosine', 'l2', 8192, ?, 'active')
    `).run('d'.repeat(64))
    assert.equal(ensureRagActiveEmbeddingModel(database, config), null)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM rag_embedding_models WHERE status = 'active'").get().count, 2)
  } finally {
    database.close()
  }
})
