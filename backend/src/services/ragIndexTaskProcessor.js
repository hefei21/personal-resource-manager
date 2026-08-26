import { getDatabase } from '../config/database.js'
import { collectRagSources } from './ragSourceCollector.js'
import {
  createRagTextIndexService,
  RagTextIndexError,
  RAG_TEXT_INDEX_ERROR_CODES
} from './ragTextIndexService.js'
import { getTaskRuntime, registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'
import { createRagEmbeddingRuntime } from './ragEmbeddingRuntime.js'

export const RAG_INDEX_TASK_TYPE = 'rag.index.refresh'
export const RAG_INDEX_PROCESSOR_VERSION = 'v1'
export const RAG_INDEX_EXECUTION_CLASS = 'disk'
export const RAG_INDEX_SUBJECT_TYPE = 'rag-index'
export const RAG_INDEX_SUBJECT_ID = 'owner'

export const RAG_INDEX_TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_INDEX_INPUT_INVALID',
  DATABASE_BUSY: 'RAG_INDEX_DATABASE_BUSY',
  CANCELLED: 'RAG_INDEX_CANCELLED',
  FAILED: 'RAG_INDEX_REFRESH_FAILED'
})

const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const SOURCE_TYPE_ALIASES = new Map([
  ['documents', 'document'],
  ['ebooks', 'ebook'],
  ['books', 'ebook'],
  ['repositories', 'code_repository'],
  ['code', 'code_repository']
])
const MAX_SOURCE_IDS = 500

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function positiveId(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value.trim())
    ? Number(value)
    : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function normalizeSourceType(value, { allowAll = false } = {}) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  if (allowAll && normalized === 'all') return 'all'
  if (SOURCE_TYPES.has(normalized)) return normalized
  return SOURCE_TYPE_ALIASES.get(normalized) ?? null
}

function normalizeSource(value) {
  if (value === undefined || value === null || value === 'all') {
    return Object.freeze({ type: 'all', id: null })
  }
  if (typeof value === 'string') {
    const type = normalizeSourceType(value, { allowAll: true })
    return type === null ? null : Object.freeze({ type, id: null })
  }
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (keys.some((key) => !['type', 'id'].includes(key))) return null
  const type = normalizeSourceType(value.type, { allowAll: true })
  if (type === null) return null
  const id = value.id === undefined || value.id === null ? null : positiveId(value.id)
  if (value.id !== undefined && value.id !== null && id === null) return null
  if (type === 'all' && id !== null) return null
  return Object.freeze({ type, id })
}

function normalizeIdList(value) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS) return null
  const ids = []
  const seen = new Set()
  for (const item of value) {
    const id = positiveId(item)
    if (id === null || seen.has(id)) return null
    seen.add(id)
    ids.push(id)
  }
  return Object.freeze(ids)
}

function normalizeFilter(value) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) return null
  const keys = Object.keys(value)
  if (keys.some((key) => !['sourceType', 'sourceIds', 'ids'].includes(key))) return null
  if (Object.hasOwn(value, 'sourceIds') && Object.hasOwn(value, 'ids')) return null
  const sourceType = value.sourceType === undefined || value.sourceType === null
    ? null
    : normalizeSourceType(value.sourceType)
  if (value.sourceType !== undefined && value.sourceType !== null && sourceType === null) return null
  const idsValue = Object.hasOwn(value, 'sourceIds') ? value.sourceIds : value.ids
  const ids = idsValue === undefined ? null : normalizeIdList(idsValue)
  if (idsValue !== undefined && ids === null) return null
  if (sourceType === null && ids === null) return null
  return Object.freeze({
    ...(sourceType === null ? {} : { sourceType }),
    ...(ids === null ? {} : { sourceIds: ids })
  })
}

/**
 * The refresh task accepts only an allowlisted source selector and source IDs.
 * Keeping this normalizer here lets the API and the task processor share the
 * same fail-closed contract without accepting collector, path, model, or
 * vector-store options from a client.
 */
export function normalizeRagIndexTaskInput(taskOrInput) {
  const input = taskOrInput?.input ?? taskOrInput
  if (!isPlainObject(input)) return null
  const allowed = new Set(['source', 'filter', 'rebuild'])
  if (Object.keys(input).some((key) => !allowed.has(key))) return null
  const source = normalizeSource(input.source)
  if (source === null) return null
  const filter = normalizeFilter(input.filter)
  if (input.filter !== undefined && input.filter !== null && filter === null) return null
  const rebuild = input.rebuild === undefined ? false : input.rebuild
  if (typeof rebuild !== 'boolean') return null
  if (source.id !== null && filter?.sourceIds && !filter.sourceIds.includes(source.id)) return null
  if (source.type !== 'all' && filter?.sourceType && filter.sourceType !== source.type) return null
  return Object.freeze({ source, ...(filter === null ? {} : { filter }), rebuild })
}

