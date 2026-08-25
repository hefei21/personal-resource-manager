import crypto from 'node:crypto'

import {
  RAG_CHUNK_TABLE,
  RAG_SOURCE_SNAPSHOT_TABLE,
  RAG_SOURCE_STATE_TABLE
} from '../config/ragIndexSchema.js'
import {
  RAG_CHUNK_EMBEDDING_TABLE,
  RAG_EMBEDDING_MODEL_TABLE,
  RAG_SNAPSHOT_EMBEDDING_STATE_TABLE
} from '../config/ragEmbeddingSchema.js'
import { lookupPcWorkerProcessor } from './pcWorkerProcessorCatalog.js'
import { ragVectorSha256 } from './ragVectorStore.js'
import { deriveTaskIdempotencyKey } from './taskStore.js'

export const RAG_EMBEDDING_COORDINATOR_VERSION = 'rag-embedding-coordinator.v1'
export const RAG_EMBEDDING_TASK_TYPE = 'rag.embedding.generate'
export const RAG_EMBEDDING_PROCESSOR_VERSION = 'v1'
export const RAG_EMBEDDING_MAX_BATCH_ITEMS = 256
export const RAG_EMBEDDING_DOCUMENT_PREFIX = 'search_document: '

export const RAG_EMBEDDING_COORDINATOR_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_EMBEDDING_INPUT_INVALID',
  DATABASE_INVALID: 'RAG_EMBEDDING_DATABASE_INVALID',
  SNAPSHOT_NOT_FOUND: 'RAG_EMBEDDING_SNAPSHOT_NOT_FOUND',
  SNAPSHOT_NOT_ACTIVE: 'RAG_EMBEDDING_SNAPSHOT_NOT_ACTIVE',
  SNAPSHOT_NOT_READY: 'RAG_EMBEDDING_SNAPSHOT_NOT_READY',
  MODEL_NOT_FOUND: 'RAG_EMBEDDING_MODEL_NOT_FOUND',
  MODEL_NOT_ACTIVE: 'RAG_EMBEDDING_MODEL_NOT_ACTIVE',
  MODEL_MISMATCH: 'RAG_EMBEDDING_MODEL_MISMATCH',
  PROCESSOR_INVALID: 'RAG_EMBEDDING_PROCESSOR_INVALID',
  TASK_INVALID: 'RAG_EMBEDDING_TASK_INVALID',
  RESULT_INVALID: 'RAG_EMBEDDING_RESULT_INVALID',
  STALE: 'RAG_EMBEDDING_STALE',
  VECTOR_STORE_UNAVAILABLE: 'RAG_EMBEDDING_VECTOR_STORE_UNAVAILABLE',
  TASK_STORE_UNAVAILABLE: 'RAG_EMBEDDING_TASK_STORE_UNAVAILABLE',
  WORKER_UNAVAILABLE: 'RAG_EMBEDDING_WORKER_UNAVAILABLE',
  WRITE_FAILED: 'RAG_EMBEDDING_WRITE_FAILED'
})

const SNAPSHOT_COMPLETE_STATUSES = new Set(['text_ready', 'embedding_pending', 'ready', 'partial'])
// Runtime assembly is driven only by the one explicitly active model.  A
// candidate model may be evaluated separately, but must never finalize a
// Worker task into the production vector index.
const MODEL_USABLE_STATUSES = new Set(['active'])
const TASK_ACTIVE_STATUSES = ['pending', 'leased', 'running']
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const SOURCE_VERSION_MAX_LENGTH = 256

export class RagEmbeddingCoordinatorError extends Error {
  constructor(code, message = code, details = {}) {
    super(message)
    this.name = 'RagEmbeddingCoordinatorError'
    this.code = code
    Object.assign(this, details)
  }
}

function fail(code, message = code, details = {}) {
  throw new RagEmbeddingCoordinatorError(code, message, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function positiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  return value
}

function boundedInteger(value, fieldName, min, max, fallback) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function requiredHash(value, fieldName) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return value
}

function requiredText(value, fieldName, maxLength = SOURCE_VERSION_MAX_LENGTH) {
  if (typeof value !== 'string') fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalHash(value) {
  return sha256(JSON.stringify(value))
}

function asTimestamp(now) {
  const value = typeof now === 'function' ? now() : now
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, 'now is invalid.')
  return date.toISOString()
}

function readTaskInput(task) {
  if (!isPlainObject(task) || !isPlainObject(task.input)) {
    fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.TASK_INVALID, 'task.input is required.')
  }
  return task.input
}

function modelIdentityFromRow(row) {
  return Object.freeze({
    provider: row.provider,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    dimensions: row.dimensions,
    inputLimit: row.input_limit,
    distance: row.distance,
    normalization: row.normalization,
    configHash: row.config_hash
  })
}

function sameModel(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false
  return left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.modelRevision === right.modelRevision &&
    left.dimensions === right.dimensions &&
    left.inputLimit === right.inputLimit &&
    left.distance === right.distance &&
    left.normalization === right.normalization &&
    left.configHash === right.configHash
}

