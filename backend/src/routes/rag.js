import crypto from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { loadRagRerankerModel } from '../config/ragReranker.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import {
  createRagAnswerService,
  RAG_ANSWER_TASK_TYPE
} from '../services/ragAnswerService.js'
import { createRagRerankService, RAG_RERANK_TASK_TYPE } from '../services/ragRerankService.js'
import { createRagHybridRetriever } from '../services/ragHybridRetriever.js'
import {
  createRagQueryRuntime,
  RAG_QUERY_EMBED_TASK_TYPE,
  RAG_QUERY_EMBED_PROCESSOR_VERSION,
  RAG_WORKER_ONLINE_WINDOW_MS,
  readActiveRagEmbeddingModel,
  readRagWorkerAvailability
} from '../services/ragQueryRuntime.js'
import { createRagTextIndexService } from '../services/ragTextIndexService.js'
import {
  normalizeRagIndexTaskInput,
  RAG_INDEX_EXECUTION_CLASS,
  RAG_INDEX_PROCESSOR_VERSION,
  RAG_INDEX_SUBJECT_ID,
  RAG_INDEX_SUBJECT_TYPE,
  RAG_INDEX_TASK_TYPE
} from '../services/ragIndexTaskProcessor.js'
import { enqueueExclusiveRun } from '../services/taskStore.js'
import { getTaskRuntime } from '../services/taskRuntime.js'
import { projectTask } from '../services/taskTypeCatalog.js'
import {
  RAG_QUERY_RUN_CONTEXT_MAX_BYTES,
  RAG_QUERY_RUN_MAX_ROWS,
  RAG_QUERY_RUN_TABLE,
  RAG_QUERY_RUN_TTL_SECONDS
} from '../config/ragQueryRunSchema.js'

const SOURCE_TABLES = Object.freeze({
  document: 'documents',
  ebook: 'books',
  code_repository: 'code_repositories'
})
const ALLOWED_QUERY_KEYS = new Set(['query', 'q', 'limit'])
const PUBLIC_LOCATOR_KEYS = new Set([
  'route',
  'sectionPath',
  'startLine',
  'endLine',
  'paragraphIndex',
  'paragraphEndIndex',
  'chapterIndex',
  'page',
  'path',
  'heading',
  'anchor'
])
const MAX_QUERY_BYTES = 16_384
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const QUERY_RUN_TTL_MS = RAG_QUERY_RUN_TTL_SECONDS * 1000
const QUERY_PENDING_STATUSES = new Set(['pending', 'leased', 'running', 'queued', 'active'])
const QUERY_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'complete', 'degraded', 'abstained'])
const OPAQUE_RUN_ID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/u
const ANSWER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u
const ANSWER_HASH_PATTERN = /^[a-f0-9]{64}$/u
const RAG_SOURCE_TYPE_PATTERN = /^(?:document|ebook|code_repository)$/u
const RAG_SOURCE_STATUS_PENDING = new Set(['building', 'indexing', 'embedding_pending', 'pending', 'processing'])
const RAG_SOURCE_STATUS_READY = new Set(['text_ready', 'ready', 'active'])
const RAG_SOURCE_STATUS_PARTIAL = new Set(['partial'])

export const RAG_ROUTE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_QUERY_INPUT_INVALID',
  CANDIDATES_INVALID: 'RAG_QUERY_CANDIDATES_INVALID',
  UNAVAILABLE: 'RAG_QUERY_UNAVAILABLE',
  VISIBILITY_FAILED: 'RAG_QUERY_VISIBILITY_FAILED',
  NOT_FOUND: 'RAG_QUERY_NOT_FOUND',
  CANCEL_CONFLICT: 'RAG_QUERY_CANCEL_CONFLICT',
  CANCEL_FAILED: 'RAG_QUERY_CANCEL_FAILED',
  INDEX_INPUT_INVALID: 'RAG_INDEX_INPUT_INVALID',
  INDEX_REFRESH_CONFLICT: 'RAG_INDEX_REFRESH_CONFLICT',
  INDEX_REFRESH_FAILED: 'RAG_INDEX_REFRESH_FAILED',
  SOURCE_STATUS_INPUT_INVALID: 'RAG_SOURCE_STATUS_INPUT_INVALID',
  SOURCE_NOT_FOUND: 'RAG_SOURCE_NOT_FOUND',
  SOURCE_STATUS_UNAVAILABLE: 'RAG_SOURCE_STATUS_UNAVAILABLE'
})

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sendCode(res, status, code) {
  return res.status(status).json({ code })
}

function ownerScope(req) {
  const identity = req?.user?.id ?? req?.user?.username ?? req?.user?.principal ?? 'owner'
  return crypto.createHash('sha256').update(String(identity), 'utf8').digest('hex')
}

function normalizeRunId(value) {
  if (typeof value !== 'string' || !OPAQUE_RUN_ID_PATTERN.test(value)) return null
  return value
}

function safeTaskStatus(value) {
  return typeof value === 'string' && (
    QUERY_PENDING_STATUSES.has(value) || QUERY_TERMINAL_STATUSES.has(value)
  ) ? value : null
}

function safeProgress(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function nowMs() {
  return Date.now()
}

function timestampText(timestamp = nowMs()) {
  return new Date(timestamp).toISOString()
}

function serializeRunContext({ query, evidence, retrieval }) {
  if (typeof query !== 'string' || !Array.isArray(evidence) || !isPlainObject(retrieval)) return null
  const context = {
    query,
    evidence,
    retrieval: {
      query,
      data: evidence,
      total: Number.isSafeInteger(retrieval.total) ? retrieval.total : evidence.length,
      limit: Number.isSafeInteger(retrieval.limit) ? retrieval.limit : DEFAULT_LIMIT,
      offset: Number.isSafeInteger(retrieval.offset) ? retrieval.offset : 0,
      retrieval: isPlainObject(retrieval.retrieval) ? retrieval.retrieval : { mode: 'fts', degraded: true }
    }
  }
  let contextJson
  try { contextJson = JSON.stringify(context) } catch { return null }
  if (typeof contextJson !== 'string' || Buffer.byteLength(contextJson, 'utf8') > RAG_QUERY_RUN_CONTEXT_MAX_BYTES) return null
  return Object.freeze({ context, contextJson })
}

function parseRunContext(row) {
  const contextJson = typeof row?.context_json === 'string'
    ? row.context_json
    : (typeof row?.contextJson === 'string' ? row.contextJson : null)
  if (!contextJson || Buffer.byteLength(contextJson, 'utf8') > RAG_QUERY_RUN_CONTEXT_MAX_BYTES) return null
  let context
  try { context = JSON.parse(contextJson) } catch { return null }
  if (!isPlainObject(context) || typeof context.query !== 'string' || !Array.isArray(context.evidence) ||
      !isPlainObject(context.retrieval) || !Array.isArray(context.retrieval.data)) return null
  return Object.freeze({
    query: context.query,
    evidence: Object.freeze([...context.evidence]),
    retrieval: Object.freeze({ ...context.retrieval, data: Object.freeze([...context.retrieval.data]) })
  })
}

function createUnavailableQueryRunStore() {
  return Object.freeze({
    available: false,
    prune: () => 0,
    get: () => null,
    upsert: () => false,
    updateStatus: () => false
  })
}

function createSqliteQueryRunStore(database) {
  if (!database?.prepare || !hasTable(database, RAG_QUERY_RUN_TABLE)) return createUnavailableQueryRunStore()
  const prune = (timestamp = nowMs()) => {
    const expiresAt = timestampText(timestamp)
    database.prepare(`DELETE FROM ${RAG_QUERY_RUN_TABLE} WHERE expires_at <= ?`).run(expiresAt)
    database.prepare(`
      DELETE FROM ${RAG_QUERY_RUN_TABLE}
       WHERE run_id IN (
         SELECT run_id FROM ${RAG_QUERY_RUN_TABLE}
          ORDER BY updated_at DESC, run_id DESC
          LIMIT -1 OFFSET ?
       )
    `).run(RAG_QUERY_RUN_MAX_ROWS)
  }
  const readAny = (runId) => database.prepare(`
    SELECT run_id, owner_scope, task_id, task_idempotency_key, task_type,
           processor_version, status, context_json, created_at, updated_at, expires_at
      FROM ${RAG_QUERY_RUN_TABLE}
     WHERE run_id = ?
  `).get(runId)
  return {
    available: true,
    prune,
    get(runId, ownerScope) {
      if (normalizeRunId(runId) === null || typeof ownerScope !== 'string') return null
      prune()
      return database.prepare(`
        SELECT run_id, owner_scope, task_id, task_idempotency_key, task_type,
               processor_version, status, context_json, created_at, updated_at, expires_at
          FROM ${RAG_QUERY_RUN_TABLE}
         WHERE run_id = ? AND owner_scope = ? AND expires_at > ?
         LIMIT 1
      `).get(runId, ownerScope, timestampText()) ?? null
    },
    upsert(entry) {
      const runId = normalizeRunId(entry?.runId)
      const owner = typeof entry?.ownerScope === 'string' ? entry.ownerScope : null
      const contextJson = typeof entry?.contextJson === 'string' ? entry.contextJson : null
      const key = entry?.taskKey
      const taskId = positiveId(key?.id)
      const idempotencyKey = typeof key?.idempotencyKey === 'string' && key.idempotencyKey.length <= 256
        ? key.idempotencyKey
        : null
      if (!runId || !owner || !contextJson || (taskId === null && idempotencyKey === null)) return false
      if (Buffer.byteLength(contextJson, 'utf8') > RAG_QUERY_RUN_CONTEXT_MAX_BYTES) return false
      prune()
      const existing = readAny(runId)
      if (existing && existing.owner_scope !== owner) {
        const error = new Error('RAG query identity conflict.')
        error.code = 'RAG_QUERY_IDENTITY_CONFLICT'
        throw error
      }
      const now = timestampText()
      const expires = timestampText(Date.now() + QUERY_RUN_TTL_MS)
      if (existing) {
        database.prepare(`
          UPDATE ${RAG_QUERY_RUN_TABLE}
             SET task_id = ?, task_idempotency_key = ?, task_type = 'rag.answer.generate',
                 processor_version = 'v1', status = ?, context_json = ?, updated_at = ?, expires_at = ?
           WHERE run_id = ? AND owner_scope = ?
        `).run(taskId, idempotencyKey, entry.status === 'active' ? 'running' : 'pending', contextJson, now, expires, runId, owner)
      } else {
        database.prepare(`
          INSERT INTO ${RAG_QUERY_RUN_TABLE} (
            run_id, owner_scope, task_id, task_idempotency_key, task_type,
            processor_version, status, context_json, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, 'rag.answer.generate', 'v1', ?, ?, ?, ?, ?)
        `).run(runId, owner, taskId, idempotencyKey,
          entry.status === 'active' ? 'running' : 'pending', contextJson, now, now, expires)
      }
      prune()
      return true
    },
    updateStatus(runId, ownerScope, status) {
      if (normalizeRunId(runId) === null || typeof ownerScope !== 'string' || !QUERY_TERMINAL_STATUSES.has(status)) return false
      const persistedStatus = status === 'cancelled' || status === 'canceled'
        ? 'cancelled'
        : status === 'failed' ? 'failed' : 'succeeded'
      return database.prepare(`
        UPDATE ${RAG_QUERY_RUN_TABLE}
           SET status = ?, updated_at = ?
         WHERE run_id = ? AND owner_scope = ? AND expires_at > ?
      `).run(persistedStatus, timestampText(), runId, ownerScope, timestampText()).changes > 0
    }
  }
}

function taskKey(task) {
  if (!isPlainObject(task)) return null
  const id = positiveId(task.id)
  const idempotencyKey = typeof task.idempotencyKey === 'string' && task.idempotencyKey.length <= 256
    ? task.idempotencyKey
    : null
  if (id === null && idempotencyKey === null) return null
  return Object.freeze({
    ...(id === null ? {} : { id }),
    ...(idempotencyKey === null ? {} : { idempotencyKey })
  })
}

function isTaskTerminal(status) {
  return QUERY_TERMINAL_STATUSES.has(status)
}

function statusValue(value) {
  return value === 'canceled' ? 'cancelled' : value
}

function failInput(message = RAG_ROUTE_ERROR_CODES.INPUT_INVALID) {
  const error = new Error(message)
  error.code = RAG_ROUTE_ERROR_CODES.INPUT_INVALID
  throw error
}

function normalizeQueryBody(body) {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    failInput()
  }
  if (body.query !== undefined && body.q !== undefined) failInput()
  const rawQuery = body.query ?? body.q
  if (typeof rawQuery !== 'string') failInput()
  const query = rawQuery.normalize('NFKC').trim()
  if (!query || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) {
    failInput()
  }

  const limit = body.limit === undefined ? DEFAULT_LIMIT : body.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) failInput()
  return Object.freeze({ query, limit })
}

