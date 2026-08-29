import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { RAG_INDEX_MIGRATIONS } from '../src/config/ragIndexSchema.js'
import { RAG_EMBEDDING_MIGRATIONS } from '../src/config/ragEmbeddingSchema.js'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { lookupPcWorkerProcessor } from '../src/services/pcWorkerProcessorCatalog.js'
import {
  RAG_EMBEDDING_COORDINATOR_ERROR_CODES,
  createRagEmbeddingCoordinator
} from '../src/services/ragEmbeddingCoordinator.js'
import { TaskStore } from '../src/services/taskStore.js'

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

const registry = createMigrationRegistry([...RAG_INDEX_MIGRATIONS, ...RAG_EMBEDDING_MIGRATIONS])
const SOURCE_HASH = 'a'.repeat(64)
const MODEL_HASH = 'd'.repeat(64)

function migrate(database) {
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function createFixture({ chunkCount = 2, chunkBodyBytes = null } = {}) {
  const database = new Database(':memory:')
  migrate(database)
  const snapshotId = Number(database.prepare(`
    INSERT INTO rag_source_snapshots (
      source_type, source_id, source_version_id, source_content_sha256,
      extractor_version, chunker_version, chunker_config_hash, status, chunk_count
    ) VALUES ('document', 41, 'v1', ?, 'extractor-v1', 'chunker-v1', ?, 'text_ready', ?)
  `).run(SOURCE_HASH, 'b'.repeat(64), chunkCount).lastInsertRowid)
  database.prepare(`
    INSERT INTO rag_source_state (
      source_type, source_id, active_snapshot_id, last_attempt_snapshot_id, status
    ) VALUES ('document', 41, ?, ?, 'active')
  `).run(snapshotId, snapshotId)
  const chunks = []
  for (let index = 0; index < chunkCount; index += 1) {
    const prefix = `chunk-${index}:`
    const body = chunkBodyBytes === null
      ? `body for chunk ${index}`
      : `${prefix}${'x'.repeat(Math.max(1, chunkBodyBytes - Buffer.byteLength(prefix, 'utf8')))}`
    const chunkSha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
    const chunkId = Number(database.prepare(`
      INSERT INTO rag_chunks (
        snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
        title, section_path_json, locator_json
      ) VALUES (?, ?, ?, ?, NULL, 'deferred', ?, '[]', ?)
    `).run(snapshotId, index, chunkSha256, body, `Chunk ${index}`, JSON.stringify({ paragraph: index })).lastInsertRowid)
    chunks.push({ id: chunkId, chunkSha256 })
  }
  const embeddingModelId = Number(database.prepare(`
    INSERT INTO rag_embedding_models (
      provider, model_id, model_revision, dimensions, distance,
      normalization, input_limit, config_hash, status
    ) VALUES ('lmstudio', 'test-embed', 'revision-1', 32, 'cosine', 'l2', 2048, ?, 'active')
  `).run(MODEL_HASH).lastInsertRowid)
  return { database, snapshotId, embeddingModelId, chunks }
}

function taskStoreFake() {
  const tasks = []
  return {
    tasks,
    list({ status, taskType, subjectType, subjectId, limit = 50 } = {}) {
      const statuses = Array.isArray(status) ? status : status ? [status] : null
      return tasks.filter((task) => (!statuses || statuses.includes(task.status)) &&
        (!taskType || task.taskType === taskType) && (!subjectType || task.subjectType === subjectType) &&
        (!subjectId || task.subjectId === subjectId)).slice(0, limit)
    },
    enqueueExclusiveRun(request) {
      const existing = this.list({ status: ['pending', 'leased', 'running'], taskType: request.taskType, subjectType: request.subjectType, subjectId: request.subjectId })[0]
      if (existing) return { task: existing, created: false, activeConflict: true, outcome: 'active-conflict' }
      const task = { id: tasks.length + 1, ...request, status: 'pending' }
      tasks.push(task)
      return { task, created: true, activeConflict: false, outcome: 'created' }
    }
  }
}

function vectorStoreFake({ failAfterWrite = false, afterWrite = null } = {}) {
  const points = new Map()
  const calls = []
  let failNext = failAfterWrite
  return {
    calls,
    modelConfig: {
      provider: 'lmstudio', modelId: 'test-embed', modelRevision: 'revision-1',
      dimensions: 32, inputLimit: 2048, distance: 'cosine', normalization: 'l2', configHash: MODEL_HASH
    },
    async upsertBatch(batch) {
      calls.push(batch)
      for (const point of batch) points.set(`${point.snapshotId}:${point.chunkId}`, {
        id: point.chunkId,
        chunkId: point.chunkId,
        snapshotId: point.snapshotId,
        vectorSha256: point.vectorSha256,
        payload: { chunkId: point.chunkId, vectorSha256: point.vectorSha256 }
      })
      if (typeof afterWrite === 'function') afterWrite()
      if (failNext) {
        failNext = false
        throw new Error('simulated qdrant acknowledgement timeout')
      }
      return { upserted: batch.length }
    },
    async listBySnapshot(snapshotId) {
      return { points: [...points.values()].filter((point) => point.snapshotId === snapshotId), nextPageOffset: null }
    },
    async deleteBySnapshot(snapshotId) {
      for (const key of points.keys()) if (key.startsWith(`${snapshotId}:`)) points.delete(key)
      return { deleted: true }
    },
    dropSnapshot(snapshotId) {
      for (const key of points.keys()) if (key.startsWith(`${snapshotId}:`)) points.delete(key)
    }
  }
}

function vector(first) {
  return Array.from({ length: 32 }, (_, index) => first + index)
}

function workerResult(task, chunks) {
  const vectors = chunks.map((chunk, index) => ({
    chunkId: chunk.chunkId,
    chunkSha256: chunk.chunkSha256,
    embedding: vector(index + 1)
  }))
  return {
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model: task.input.model,
      snapshotId: task.input.snapshotId,
      sourceVersionId: task.input.sourceVersionId,
      sourceContentSha256: task.input.sourceContentSha256,
      vectors,
      vectorSha256: crypto.createHash('sha256')
        .update(JSON.stringify(vectors.map(({ embedding }) => embedding)))
        .digest('hex')
    }
  }
}

