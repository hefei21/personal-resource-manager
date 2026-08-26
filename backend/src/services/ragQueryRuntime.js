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
import { computeRagVectorConfigHash } from '../config/ragVector.js'
import { ragVectorConfig } from '../config/index.js'
import {
  createRagVectorStore
} from './ragVectorStore.js'
import {
  lookupPcWorkerProcessor,
  PC_WORKER_MODEL_BOUND_TASK_TYPES
} from './pcWorkerProcessorCatalog.js'

export const RAG_QUERY_EMBED_TASK_TYPE = 'rag.query.embed'
export const RAG_QUERY_EMBED_PROCESSOR_VERSION = 'v1'
export const RAG_QUERY_EMBED_EXECUTION_CLASS = 'gpu'
// The PC Worker default poll interval is 5 seconds.  Leave one poll plus
// response/lease jitter inside the request budget while retaining a bounded
// FTS-degraded timeout when the Worker remains offline.
export const RAG_QUERY_EMBED_WAIT_MS = 8_000
export const RAG_QUERY_EMBED_POLL_MS = 25
export const RAG_QUERY_VECTOR_OVERFETCH = 3
export const RAG_QUERY_TERMINAL_RETRY_DEFAULT_ENABLED = true
export const RAG_QUERY_TERMINAL_RETRY_DEFAULT_BUDGET = 1
export const RAG_QUERY_TERMINAL_RETRY_MAX_BUDGET = 3
export const RAG_QUERY_RUNTIME_VERSION = 'rag-query-runtime.v1'
export const RAG_QUERY_EMBEDDING_PREFIX = 'search_query: '

export const RAG_QUERY_RUNTIME_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_QUERY_RUNTIME_INPUT_INVALID',
  CONFIG_INCOMPLETE: 'RAG_QUERY_RUNTIME_CONFIG_INCOMPLETE',
  MODEL_UNAVAILABLE: 'RAG_QUERY_RUNTIME_MODEL_UNAVAILABLE',
  MODEL_MISMATCH: 'RAG_QUERY_RUNTIME_MODEL_MISMATCH',
  WORKER_UNAVAILABLE: 'RAG_QUERY_RUNTIME_WORKER_UNAVAILABLE',
  TASK_STORE_UNAVAILABLE: 'RAG_QUERY_RUNTIME_TASK_STORE_UNAVAILABLE',
  TASK_FAILED: 'RAG_QUERY_RUNTIME_TASK_FAILED',
  TIMEOUT: 'RAG_QUERY_RUNTIME_TIMEOUT',
  STALE: 'RAG_QUERY_RUNTIME_STALE',
  VECTOR_UNAVAILABLE: 'RAG_QUERY_RUNTIME_VECTOR_UNAVAILABLE',
  VECTOR_SCHEMA_MISMATCH: 'RAG_QUERY_RUNTIME_VECTOR_SCHEMA_MISMATCH',
  RESULT_INVALID: 'RAG_QUERY_RUNTIME_RESULT_INVALID',
  DATABASE_UNAVAILABLE: 'RAG_QUERY_RUNTIME_DATABASE_UNAVAILABLE'
})