function normalizeRagIndexRefreshBody(body) {
  const source = body === undefined || body === null ? {} : body
  const normalized = normalizeRagIndexTaskInput(source)
  if (normalized === null) {
    const error = new Error('RAG index refresh input is invalid.')
    error.code = RAG_ROUTE_ERROR_CODES.INDEX_INPUT_INVALID
    throw error
  }
  return normalized
}

function normalizeRagSourceParams(type, id) {
  if (typeof type !== 'string' || !RAG_SOURCE_TYPE_PATTERN.test(type)) return null
  const sourceId = positiveId(id)
  return sourceId === null ? null : Object.freeze({ sourceType: type, sourceId })
}

function safeStatus(value) {
  return typeof value === 'string' ? value : null
}

function safeCount(value) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function publicSourceVersionId(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized) ||
      /(?:[A-Za-z]:[\\/]|^\\\\|\/(?:home|root|mnt|var|tmp|etc|opt|srv|data)\/|storage[ _-]?key|(?:sha|sha256)[ _-]?hash|[a-f0-9]{64})/iu.test(normalized)) {
    return null
  }
  return normalized
}

function publicModelId(value) {
  return typeof value === 'string' && ANSWER_TOKEN_PATTERN.test(value) ? value : null
}

function publicErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,127}$/u.test(value) ? value : null
}

function sourceStateStatus(value) {
  const status = safeStatus(value)
  if (status === null) return 'missing'
  if (RAG_SOURCE_STATUS_PENDING.has(status)) return 'pending'
  if (RAG_SOURCE_STATUS_PARTIAL.has(status)) return 'partial'
  if (RAG_SOURCE_STATUS_READY.has(status)) return 'ready'
  if (status === 'failed') return 'failed'
  if (status === 'stale') return 'stale'
  return 'unknown'
}

function embeddingOverallStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'missing'
  const statuses = rows.map((row) => safeStatus(row.status)).filter(Boolean)
  if (statuses.length === 0) return 'missing'
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'partial')) return 'partial'
  if (statuses.every((status) => status === 'active' || status === 'ready')) return 'ready'
  if (statuses.some((status) => status === 'indexing' || status === 'pending')) return 'pending'
  if (statuses.some((status) => status === 'stale')) return 'stale'
  return 'unknown'
}

function embeddingStatus(value) {
  const status = safeStatus(value)
  if (status === 'active' || status === 'ready') return 'ready'
  if (status === 'indexing' || status === 'pending' || status === 'processing') return 'pending'
  if (status === 'partial') return 'partial'
  if (status === 'failed') return 'failed'
  if (status === 'stale') return 'stale'
  return 'unknown'
}