// The PC Worker embedding contract intentionally carries only the model identity
// it can verify locally. Distance/normalization belong to the NAS/Qdrant model
// contract and are resolved again from SQLite before vector persistence.
function workerModelIdentity(model) {
  return Object.freeze({
    provider: model.provider,
    modelId: model.modelId,
    modelRevision: model.modelRevision,
    dimensions: model.dimensions,
    inputLimit: model.inputLimit,
    configHash: model.configHash
  })
}

function taskModelMatchesRow(taskModel, rowModel) {
  if (!isPlainObject(taskModel) || !isPlainObject(rowModel)) return false
  const coreFields = ['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'configHash']
  if (!coreFields.every((field) => taskModel[field] === rowModel[field])) return false
  if (Object.hasOwn(taskModel, 'distance') && taskModel.distance !== rowModel.distance) return false
  if (Object.hasOwn(taskModel, 'normalization') && taskModel.normalization !== rowModel.normalization) return false
  return true
}

function sourceIdentity(row) {
  return Object.freeze({
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    sourceContentSha256: row.source_content_sha256
  })
}

function taskSubjectId(snapshotId, embeddingModelId) {
  return `${snapshotId}:${embeddingModelId}`
}

function parseInventoryPoint(value) {
  if (!isPlainObject(value)) return null
  const payload = isPlainObject(value.payload) ? value.payload : value
  const chunkId = value.chunkId ?? value.id ?? payload.chunkId
  const vectorSha256 = value.vectorSha256 ?? payload.vectorSha256
  if (!Number.isSafeInteger(chunkId) || chunkId <= 0 || typeof vectorSha256 !== 'string' || !HASH_PATTERN.test(vectorSha256)) return null
  return { chunkId, vectorSha256 }
}

function normalizeWorkerAvailability(value) {
  if (value === true || value === undefined) return { available: true, reason: null }
  if (value === false || value === null) return { available: false, reason: 'RAG_WORKER_UNAVAILABLE' }
  if (isPlainObject(value)) return { available: value.available === true, reason: value.reason ?? 'RAG_WORKER_UNAVAILABLE' }
  return { available: Boolean(value), reason: Boolean(value) ? null : 'RAG_WORKER_UNAVAILABLE' }
}

export class RagEmbeddingCoordinator {
  constructor({
    database,
    taskStore = null,
    vectorStore = null,
    processorCatalog = lookupPcWorkerProcessor,
    workerAvailable = () => true,
    modelConfigResolver = null,
    activeModelIdResolver = null,
    now = () => new Date(),
    maxBatchItems = RAG_EMBEDDING_MAX_BATCH_ITEMS,
    maxAttempts = 3,
    indexPriority = 10
  } = {}) {
    if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.DATABASE_INVALID, 'database is required.')
    }
    if (typeof processorCatalog !== 'function') fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.PROCESSOR_INVALID, 'processorCatalog is invalid.')
    if (typeof workerAvailable !== 'function') fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, 'workerAvailable is invalid.')
    if (modelConfigResolver !== null && typeof modelConfigResolver !== 'function') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, 'modelConfigResolver is invalid.')
    }
    if (activeModelIdResolver !== null && typeof activeModelIdResolver !== 'function') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.INPUT_INVALID, 'activeModelIdResolver is invalid.')
    }
    this.database = database
    this.taskStore = taskStore
    this.vectorStore = vectorStore
    this.processorCatalog = processorCatalog
    this.workerAvailable = workerAvailable
    this.modelConfigResolver = modelConfigResolver
    this.activeModelIdResolver = activeModelIdResolver
    this.now = now
    this.maxBatchItems = boundedInteger(maxBatchItems, 'maxBatchItems', 1, RAG_EMBEDDING_MAX_BATCH_ITEMS, RAG_EMBEDDING_MAX_BATCH_ITEMS)
    this.maxAttempts = boundedInteger(maxAttempts, 'maxAttempts', 1, 10, 3)
    this.indexPriority = boundedInteger(indexPriority, 'indexPriority', 0, 1_000_000, 10)
  }

  #transaction(callback) {
    return this.database.transaction(callback)()
  }

  #processor() {
    const processor = this.processorCatalog(RAG_EMBEDDING_TASK_TYPE, RAG_EMBEDDING_PROCESSOR_VERSION)
    if (!processor || typeof processor.projectInput !== 'function' || typeof processor.normalizeResult !== 'function') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.PROCESSOR_INVALID, 'embedding processor is unavailable.')
    }
    return processor
  }

  #activeModelMatches(row) {
    if (!this.activeModelIdResolver) return true
    try { return this.activeModelIdResolver() === row?.embedding_model_id } catch { return false }
  }

  #readTarget(snapshotId, embeddingModelId) {
    const row = this.database.prepare(`
      SELECT snapshot.id, snapshot.source_type, snapshot.source_id,
             snapshot.source_version_id, snapshot.source_content_sha256,
             snapshot.status AS snapshot_status,
             source_state.active_snapshot_id, source_state.status AS source_state_status,
             model.id AS embedding_model_id, model.provider, model.model_id,
             model.model_revision, model.dimensions, model.distance,
             model.normalization, model.input_limit, model.config_hash,
             model.status AS model_status,
             embedding_state.status AS embedding_state_status,
             embedding_state.vector_count, embedding_state.error_count
        FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
        LEFT JOIN ${RAG_SOURCE_STATE_TABLE} source_state
          ON source_state.source_type = snapshot.source_type
         AND source_state.source_id = snapshot.source_id
        JOIN ${RAG_EMBEDDING_MODEL_TABLE} model
          ON model.id = ?
        LEFT JOIN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} embedding_state
          ON embedding_state.snapshot_id = snapshot.id
         AND embedding_state.embedding_model_id = model.id
       WHERE snapshot.id = ?
    `).get(embeddingModelId, snapshotId)
    if (!row) return null
    row.model = modelIdentityFromRow(row)
    row.source = sourceIdentity(row)
    return row
  }

  #assertTarget(row, { allowStale = false } = {}) {
    if (!row) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.SNAPSHOT_NOT_FOUND, 'snapshot or model was not found.')
    if (!MODEL_USABLE_STATUSES.has(row.model_status)) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.MODEL_NOT_ACTIVE, 'embedding model is not usable.')
    }
    if (!this.#activeModelMatches(row)) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.MODEL_NOT_ACTIVE, 'embedding model is no longer active.')
    }
    if (!SNAPSHOT_COMPLETE_STATUSES.has(row.snapshot_status)) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.SNAPSHOT_NOT_READY, 'snapshot is not text-ready.')
    }
    if (!allowStale && row.active_snapshot_id !== row.id) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.SNAPSHOT_NOT_ACTIVE, 'snapshot is no longer active.')
    }
    return row
  }

  #resolveModelConfig(row) {
    const resolved = this.modelConfigResolver
      ? this.modelConfigResolver(row)
      : this.vectorStore?.modelConfig ?? row.model
    if (!isPlainObject(resolved) || !sameModel(resolved, row.model)) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.MODEL_MISMATCH, 'vector store and SQLite model identities differ.')
    }
    return Object.freeze({ ...resolved })
  }

  #buildInput(row, chunks, model) {
    return {
      schemaVersion: 1,
      snapshotId: row.id,
      ...row.source,
      contentBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.body, 'utf8'), 0),
      model: workerModelIdentity(model),
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        chunkSha256: chunk.chunk_sha256,
        body: `${RAG_EMBEDDING_DOCUMENT_PREFIX}${chunk.body}`
      }))
    }
  }

  #batchHash(input, embeddingModelId) {
    return canonicalHash({
      snapshotId: input.snapshotId,
      embeddingModelId,
      model: input.model,
      chunks: input.chunks.map(({ chunkId, chunkSha256 }) => ({ chunkId, chunkSha256 }))
    })
  }

  #setIndexing(row, now, chunkIds = []) {
    this.#transaction(() => {
      this.database.prepare(`
        INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} (
          snapshot_id, embedding_model_id, status, vector_count, error_count,
          last_error_code, last_started_at, updated_at
        ) VALUES (?, ?, 'indexing', 0, 0, NULL, ?, ?)
        ON CONFLICT(snapshot_id, embedding_model_id) DO UPDATE SET
          status = 'indexing', last_error_code = NULL,
          last_started_at = excluded.last_started_at, updated_at = excluded.updated_at
      `).run(row.id, row.embedding_model_id, now, now)
      this.database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
           SET status = CASE WHEN status IN ('text_ready', 'partial', 'ready', 'embedding_pending')
                             THEN 'embedding_pending' ELSE status END
         WHERE id = ? AND status <> 'stale'
      `).run(row.id)
      if (chunkIds.length > 0) {
        const placeholders = chunkIds.map(() => '?').join(', ')
        this.database.prepare(`
          UPDATE ${RAG_CHUNK_EMBEDDING_TABLE}
             SET status = 'processing'
           WHERE embedding_model_id = ? AND chunk_id IN (${placeholders})
             AND status IN ('pending', 'failed', 'stale')
        `).run(row.embedding_model_id, ...chunkIds)
      }
    })
  }

  #setPending(snapshotId, embeddingModelId, errorCode = null) {
    const now = asTimestamp(this.now)
    this.#transaction(() => {
      this.database.prepare(`
        INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} (
          snapshot_id, embedding_model_id, status, last_error_code, updated_at
        ) VALUES (?, ?, 'pending', ?, ?)
        ON CONFLICT(snapshot_id, embedding_model_id) DO UPDATE SET
          status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending' END,
          last_error_code = excluded.last_error_code, updated_at = excluded.updated_at
      `).run(snapshotId, embeddingModelId, errorCode, now)
      this.database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
           SET status = CASE WHEN status IN ('text_ready', 'embedding_pending', 'partial') THEN 'embedding_pending' ELSE status END
          WHERE id = ? AND status <> 'stale'
      `).run(snapshotId)
      this.database.prepare(`
        UPDATE ${RAG_CHUNK_EMBEDDING_TABLE}
           SET status = 'pending'
         WHERE embedding_model_id = ?
           AND status = 'processing'
           AND chunk_id IN (SELECT id FROM ${RAG_CHUNK_TABLE} WHERE snapshot_id = ?)
      `).run(embeddingModelId, snapshotId)
    })
  }

  #activeTask(snapshotId, embeddingModelId) {
    if (!this.taskStore) return null
    const subjectType = 'rag.embedding.snapshot-model'
    const subjectId = taskSubjectId(snapshotId, embeddingModelId)
    if (typeof this.taskStore.list === 'function') {
      return this.taskStore.list({
        status: TASK_ACTIVE_STATUSES,
        taskType: RAG_EMBEDDING_TASK_TYPE,
        subjectType,
        subjectId,
        limit: 1
      })[0] ?? null
    }
    if (typeof this.taskStore.count === 'function' && this.taskStore.count({
      status: TASK_ACTIVE_STATUSES,
      taskType: RAG_EMBEDDING_TASK_TYPE,
      subjectType,
      subjectId
    }) > 0) return { subjectType, subjectId, taskType: RAG_EMBEDDING_TASK_TYPE }
    return null
  }

  #taskRequest(prepared) {
    const subjectVersionId = sha256(`${prepared.input.sourceVersionId}\u0000${prepared.model.modelRevision}\u0000${prepared.model.configHash}`)
    return {
      taskType: RAG_EMBEDDING_TASK_TYPE,
      processorVersion: RAG_EMBEDDING_PROCESSOR_VERSION,
      subjectType: 'rag.embedding.snapshot-model',
      subjectId: taskSubjectId(prepared.snapshotId, prepared.embeddingModelId),
      subjectVersionId,
      subjectContentSha256: prepared.batchId,
      input: prepared.input,
      executionClass: 'gpu',
      priority: this.indexPriority,
      maxAttempts: this.maxAttempts
    }
  }

  async prepareBatch({ snapshotId, embeddingModelId, batchSize, retryFailed = false } = {}) {
    const normalizedSnapshotId = positiveInteger(snapshotId, 'snapshotId')
    const normalizedModelId = positiveInteger(embeddingModelId, 'embeddingModelId')
    const requestedBatchSize = boundedInteger(batchSize, 'batchSize', 1, this.maxBatchItems, this.maxBatchItems)
    let row = this.#readTarget(normalizedSnapshotId, normalizedModelId)
    this.#assertTarget(row)
    const model = this.#resolveModelConfig(row)
    const processor = this.#processor()
    let chunks = this.database.prepare(`
      SELECT chunks.id, chunks.ordinal, chunks.chunk_sha256, chunks.body,
             embeddings.status AS embedding_status,
             embeddings.chunk_sha256 AS embedding_chunk_sha256
        FROM ${RAG_CHUNK_TABLE} chunks
        LEFT JOIN ${RAG_CHUNK_EMBEDDING_TABLE} embeddings
          ON embeddings.chunk_id = chunks.id
         AND embeddings.embedding_model_id = ?
       WHERE chunks.snapshot_id = ?
         AND (
           embeddings.id IS NULL
           OR embeddings.chunk_sha256 <> chunks.chunk_sha256
           OR embeddings.status IN ('pending', 'stale')
           OR (? = 1 AND embeddings.status = 'failed')
         )
       ORDER BY chunks.ordinal ASC, chunks.id ASC
       LIMIT ?
    `).all(normalizedModelId, normalizedSnapshotId, retryFailed ? 1 : 0, requestedBatchSize)

    if (chunks.length === 0) {
      const completion = this.#completeIfReady(row, model)
      return Object.freeze({ status: completion.active ? 'complete' : 'pending', snapshotId: normalizedSnapshotId, embeddingModelId: normalizedModelId, ...completion })
    }

    let projected
    while (chunks.length > 0) {
      const input = this.#buildInput(row, chunks, model)
      try {
        projected = processor.projectInput(input)
        break
      } catch (error) {
        if (chunks.length === 1 || !String(error?.code ?? '').includes('TOO_LARGE')) throw error
        chunks = chunks.slice(0, Math.max(1, Math.floor(chunks.length / 2)))
      }
    }

    row = this.#readTarget(normalizedSnapshotId, normalizedModelId)
    this.#assertTarget(row)
    this.#setIndexing(row, asTimestamp(this.now), chunks.map((chunk) => chunk.id))
    const batchId = this.#batchHash(projected, normalizedModelId)
    return Object.freeze({
      status: 'prepared',
      snapshotId: normalizedSnapshotId,
      embeddingModelId: normalizedModelId,
      model,
      input: projected,
      chunks: Object.freeze(chunks.map((chunk) => Object.freeze({
        chunkId: chunk.id,
        chunkSha256: chunk.chunk_sha256,
        ordinal: chunk.ordinal
      }))),
      batchId
    })
  }

  async enqueueBatch(options = {}) {
    const snapshotId = positiveInteger(options.snapshotId, 'snapshotId')
    const embeddingModelId = positiveInteger(options.embeddingModelId, 'embeddingModelId')
    const activeTask = this.#activeTask(snapshotId, embeddingModelId)
    if (activeTask) return Object.freeze({ status: 'active', task: activeTask, batch: null })
    let targetForAvailability = null
    try { targetForAvailability = this.#readTarget(snapshotId, embeddingModelId) } catch {}
    const availability = normalizeWorkerAvailability(await this.workerAvailable({
      taskType: RAG_EMBEDDING_TASK_TYPE,
      model: targetForAvailability?.model ?? null
    }))
    if (!availability.available) {
      // Preserve a durable pending marker for a valid active snapshot even
      // when no GPU worker is online.  The text/FTS commit remains complete,
      // while a later reconcile or refresh can resume this model explicitly.
      try {
        const row = this.#readTarget(snapshotId, embeddingModelId)
        this.#assertTarget(row)
        this.#setPending(snapshotId, embeddingModelId, availability.reason)
      } catch {}
      return Object.freeze({ status: 'offline', task: null, batch: null, errorCode: availability.reason })
    }
    let prepared
    try {
      prepared = await this.prepareBatch(options)
      if (prepared.status === 'complete' || prepared.status === 'pending') return Object.freeze({ ...prepared, task: null, batch: prepared })
      if (!this.taskStore || (typeof this.taskStore.enqueueExclusiveRun !== 'function' && typeof this.taskStore.enqueue !== 'function')) {
        fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.TASK_STORE_UNAVAILABLE, 'taskStore enqueue API is unavailable.')
      }
      const request = this.#taskRequest(prepared)
      if (options.retryFailed && typeof this.taskStore.retryTerminalTask === 'function' &&
          typeof this.taskStore.getByIdempotencyKey === 'function') {
        const idempotencyKey = deriveTaskIdempotencyKey(request)
        const existing = await Promise.resolve(this.taskStore.getByIdempotencyKey(idempotencyKey))
        if (existing && ['failed', 'cancelled'].includes(existing.status)) {
          const retryOutcome = await Promise.resolve(this.taskStore.retryTerminalTask({ id: existing.id, maxRetries: 1 }))
          const retryTask = retryOutcome?.task ?? retryOutcome
          if (retryTask && retryTask.id !== existing.id) {
            if (retryOutcome?.exhausted && ['failed', 'cancelled'].includes(retryTask.status)) {
              try {
                this.#setPending(prepared.snapshotId, prepared.embeddingModelId, 'RAG_EMBEDDING_RETRY_EXHAUSTED')
              } catch {}
            }
            const retryStatus = ['pending', 'leased', 'running'].includes(retryTask.status)
              ? 'enqueued'
              : retryTask.status ?? 'enqueued'
            return Object.freeze({
              status: retryStatus,
              task: retryTask,
              batch: prepared,
              created: retryOutcome?.created ?? false
            })
          }
        }
      }
      const result = typeof this.taskStore.enqueueExclusiveRun === 'function'
        ? await this.taskStore.enqueueExclusiveRun(request, { taskTypes: [RAG_EMBEDDING_TASK_TYPE] })
        : await this.taskStore.enqueue(request)
      return Object.freeze({ status: result?.activeConflict ? 'active' : 'enqueued', task: result?.task ?? result, batch: prepared, created: result?.created ?? true })
    } catch (error) {
      if (prepared?.snapshotId && prepared?.embeddingModelId) {
        try { this.#setPending(prepared.snapshotId, prepared.embeddingModelId, error?.code ?? 'RAG_EMBEDDING_ENQUEUE_FAILED') } catch {}
      }
      throw error
    }
  }

  async claimBatch(options = {}) {
    return this.enqueueBatch(options)
  }

  #readTaskTarget(taskInput) {
    const snapshotId = positiveInteger(taskInput.snapshotId, 'task.input.snapshotId')
    const model = taskInput.model
    if (!isPlainObject(model) || typeof model.modelId !== 'string' || typeof model.configHash !== 'string') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.TASK_INVALID, 'task.input.model is invalid.')
    }
    const hasDistance = Object.hasOwn(model, 'distance')
    const hasNormalization = Object.hasOwn(model, 'normalization')
    const modelPredicates = [
      'model.provider = ?',
      'model.model_id = ?',
      'model.model_revision = ?',
      'model.dimensions = ?',
      'model.input_limit = ?',
      'model.config_hash = ?'
    ]
    const modelParameters = [
      model.provider, model.modelId, model.modelRevision,
      model.dimensions, model.inputLimit, model.configHash
    ]
    if (hasDistance) {
      modelPredicates.push('model.distance = ?')
      modelParameters.push(model.distance)
    }
    if (hasNormalization) {
      modelPredicates.push('model.normalization = ?')
      modelParameters.push(model.normalization)
    }
    const row = this.database.prepare(`
      SELECT snapshot.id, snapshot.source_type, snapshot.source_id,
             snapshot.source_version_id, snapshot.source_content_sha256,
             snapshot.status AS snapshot_status, source_state.active_snapshot_id,
             model.id AS embedding_model_id, model.provider, model.model_id,
             model.model_revision, model.dimensions, model.distance,
             model.normalization, model.input_limit, model.config_hash,
             model.status AS model_status
        FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
        LEFT JOIN ${RAG_SOURCE_STATE_TABLE} source_state
          ON source_state.source_type = snapshot.source_type
         AND source_state.source_id = snapshot.source_id
         JOIN ${RAG_EMBEDDING_MODEL_TABLE} model
           ON ${modelPredicates.join(' AND ')}
        WHERE snapshot.id = ?
    `).get(...modelParameters, snapshotId)
    if (!row) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.TASK_INVALID, 'task target no longer exists.')
    row.model = modelIdentityFromRow(row)
    row.source = sourceIdentity(row)
    if (!taskModelMatchesRow(model, row.model)) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.MODEL_MISMATCH, 'task model identity is stale.')
    return row
  }

  #staleResult(reason, externalUpserted = false) {
    return Object.freeze({ status: 'stale', applied: false, externalUpserted, reason })
  }

  async applyWorkerResult(taskOrOptions, maybeResult) {
    const options = maybeResult === undefined && isPlainObject(taskOrOptions) &&
      (Object.hasOwn(taskOrOptions, 'task') || Object.hasOwn(taskOrOptions, 'result') || Object.hasOwn(taskOrOptions, 'workerResult'))
      ? taskOrOptions
      : { task: taskOrOptions, result: maybeResult }
    const task = options.task
    const workerResult = options.result ?? options.workerResult
    const taskInput = readTaskInput(task)
    if (task.taskType !== undefined && task.taskType !== RAG_EMBEDDING_TASK_TYPE) {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.TASK_INVALID, 'task type is invalid.')
    }
    const processor = this.#processor()
    const projectedInput = processor.projectInput(taskInput)
    const normalizedEnvelope = processor.normalizeResult(workerResult, { input: projectedInput })
    const output = normalizedEnvelope.output
    const row = this.#readTaskTarget(projectedInput)
    try { this.#assertTarget(row) } catch (error) {
      if ([
        RAG_EMBEDDING_COORDINATOR_ERROR_CODES.SNAPSHOT_NOT_ACTIVE,
        RAG_EMBEDDING_COORDINATOR_ERROR_CODES.SNAPSHOT_NOT_READY,
        RAG_EMBEDDING_COORDINATOR_ERROR_CODES.MODEL_NOT_ACTIVE
      ].includes(error.code)) return this.#staleResult(error.code)
      throw error
    }
    const model = this.#resolveModelConfig(row)
    const vectorsById = new Map(output.vectors.map((vector) => [vector.chunkId, vector]))
    const chunkIds = [...vectorsById.keys()]
    const placeholders = chunkIds.map(() => '?').join(', ')
    const chunkRows = this.database.prepare(`
      SELECT id, chunk_sha256 FROM ${RAG_CHUNK_TABLE}
       WHERE snapshot_id = ? AND id IN (${placeholders})
    `).all(row.id, ...chunkIds)
    const chunkMap = new Map(chunkRows.map((chunk) => [chunk.id, chunk]))
    for (const vector of output.vectors) {
      const chunk = chunkMap.get(vector.chunkId)
      if (!chunk || chunk.chunk_sha256 !== vector.chunkSha256) {
        return this.#staleResult(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.STALE)
      }
    }
    if (!this.vectorStore || typeof this.vectorStore.upsertBatch !== 'function') {
      fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.VECTOR_STORE_UNAVAILABLE, 'vectorStore upsert API is unavailable.')
    }
    const points = output.vectors.map((vector) => ({
      chunkId: vector.chunkId,
      snapshotId: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      vector: vector.embedding,
      vectorSha256: ragVectorSha256(vector.embedding),
      modelId: model.modelId,
      modelRevision: model.modelRevision,
      modelConfigHash: model.configHash
    }))
    await this.vectorStore.upsertBatch(points, { signal: options.signal })

    const afterUpsert = this.#readTarget(row.id, row.embedding_model_id)
    if (!afterUpsert || afterUpsert.active_snapshot_id !== row.id ||
        afterUpsert.source_version_id !== row.source_version_id ||
        afterUpsert.source_content_sha256 !== row.source_content_sha256 ||
        !MODEL_USABLE_STATUSES.has(afterUpsert.model_status) ||
        !this.#activeModelMatches(afterUpsert)) {
      return this.#staleResult(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.STALE, true)
    }

    const now = asTimestamp(this.now)
    let completed = false
    this.#transaction(() => {
      const current = this.#readTarget(row.id, row.embedding_model_id)
      this.#assertTarget(current)
      if (!current || current.active_snapshot_id !== row.id ||
          current.source_version_id !== row.source_version_id ||
          current.source_content_sha256 !== row.source_content_sha256 ||
          !sameModel(current.model, model)) {
        fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.STALE, 'snapshot changed before SQLite finalize.')
      }
      const upsert = this.database.prepare(`
        INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
          chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256, status
        ) VALUES (?, ?, ?, ?, ?, 'ready')
        ON CONFLICT(chunk_id, embedding_model_id) DO UPDATE SET
          chunk_sha256 = excluded.chunk_sha256,
          vector_id = excluded.vector_id,
          vector_sha256 = excluded.vector_sha256,
          status = 'ready'
      `)
      for (const vector of output.vectors) {
        upsert.run(vector.chunkId, vector.chunkSha256, row.embedding_model_id, String(vector.chunkId), ragVectorSha256(vector.embedding))
      }
      const total = Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM ${RAG_CHUNK_TABLE} WHERE snapshot_id = ?
      `).get(row.id).count)
      const ready = Number(this.database.prepare(`
        SELECT COUNT(*) AS count
          FROM ${RAG_CHUNK_TABLE} chunks
          JOIN ${RAG_CHUNK_EMBEDDING_TABLE} embeddings
            ON embeddings.chunk_id = chunks.id
           AND embeddings.embedding_model_id = ?
           AND embeddings.chunk_sha256 = chunks.chunk_sha256
           AND embeddings.status = 'ready'
         WHERE chunks.snapshot_id = ?
      `).get(row.embedding_model_id, row.id).count)
      completed = ready === total
      this.database.prepare(`
        INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} (
          snapshot_id, embedding_model_id, status, vector_count,
          error_count, last_completed_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(snapshot_id, embedding_model_id) DO UPDATE SET
          status = excluded.status, vector_count = excluded.vector_count,
          error_count = 0, last_error_code = NULL,
          last_completed_at = CASE WHEN excluded.status = 'active' THEN excluded.last_completed_at ELSE rag_snapshot_embedding_state.last_completed_at END,
          updated_at = excluded.updated_at
      `).run(row.id, row.embedding_model_id, completed ? 'active' : 'indexing', ready, completed ? now : null, now)
      this.database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
           SET status = ?
         WHERE id = ? AND status IN ('text_ready', 'embedding_pending', 'partial', 'ready')
      `).run(completed ? 'ready' : 'embedding_pending', row.id)
    })
    return Object.freeze({
      status: completed ? 'active' : 'partial',
      applied: true,
      snapshotId: row.id,
      embeddingModelId: row.embedding_model_id,
      vectorCount: output.vectors.length,
      snapshotComplete: completed
    })
  }

  #completeIfReady(row, model) {
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN embeddings.status = 'ready'
                       AND embeddings.chunk_sha256 = chunks.chunk_sha256 THEN 1 ELSE 0 END) AS ready
        FROM ${RAG_CHUNK_TABLE} chunks
        LEFT JOIN ${RAG_CHUNK_EMBEDDING_TABLE} embeddings
          ON embeddings.chunk_id = chunks.id
         AND embeddings.embedding_model_id = ?
       WHERE chunks.snapshot_id = ?
    `).get(row.embedding_model_id, row.id)
    const total = Number(counts.total ?? 0)
    const ready = Number(counts.ready ?? 0)
    const active = total === ready
    const now = asTimestamp(this.now)
    this.#transaction(() => {
      const current = this.#readTarget(row.id, row.embedding_model_id)
      if (!current || current.active_snapshot_id !== row.id ||
          current.source_version_id !== row.source_version_id ||
          current.source_content_sha256 !== row.source_content_sha256 ||
          !sameModel(current.model, row.model)) {
        fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.STALE, 'snapshot changed before completion.')
      }
      this.database.prepare(`
        INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} (
          snapshot_id, embedding_model_id, status, vector_count,
          error_count, last_completed_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(snapshot_id, embedding_model_id) DO UPDATE SET
          status = excluded.status, vector_count = excluded.vector_count,
          last_completed_at = CASE WHEN excluded.status = 'active' THEN excluded.last_completed_at ELSE rag_snapshot_embedding_state.last_completed_at END,
          updated_at = excluded.updated_at
      `).run(row.id, row.embedding_model_id, active ? 'active' : 'pending', ready, active ? now : null, now)
      this.database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE} SET status = ? WHERE id = ? AND status <> 'stale'
      `).run(active ? 'ready' : 'embedding_pending', row.id)
    })
    return Object.freeze({ active, total, ready, model })
  }

  #markStale(snapshotId, embeddingModelId) {
    const now = asTimestamp(this.now)
    this.#transaction(() => {
      this.database.prepare(`
        UPDATE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
           SET status = 'stale', last_error_code = 'RAG_EMBEDDING_STALE', updated_at = ?
         WHERE snapshot_id = ? AND embedding_model_id = ?
      `).run(now, snapshotId, embeddingModelId)
      this.database.prepare(`
        UPDATE ${RAG_CHUNK_EMBEDDING_TABLE}
           SET status = 'stale'
         WHERE embedding_model_id = ?
           AND chunk_id IN (SELECT id FROM ${RAG_CHUNK_TABLE} WHERE snapshot_id = ?)
           AND status <> 'stale'
      `).run(embeddingModelId, snapshotId)
    })
  }

  async #inventory(snapshotId, options = {}) {
    if (!this.vectorStore || typeof this.vectorStore.listBySnapshot !== 'function') return null
    const points = []
    let offset = null
    do {
      const page = await this.vectorStore.listBySnapshot(snapshotId, { ...options, offset })
      const pagePoints = Array.isArray(page) ? page : page?.points
      if (!Array.isArray(pagePoints)) fail(RAG_EMBEDDING_COORDINATOR_ERROR_CODES.RESULT_INVALID, 'vector inventory response is invalid.')
      points.push(...pagePoints)
      offset = Array.isArray(page) ? null : (page.nextPageOffset ?? page.next_page_offset ?? null)
    } while (offset !== null && offset !== undefined)
    return new Map(points.map(parseInventoryPoint).filter(Boolean).map((point) => [point.chunkId, point.vectorSha256]))
  }

  async reconcile({ enqueue = false, maxBatches = 1 } = {}) {
    const rows = this.database.prepare(`
      SELECT snapshot.id AS snapshot_id, snapshot.source_type, snapshot.source_id,
             snapshot.status AS snapshot_status, state.active_snapshot_id,
             embedding_state.embedding_model_id, embedding_state.status AS embedding_status
        FROM ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} embedding_state
        JOIN ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot ON snapshot.id = embedding_state.snapshot_id
        LEFT JOIN ${RAG_SOURCE_STATE_TABLE} state
          ON state.source_type = snapshot.source_type AND state.source_id = snapshot.source_id
       WHERE embedding_state.status IN ('pending', 'indexing', 'active', 'partial', 'failed')
       ORDER BY embedding_state.id ASC
    `).all()
    const result = { recovered: 0, stale: 0, missing: 0, cleaned: 0, cleanupErrors: [], enqueued: [] }
    for (const state of rows) {
      const current = this.#readTarget(state.snapshot_id, state.embedding_model_id)
      if (!current || current.active_snapshot_id !== state.snapshot_id ||
          !SNAPSHOT_COMPLETE_STATUSES.has(current.snapshot_status) ||
          !MODEL_USABLE_STATUSES.has(current.model_status) ||
          !this.#activeModelMatches(current)) {
        this.#markStale(state.snapshot_id, state.embedding_model_id)
        result.stale += 1
        try {
          if (this.vectorStore?.deleteBySnapshot) {
            await this.vectorStore.deleteBySnapshot(state.snapshot_id)
            result.cleaned += 1
          }
        } catch (error) {
          result.cleanupErrors.push({ snapshotId: state.snapshot_id, code: error?.code ?? 'RAG_VECTOR_DELETE_FAILED' })
        }
        continue
      }

      const now = asTimestamp(this.now)
      this.#transaction(() => {
        const reset = this.database.prepare(`
          UPDATE ${RAG_CHUNK_EMBEDDING_TABLE}
             SET status = 'pending'
           WHERE embedding_model_id = ?
             AND status = 'processing'
             AND chunk_id IN (SELECT id FROM ${RAG_CHUNK_TABLE} WHERE snapshot_id = ?)
        `).run(state.embedding_model_id, state.snapshot_id)
        if (reset.changes > 0) result.recovered += reset.changes
        this.database.prepare(`
          UPDATE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
             SET status = CASE WHEN status = 'indexing' THEN 'pending' ELSE status END,
                 updated_at = ?
           WHERE snapshot_id = ? AND embedding_model_id = ?
        `).run(now, state.snapshot_id, state.embedding_model_id)
      })

      let inventory = null
      try {
        inventory = await this.#inventory(state.snapshot_id)
      } catch (error) {
        result.cleanupErrors.push({ snapshotId: state.snapshot_id, code: error?.code ?? 'RAG_VECTOR_INVENTORY_FAILED' })
      }
      if (inventory) {
        const readyRows = this.database.prepare(`
          SELECT embeddings.chunk_id, embeddings.vector_sha256
            FROM ${RAG_CHUNK_EMBEDDING_TABLE} embeddings
            JOIN ${RAG_CHUNK_TABLE} chunks ON chunks.id = embeddings.chunk_id
           WHERE chunks.snapshot_id = ? AND embeddings.embedding_model_id = ? AND embeddings.status = 'ready'
        `).all(state.snapshot_id, state.embedding_model_id)
        const missingIds = readyRows.filter((row) => inventory.get(row.chunk_id) !== row.vector_sha256).map((row) => row.chunk_id)
        if (missingIds.length > 0) {
          this.#transaction(() => {
            const placeholders = missingIds.map(() => '?').join(', ')
            this.database.prepare(`
              UPDATE ${RAG_CHUNK_EMBEDDING_TABLE}
                 SET status = 'pending'
               WHERE embedding_model_id = ? AND chunk_id IN (${placeholders})
            `).run(state.embedding_model_id, ...missingIds)
            this.database.prepare(`
              UPDATE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
                 SET status = 'pending', updated_at = ?
               WHERE snapshot_id = ? AND embedding_model_id = ?
            `).run(now, state.snapshot_id, state.embedding_model_id)
          })
          result.missing += missingIds.length
        }
      }
      if (enqueue && result.enqueued.length < boundedInteger(maxBatches, 'maxBatches', 0, 100, 1)) {
        const queued = await this.enqueueBatch({ snapshotId: state.snapshot_id, embeddingModelId: state.embedding_model_id })
        if (queued.task) result.enqueued.push(queued.task)
      }
    }
    return Object.freeze({ ...result, enqueued: Object.freeze(result.enqueued), cleanupErrors: Object.freeze(result.cleanupErrors) })
  }

  recover(options = {}) {
    return this.reconcile(options)
  }
}

export function createRagEmbeddingCoordinator(options) {
  return new RagEmbeddingCoordinator(options)
}

export default createRagEmbeddingCoordinator