export const RAG_WORKER_ONLINE_WINDOW_MS = 120_000

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const TASK_PENDING_STATUSES = new Set(['pending', 'leased', 'running'])
const TASK_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const MAX_ACTIVE_SOURCES = 256
const MODEL_FIELDS = Object.freeze([
  'provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit',
  'distance', 'normalization', 'configHash'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code, message = code, details = {}) {
  const error = new Error(message)
  error.name = 'RagQueryRuntimeError'
  error.code = code
  Object.assign(error, details)
  return error
}

function positiveInteger(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function boundedInteger(value, fieldName, min, max, fallback) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function normalizeQueryText(value) {
  if (typeof value !== 'string') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'query is invalid.')
  const query = value.normalize('NFKC').trim()
  if (!query || Buffer.byteLength(query, 'utf8') > 64 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) {
    throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'query is invalid.')
  }
  return query
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function modelIdentity(row) {
  if (!isPlainObject(row)) return null
  const model = {
    provider: row.provider ?? row.model?.provider,
    modelId: row.modelId ?? row.model_id ?? row.model?.modelId,
    modelRevision: row.modelRevision ?? row.model_revision ?? row.model?.modelRevision,
    dimensions: row.dimensions ?? row.model?.dimensions,
    inputLimit: row.inputLimit ?? row.input_limit ?? row.model?.inputLimit,
    distance: row.distance ?? row.model?.distance,
    normalization: row.normalization ?? row.model?.normalization,
    configHash: row.configHash ?? row.config_hash ?? row.model?.configHash
  }
  if (typeof model.provider !== 'string' || !model.provider.trim() ||
      typeof model.modelId !== 'string' || !model.modelId.trim() ||
      typeof model.modelRevision !== 'string' || !model.modelRevision.trim() ||
      !Number.isSafeInteger(model.dimensions) || model.dimensions < 1 ||
      !Number.isSafeInteger(model.inputLimit) || model.inputLimit < 1 ||
      !['cosine', 'dot', 'euclid'].includes(model.distance) ||
      !['none', 'l2'].includes(model.normalization) ||
      typeof model.configHash !== 'string' || !HASH_PATTERN.test(model.configHash)) return null
  return Object.freeze(model)
}

function sameModel(left, right) {
  const a = modelIdentity(left)
  const b = modelIdentity(right)
  return Boolean(a && b && MODEL_FIELDS.every((field) => a[field] === b[field]))
}

function workerModel(model) {
  return Object.freeze({
    provider: model.provider,
    modelId: model.modelId,
    modelRevision: model.modelRevision,
    dimensions: model.dimensions,
    inputLimit: model.inputLimit,
    configHash: model.configHash
  })
}

function sameWorkerModel(actual, expected) {
  if (!isPlainObject(actual) || !isPlainObject(expected)) return false
  return ['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'configHash']
    .every((field) => actual[field] === expected[field])
}

const MODEL_BOUND_TASK_TYPES = new Set(PC_WORKER_MODEL_BOUND_TASK_TYPES)

function modelColumns(model) {
  return [
    model.provider,
    model.modelId,
    model.modelRevision,
    model.dimensions,
    model.distance,
    model.normalization,
    model.inputLimit,
    model.configHash
  ]
}

function modelRowId(row) {
  return positiveInteger(row?.embeddingModelId ?? row?.embedding_model_id ?? row?.id)
}

function modelResult(row) {
  const model = modelIdentity(row)
  const embeddingModelId = modelRowId(row)
  if (!model || embeddingModelId === null) return null
  return Object.freeze({ embeddingModelId, model })
}

function tablePresent(database, name) {
  try {
    return Boolean(database?.prepare?.(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name))
  } catch {
    return false
  }
}

/**
 * Resolve the capability contract shared by query and indexing embeddings.
 * Worker liveness is authoritative only when the worker row, protocol and
 * catalog processor identity all agree; callers can then degrade without
 * enqueueing work that cannot be consumed.
 */
export function readRagWorkerAvailability({
  database,
  taskType,
  processorVersion = 'v1',
  model = null,
  now = Date.now,
  onlineWindowMs = RAG_WORKER_ONLINE_WINDOW_MS
} = {}) {
  const definition = lookupPcWorkerProcessor(taskType, processorVersion)
  if (!definition || !database?.prepare) {
    return Object.freeze({ available: false, reason: 'RAG_WORKER_UNAVAILABLE' })
  }
  const nowValue = typeof now === 'function' ? now() : now
  if (!Number.isFinite(nowValue) || !Number.isFinite(onlineWindowMs) || onlineWindowMs < 0) {
    return Object.freeze({ available: false, reason: 'RAG_WORKER_UNAVAILABLE' })
  }
  const expectedModel = model ?? readActiveModelFromDatabase(database)?.model ?? null
  const expectedWorkerModel = MODEL_BOUND_TASK_TYPES.has(taskType) && expectedModel
    ? workerModel(expectedModel)
    : null
  if (MODEL_BOUND_TASK_TYPES.has(taskType) && !expectedWorkerModel) {
    return Object.freeze({ available: false, reason: 'RAG_WORKER_MODEL_UNAVAILABLE' })
  }
  try {
    const rows = database.prepare(`
      SELECT status, protocol_version, last_seen_at, capabilities_json
        FROM pc_workers
       WHERE status = 'active'
    `).all()
    const cutoff = nowValue - onlineWindowMs
    for (const row of rows) {
      if (row.status !== 'active' || row.protocol_version !== 1) continue
      const lastSeen = Date.parse(row.last_seen_at ?? '')
      if (!Number.isFinite(lastSeen) || lastSeen < cutoff || lastSeen > nowValue + 5_000) continue
      let capabilities
      try { capabilities = JSON.parse(row.capabilities_json) } catch { continue }
      if (Array.isArray(capabilities?.processors) && capabilities.processors.some((processor) =>
        processor?.taskType === definition.taskType &&
        processor?.processorVersion === definition.processorVersion &&
        processor?.executionClass === definition.executionClass &&
        processor?.outputSchemaVersion === definition.outputSchemaVersion &&
        (!expectedWorkerModel || sameWorkerModel(processor.model, expectedWorkerModel))
      )) return Object.freeze({ available: true })
    }
  } catch {}
  return Object.freeze({ available: false, reason: 'RAG_WORKER_UNAVAILABLE' })
}

function readActiveModelFromDatabase(database) {
  if (!database?.prepare || ![
    RAG_EMBEDDING_MODEL_TABLE,
    RAG_SOURCE_SNAPSHOT_TABLE,
    RAG_SOURCE_STATE_TABLE,
    RAG_CHUNK_TABLE,
    RAG_CHUNK_EMBEDDING_TABLE,
    RAG_SNAPSHOT_EMBEDDING_STATE_TABLE
  ].every((table) => tablePresent(database, table))) return null
  try {
    const row = database.prepare(`
      SELECT id AS embedding_model_id, provider, model_id, model_revision,
             dimensions, distance, normalization, input_limit, config_hash,
             status
        FROM ${RAG_EMBEDDING_MODEL_TABLE}
       WHERE status = 'active'
       ORDER BY id DESC
       LIMIT 1
    `).get()
    if (!row || row.status !== 'active') return null
    return modelResult(row)
  } catch {
    return null
  }
}

/**
 * Register only the exact, hash-bound vector model explicitly supplied by
 * RAG_VECTOR_* configuration.  An existing active identity is authoritative:
 * a mismatch is fail-closed and never silently retired or replaced.
 *
 * The write and snapshot-state backfill share one SQLite transaction so a
 * newly enabled vector path cannot observe an active model without its
 * durable pending work markers.
 */
export function ensureRagActiveEmbeddingModel(database, config = ragVectorConfig) {
  if (!database?.prepare || typeof database.transaction !== 'function' ||
      config?.enabled !== true || !isPlainObject(config.modelConfig)) return null
  if (Object.keys(config.modelConfig).some((key) => !MODEL_FIELDS.includes(key)) ||
      MODEL_FIELDS.some((key) => !Object.hasOwn(config.modelConfig, key))) return null
  const configured = modelIdentity(config.modelConfig)
  if (!configured || computeRagVectorConfigHash(configured) !== configured.configHash || ![
    RAG_EMBEDDING_MODEL_TABLE,
    RAG_SOURCE_SNAPSHOT_TABLE,
    RAG_SOURCE_STATE_TABLE,
    RAG_SNAPSHOT_EMBEDDING_STATE_TABLE
  ].every((table) => tablePresent(database, table))) return null

  try {
    const transaction = database.transaction(() => {
      const activeRows = database.prepare(`
        SELECT id AS embedding_model_id, provider, model_id, model_revision,
               dimensions, distance, normalization, input_limit, config_hash,
               status
          FROM ${RAG_EMBEDDING_MODEL_TABLE}
         WHERE status = 'active'
         ORDER BY id ASC
      `).all()
      const activeModels = activeRows.map(modelResult)
      if (activeModels.some((row) => !row || !sameModel(row.model, configured))) return null

      let active = activeModels.find((row) => sameModel(row.model, configured)) ?? null
      if (!active) {
        const exact = database.prepare(`
          SELECT id AS embedding_model_id, provider, model_id, model_revision,
                 dimensions, distance, normalization, input_limit, config_hash,
                 status
            FROM ${RAG_EMBEDDING_MODEL_TABLE}
           WHERE provider = ? AND model_id = ? AND model_revision = ?
             AND dimensions = ? AND distance = ? AND normalization = ?
             AND input_limit = ? AND config_hash = ?
           ORDER BY id DESC
           LIMIT 1
        `).get(...modelColumns(configured))
        if (exact) {
          database.prepare(`
            UPDATE ${RAG_EMBEDDING_MODEL_TABLE}
               SET status = 'active'
             WHERE id = ? AND status <> 'active'
          `).run(exact.embedding_model_id)
          active = modelResult({ ...exact, status: 'active' })
        } else {
          const inserted = database.prepare(`
            INSERT INTO ${RAG_EMBEDDING_MODEL_TABLE} (
              provider, model_id, model_revision, dimensions, distance,
              normalization, input_limit, config_hash, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
          `).run(...modelColumns(configured))
          active = modelResult({
            embedding_model_id: inserted.lastInsertRowid,
            ...configured,
            status: 'active'
          })
        }
      }
      if (!active) return null

      const now = new Date().toISOString()
      database.prepare(`
        INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} (
          snapshot_id, embedding_model_id, status, vector_count, error_count, updated_at
        )
        SELECT snapshot.id, ?, 'pending', 0, 0, ?
          FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
          JOIN ${RAG_SOURCE_STATE_TABLE} source_state
            ON source_state.source_type = snapshot.source_type
           AND source_state.source_id = snapshot.source_id
           AND source_state.active_snapshot_id = snapshot.id
         WHERE snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
        ON CONFLICT(snapshot_id, embedding_model_id) DO UPDATE SET
          status = CASE
            WHEN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.status = 'stale' THEN 'pending'
            ELSE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.status
          END,
          last_error_code = CASE
            WHEN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.status = 'stale' THEN NULL
            ELSE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.last_error_code
          END,
          error_count = CASE
            WHEN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.status = 'stale' THEN 0
            ELSE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.error_count
          END,
          updated_at = CASE
            WHEN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.status = 'stale' THEN excluded.updated_at
            ELSE ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}.updated_at
          END
      `).run(active.embeddingModelId, now)
      return active
    })
    return transaction()
  } catch {
    return null
  }
}

function normalizeActiveSources(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ACTIVE_SOURCES) return null
  const seen = new Set()
  const sources = []
  for (const row of rows) {
    const snapshotId = positiveInteger(row.snapshotId ?? row.snapshot_id)
    const sourceId = positiveInteger(row.sourceId ?? row.source_id)
    const sourceType = row.sourceType ?? row.source_type
    const sourceVersionId = row.sourceVersionId ?? row.source_version_id
    if (snapshotId === null || sourceId === null || !SOURCE_TYPES.has(sourceType) ||
        typeof sourceVersionId !== 'string' || !sourceVersionId.trim()) return null
    const key = `${snapshotId}\u0000${sourceType}\u0000${sourceId}\u0000${sourceVersionId}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(Object.freeze({ snapshotId, sourceType, sourceId, sourceVersionId }))
  }
  return sources.length > 0 && sources.length <= MAX_ACTIVE_SOURCES ? Object.freeze(sources) : null
}

function readActiveSourcesFromDatabase(database, embeddingModelId) {
  if (!database?.prepare || !Number.isSafeInteger(embeddingModelId)) return null
  try {
    const rows = database.prepare(`
      SELECT snapshot.id AS snapshot_id,
             snapshot.source_type, snapshot.source_id, snapshot.source_version_id
        FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
        JOIN ${RAG_SOURCE_STATE_TABLE} source_state
          ON source_state.source_type = snapshot.source_type
         AND source_state.source_id = snapshot.source_id
         AND source_state.active_snapshot_id = snapshot.id
        JOIN ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE} embedding_state
          ON embedding_state.snapshot_id = snapshot.id
         AND embedding_state.embedding_model_id = ?
         AND embedding_state.status = 'active'
       WHERE snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
       ORDER BY snapshot.id ASC
    `).all(embeddingModelId)
    return normalizeActiveSources(rows)
  } catch {
    return null
  }
}

function parseLocator(value) {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function createDefaultRagVectorStore({ model, config = ragVectorConfig } = {}) {
  if (!model || !config?.enabled || !config.baseUrl || !config.collection ||
      !Number.isSafeInteger(config.timeoutMs) || !sameModel(config.modelConfig, model)) return null
  try {
    return createRagVectorStore({
      baseUrl: config.baseUrl,
      collection: config.collection,
      modelConfig: config.modelConfig,
      timeoutMs: config.timeoutMs
    })
  } catch {
    return null
  }
}

function degradedResult(code, reason = code) {
  return Object.freeze({
    vectorCandidates: Object.freeze([]),
    vectorError: Object.freeze({ code, reason })
  })
}

function taskStatus(task) {
  return typeof task?.status === 'string' ? task.status : null
}

function taskId(task) {
  return positiveInteger(task?.id ?? task?.taskId)
}

export class RagQueryRuntime {
  constructor({
    database,
    taskStore = null,
    vectorStore = null,
    vectorConfig = ragVectorConfig,
    vectorStoreFactory = createDefaultRagVectorStore,
    modelResolver = null,
    activeSourcesResolver = null,
    workerAvailable = async () => false,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitMs = RAG_QUERY_EMBED_WAIT_MS,
    pollMs = RAG_QUERY_EMBED_POLL_MS,
    vectorOverfetch = RAG_QUERY_VECTOR_OVERFETCH,
    retryTerminal = RAG_QUERY_TERMINAL_RETRY_DEFAULT_ENABLED,
    terminalRetryBudget = RAG_QUERY_TERMINAL_RETRY_DEFAULT_BUDGET
  } = {}) {
    if (!database?.prepare) throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.DATABASE_UNAVAILABLE, 'database is required.')
    if (taskStore !== null && !isPlainObject(taskStore) && typeof taskStore !== 'object') {
      throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'taskStore is invalid.')
    }
    if (typeof vectorStoreFactory !== 'function') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'vectorStoreFactory is invalid.')
    if (modelResolver !== null && typeof modelResolver !== 'function') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'modelResolver is invalid.')
    if (activeSourcesResolver !== null && typeof activeSourcesResolver !== 'function') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'activeSourcesResolver is invalid.')
    if (typeof workerAvailable !== 'function') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'workerAvailable is invalid.')
    if (typeof now !== 'function' || typeof sleep !== 'function') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'clock is invalid.')
    if (typeof retryTerminal !== 'boolean') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'retryTerminal is invalid.')
    this.database = database
    this.taskStore = taskStore
    this.vectorStore = vectorStore
    this.vectorConfig = vectorConfig
    this.vectorStoreFactory = vectorStoreFactory
    this.modelResolver = modelResolver
    this.activeSourcesResolver = activeSourcesResolver
    this.workerAvailable = workerAvailable
    this.now = now
    this.sleep = sleep
    this.waitMs = boundedInteger(waitMs, 'waitMs', 0, 60_000, RAG_QUERY_EMBED_WAIT_MS)
    this.pollMs = boundedInteger(pollMs, 'pollMs', 1, 5_000, RAG_QUERY_EMBED_POLL_MS)
    this.vectorOverfetch = boundedInteger(vectorOverfetch, 'vectorOverfetch', 1, 10, RAG_QUERY_VECTOR_OVERFETCH)
    this.retryTerminal = retryTerminal
    this.terminalRetryBudget = boundedInteger(
      terminalRetryBudget,
      'terminalRetryBudget',
      0,
      RAG_QUERY_TERMINAL_RETRY_MAX_BUDGET,
      RAG_QUERY_TERMINAL_RETRY_DEFAULT_BUDGET
    )
  }

  async #resolveModel() {
    const result = this.modelResolver
      ? await Promise.resolve(this.modelResolver({ database: this.database }))
      : typeof this.database.transaction === 'function'
        ? ensureRagActiveEmbeddingModel(this.database, this.vectorConfig)
        : readActiveModelFromDatabase(this.database)
    if (!result) return null
    if (result.model) return modelResult({ ...result.model, embeddingModelId: result.embeddingModelId })
    return modelResult(result)
  }

  async #resolveVectorStore(model) {
    if (this.vectorStore) return this.vectorStore
    const value = await Promise.resolve(this.vectorStoreFactory({
      database: this.database,
      model: model.model,
      modelConfig: model.model,
      config: this.vectorConfig
    }))
    return value ?? null
  }

  async #workerIsAvailable(model, phase = 'query') {
    try {
      const value = await Promise.resolve(this.workerAvailable({
        taskType: RAG_QUERY_EMBED_TASK_TYPE,
        processorVersion: RAG_QUERY_EMBED_PROCESSOR_VERSION,
        model: model.model,
        database: this.database,
        phase
      }))
      return value === true || (isPlainObject(value) && value.available === true)
    } catch {
      return false
    }
  }

  async availability() {
    const model = await this.#resolveModel()
    if (!model) return Object.freeze({ available: false, reason: RAG_QUERY_RUNTIME_ERROR_CODES.MODEL_UNAVAILABLE })
    if (!(await this.#workerIsAvailable(model, 'status'))) {
      return Object.freeze({ available: false, reason: RAG_QUERY_RUNTIME_ERROR_CODES.WORKER_UNAVAILABLE, model })
    }
    let vectorStore
    try { vectorStore = await this.#resolveVectorStore(model) } catch { vectorStore = null }
    if (!vectorStore) {
      return Object.freeze({
        available: false,
        reason: this.vectorConfig?.enabled === false
          ? RAG_QUERY_RUNTIME_ERROR_CODES.CONFIG_INCOMPLETE
          : RAG_QUERY_RUNTIME_ERROR_CODES.MODEL_MISMATCH,
        model
      })
    }
    if (!sameModel(vectorStore.modelConfig, model.model)) {
      return Object.freeze({ available: false, reason: RAG_QUERY_RUNTIME_ERROR_CODES.MODEL_MISMATCH, model })
    }
    try {
      if (typeof vectorStore.ensureCollection === 'function') {
        await vectorStore.ensureCollection()
      }
      if (typeof vectorStore.health === 'function') {
        const health = await vectorStore.health()
        if (health?.available !== true) throw new Error('vector store is unavailable')
      }
    } catch (error) {
      return Object.freeze({
        available: false,
        reason: error?.code === 'RAG_VECTOR_SCHEMA_MISMATCH'
          ? RAG_QUERY_RUNTIME_ERROR_CODES.VECTOR_SCHEMA_MISMATCH
          : RAG_QUERY_RUNTIME_ERROR_CODES.VECTOR_UNAVAILABLE,
        model
      })
    }
    return Object.freeze({ available: true, model, vectorStore })
  }

  async #waitForTask(task) {
    if (!task || typeof task !== 'object') return null
    let current = task
    const initialStatus = taskStatus(current)
    if (initialStatus === 'succeeded' || (initialStatus === null && current.result)) return current
    if (TASK_TERMINAL_STATUSES.has(initialStatus)) return current
    const id = taskId(current)
    if (id === null || typeof this.taskStore?.getById !== 'function') return null
    const deadline = this.now() + this.waitMs
    while (this.now() <= deadline) {
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())))
      current = await Promise.resolve(this.taskStore.getById(id)).catch(() => null)
      if (!current) return null
      const status = taskStatus(current)
      if (TASK_TERMINAL_STATUSES.has(status) || status === null) return current
      if (!TASK_PENDING_STATUSES.has(status)) return null
    }
    return null
  }

  async #embed(query, model, retryTerminal = this.retryTerminal) {
    if (!this.taskStore || (typeof this.taskStore.enqueueExclusiveRun !== 'function' && typeof this.taskStore.enqueue !== 'function')) {
      throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.TASK_STORE_UNAVAILABLE, 'query embedding task store is unavailable.')
    }
    const processor = lookupPcWorkerProcessor(RAG_QUERY_EMBED_TASK_TYPE, RAG_QUERY_EMBED_PROCESSOR_VERSION)
    if (!processor || typeof processor.projectInput !== 'function' || typeof processor.normalizeResult !== 'function') {
      throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.RESULT_INVALID, 'query embedding processor is unavailable.')
    }
    const querySha256 = sha256(query)
    const input = processor.projectInput({
      schemaVersion: 1,
      querySha256,
      query: `${RAG_QUERY_EMBEDDING_PREFIX}${query}`,
      model: workerModel(model.model)
    })
    const request = {
      taskType: RAG_QUERY_EMBED_TASK_TYPE,
      processorVersion: RAG_QUERY_EMBED_PROCESSOR_VERSION,
      subjectType: 'rag-query-embed',
      subjectId: querySha256,
      subjectVersionId: model.model.configHash,
      subjectContentSha256: querySha256,
      executionClass: RAG_QUERY_EMBED_EXECUTION_CLASS,
      priority: 100,
      maxAttempts: 1,
      input
    }
    const outcome = typeof this.taskStore.enqueueExclusiveRun === 'function'
      ? await this.taskStore.enqueueExclusiveRun(request, { taskTypes: [RAG_QUERY_EMBED_TASK_TYPE] })
      : await this.taskStore.enqueue(request)
    let task = outcome?.task ?? outcome
    let completed = await this.#waitForTask(task)
    const retryTaskId = taskId(completed)
    if (completed && retryTaskId !== null && ['failed', 'cancelled'].includes(taskStatus(completed)) && retryTerminal &&
        typeof this.taskStore.retryTerminalTask === 'function') {
      const retryOutcome = await Promise.resolve(this.taskStore.retryTerminalTask({
        id: retryTaskId,
        maxRetries: this.terminalRetryBudget
      }))
      task = retryOutcome?.task ?? retryOutcome
      completed = await this.#waitForTask(task)
    }
    if (!completed || taskStatus(completed) !== 'succeeded' || !completed.result) {
      throw fail(
        completed && ['failed', 'cancelled'].includes(taskStatus(completed))
          ? RAG_QUERY_RUNTIME_ERROR_CODES.TASK_FAILED
          : RAG_QUERY_RUNTIME_ERROR_CODES.TIMEOUT,
        'query embedding did not complete.'
      )
    }
    let normalized
    try {
      normalized = processor.normalizeResult(completed.result, { input })
    } catch {
      throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.RESULT_INVALID, 'query embedding result is invalid.')
    }
    if (!normalized?.output || !sameWorkerModel(normalized.output.model, workerModel(model.model)) ||
        normalized.output.querySha256 !== querySha256) {
      throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.STALE, 'query embedding result is stale.')
    }
    return normalized.output
  }

  async #activeSources(model) {
    const result = this.activeSourcesResolver
      ? await Promise.resolve(this.activeSourcesResolver({ database: this.database, model }))
      : readActiveSourcesFromDatabase(this.database, model.embeddingModelId)
    return normalizeActiveSources(result)
  }

  #readCandidate(candidate, model) {
    const chunkId = positiveInteger(candidate?.chunkId)
    const snapshotId = positiveInteger(candidate?.snapshotId)
    const sourceId = positiveInteger(candidate?.sourceId)
    if (chunkId === null || snapshotId === null || sourceId === null || !SOURCE_TYPES.has(candidate?.sourceType) ||
        typeof candidate?.sourceVersionId !== 'string') return null
    try {
      const row = this.database.prepare(`
        SELECT chunks.id AS chunk_id, chunks.snapshot_id, chunks.ordinal, chunks.body, chunks.title,
               chunks.locator_json, snapshot.source_type, snapshot.source_id,
               snapshot.source_version_id, snapshot.source_content_sha256
          FROM ${RAG_CHUNK_TABLE} chunks
          JOIN ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
            ON snapshot.id = chunks.snapshot_id
          JOIN ${RAG_SOURCE_STATE_TABLE} source_state
            ON source_state.source_type = snapshot.source_type
           AND source_state.source_id = snapshot.source_id
           AND source_state.active_snapshot_id = snapshot.id
          JOIN ${RAG_CHUNK_EMBEDDING_TABLE} embeddings
            ON embeddings.chunk_id = chunks.id
           AND embeddings.embedding_model_id = ?
           AND embeddings.chunk_sha256 = chunks.chunk_sha256
           AND embeddings.status = 'ready'
         WHERE chunks.id = ?
           AND chunks.snapshot_id = ?
           AND snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
      `).get(model.embeddingModelId, chunkId, snapshotId)
      if (!row || row.source_type !== candidate.sourceType || Number(row.source_id) !== sourceId ||
          String(row.source_version_id) !== candidate.sourceVersionId ||
          (candidate.sourceContentSha256 !== undefined && candidate.sourceContentSha256 !== null &&
            row.source_content_sha256 !== candidate.sourceContentSha256)) return null
      const locator = parseLocator(row.locator_json)
      if (!locator || typeof row.body !== 'string' || !row.body.trim()) return null
      return Object.freeze({
        body: row.body,
        title: typeof row.title === 'string' ? row.title : null,
        locator: Object.freeze(locator),
        ordinal: Number.isSafeInteger(row.ordinal) ? row.ordinal : 0,
        sourceContentSha256: row.source_content_sha256
      })
    } catch {
      return null
    }
  }

  async resolveCandidate(candidate, model = null) {
    if (!candidate || candidate.channel !== 'vector') return null
    const resolvedModel = model ?? await this.#resolveModel()
    return resolvedModel ? this.#readCandidate(candidate, resolvedModel) : null
  }

  async query({ query, limit = 10, signal, retryTerminal = this.retryTerminal } = {}) {
    const normalizedQuery = normalizeQueryText(query)
    const normalizedLimit = boundedInteger(limit, 'limit', 1, 100, 10)
    if (typeof retryTerminal !== 'boolean') throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.INPUT_INVALID, 'retryTerminal is invalid.')
    const availability = await this.availability()
    if (!availability.available) return degradedResult(availability.reason)
    const modelBefore = availability.model
    let embedding
    try {
      embedding = await this.#embed(normalizedQuery, modelBefore, retryTerminal)
    } catch (error) {
      return degradedResult(error?.code ?? RAG_QUERY_RUNTIME_ERROR_CODES.WORKER_UNAVAILABLE)
    }
    const modelAfter = await this.#resolveModel()
    if (!modelAfter || modelAfter.embeddingModelId !== modelBefore.embeddingModelId || !sameModel(modelAfter.model, modelBefore.model)) {
      return degradedResult(RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
    }
    const activeSources = await this.#activeSources(modelAfter)
    if (!activeSources) return degradedResult(RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
    try {
      const result = await availability.vectorStore.search(embedding.embedding, {
        activeSnapshotSources: activeSources,
        limit: normalizedLimit,
        overfetch: this.vectorOverfetch,
        signal
      })
      if (!result || !Array.isArray(result.points)) throw fail(RAG_QUERY_RUNTIME_ERROR_CODES.VECTOR_SCHEMA_MISMATCH, 'vector search response is invalid.')
      const candidates = []
      for (const point of result.points) {
        const payload = point?.payload
        const resolved = this.#readCandidate(payload, modelAfter)
        if (!resolved) continue
        candidates.push(Object.freeze({
          chunkId: payload.chunkId,
          snapshotId: payload.snapshotId,
          sourceType: payload.sourceType,
          sourceId: payload.sourceId,
          sourceVersionId: payload.sourceVersionId,
          sourceContentSha256: payload.sourceContentSha256,
          score: point.score
        }))
      }
      if (candidates.length === 0) return degradedResult(RAG_QUERY_RUNTIME_ERROR_CODES.STALE)
      return Object.freeze({
        vectorCandidates: Object.freeze(candidates),
        candidateResolver: (candidate) => this.resolveCandidate(candidate, modelAfter)
      })
    } catch (error) {
      return degradedResult(error?.code ?? RAG_QUERY_RUNTIME_ERROR_CODES.VECTOR_UNAVAILABLE)
    }
  }
}

export function createRagQueryRuntime(options) {
  return new RagQueryRuntime(options)
}

export function readActiveRagEmbeddingModel(database) {
  return readActiveModelFromDatabase(database)
}

export default createRagQueryRuntime