function defaultRagSourceStatusProvider({ database, sourceType, sourceId, checks }) {
  if (!database?.prepare || !SOURCE_TABLES[sourceType]) return null
  try {
    const sourceExists = database.prepare(
      `SELECT 1 AS present FROM ${SOURCE_TABLES[sourceType]} WHERE id = ? LIMIT 1`
    ).get(sourceId)
    if (!sourceExists) return null

    const visibilityCandidate = { sourceType, sourceId }
    if (sourceType === 'document') {
      if (!hasTable(database, 'document_versions') || !hasTable(database, 'resource_trash_entries')) return null
      const version = database.prepare(`
        SELECT version_row.id
          FROM document_versions version_row
          JOIN documents document_row ON document_row.id = version_row.document_id
         WHERE version_row.document_id = ?
           AND CAST(version_row.version AS REAL) = CAST(document_row.version AS REAL)
         ORDER BY version_row.id DESC
         LIMIT 1
      `).get(sourceId)
      const versionId = positiveId(version?.id)
      if (versionId === null) return null
      visibilityCandidate.sourceVersionId = String(versionId)
    }
    if (typeof checks?.authoritativeVisibility !== 'function' ||
        checks.authoritativeVisibility(visibilityCandidate) !== true) return null

    const base = {
      source: Object.freeze({ type: sourceType, id: sourceId }),
      snapshot: Object.freeze({ status: 'missing' }),
      chunks: Object.freeze({ status: 'missing', count: 0 }),
      embedding: Object.freeze({ status: 'missing', models: Object.freeze([]) })
    }
    if (!hasTable(database, 'rag_source_snapshots') || !hasTable(database, 'rag_source_state') ||
        !hasTable(database, 'rag_chunks')) return Object.freeze(base)

    const state = database.prepare(`
      SELECT status, active_snapshot_id, last_attempt_snapshot_id, last_error_code, updated_at
        FROM rag_source_state
       WHERE source_type = ? AND source_id = ?
       LIMIT 1
    `).get(sourceType, sourceId)
    const snapshotId = positiveId(state?.active_snapshot_id) ?? positiveId(state?.last_attempt_snapshot_id)
    if (snapshotId === null) {
      return Object.freeze({
        ...base,
        sourceState: Object.freeze({
          status: sourceStateStatus(state?.status),
          errorCode: typeof state?.last_error_code === 'string' ? state.last_error_code : null,
          updatedAt: typeof state?.updated_at === 'string' ? state.updated_at : null
        })
      })
    }

    const snapshot = database.prepare(`
      SELECT id, source_version_id, status, chunk_count, error_count,
             last_error_code, created_at, completed_at
        FROM rag_source_snapshots
       WHERE id = ? AND source_type = ? AND source_id = ?
       LIMIT 1
    `).get(snapshotId, sourceType, sourceId)
    if (!snapshot) return Object.freeze(base)
    const chunkCount = safeCount(database.prepare(
      'SELECT COUNT(*) AS count FROM rag_chunks WHERE snapshot_id = ?'
    ).get(snapshot.id)?.count)
    const snapshotStatus = sourceStateStatus(snapshot.status)
    const snapshotData = Object.freeze({
      id: snapshot.id,
      status: snapshotStatus,
      sourceVersionId: publicSourceVersionId(snapshot.source_version_id),
      chunkCount,
      errorCount: safeCount(snapshot.error_count),
      errorCode: typeof snapshot.last_error_code === 'string' ? snapshot.last_error_code : null,
      createdAt: typeof snapshot.created_at === 'string' ? snapshot.created_at : null,
      completedAt: typeof snapshot.completed_at === 'string' ? snapshot.completed_at : null
    })
    const models = []
    if (hasTable(database, 'rag_snapshot_embedding_state') && hasTable(database, 'rag_embedding_models') &&
        hasTable(database, 'rag_chunk_embeddings')) {
      const rows = database.prepare(`
        SELECT state.embedding_model_id, state.status, state.vector_count, state.error_count,
               state.last_error_code,
               model.provider, model.model_id, model.model_revision,
               SUM(CASE WHEN embeddings.status = 'ready'
                          AND embeddings.chunk_sha256 = chunks.chunk_sha256 THEN 1 ELSE 0 END) AS ready_count
          FROM rag_snapshot_embedding_state state
          JOIN rag_embedding_models model ON model.id = state.embedding_model_id
          LEFT JOIN rag_chunks chunks ON chunks.snapshot_id = state.snapshot_id
          LEFT JOIN rag_chunk_embeddings embeddings
            ON embeddings.chunk_id = chunks.id
           AND embeddings.embedding_model_id = state.embedding_model_id
         WHERE state.snapshot_id = ?
         GROUP BY state.id, state.embedding_model_id, state.status, state.vector_count,
                  state.error_count, state.last_error_code,
                  model.provider, model.model_id, model.model_revision
         ORDER BY state.embedding_model_id ASC
      `).all(snapshot.id)
      for (const row of rows) {
        let taskStatus = null
        let taskErrorCode = null
        if (hasTable(database, 'tasks')) {
          const task = database.prepare(`
            SELECT status, error_code
              FROM tasks
             WHERE task_type = 'rag.embedding.generate'
               AND subject_type = 'rag.embedding.snapshot-model'
               AND subject_id = ?
             ORDER BY id DESC
             LIMIT 1
          `).get(`${snapshot.id}:${row.embedding_model_id}`)
          taskStatus = ['pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled'].includes(task?.status)
            ? task.status
            : null
          taskErrorCode = publicErrorCode(task?.error_code)
        }
        models.push(Object.freeze({
          modelId: publicModelId(row.model_id),
          status: embeddingStatus(row.status),
          vectorCount: safeCount(row.vector_count),
          readyCount: safeCount(row.ready_count),
          errorCount: safeCount(row.error_count),
          errorCode: publicErrorCode(row.last_error_code),
          taskStatus,
          taskErrorCode
        }))
      }
    }
    const rawRows = models
    return Object.freeze({
      source: Object.freeze({ type: sourceType, id: sourceId }),
      sourceState: Object.freeze({
        status: sourceStateStatus(state?.status),
        errorCode: typeof state?.last_error_code === 'string' ? state.last_error_code : null,
        updatedAt: typeof state?.updated_at === 'string' ? state.updated_at : null
      }),
      snapshot: snapshotData,
      chunks: Object.freeze({ status: snapshotStatus, count: chunkCount }),
      embedding: Object.freeze({
        status: embeddingOverallStatus(rawRows),
        models: Object.freeze(models)
      })
    })
  } catch {
    const error = new Error('RAG source status is unavailable.')
    error.code = RAG_ROUTE_ERROR_CODES.SOURCE_STATUS_UNAVAILABLE
    throw error
  }
}

function defaultDatabaseProvider(req) {
  return getDatabase(req)
}

