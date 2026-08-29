import { randomUUID } from 'node:crypto'

import {
  RAG_SOURCE_STATE_TABLE
} from '../config/ragIndexSchema.js'
import { enqueueTask } from './taskStore.js'

const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,127}$/u
const RAG_INDEX_TASK_TYPE = 'rag.index.refresh'
const RAG_INDEX_PROCESSOR_VERSION = 'v1'
const RAG_INDEX_EXECUTION_CLASS = 'disk'
const RAG_INDEX_SUBJECT_TYPE = 'rag-index'
const RAG_INDEX_SUBJECT_ID = 'owner'

function positiveId(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value.trim()) ? Number(value) : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function hasTable(database, tableName) {
  try {
    return Boolean(database?.prepare?.(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).get(tableName))
  } catch {
    return false
  }
}

function normalizeSource(sourceType, sourceId) {
  const id = positiveId(sourceId)
  return SOURCE_TYPES.has(sourceType) && id !== null
    ? Object.freeze({ sourceType, sourceId: id })
    : null
}

function safeReasonCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value)
    ? value
    : 'RAG_SOURCE_CHANGED'
}

export function invalidateRagSource(database, {
  sourceType,
  sourceId,
  reasonCode = 'RAG_SOURCE_CHANGED',
  ensureState = false
} = {}) {
  const source = normalizeSource(sourceType, sourceId)
  if (!source || !hasTable(database, RAG_SOURCE_STATE_TABLE)) return false
  const errorCode = safeReasonCode(reasonCode)
  try {
    if (ensureState) {
      database.prepare(`
        INSERT INTO ${RAG_SOURCE_STATE_TABLE} (
          source_type, source_id, active_snapshot_id, last_attempt_snapshot_id,
          status, last_error_code, updated_at
        ) VALUES (?, ?, NULL, NULL, 'stale', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_type, source_id) DO UPDATE SET
          active_snapshot_id = NULL,
          status = 'stale',
          last_error_code = excluded.last_error_code,
          updated_at = CURRENT_TIMESTAMP
      `).run(source.sourceType, source.sourceId, errorCode)
      return true
    }
    return database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE}
         SET active_snapshot_id = NULL,
             status = 'stale',
             last_error_code = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE source_type = ? AND source_id = ?
    `).run(errorCode, source.sourceType, source.sourceId).changes > 0
  } catch {
    return false
  }
}

export async function scheduleRagSourceRefresh({
  database,
  sourceType,
  sourceId,
  reasonCode = 'RAG_SOURCE_CHANGED',
  rebuild = false,
  enqueue = enqueueTask,
  runIdentity = randomUUID
} = {}) {
  const source = normalizeSource(sourceType, sourceId)
  if (!source || !database?.prepare || typeof enqueue !== 'function' || typeof runIdentity !== 'function') {
    return Object.freeze({ status: 'invalid' })
  }
  const invalidated = invalidateRagSource(database, {
    ...source,
    reasonCode,
    ensureState: true
  })
  try {
    const outcome = await Promise.resolve(enqueue(database, {
      taskType: RAG_INDEX_TASK_TYPE,
      processorVersion: RAG_INDEX_PROCESSOR_VERSION,
      subjectType: RAG_INDEX_SUBJECT_TYPE,
      subjectId: RAG_INDEX_SUBJECT_ID,
      subjectVersionId: `lifecycle:${source.sourceType}:${source.sourceId}:${runIdentity()}`,
      executionClass: RAG_INDEX_EXECUTION_CLASS,
      input: {
        source: { type: source.sourceType, id: source.sourceId },
        filter: { sourceType: source.sourceType, sourceIds: [source.sourceId] },
        rebuild: Boolean(rebuild)
      },
      priority: 40,
      maxAttempts: 3
    }))
    return Object.freeze({
      status: outcome?.created === false ? 'existing' : 'enqueued',
      invalidated,
      taskId: positiveId(outcome?.task?.id)
    })
  } catch {
    // The resource mutation remains successful, but the stale marker prevents
    // old evidence from being served and makes the coverage failure visible.
    return Object.freeze({ status: 'stale_only', invalidated })
  }
}

export async function scheduleRagSourcesRefresh({
  database,
  sourceType,
  sourceIds,
  reasonCode = 'RAG_SOURCE_CHANGED',
  rebuild = false,
  enqueue = enqueueTask,
  runIdentity = randomUUID
} = {}) {
  if (!SOURCE_TYPES.has(sourceType) || !Array.isArray(sourceIds) || sourceIds.length < 1 ||
      sourceIds.length > 500 || typeof enqueue !== 'function' || typeof runIdentity !== 'function') {
    return Object.freeze({ status: 'invalid' })
  }
  const ids = [...new Set(sourceIds.map(positiveId))]
  if (ids.length !== sourceIds.length || ids.some((id) => id === null)) {
    return Object.freeze({ status: 'invalid' })
  }
  let invalidated = 0
  for (const sourceId of ids) {
    if (invalidateRagSource(database, {
      sourceType,
      sourceId,
      reasonCode,
      ensureState: true
    })) invalidated += 1
  }
  try {
    const outcome = await Promise.resolve(enqueue(database, {
      taskType: RAG_INDEX_TASK_TYPE,
      processorVersion: RAG_INDEX_PROCESSOR_VERSION,
      subjectType: RAG_INDEX_SUBJECT_TYPE,
      subjectId: RAG_INDEX_SUBJECT_ID,
      subjectVersionId: `lifecycle:${sourceType}:batch:${runIdentity()}`,
      executionClass: RAG_INDEX_EXECUTION_CLASS,
      input: {
        source: { type: sourceType },
        filter: { sourceType, sourceIds: ids },
        rebuild: Boolean(rebuild)
      },
      priority: 40,
      maxAttempts: 3
    }))
    return Object.freeze({
      status: outcome?.created === false ? 'existing' : 'enqueued',
      invalidated,
      taskId: positiveId(outcome?.task?.id)
    })
  } catch {
    return Object.freeze({ status: 'stale_only', invalidated })
  }
}

export default scheduleRagSourceRefresh