function normalizeTask(task) {
  if (!isPlainObject(task) || task.taskType !== RAG_INDEX_TASK_TYPE) return null
  if (task.processorVersion !== undefined && task.processorVersion !== RAG_INDEX_PROCESSOR_VERSION) return null
  if (task.executionClass !== undefined && task.executionClass !== RAG_INDEX_EXECUTION_CLASS) return null
  if (task.subjectType !== undefined && task.subjectType !== RAG_INDEX_SUBJECT_TYPE) return null
  if (task.subjectId !== undefined && String(task.subjectId) !== RAG_INDEX_SUBJECT_ID) return null
  return normalizeRagIndexTaskInput(task.input)
}

function sourceSelected(source, input) {
  if (!isPlainObject(source)) return false
  const sourceType = source.sourceType ?? source.source_type
  const sourceId = positiveId(source.sourceId ?? source.source_id)
  if (!SOURCE_TYPES.has(sourceType) || sourceId === null) return false
  if (input.source.type !== 'all' && sourceType !== input.source.type) return false
  if (input.source.id !== null && sourceId !== input.source.id) return false
  if (input.filter?.sourceType && sourceType !== input.filter.sourceType) return false
  if (input.filter?.sourceIds && !input.filter.sourceIds.includes(sourceId)) return false
  return true
}

function filterCollected(report, input) {
  if (!isPlainObject(report)) return null
  if (!Array.isArray(report.sources) || !Array.isArray(report.errors)) return null
  const sources = report.sources.filter((source) => sourceSelected(source, input))
  const errors = report.errors.filter((error) => {
    if (!isPlainObject(error)) return false
    const sourceType = error.sourceType ?? error.source_type
    const sourceId = error.sourceId ?? error.source_id
    if (sourceType === undefined && sourceId === undefined) return true
    return sourceSelected({ sourceType, sourceId }, input)
  })
  return Object.freeze({
    sources: Object.freeze([...sources]),
    errors: Object.freeze([...errors])
  })
}

const EMBEDDING_ENQUEUE_ERROR_CODES = Object.freeze({
  TASK_STORE_UNAVAILABLE: 'RAG_EMBEDDING_TASK_STORE_UNAVAILABLE',
  RUNTIME_UNAVAILABLE: 'RAG_EMBEDDING_RUNTIME_UNAVAILABLE',
  ENQUEUE_FAILED: 'RAG_EMBEDDING_ENQUEUE_FAILED'
})

function recordEmbeddingEnqueueError(database, snapshotId, errorCode, embeddingModelId = null) {
  if (!database?.prepare || positiveId(snapshotId) === null ||
      (embeddingModelId !== null && positiveId(embeddingModelId) === null) ||
      typeof errorCode !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,127}$/u.test(errorCode)) return
  try {
    database.prepare(`
      UPDATE rag_snapshot_embedding_state
         SET status = 'pending', last_error_code = ?, updated_at = ?
       WHERE snapshot_id = ?
         AND status <> 'active'
         AND snapshot_id IN (
           SELECT active_snapshot_id FROM rag_source_state WHERE active_snapshot_id = ?
         )
         AND embedding_model_id = COALESCE(?, (
           SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END
             FROM rag_embedding_models
            WHERE status = 'active'
         ))
    `).run(errorCode, new Date().toISOString(), snapshotId, snapshotId, embeddingModelId)
  } catch {}
}

function mapError(error, signal) {
  if (error instanceof TaskProcessorError) return error
  const code = String(error?.code ?? '')
  if (signal?.aborted || code === RAG_INDEX_TASK_ERROR_CODES.CANCELLED || code === 'RAG_SOURCE_CANCELLED' ||
      code === 'ABORT_ERR' || error?.name === 'AbortError' ||
      (error instanceof RagTextIndexError && error.code === RAG_TEXT_INDEX_ERROR_CODES.INTERRUPTED)) {
    return taskError(RAG_INDEX_TASK_ERROR_CODES.CANCELLED, 'RAG index refresh was cancelled.', false)
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT') {
    return taskError(RAG_INDEX_TASK_ERROR_CODES.DATABASE_BUSY, 'RAG index storage is temporarily busy.', true)
  }
  if (error instanceof RagTextIndexError && error.code === RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID) {
    return taskError(RAG_INDEX_TASK_ERROR_CODES.INPUT_INVALID, 'RAG index input is invalid.', false)
  }
  return taskError(RAG_INDEX_TASK_ERROR_CODES.FAILED, 'RAG index refresh failed.', false)
}