function firstEnvValue(env, names) {
  for (const name of names) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function boundedEnvInteger(value, min, max, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export function readRagAnswerModelFromEnv(env = process.env) {
  const providerRaw = firstEnvValue(env, ['PC_WORKER_ANSWER_PROVIDER', 'RAG_ANSWER_PROVIDER'])
  const modelId = firstEnvValue(env, ['PC_WORKER_ANSWER_MODEL_ID', 'PC_WORKER_LLM_MODEL_ID', 'RAG_ANSWER_MODEL_ID'])
  const modelRevision = firstEnvValue(env, ['PC_WORKER_ANSWER_MODEL_REVISION', 'PC_WORKER_LLM_MODEL_REVISION', 'RAG_ANSWER_MODEL_REVISION'])
  const contextLimitRaw = firstEnvValue(env, [
    'PC_WORKER_ANSWER_CONTEXT_LIMIT',
    'PC_WORKER_ANSWER_CONTEXT_BYTES',
    'PC_WORKER_ANSWER_MAX_CONTEXT_BYTES',
    'RAG_ANSWER_CONTEXT_LIMIT'
  ])
  const maxOutputBytesRaw = firstEnvValue(env, [
    'PC_WORKER_ANSWER_MAX_OUTPUT_BYTES',
    'PC_WORKER_ANSWER_OUTPUT_LIMIT_BYTES',
    'RAG_ANSWER_MAX_OUTPUT_BYTES'
  ])
  const maxEvidenceRaw = firstEnvValue(env, ['PC_WORKER_ANSWER_MAX_EVIDENCE', 'RAG_ANSWER_MAX_EVIDENCE'])
  const configHashRaw = firstEnvValue(env, ['PC_WORKER_ANSWER_CONFIG_HASH', 'RAG_ANSWER_CONFIG_HASH'])
  const dimensionsRaw = firstEnvValue(env, ['PC_WORKER_ANSWER_DIMENSIONS', 'RAG_ANSWER_DIMENSIONS'])
  const inputLimitRaw = firstEnvValue(env, ['PC_WORKER_ANSWER_INPUT_LIMIT', 'RAG_ANSWER_INPUT_LIMIT'])
  const hasConfiguration = [providerRaw, modelId, modelRevision, contextLimitRaw, maxOutputBytesRaw,
    maxEvidenceRaw, configHashRaw, dimensionsRaw, inputLimitRaw].some((value) => value !== null)
  if (!hasConfiguration) return null

  const provider = providerRaw ?? 'openai-compatible'
  const contextLimit = boundedEnvInteger(contextLimitRaw, 1, 1_048_576)
  const maxOutputBytes = boundedEnvInteger(maxOutputBytesRaw, 1, 256 * 1024)
  const maxEvidenceItems = boundedEnvInteger(maxEvidenceRaw, 1, 64, 64)
  const dimensions = boundedEnvInteger(dimensionsRaw, 1, 65_536, 1)
  const inputLimit = boundedEnvInteger(inputLimitRaw, 1, 1_048_576, contextLimit)
  if (!modelId || !modelRevision || !ANSWER_TOKEN_PATTERN.test(provider) ||
      !ANSWER_TOKEN_PATTERN.test(modelId) || !ANSWER_TOKEN_PATTERN.test(modelRevision) ||
      contextLimit === null || maxOutputBytes === null || maxEvidenceItems === null ||
      dimensions === null || inputLimit === null) return null

  const configHash = configHashRaw === null
    ? crypto.createHash('sha256').update(JSON.stringify({
      provider,
      modelId,
      modelRevision,
      contextLimit,
      maxOutputBytes,
      maxEvidenceItems
    })).digest('hex')
    : configHashRaw.toLowerCase()
  if (!ANSWER_HASH_PATTERN.test(configHash)) return null
  return Object.freeze({
    provider,
    modelId,
    modelRevision,
    dimensions,
    inputLimit,
    configHash
  })
}

export function readRagRerankerModelFromEnv(env = process.env) {
  return loadRagRerankerModel(env)
}

function defaultWorkerAvailable({ database, taskType = RAG_ANSWER_TASK_TYPE, model = null } = {}) {
  return readRagWorkerAvailability({
    database,
    taskType,
    processorVersion: taskType === RAG_QUERY_EMBED_TASK_TYPE ? RAG_QUERY_EMBED_PROCESSOR_VERSION : 'v1',
    model
  }).available
}

function hasTable(database, name) {
  try {
    return Boolean(database?.prepare?.(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name))
  } catch {
    return false
  }
}

function positiveId(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function sourceIdentityMatches(row, candidate) {
  if (!row || row.source_type !== candidate.sourceType || Number(row.source_id) !== positiveId(candidate.sourceId)) {
    return false
  }
  if (candidate.sourceVersionId !== undefined && candidate.sourceVersionId !== null &&
      String(row.source_version_id) !== String(candidate.sourceVersionId)) return false
  if (candidate.sourceContentSha256 !== undefined && candidate.sourceContentSha256 !== null &&
      String(row.source_content_sha256) !== String(candidate.sourceContentSha256)) return false
  return true
}

function createAuthoritativeChecks(database) {
  const activeSnapshot = (candidate) => {
    const sourceType = candidate?.sourceType
    const sourceId = positiveId(candidate?.sourceId)
    const snapshotId = positiveId(candidate?.snapshotId)
    if (!SOURCE_TABLES[sourceType] || sourceId === null || snapshotId === null ||
        !database?.prepare || !hasTable(database, 'rag_source_snapshots') ||
        !hasTable(database, 'rag_source_state') || !hasTable(database, 'rag_chunks')) return false
    try {
      const row = database.prepare(`
        SELECT snapshot.id, snapshot.source_type, snapshot.source_id,
               snapshot.source_version_id, snapshot.source_content_sha256,
               snapshot.status, state.active_snapshot_id,
               chunks.id AS chunk_id
          FROM rag_source_snapshots snapshot
          JOIN rag_source_state state
            ON state.source_type = snapshot.source_type
           AND state.source_id = snapshot.source_id
           AND state.active_snapshot_id = snapshot.id
          LEFT JOIN rag_chunks chunks
            ON chunks.id = ? AND chunks.snapshot_id = snapshot.id
         WHERE snapshot.id = ?
           AND snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
      `).get(candidate.chunkId ?? null, snapshotId)
      if (!sourceIdentityMatches(row, candidate) || Number(row.active_snapshot_id) !== snapshotId) return false
      if (candidate.chunkId !== undefined && candidate.chunkId !== null &&
          positiveId(candidate.chunkId) !== Number(row.chunk_id)) return false
      return true
    } catch {
      return false
    }
  }

  const visibility = (candidate) => {
    const sourceType = candidate?.sourceType
    const sourceId = positiveId(candidate?.sourceId)
    const table = SOURCE_TABLES[sourceType]
    if (!table || sourceId === null || !database?.prepare || !hasTable(database, table)) return false
    const predicates = ['domain_source.id = ?']
    const parameters = [sourceId]
    if (hasTable(database, 'resource_trash_entries')) {
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM resource_trash_entries trash
         WHERE trash.resource_type = ? AND trash.resource_id = domain_source.id
      )`)
      parameters.push(sourceType)
    }
    if (sourceType === 'document') {
      const versionId = positiveId(candidate?.sourceVersionId)
      // A document candidate is only authoritative when its exact immutable
      // version can be checked. Missing identity/schema is fail-closed.
      if (versionId === null || !hasTable(database, 'document_versions') ||
          !hasTable(database, 'resource_trash_entries')) return false
      predicates.push(`EXISTS (
        SELECT 1 FROM document_versions version_row
         WHERE version_row.id = ? AND version_row.document_id = domain_source.id
      )`)
      parameters.push(versionId)
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM resource_trash_entries version_trash
         WHERE version_trash.resource_type = 'document_version'
           AND version_trash.resource_id = ?
      )`)
      parameters.push(versionId)
    }
    if (hasTable(database, 'resource_domain_links')) {
      if (hasTable(database, 'resources')) {
        predicates.push(`(
          NOT EXISTS (
            SELECT 1 FROM resource_domain_links link
             WHERE link.domain_type = ? AND link.domain_id = domain_source.id
          )
          OR EXISTS (
            SELECT 1
              FROM resource_domain_links link
              JOIN resources resource ON resource.id = link.resource_id
             WHERE link.domain_type = ?
               AND link.domain_id = domain_source.id
               AND resource.resource_type = ?
               AND resource.lifecycle_status = 'active'
          )
        )`)
        parameters.push(sourceType, sourceType, sourceType)
      } else {
        predicates.push(`NOT EXISTS (
          SELECT 1 FROM resource_domain_links link
           WHERE link.domain_type = ? AND link.domain_id = domain_source.id
        )`)
        parameters.push(sourceType)
      }
    }
    try {
      return Boolean(database.prepare(`
        SELECT 1 FROM ${table} domain_source
         WHERE ${predicates.join(' AND ')}
         LIMIT 1
      `).get(...parameters))
    } catch {
      return false
    }
  }

  return Object.freeze({
    authoritativeActiveSnapshot: activeSnapshot,
    authoritativeVisibility: visibility
  })
}

async function defaultCandidateProvider({
  database,
  req,
  query,
  limit,
  authoritativeVisibility,
  authoritativeActiveSnapshot,
  textIndexServiceFactory,
  queryRuntimeFactory,
  taskStoreProvider,
  workerAvailable
}) {
  const service = await Promise.resolve(textIndexServiceFactory({
    database,
    authoritativeVisibility
  }))
  if (!service || typeof service.query !== 'function') {
    const error = new Error('RAG text index is unavailable.')
    error.code = RAG_ROUTE_ERROR_CODES.CANDIDATES_INVALID
    throw error
  }
  const result = await Promise.resolve(service.query({ q: query, limit, offset: 0 }))
  if (!isPlainObject(result) || !Array.isArray(result.data)) {
    const error = new Error('RAG text candidates are invalid.')
    error.code = RAG_ROUTE_ERROR_CODES.CANDIDATES_INVALID
    throw error
  }
  let vectorOutput = null
  try {
    const taskStore = typeof taskStoreProvider === 'function'
      ? await Promise.resolve(taskStoreProvider({ database, req }))
      : null
    const runtime = await resolveComponent(queryRuntimeFactory, {
      database,
      req,
      taskStore,
      workerAvailable: (context) => workerAvailable({ ...context, database, req }),
      authoritativeVisibility,
      authoritativeActiveSnapshot
    })
    if (runtime && typeof runtime.query === 'function') {
      vectorOutput = await runtime.query({ query, limit })
    }
  } catch (error) {
    vectorOutput = { vectorCandidates: [], vectorError: Object.freeze({ code: error?.code ?? 'VECTOR_UNAVAILABLE' }) }
  }
  return Object.freeze({
    ftsCandidates: result.data,
    ...(vectorOutput?.vectorCandidates === undefined
      ? { vectorCandidates: [], vectorError: Object.freeze({ code: 'VECTOR_UNAVAILABLE' }) }
      : { vectorCandidates: vectorOutput.vectorCandidates }),
    ...(vectorOutput?.vectorError === undefined ? {} : { vectorError: vectorOutput.vectorError }),
    ...(typeof vectorOutput?.candidateResolver === 'function' ? { candidateResolver: vectorOutput.candidateResolver } : {})
  })
}

function defaultTextIndexServiceFactory(options) {
  return createRagTextIndexService(options)
}

function defaultQueryRuntimeFactory(options) {
  return createRagQueryRuntime(options)
}

function defaultHybridRetrieverFactory({ retrievalConfig, checks, candidateResolver }) {
  return createRagHybridRetriever({
    config: retrievalConfig,
    authoritativeVisibility: checks.authoritativeVisibility,
    authoritativeActiveSnapshot: checks.authoritativeActiveSnapshot,
    candidateResolver
  })
}

function defaultTaskStoreProvider() {
  try {
    return getTaskRuntime().getStore()
  } catch {
    return null
  }
}

function defaultTaskRuntimeProvider() {
  try {
    return getTaskRuntime()
  } catch {
    return null
  }
}

function defaultAnswerServiceFactory({ answerConfig, checks, taskStore, workerAvailable, model }) {
  return createRagAnswerService({
    config: answerConfig,
    taskStore,
    workerAvailable,
    model,
    authoritativeVisibility: checks.authoritativeVisibility,
    authoritativeActiveSnapshot: checks.authoritativeActiveSnapshot
  })
}

function defaultRerankerServiceFactory({ rerankerConfig, taskStore, workerAvailable, model }) {
  return createRagRerankService({
    ...rerankerConfig,
    enabled: model !== null,
    taskStore,
    workerAvailable,
    model
  })
}

function tableCount(database, sql) {
  try {
    const value = database.prepare(sql).get()?.count
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

function readRagTextStatus(database) {
  const requiredTables = ['rag_source_snapshots', 'rag_source_state', 'rag_chunks', 'rag_chunks_fts']
  if (!requiredTables.every((table) => hasTable(database, table))) {
    return Object.freeze({ status: 'missing', snapshotCount: 0, chunkCount: 0 })
  }
  const snapshotCount = tableCount(database, `
    SELECT COUNT(*) AS count
      FROM rag_source_snapshots
     WHERE status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
  `)
  const chunkCount = tableCount(database, 'SELECT COUNT(*) AS count FROM rag_chunks')
  return Object.freeze({ status: 'ready', snapshotCount, chunkCount })
}

function availableValue(value) {
  return value === true || (isPlainObject(value) && value.available === true)
}

async function probeAvailability(provider, context) {
  try {
    const value = await provider(context)
    return Object.freeze({ available: availableValue(value) })
  } catch {
    return Object.freeze({ available: false, unknown: true })
  }
}

function readPcWorkerConnection(database, now = Date.now()) {
  if (!hasTable(database, 'pc_workers')) {
    return Object.freeze({ status: 'unknown', reason: 'registry_unavailable' })
  }
  try {
    const rows = database.prepare(`
      SELECT status, last_seen_at
        FROM pc_workers
       WHERE status = 'active'
    `).all()
    const activeRows = Array.isArray(rows) ? rows.filter((row) => row.status === 'active') : []
    if (activeRows.length === 0) {
      return Object.freeze({ status: 'offline', reason: 'not_registered' })
    }
    const cutoff = now - RAG_WORKER_ONLINE_WINDOW_MS
    const lastSeenValues = activeRows
      .map((row) => Date.parse(row.last_seen_at ?? ''))
      .filter((value) => Number.isFinite(value) && value <= now + 5_000)
    if (lastSeenValues.some((value) => value >= cutoff)) {
      return Object.freeze({ status: 'online', reason: 'heartbeat_recent' })
    }
    return Object.freeze({ status: 'offline', reason: 'heartbeat_stale' })
  } catch {
    return Object.freeze({ status: 'unknown', reason: 'registry_unavailable' })
  }
}

function capabilityState({ configured, probe, connection }) {
  if (!configured) return Object.freeze({ status: 'not_configured', reason: 'configuration_missing' })
  if (probe.unknown) return Object.freeze({ status: 'unknown', reason: 'probe_failed' })
  if (probe.available) return Object.freeze({ status: 'ready', reason: 'capability_advertised' })
  if (connection.status === 'offline') return Object.freeze({ status: 'worker_offline', reason: connection.reason })
  return Object.freeze({ status: 'unavailable', reason: 'capability_not_advertised' })
}

async function readRagStatus({ database, req, workerAvailable, vectorAvailable, model, rerankerModel }) {
  const text = readRagTextStatus(database)
  const embeddingModel = readActiveRagEmbeddingModel(database)?.model ?? null
  const [answerProbe, embeddingProbe, rerankerProbe, vectorProbe] = await Promise.all([
    probeAvailability(workerAvailable, {
      taskType: RAG_ANSWER_TASK_TYPE, model, database, req, phase: 'status'
    }),
    embeddingModel
      ? probeAvailability(workerAvailable, {
        taskType: RAG_QUERY_EMBED_TASK_TYPE, model: embeddingModel, database, req, phase: 'status'
      })
      : Object.freeze({ available: false }),
    rerankerModel
      ? probeAvailability(workerAvailable, {
        taskType: RAG_RERANK_TASK_TYPE, model: rerankerModel, database, req, phase: 'status'
      })
      : Object.freeze({ available: false }),
    probeAvailability(vectorAvailable, { database, req, phase: 'status' })
  ])
  let connection = readPcWorkerConnection(database)
  if (connection.status === 'unknown' && (answerProbe.available || embeddingProbe.available || rerankerProbe.available)) {
    connection = Object.freeze({ status: 'online', reason: 'capability_advertised' })
  }
  const answer = capabilityState({ configured: Boolean(model), probe: answerProbe, connection })
  const embedding = capabilityState({ configured: Boolean(embeddingModel), probe: embeddingProbe, connection })
  const reranker = capabilityState({ configured: Boolean(rerankerModel), probe: rerankerProbe, connection })
  const vectorStatus = vectorProbe.unknown ? 'unknown' : vectorProbe.available ? 'available' : 'unavailable'
  const modelStatus = model ? 'configured' : 'unavailable'
  const status = text.status === 'missing'
    ? 'missing'
    : text.status !== 'ready'
      ? 'failed'
      : answer.status === 'ready' && embedding.status === 'ready' && vectorStatus === 'available'
        ? 'ready'
        : 'degraded'
  const degradedReason = status === 'degraded'
    ? connection.status === 'offline'
      ? 'worker_offline'
      : modelStatus !== 'configured'
        ? 'model_unavailable'
        : answer.status !== 'ready'
          ? 'answer_unavailable'
          : vectorStatus !== 'available'
            ? 'vector_unavailable'
            : embedding.status !== 'ready'
              ? 'embedding_unavailable'
              : 'rag_query_degraded'
    : undefined
  return Object.freeze({
    status,
    text,
    vector: Object.freeze({ status: vectorStatus }),
    model: Object.freeze({ status: modelStatus }),
    pcWorker: connection,
    capabilities: Object.freeze({ answer, embedding, reranker }),
    ...(degradedReason === undefined ? {} : { degradedReason })
  })
}

function resolveComponent(factory, options) {
  if (typeof factory === 'function') return Promise.resolve(factory(options))
  return Promise.resolve(factory)
}

function publicLocator(locator, citationId) {
  if (!isPlainObject(locator)) return { citationId }
  const output = { citationId }
  for (const [key, value] of Object.entries(locator)) {
    if (!PUBLIC_LOCATOR_KEYS.has(key)) continue
    if (/^(?:absolute|storage|db|database|internal|secret|token|credential)/iu.test(key) ||
        /(?:hash|storagekey|storage_key|documentid|bookid|repositoryid|sourceid|snapshotid|versionid|commit)/iu.test(key)) continue
    if (key === 'path' && (typeof value !== 'string' || /^[A-Za-z]:[\\/]|^\\\\|^\//u.test(value))) continue
    if (Array.isArray(value) && value.some((item) => typeof item === 'string' &&
        /(?:[A-Za-z]:[\\/]|^\\\\|\/(?:home|root|mnt|var|tmp|etc|opt|srv|data)\/|storage[ _-]?key|(?:sha|sha256)[ _-]?hash|api[ _-]?key|password|secret|lease[ _-]?token)/iu.test(item))) continue
    if (typeof value === 'string' && /(?:[A-Za-z]:[\\/]|^\\\\|\/(?:home|root|mnt|var|tmp|etc|opt|srv|data)\/|storage[ _-]?key|(?:sha|sha256)[ _-]?hash|api[ _-]?key|password|secret|lease[ _-]?token)/iu.test(value)) continue
    output[key] = value
  }
  return output
}

function publicCitation(item, index) {
  const citationId = `C${index + 1}`
  const citation = { citationId }
  if (isPlainObject(item)) {
    if (typeof item.title === 'string' && !/[A-Za-z]:[\\/]|^\\\\|(?:sha|sha256)[ _-]?hash|storage[ _-]?key|password|secret|(?:source|document|book|repository|snapshot|chunk|database)[ _-]?id\s*[:=]?\s*\d+/iu.test(item.title)) {
      citation.title = item.title
    }
    citation.locator = publicLocator(item.locator, citationId)
  } else {
    citation.locator = { citationId }
  }
  return citation
}

function referenceCitations(evidence) {
  return Array.isArray(evidence) ? evidence.map(publicCitation) : []
}

function languageForQuery(query) {
  return /[\u3400-\u9fff]/u.test(query) ? 'zh' : 'en'
}

function safeAnswerText(value) {
  if (typeof value !== 'string') return null
  if (/(?:[A-Za-z]:[\\/]|^\\\\|\/(?:home|root|mnt|var|tmp|etc|opt|srv|data)\/|storage[ _-]?key|(?:sha|sha256)[ _-]?hash|api[ _-]?key|password|secret|lease[ _-]?token|(?:source|document|book|repository|snapshot|chunk|database)[ _-]?id\s*[:=]?\s*\d+)/iu.test(value)) return null
  return value
}

function fallbackReason(error) {
  const code = String(error?.code ?? error?.reason ?? error ?? '').toUpperCase()
  if (code.includes('TIMEOUT')) return 'model_timeout'
  if (code.includes('SCHEMA') || code.includes('RESULT_INVALID') || code.includes('INPUT_MISMATCH')) return 'model_schema_invalid'
  return 'model_unavailable'
}

function referenceFallback(query, evidence, error) {
  const reason = typeof error === 'string' ? error : fallbackReason(error)
  return Object.freeze({
    status: 'degraded',
    query,
    language: languageForQuery(query),
    answer: null,
    abstained: true,
    reasonCode: reason,
    degraded: true,
    degradedReason: reason,
    citations: referenceCitations(evidence)
  })
}

function isVisibilityError(error) {
  const code = String(error?.code ?? '').toUpperCase()
  return code.includes('VISIBILITY') || code.includes('STALE') || code.includes('FORBIDDEN')
}

function checkPassed(value) {
  return value === true || (isPlainObject(value) && value.visible === true)
}

async function authorizeReturnedEvidence(retrieval, checks, context) {
  if (!isPlainObject(retrieval) || !Array.isArray(retrieval.data)) {
    const error = new Error('RAG retrieval output is invalid.')
    error.code = RAG_ROUTE_ERROR_CODES.CANDIDATES_INVALID
    throw error
  }
  const visible = []
  for (const candidate of retrieval.data) {
    try {
      const active = await checks.authoritativeActiveSnapshot(candidate, context)
      if (!checkPassed(active)) continue
      const allowed = await checks.authoritativeVisibility(candidate, context)
      if (!checkPassed(allowed)) continue
      visible.push(candidate)
    } catch {
      const error = new Error('Authoritative RAG visibility check failed.')
      error.code = RAG_ROUTE_ERROR_CODES.VISIBILITY_FAILED
      throw error
    }
  }
  return Object.freeze({
    ...retrieval,
    data: Object.freeze(visible),
    total: visible.length
  })
}

function projectAnswer(answer, retrieval, runId) {
  const result = isPlainObject(answer) ? answer : {}
  const safeAnswer = safeAnswerText(result.answer)
  const unsafeAnswer = typeof result.answer === 'string' && safeAnswer === null
  const projected = {
    status: unsafeAnswer ? 'degraded' : (typeof result.status === 'string' ? result.status : 'degraded'),
    ...(typeof result.query === 'string' ? { query: result.query } : {}),
    ...(typeof result.language === 'string' ? { language: result.language } : {}),
    answer: unsafeAnswer ? null : safeAnswer,
    abstained: unsafeAnswer || result.abstained === true,
    ...(unsafeAnswer
      ? { reasonCode: 'unsafe_output' }
      : (typeof result.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {})),
    degraded: unsafeAnswer || result.degraded === true,
    ...(unsafeAnswer
      ? { degradedReason: 'unsafe_output' }
      : (typeof result.degradedReason === 'string' ? { degradedReason: result.degradedReason } : {})),
    citations: Array.isArray(result.citations) ? result.citations.map(publicCitation) : []
  }
  if (Array.isArray(result.omitted)) {
    projected.omitted = result.omitted.map((item, index) => ({
      citationId: `C${index + 1}`,
      reason: typeof item?.reason === 'string' ? item.reason : 'omitted'
    }))
  }
  if (projected.status === 'queued' || projected.status === 'active') {
    projected.runId = runId
    projected.cancellable = true
  }
  projected.retrieval = {
    mode: retrieval?.retrieval?.mode === 'hybrid' ? 'hybrid' : 'fts',
    degraded: retrieval?.retrieval?.degraded === true,
    ...(typeof retrieval?.retrieval?.degradedReason === 'string'
      ? { degradedReason: retrieval.retrieval.degradedReason }
      : {}),
    fusion: 'rrf',
    total: Number.isSafeInteger(retrieval?.total) ? retrieval.total : projected.citations.length,
    limit: Number.isSafeInteger(retrieval?.limit) ? retrieval.limit : undefined,
    ...(isPlainObject(retrieval?.retrieval?.reranker)
      ? {
          reranker: {
            status: retrieval.retrieval.reranker.status === 'applied' ? 'applied' : 'unavailable',
            ...(typeof retrieval.retrieval.reranker.reason === 'string'
              ? { reason: retrieval.retrieval.reranker.reason }
              : {})
          }
        }
      : {})
  }
  if (projected.retrieval.limit === undefined) delete projected.retrieval.limit
  return projected
}

function projectPendingQuery(runId, status, task, canCancel = true) {
  const publicStatus = status === 'queued' ? 'pending' : status === 'active' ? 'running' : status
  const leaseOwner = task?.leaseOwner ?? task?.lease_owner
  const leaseToken = task?.leaseToken ?? task?.lease_token
  const cancellable = canCancel && (publicStatus === 'pending' ||
    ((publicStatus === 'leased' || publicStatus === 'running') &&
      typeof leaseOwner === 'string' && leaseOwner.length > 0 &&
      typeof leaseToken === 'string' && leaseToken.length > 0))
  const projected = {
    runId,
    status: QUERY_PENDING_STATUSES.has(status) ? publicStatus : 'pending',
    cancellable
  }
  const progress = safeProgress(task?.progress)
  if (progress !== undefined) projected.progress = progress
  return projected
}

function projectCancelledQuery(runId) {
  return {
    runId,
    status: 'cancelled',
    cancellable: false,
    abstained: true,
    reasonCode: 'cancelled',
    degraded: false,
    citations: []
  }
}

function projectFailedQuery(runId) {
  return {
    runId,
    status: 'failed',
    cancellable: false,
    errorCode: 'RAG_QUERY_FAILED',
    abstained: true,
    degraded: true,
    reasonCode: 'task_failed',
    citations: []
  }
}

async function readTrackedTask(entry, { database, req, taskStoreProvider }) {
  let store = entry.taskStore
  if ((!store || (typeof store.getById !== 'function' && typeof store.getByIdempotencyKey !== 'function')) &&
      typeof taskStoreProvider === 'function') {
    try { store = await Promise.resolve(taskStoreProvider({ database, req })) } catch {}
  }
  const key = entry.taskKey
  if (!store || !key) return { store, task: entry.task, persistent: false }
  if (key.id !== undefined && typeof store.getById === 'function') {
    try {
      return { store, task: await Promise.resolve(store.getById(key.id)), persistent: true }
    } catch (error) {
      if (error?.code === 'TASK_NOT_FOUND') return { store, task: null, persistent: true }
      throw error
    }
  }
  if (key.idempotencyKey !== undefined && typeof store.getByIdempotencyKey === 'function') {
    try {
      return { store, task: await Promise.resolve(store.getByIdempotencyKey(key.idempotencyKey)), persistent: true }
    } catch (error) {
      if (error?.code === 'TASK_NOT_FOUND') return { store, task: null, persistent: true }
      throw error
    }
  }
  return { store, task: entry.task, persistent: false }
}

function taskKeyFromPersistedRow(row) {
  const id = positiveId(row?.task_id ?? row?.taskId)
  const idempotencyKey = typeof (row?.task_idempotency_key ?? row?.taskIdempotencyKey) === 'string' &&
      (row.task_idempotency_key ?? row.taskIdempotencyKey).length <= 256
    ? (row.task_idempotency_key ?? row.taskIdempotencyKey)
    : null
  if (id === null && idempotencyKey === null) return null
  return Object.freeze({
    ...(id === null ? {} : { id }),
    ...(idempotencyKey === null ? {} : { idempotencyKey })
  })
}

async function loadPersistedQueryEntry({
  row,
  database,
  req,
  authoritativeChecksFactory,
  resolvedAnswerServiceFactory,
  taskStoreProvider,
  workerAvailable,
  model,
  answerConfig
}) {
  const runId = normalizeRunId(row?.run_id ?? row?.runId)
  const owner = row?.owner_scope ?? row?.ownerScope
  const context = parseRunContext(row)
  const taskKey = taskKeyFromPersistedRow(row)
  if (runId === null || typeof owner !== 'string' || !context || !taskKey ||
      row?.task_type !== undefined && row.task_type !== RAG_ANSWER_TASK_TYPE ||
      row?.processor_version !== undefined && row.processor_version !== 'v1') return null

  const checks = await Promise.resolve(authoritativeChecksFactory({ database, req }))
  if (!checks || typeof checks.authoritativeVisibility !== 'function' ||
      typeof checks.authoritativeActiveSnapshot !== 'function') return null
  let taskStore = null
  if (typeof taskStoreProvider === 'function') {
    try { taskStore = await Promise.resolve(taskStoreProvider({ database, req })) } catch {}
  }
  let answerService = null
  try {
    answerService = await resolveComponent(resolvedAnswerServiceFactory, {
      database,
      req,
      checks,
      taskStore,
      workerAvailable: (contextValue) => workerAvailable({ ...contextValue, database, req }),
      model,
      answerConfig
    })
  } catch {}
  return {
    runId,
    ownerScope: owner,
    query: context.query,
    evidence: context.evidence,
    retrieval: context.retrieval,
    checks,
    answerService,
    taskStore,
    task: null,
    taskKey,
    status: statusValue(row.status ?? 'pending'),
    initialAnswer: null,
    updatedAt: Date.parse(row.updated_at ?? row.updatedAt ?? '') || nowMs()
  }
}

async function projectTrackedQuery(entry, task, req) {
  const status = statusValue(safeTaskStatus(task?.status) ?? safeTaskStatus(entry.status) ?? 'pending')
  entry.status = status
  entry.updatedAt = nowMs()
  if (QUERY_PENDING_STATUSES.has(status)) {
    return projectPendingQuery(entry.runId, status, task, typeof entry.taskStore?.cancel === 'function')
  }
  if (status === 'cancelled') return projectCancelledQuery(entry.runId)
  if (status === 'failed') return projectFailedQuery(entry.runId)

  const checks = entry.checks
  let retrieval = entry.retrieval
  if (!checks || typeof checks.authoritativeActiveSnapshot !== 'function' ||
      typeof checks.authoritativeVisibility !== 'function') {
    return projectAnswer(referenceFallback(entry.query, [], 'evidence_stale'), retrieval, entry.runId)
  }
  try {
    retrieval = await authorizeReturnedEvidence(retrieval, checks, {
      phase: 'query_read',
      query: entry.query,
      req
    })
  } catch {
    return projectAnswer(referenceFallback(entry.query, [], 'evidence_stale'), retrieval, entry.runId)
  }
  const originalCount = Array.isArray(entry.evidence) ? entry.evidence.length : retrieval.data.length
  if (retrieval.data.length < originalCount) {
    return projectAnswer(referenceFallback(entry.query, retrieval.data, 'evidence_stale'), retrieval, entry.runId)
  }

  let answer
  const applyResult = entry.answerService?.applyResult ?? entry.answerService?.complete
  if (typeof applyResult === 'function' && isPlainObject(task)) {
    try {
      answer = await applyResult.call(entry.answerService, {
        task,
        result: task.result,
        evidence: entry.evidence
      })
    } catch (error) {
      answer = referenceFallback(entry.query, retrieval.data, isVisibilityError(error) ? 'evidence_stale' : error)
    }
  } else if (isPlainObject(task?.result)) {
    answer = task.result
  } else if (isPlainObject(entry.initialAnswer) &&
      !QUERY_PENDING_STATUSES.has(entry.initialAnswer.status)) {
    answer = entry.initialAnswer
  } else {
    answer = referenceFallback(entry.query, retrieval.data, 'model_unavailable')
  }
  if (isPlainObject(answer) && (typeof answer.query !== 'string' || answer.query.length === 0)) {
    answer = { ...answer, query: entry.query }
  }
  return projectAnswer(answer, retrieval, entry.runId)
}

async function cancelTrackedTask(store, task) {
  if (!store || typeof store.cancel !== 'function' || !isPlainObject(task)) {
    const error = new Error('RAG query cannot be cancelled.')
    error.code = RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT
    throw error
  }
  const id = positiveId(task.id)
  if (id === null) {
    const error = new Error('RAG query task identity is unavailable.')
    error.code = RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT
    throw error
  }
  const status = statusValue(safeTaskStatus(task.status) ?? '')
  if (status === 'pending') return store.cancel(id)
  if (status !== 'leased' && status !== 'running') {
    const error = new Error('RAG query is already terminal.')
    error.code = RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT
    throw error
  }
  const owner = task.leaseOwner ?? task.lease_owner
  const token = task.leaseToken ?? task.lease_token
  if (typeof owner !== 'string' || typeof token !== 'string' || !owner || !token) {
    const error = new Error('RAG query lease credentials are unavailable.')
    error.code = RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT
    throw error
  }
  return store.cancel(id, { owner, token })
}

function queryError(res, error) {
  const code = error?.code
  if (code === RAG_ROUTE_ERROR_CODES.INPUT_INVALID) return sendCode(res, 400, code)
  if (code === RAG_ROUTE_ERROR_CODES.CANDIDATES_INVALID) return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
  if (code === RAG_ROUTE_ERROR_CODES.NOT_FOUND) return sendCode(res, 404, code)
  if (code === RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT) return sendCode(res, 409, code)
  if (code === RAG_ROUTE_ERROR_CODES.CANCEL_FAILED) return sendCode(res, 503, code)
  if (isVisibilityError(error)) return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.VISIBILITY_FAILED)
  return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
}

export function createRagRouter({
  databaseProvider = defaultDatabaseProvider,
  authoritativeChecksFactory = ({ database }) => createAuthoritativeChecks(database),
  textIndexServiceFactory = defaultTextIndexServiceFactory,
  candidateProvider = null,
  retrieveCandidates = null,
  queryRuntimeFactory = defaultQueryRuntimeFactory,
  hybridRetrieverFactory = defaultHybridRetrieverFactory,
  hybridRetriever = null,
  answerServiceFactory = defaultAnswerServiceFactory,
  answerService = null,
  rerankerServiceFactory = defaultRerankerServiceFactory,
  rerankerService = null,
  taskStoreProvider = defaultTaskStoreProvider,
  taskRuntimeProvider = defaultTaskRuntimeProvider,
  enqueue = enqueueExclusiveRun,
  sourceStatusProvider = defaultRagSourceStatusProvider,
  workerAvailable = defaultWorkerAvailable,
  vectorAvailable = null,
  model = undefined,
  rerankerModel = undefined,
  retrievalConfig = {},
  answerConfig = {},
  rerankerConfig = {},
  requestIdFactory = () => crypto.randomUUID(),
  queryRunStore = null
} = {}) {
  const router = express.Router()
  router.use(requireOwner)
  const resolveConfiguredModel = () => model === undefined ? readRagAnswerModelFromEnv() : model
  const resolveConfiguredRerankerModel = () => rerankerModel === undefined
    ? readRagRerankerModelFromEnv()
    : rerankerModel
  const resolveQueryRunStore = async (database, req) => {
    if (typeof queryRunStore === 'function') {
      try { return await Promise.resolve(queryRunStore({ database, req })) } catch { return createUnavailableQueryRunStore() }
    }
    if (queryRunStore && typeof queryRunStore === 'object') return queryRunStore
    return createSqliteQueryRunStore(database)
  }

  const resolvedCandidateProvider = retrieveCandidates ?? candidateProvider ?? ((options) => defaultCandidateProvider({
    ...options,
    textIndexServiceFactory,
    queryRuntimeFactory,
    taskStoreProvider,
    workerAvailable
  }))
  const resolvedHybridRetrieverFactory = hybridRetriever ?? hybridRetrieverFactory
  const resolvedAnswerServiceFactory = answerService ?? answerServiceFactory
  const resolvedRerankerServiceFactory = rerankerService ?? rerankerServiceFactory
  const resolvedVectorAvailable = vectorAvailable ?? (async ({ database, req, phase } = {}) => {
    try {
      const taskStore = typeof taskStoreProvider === 'function'
        ? await Promise.resolve(taskStoreProvider({ database, req }))
        : null
      const runtime = await resolveComponent(queryRuntimeFactory, {
        database,
        req,
        taskStore,
        workerAvailable: (context) => workerAvailable({ ...context, database, req }),
        phase
      })
      return runtime && typeof runtime.vectorAvailability === 'function'
        ? await runtime.vectorAvailability()
        : false
    } catch {
      return false
    }
  })

  router.get('/status', async (req, res) => {
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const status = await readRagStatus({
        database,
        req,
        workerAvailable: (context) => workerAvailable({ ...context, database, req }),
        vectorAvailable: (context) => resolvedVectorAvailable({ ...context, database, req }),
        model: resolveConfiguredModel(),
        rerankerModel: resolveConfiguredRerankerModel()
      })
      return res.json({ data: status })
    } catch {
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
    }
  })

  router.post('/index/refresh', requireWritePermission, async (req, res) => {
    let input
    try {
      input = normalizeRagIndexRefreshBody(req.body)
    } catch {
      return sendCode(res, 400, RAG_ROUTE_ERROR_CODES.INDEX_INPUT_INVALID)
    }
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const runtime = typeof taskRuntimeProvider === 'function' ? taskRuntimeProvider() : null
      let store = null
      try { store = runtime?.getStore?.() ?? null } catch {}
      const enqueueOperation = store && typeof store.enqueueExclusiveRun === 'function'
        ? (value, options) => store.enqueueExclusiveRun(value, options)
        : (value, options) => enqueue(database, value, options)
      const identity = String(requestIdFactory()).normalize('NFKC').trim()
      if (!identity || identity.length > 128 || /[\u0000-\u001f\u007f]/u.test(identity)) {
        return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.INDEX_REFRESH_FAILED)
      }
      const taskInput = {
        taskType: RAG_INDEX_TASK_TYPE,
        processorVersion: RAG_INDEX_PROCESSOR_VERSION,
        subjectType: RAG_INDEX_SUBJECT_TYPE,
        subjectId: RAG_INDEX_SUBJECT_ID,
        subjectVersionId: identity,
        executionClass: RAG_INDEX_EXECUTION_CLASS,
        input
      }
      const outcome = await Promise.resolve(enqueueOperation(taskInput, {
        mutexTaskTypes: [RAG_INDEX_TASK_TYPE]
      }))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict') {
        return sendCode(res, 409, RAG_ROUTE_ERROR_CODES.INDEX_REFRESH_CONFLICT)
      }
      const data = projectTask(outcome.task)
      if (!data || data.taskType !== RAG_INDEX_TASK_TYPE) {
        return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.INDEX_REFRESH_FAILED)
      }
      return res.status(202).json({ data })
    } catch (error) {
      if (error?.code === 'TASK_STATE_CONFLICT') {
        return sendCode(res, 409, RAG_ROUTE_ERROR_CODES.INDEX_REFRESH_CONFLICT)
      }
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.INDEX_REFRESH_FAILED)
    }
  })

  router.get('/sources/:type/:id/status', async (req, res) => {
    const source = normalizeRagSourceParams(req.params.type, req.params.id)
    if (source === null) return sendCode(res, 400, RAG_ROUTE_ERROR_CODES.SOURCE_STATUS_INPUT_INVALID)
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const checks = await Promise.resolve(authoritativeChecksFactory({ database, req }))
      // The built-in document status provider resolves and checks the exact
      // current document version before returning status. Injected providers
      // retain the route-level identity check for test/application adapters.
      const providerDoesVersionCheck = source.sourceType === 'document' &&
        sourceStatusProvider === defaultRagSourceStatusProvider
      if (!checks || typeof checks.authoritativeVisibility !== 'function' ||
          (!providerDoesVersionCheck && checks.authoritativeVisibility({
            sourceType: source.sourceType,
            sourceId: source.sourceId
          }) !== true)) {
        return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.SOURCE_NOT_FOUND)
      }
      const data = await Promise.resolve(sourceStatusProvider({
        database,
        req,
        checks,
        sourceType: source.sourceType,
        sourceId: source.sourceId
      }))
      if (data === null || data === undefined) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.SOURCE_NOT_FOUND)
      return res.json({ data })
    } catch (error) {
      if (error?.code === RAG_ROUTE_ERROR_CODES.SOURCE_STATUS_INPUT_INVALID) {
        return sendCode(res, 400, error.code)
      }
      if (error?.code === RAG_ROUTE_ERROR_CODES.SOURCE_NOT_FOUND) {
        return sendCode(res, 404, error.code)
      }
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.SOURCE_STATUS_UNAVAILABLE)
    }
  })

  router.post('/queries', async (req, res) => {
    let input
    try {
      input = normalizeQueryBody(req.body)
    } catch (error) {
      return queryError(res, error)
    }

    try {
      const database = await Promise.resolve(databaseProvider(req))
      const checks = await Promise.resolve(authoritativeChecksFactory({ database, req }))
      if (!checks || typeof checks.authoritativeVisibility !== 'function' ||
          typeof checks.authoritativeActiveSnapshot !== 'function') {
        const error = new Error('Authoritative RAG checks are unavailable.')
        error.code = RAG_ROUTE_ERROR_CODES.VISIBILITY_FAILED
        throw error
      }
      const providerOutput = await Promise.resolve(resolvedCandidateProvider({
        database,
        req,
        query: input.query,
        limit: input.limit,
        authoritativeVisibility: checks.authoritativeVisibility,
        authoritativeActiveSnapshot: checks.authoritativeActiveSnapshot
      }))
      if (!isPlainObject(providerOutput) || !Array.isArray(providerOutput.ftsCandidates)) {
        const error = new Error('RAG candidate provider output is invalid.')
        error.code = RAG_ROUTE_ERROR_CODES.CANDIDATES_INVALID
        throw error
      }

      const retriever = await resolveComponent(resolvedHybridRetrieverFactory, {
        database,
        req,
        checks,
        retrievalConfig,
        candidateResolver: typeof providerOutput.candidateResolver === 'function'
          ? providerOutput.candidateResolver
          : null
      })
      if (!retriever || typeof retriever.retrieve !== 'function') {
        const error = new Error('RAG retriever is unavailable.')
        error.code = RAG_ROUTE_ERROR_CODES.UNAVAILABLE
        throw error
      }
      const retrieval = await retriever.retrieve({
        query: input.query,
        ftsCandidates: providerOutput.ftsCandidates,
        ...(providerOutput.vectorCandidates === undefined
          ? {}
          : { vectorCandidates: providerOutput.vectorCandidates }),
        ...(providerOutput.vectorError === undefined ? {} : { vectorError: providerOutput.vectorError }),
        limit: input.limit,
        offset: 0
      })
      const authorizedRetrieval = await authorizeReturnedEvidence(retrieval, checks, {
        phase: 'route_final',
        query: input.query,
        req
      })

      let taskStore = null
      try { taskStore = await Promise.resolve(taskStoreProvider({ database, req })) } catch {}
      let rankedRetrieval = authorizedRetrieval
      if (authorizedRetrieval.data.length > 0) {
        try {
          const resolvedReranker = await resolveComponent(resolvedRerankerServiceFactory, {
            database,
            req,
            taskStore,
            workerAvailable: (context) => workerAvailable({ ...context, database, req }),
            model: resolveConfiguredRerankerModel(),
            rerankerConfig
          })
          if (resolvedReranker && typeof resolvedReranker.rerank === 'function') {
            const window = authorizedRetrieval.data.slice(0, 10)
            const reranked = await resolvedReranker.rerank({ query: input.query, candidates: window })
            if (Array.isArray(reranked?.candidates) && reranked.candidates.length === window.length) {
              const combined = [...reranked.candidates, ...authorizedRetrieval.data.slice(window.length)]
              rankedRetrieval = Object.freeze({
                ...authorizedRetrieval,
                data: Object.freeze(combined),
                total: combined.length,
                retrieval: Object.freeze({
                  ...authorizedRetrieval.retrieval,
                  reranker: Object.freeze({
                    status: reranked.applied === true ? 'applied' : 'unavailable',
                    ...(typeof reranked.reason === 'string' ? { reason: reranked.reason } : {})
                  })
                })
              })
            }
          }
        } catch {}
      }
      rankedRetrieval = await authorizeReturnedEvidence(rankedRetrieval, checks, {
        phase: 'route_post_rerank',
        query: input.query,
        req
      })

      const evidence = rankedRetrieval.data
      let answer
      let resolvedAnswerService = null
      let runStore = null
      const persistedContext = evidence.length > 0
        ? serializeRunContext({ query: input.query, evidence, retrieval: rankedRetrieval })
        : null
      if (!Array.isArray(evidence) || evidence.length === 0) {
        answer = {
          status: 'abstained',
          query: input.query,
          language: languageForQuery(input.query),
          answer: null,
          abstained: true,
          reasonCode: 'no_evidence',
          degraded: false,
          citations: []
        }
      } else if (!persistedContext) {
        answer = referenceFallback(input.query, evidence, 'query_context_too_large')
      } else {
        const workerAvailability = (context) => workerAvailable({ ...context, database, req })
        resolvedAnswerService = await resolveComponent(resolvedAnswerServiceFactory, {
          database,
          req,
          checks,
          taskStore,
          workerAvailable: workerAvailability,
          model: resolveConfiguredModel(),
          answerConfig
        })
        if (!resolvedAnswerService || typeof resolvedAnswerService.generate !== 'function') {
          const error = new Error('RAG answer service is unavailable.')
          error.code = RAG_ROUTE_ERROR_CODES.UNAVAILABLE
          throw error
        }
        try {
          answer = await resolvedAnswerService.generate({ query: input.query, evidence })
        } catch (error) {
          if (isVisibilityError(error)) throw error
          answer = referenceFallback(input.query, evidence, error)
        }
      }
      const requiresRunId = answer?.status === 'queued' || answer?.status === 'active'
      const generatedRunId = requiresRunId ? requestIdFactory() : null
      const runId = requiresRunId
        ? normalizeRunId(typeof generatedRunId === 'string' ? generatedRunId : String(generatedRunId ?? ''))
        : null
      if (requiresRunId && runId === null) {
        answer = referenceFallback(input.query, evidence, 'task_store_unavailable')
      }
      if (requiresRunId && runId !== null &&
          (answer?.status === 'queued' || answer?.status === 'active')) {
        runStore = await resolveQueryRunStore(database, req)
        const binding = taskKey(answer.task)
        if (!persistedContext || !binding || !runStore || runStore.available === false ||
            typeof runStore.upsert !== 'function') {
          answer = referenceFallback(input.query, evidence, 'query_state_unavailable')
        } else {
          try {
            const saved = await Promise.resolve(runStore.upsert({
              runId,
              ownerScope: ownerScope(req),
              query: input.query,
              evidence,
              retrieval: rankedRetrieval,
              contextJson: persistedContext.contextJson,
              taskKey: binding,
              status: answer.status
            }))
            if (saved !== true) answer = referenceFallback(input.query, evidence, 'query_state_unavailable')
          } catch {
            answer = referenceFallback(input.query, evidence, 'query_state_unavailable')
          }
        }
      }
      const response = projectAnswer(answer, rankedRetrieval, runId)
      if (requiresRunId && response.cancellable === true) {
        response.cancellable = typeof taskStore?.cancel === 'function'
      }
      const httpStatus = response.status === 'queued' || response.status === 'active' ? 202 : 200
      return res.status(httpStatus).json({ data: response })
    } catch (error) {
      return queryError(res, error)
    }
  })

  router.get('/queries/:runId', async (req, res) => {
    const runId = normalizeRunId(req.params.runId)
    if (runId === null) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const store = await resolveQueryRunStore(database, req)
      if (!store || store.available === false || typeof store.get !== 'function') {
        return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      }
      const row = await Promise.resolve(store.get(runId, ownerScope(req)))
      if (!row) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      const entry = await loadPersistedQueryEntry({
        row,
        database,
        req,
        authoritativeChecksFactory,
        resolvedAnswerServiceFactory,
        taskStoreProvider,
        workerAvailable,
        model: resolveConfiguredModel(),
        answerConfig
      })
      if (!entry) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      const loaded = await readTrackedTask(entry, { database, req, taskStoreProvider })
      if (loaded.persistent && loaded.task === null) {
        return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      }
      if (loaded.store) entry.taskStore = loaded.store
      if (loaded.task) entry.task = loaded.task
      const data = await projectTrackedQuery(entry, loaded.task ?? entry.task, req)
      if (isTaskTerminal(entry.status) && typeof store.updateStatus === 'function') {
        try { await Promise.resolve(store.updateStatus(runId, ownerScope(req), entry.status)) } catch {}
      }
      return res.json({ data })
    } catch {
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
    }
  })

  router.post('/queries/:runId/cancel', async (req, res) => {
    const runId = normalizeRunId(req.params.runId)
    if (runId === null) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const store = await resolveQueryRunStore(database, req)
      if (!store || store.available === false || typeof store.get !== 'function') {
        return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      }
      const row = await Promise.resolve(store.get(runId, ownerScope(req)))
      if (!row) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      const entry = await loadPersistedQueryEntry({
        row,
        database,
        req,
        authoritativeChecksFactory,
        resolvedAnswerServiceFactory,
        taskStoreProvider,
        workerAvailable,
        model: resolveConfiguredModel(),
        answerConfig
      })
      if (!entry) return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      const loaded = await readTrackedTask(entry, { database, req, taskStoreProvider })
      const task = loaded.task ?? entry.task
      const status = statusValue(safeTaskStatus(task?.status) ?? safeTaskStatus(entry.status) ?? 'pending')
      if (isTaskTerminal(status)) return sendCode(res, 409, RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT)
      if (!loaded.store || !task) return sendCode(res, 409, RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT)
      const outcome = await Promise.resolve(cancelTrackedTask(loaded.store, task))
      const cancelledTask = outcome?.task ?? outcome
      if (!isPlainObject(cancelledTask) || statusValue(cancelledTask.status) !== 'cancelled') {
        return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.CANCEL_FAILED)
      }
      entry.task = cancelledTask
      entry.status = 'cancelled'
      if (typeof store.updateStatus === 'function') {
        try { await Promise.resolve(store.updateStatus(runId, ownerScope(req), 'cancelled')) } catch {}
      }
      return res.json({ data: projectCancelledQuery(runId) })
    } catch (error) {
      if (error?.code === RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT ||
          error?.code === 'TASK_INVALID_STATE' || error?.code === 'TASK_STATE_CONFLICT') {
        return sendCode(res, 409, RAG_ROUTE_ERROR_CODES.CANCEL_CONFLICT)
      }
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.CANCEL_FAILED)
    }
  })

  return router
}

export { createAuthoritativeChecks, normalizeQueryBody, normalizeRagIndexRefreshBody }
export const createRagQueryRouter = createRagRouter
export default createRagRouter()