function createCoordinator(fixture, overrides = {}) {
  return createRagEmbeddingCoordinator({
    database: fixture.database,
    taskStore: fixture.taskStore ?? taskStoreFake(),
    vectorStore: fixture.vectorStore ?? vectorStoreFake(),
    processorCatalog: lookupPcWorkerProcessor,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
    ...overrides
  })
}

test('prepares, enqueues and finalizes only after Qdrant upsert, with retry idempotency', nativeTestOptions, async () => {
  const fixture = createFixture()
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    assert.equal(queued.status, 'enqueued')
    assert.equal(fixture.taskStore.tasks.length, 1)
    const task = fixture.taskStore.tasks[0]
    const result = await coordinator.applyWorkerResult(task, workerResult(task, task.input.chunks))
    assert.equal(result.status, 'active')
    assert.equal(fixture.database.prepare('SELECT status FROM rag_snapshot_embedding_state').get().status, 'active')
    assert.equal(fixture.database.prepare('SELECT status FROM rag_source_snapshots WHERE id = ?').get(fixture.snapshotId).status, 'ready')
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM rag_chunk_embeddings WHERE status = \'ready\'').get().count, 2)
    const repeated = await coordinator.applyWorkerResult(task, workerResult(task, task.input.chunks))
    assert.equal(repeated.status, 'active')
    assert.equal(fixture.vectorStore.calls.length, 2)
  } finally {
    fixture.database.close()
  }
})

test('enqueues an embedding batch through the real SQLite TaskStore contract', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  try {
    fixture.database.exec(CREATE_TASK_SCHEMA_SQL)
    fixture.taskStore = new TaskStore({
      database: fixture.database,
      now: () => '2026-08-25T00:00:00.000Z'
    })
    const coordinator = createCoordinator(fixture, { workerAvailable: () => true })

    const result = await coordinator.enqueueBatch({
      snapshotId: fixture.snapshotId,
      embeddingModelId: fixture.embeddingModelId,
      retryFailed: true
    })

    assert.equal(result.status, 'enqueued')
    assert.equal(result.created, true)
    assert.equal(result.task.taskType, 'rag.embedding.generate')
    assert.equal(result.task.subjectType, 'rag.embedding.snapshot-model')
    assert.equal(result.task.subjectId, `${fixture.snapshotId}:${fixture.embeddingModelId}`)
    assert.equal(fixture.taskStore.list({ taskType: 'rag.embedding.generate' }).length, 1)
  } finally {
    fixture.database.close()
  }
})

test('splits a large source into Worker-safe serialized embedding batches before enqueue', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 24, chunkBodyBytes: 64 * 1024 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({
      snapshotId: fixture.snapshotId,
      embeddingModelId: fixture.embeddingModelId
    })
    assert.equal(queued.status, 'enqueued')
    assert.equal(queued.task.input.chunks.length > 0, true)
    assert.equal(queued.task.input.chunks.length < 24, true)
    assert.equal(Buffer.byteLength(JSON.stringify(queued.task.input), 'utf8') <= 1024 * 1024, true)
  } finally {
    fixture.database.close()
  }
})