export function createRagIndexTaskProcessor({
  database,
  databaseProvider = getDatabase,
  collectSources = collectRagSources,
  serviceFactory = createRagTextIndexService,
  taskStoreProvider = () => getTaskRuntime().getStore(),
  embeddingRuntimeFactory = createRagEmbeddingRuntime
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof collectSources !== 'function') throw new TypeError('collectSources must be a function')
  if (typeof serviceFactory !== 'function') throw new TypeError('serviceFactory must be a function')
  if (typeof taskStoreProvider !== 'function') throw new TypeError('taskStoreProvider must be a function')
  if (typeof embeddingRuntimeFactory !== 'function') throw new TypeError('embeddingRuntimeFactory must be a function')

  const enqueueEmbeddingWork = async (result, databaseConnection, context) => {
    if (!isPlainObject(result) || !Array.isArray(result.sources) || context.signal?.aborted) return
    const sources = result.sources.filter((source) =>
      isPlainObject(source) && source.status !== 'failed' && positiveId(source.snapshotId) !== null
    )
    if (sources.length === 0) return
    let taskStore
    try {
      taskStore = await Promise.resolve(taskStoreProvider({ database: databaseConnection, context }))
    } catch {
      for (const source of sources) recordEmbeddingEnqueueError(
        databaseConnection,
        source.snapshotId,
        EMBEDDING_ENQUEUE_ERROR_CODES.TASK_STORE_UNAVAILABLE
      )
      return
    }
    if (!taskStore) {
      for (const source of sources) recordEmbeddingEnqueueError(
        databaseConnection,
        source.snapshotId,
        EMBEDDING_ENQUEUE_ERROR_CODES.TASK_STORE_UNAVAILABLE
      )
      return
    }
    let runtime
    try {
      runtime = await Promise.resolve(embeddingRuntimeFactory({
        database: databaseConnection,
        taskStore,
        signal: context.signal
      }))
    } catch {
      for (const source of sources) recordEmbeddingEnqueueError(
        databaseConnection,
        source.snapshotId,
        EMBEDDING_ENQUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE
      )
      return
    }
    if (!runtime || typeof runtime.enqueueBatch !== 'function' || !Number.isSafeInteger(runtime.embeddingModelId)) {
      for (const source of sources) recordEmbeddingEnqueueError(
        databaseConnection,
        source.snapshotId,
        EMBEDDING_ENQUEUE_ERROR_CODES.RUNTIME_UNAVAILABLE
      )
      return
    }
    for (const source of sources) {
      if (context.signal?.aborted) return
      try {
        // Enqueueing is intentionally best-effort for the text path.  An
        // offline worker leaves the embedding state pending; it never turns a
        // successfully committed FTS refresh into a failed index task.
        await Promise.resolve(runtime.enqueueBatch({
          snapshotId: positiveId(source.snapshotId),
          embeddingModelId: runtime.embeddingModelId,
          retryFailed: true
        }))
      } catch (error) {
        recordEmbeddingEnqueueError(
          databaseConnection,
          source.snapshotId,
          typeof error?.code === 'string' ? error.code : EMBEDDING_ENQUEUE_ERROR_CODES.ENQUEUE_FAILED,
          runtime.embeddingModelId
        )
      }
    }
  }

  return async function processRagIndexTask(context = {}) {
    const input = normalizeTask(context.task)
    if (!input) throw taskError(RAG_INDEX_TASK_ERROR_CODES.INPUT_INVALID, 'RAG index input is invalid.', false)
    if (context.signal?.aborted) throw taskError(RAG_INDEX_TASK_ERROR_CODES.CANCELLED, 'RAG index refresh was cancelled.', false)
    try {
      const databaseConnection = await getDatabaseForTask()
      const progress = typeof context.progress === 'function' ? context.progress : async () => {}
      const collector = async (options = {}) => {
        const collected = await collectSources({
          ...options,
          database: databaseConnection,
          signal: context.signal,
          source: input.source,
          filter: input.filter,
          onProgress: async (value) => progress(Math.round(Number(value) * 0.5))
        })
        const filtered = filterCollected(collected, input)
        if (!filtered) throw taskError(RAG_INDEX_TASK_ERROR_CODES.FAILED, 'RAG source collection failed.', false)
        return filtered
      }
      const service = serviceFactory({ database: databaseConnection, collectSources: collector })
      if (!service || typeof service.refresh !== 'function') {
        throw taskError(RAG_INDEX_TASK_ERROR_CODES.FAILED, 'RAG text index service is unavailable.', false)
      }
      const result = await service.refresh({
        source: input.source,
        filter: input.filter,
        rebuild: input.rebuild,
        signal: context.signal,
        onProgress: async (value) => progress(50 + Math.round(Number(value) * 0.5))
      })
      await enqueueEmbeddingWork(result, databaseConnection, context)
      return result
    } catch (error) {
      throw mapError(error, context.signal)
    }
  }
}

const registeredProcessor = createRagIndexTaskProcessor()
registerTaskProcessor(
  RAG_INDEX_TASK_TYPE,
  RAG_INDEX_PROCESSOR_VERSION,
  RAG_INDEX_EXECUTION_CLASS,
  registeredProcessor
)

export default registeredProcessor