test('keeps SQLite pending when Qdrant acknowledges then reports a retryable failure', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake({ failAfterWrite: true })
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    await assert.rejects(
      coordinator.applyWorkerResult(queued.task, workerResult(queued.task, queued.task.input.chunks)),
      /simulated qdrant acknowledgement timeout/u
    )
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM rag_chunk_embeddings').get().count, 0)
    const retried = await coordinator.applyWorkerResult(queued.task, workerResult(queued.task, queued.task.input.chunks))
    assert.equal(retried.status, 'active')
    assert.equal(fixture.database.prepare("SELECT status FROM rag_chunk_embeddings").get().status, 'ready')
  } finally {
    fixture.database.close()
  }
})

test('rejects a result after active snapshot changes without writing the stale vector', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    fixture.database.prepare('UPDATE rag_source_state SET active_snapshot_id = NULL WHERE source_id = 41').run()
    const result = await coordinator.applyWorkerResult(queued.task, workerResult(queued.task, queued.task.input.chunks))
    assert.equal(result.status, 'stale')
    assert.equal(fixture.vectorStore.calls.length, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM rag_chunk_embeddings').get().count, 0)
  } finally {
    fixture.database.close()
  }
})

test('rejects a result that becomes stale after Qdrant acknowledgement and before SQLite finalize', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake({
    afterWrite: () => fixture.database.prepare('UPDATE rag_source_state SET active_snapshot_id = NULL WHERE source_id = 41').run()
  })
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    const result = await coordinator.applyWorkerResult(queued.task, workerResult(queued.task, queued.task.input.chunks))
    assert.equal(result.status, 'stale')
    assert.equal(result.externalUpserted, true)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM rag_chunk_embeddings').get().count, 0)
  } finally {
    fixture.database.close()
  }
})

test('reconcile resets interrupted work and returns missing ready points to pending', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    await coordinator.applyWorkerResult(queued.task, workerResult(queued.task, queued.task.input.chunks))
    fixture.vectorStore.dropSnapshot(fixture.snapshotId)
    const recovered = await coordinator.reconcile()
    assert.equal(recovered.missing, 1)
    assert.equal(fixture.database.prepare('SELECT status FROM rag_chunk_embeddings').get().status, 'pending')
    assert.equal(fixture.database.prepare('SELECT status FROM rag_snapshot_embedding_state').get().status, 'pending')
  } finally {
    fixture.database.close()
  }
})

test('offline worker does not enqueue a chunk-level task', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 2 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture, { workerAvailable: () => false })
    const result = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    assert.equal(result.status, 'offline')
    assert.equal(fixture.taskStore.tasks.length, 0)
    assert.equal(fixture.database.prepare('SELECT status FROM rag_snapshot_embedding_state').get().status, 'pending')
    assert.equal(fixture.database.prepare('SELECT status FROM rag_source_snapshots').get().status, 'embedding_pending')
  } finally {
    fixture.database.close()
  }
})

test('rolls an SQLite claim back to pending when task enqueue fails', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = {
    enqueueExclusiveRun() {
      throw new Error('simulated task-store failure')
    }
  }
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    await assert.rejects(
      coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId }),
      /simulated task-store failure/u
    )
    assert.equal(fixture.database.prepare('SELECT status FROM rag_snapshot_embedding_state').get().status, 'pending')
    assert.equal(fixture.database.prepare('SELECT status FROM rag_source_snapshots').get().status, 'embedding_pending')
  } finally {
    fixture.database.close()
  }
})

test('fails closed when the processor result model or chunk identity is stale', nativeTestOptions, async () => {
  const fixture = createFixture({ chunkCount: 1 })
  fixture.taskStore = taskStoreFake()
  fixture.vectorStore = vectorStoreFake()
  try {
    const coordinator = createCoordinator(fixture)
    const queued = await coordinator.enqueueBatch({ snapshotId: fixture.snapshotId, embeddingModelId: fixture.embeddingModelId })
    const invalid = workerResult(queued.task, queued.task.input.chunks)
    invalid.output.model = { ...invalid.output.model, configHash: 'e'.repeat(64) }
    await assert.rejects(
      coordinator.applyWorkerResult(queued.task, invalid),
      (error) => error.code === 'PC_WORKER_PROCESSOR_RESULT_MODEL_MISMATCH'
    )
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM rag_chunk_embeddings').get().count, 0)
    assert.equal(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.STALE, 'RAG_EMBEDDING_STALE')
  } finally {
    fixture.database.close()
  }
})
