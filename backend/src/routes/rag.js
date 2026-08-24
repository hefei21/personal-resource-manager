import crypto from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner } from '../middlewares/auth.js'
import {
  createRagAnswerService,
  RAG_ANSWER_TASK_TYPE
} from '../services/ragAnswerService.js'
import { createRagHybridRetriever } from '../services/ragHybridRetriever.js'
import { createRagTextIndexService } from '../services/ragTextIndexService.js'
import { getTaskRuntime } from '../services/taskRuntime.js'

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
const MAX_TRACKED_QUERIES = 256
const TRACKED_QUERY_TTL_MS = 15 * 60 * 1000
const PC_WORKER_ONLINE_WINDOW_MS = 120_000
const QUERY_PENDING_STATUSES = new Set(['pending', 'leased', 'running', 'queued', 'active'])
const QUERY_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'complete', 'degraded', 'abstained'])
const OPAQUE_RUN_ID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/u
const ANSWER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u
const ANSWER_HASH_PATTERN = /^[a-f0-9]{64}$/u

export const RAG_ROUTE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_QUERY_INPUT_INVALID',
  CANDIDATES_INVALID: 'RAG_QUERY_CANDIDATES_INVALID',
  UNAVAILABLE: 'RAG_QUERY_UNAVAILABLE',
  VISIBILITY_FAILED: 'RAG_QUERY_VISIBILITY_FAILED',
  NOT_FOUND: 'RAG_QUERY_NOT_FOUND',
  CANCEL_CONFLICT: 'RAG_QUERY_CANCEL_CONFLICT',
  CANCEL_FAILED: 'RAG_QUERY_CANCEL_FAILED'
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

function pruneTrackedQueries(registry, timestamp = nowMs()) {
  for (const [runId, entry] of registry) {
    if (entry.expiresAt <= timestamp) registry.delete(runId)
  }
}

function rememberTrackedQuery(registry, entry, timestamp = nowMs()) {
  pruneTrackedQueries(registry, timestamp)
  while (registry.size >= MAX_TRACKED_QUERIES) {
    const oldest = registry.keys().next().value
    if (oldest === undefined) break
    registry.delete(oldest)
  }
  registry.set(entry.runId, Object.assign(entry, {
    updatedAt: timestamp,
    expiresAt: timestamp + TRACKED_QUERY_TTL_MS
  }))
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
  if (!query || Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES || /[\u0000]/u.test(query)) {
    failInput()
  }

  const limit = body.limit === undefined ? DEFAULT_LIMIT : body.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) failInput()
  return Object.freeze({ query, limit })
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

function answerProcessorConfigured(capabilities) {
  return Array.isArray(capabilities?.processors) && capabilities.processors.some((processor) =>
    processor?.taskType === RAG_ANSWER_TASK_TYPE &&
    processor?.processorVersion === 'v1' &&
    processor?.executionClass === 'gpu' &&
    processor?.outputSchemaVersion === 1
  )
}

function defaultWorkerAvailable({ database } = {}) {
  if (!database?.prepare) return false
  try {
    const rows = database.prepare(`
      SELECT status, protocol_version, last_seen_at, capabilities_json
        FROM pc_workers
       WHERE status = 'active'
    `).all()
    const now = Date.now()
    const cutoff = now - PC_WORKER_ONLINE_WINDOW_MS
    for (const row of rows) {
      if (row.status !== 'active') continue
      if (row.protocol_version !== 1) continue
      const lastSeen = Date.parse(row.last_seen_at ?? '')
      if (!Number.isFinite(lastSeen) || lastSeen < cutoff || lastSeen > now + 5_000) continue
      let capabilities
      try { capabilities = JSON.parse(row.capabilities_json) } catch { continue }
      if (answerProcessorConfigured(capabilities)) return Object.freeze({ available: true })
    }
  } catch {}
  return Object.freeze({ available: false })
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
  query,
  limit,
  authoritativeVisibility,
  textIndexServiceFactory
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
  return Object.freeze({
    ftsCandidates: result.data,
    vectorCandidates: [],
    vectorError: Object.freeze({ code: 'VECTOR_UNAVAILABLE' })
  })
}

function defaultTextIndexServiceFactory(options) {
  return createRagTextIndexService(options)
}

function defaultHybridRetrieverFactory({ retrievalConfig, checks }) {
  return createRagHybridRetriever({
    config: retrievalConfig,
    authoritativeVisibility: checks.authoritativeVisibility,
    authoritativeActiveSnapshot: checks.authoritativeActiveSnapshot
  })
}

function defaultTaskStoreProvider() {
  try {
    return getTaskRuntime().getStore()
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

async function readRagStatus({ database, req, workerAvailable, vectorAvailable, model }) {
  const text = readRagTextStatus(database)
  let workerStatus = 'unknown'
  try {
    workerStatus = availableValue(await workerAvailable({
      taskType: RAG_ANSWER_TASK_TYPE,
      database,
      req,
      phase: 'status'
    })) ? 'online' : 'offline'
  } catch {
    workerStatus = 'unknown'
  }

  let vectorStatus = 'unknown'
  try {
    vectorStatus = availableValue(await vectorAvailable({ database, req, phase: 'status' }))
      ? 'available'
      : 'unavailable'
  } catch {
    vectorStatus = 'unknown'
  }
  const modelStatus = model ? 'configured' : 'unavailable'
  const status = text.status === 'missing'
    ? 'missing'
    : text.status !== 'ready'
      ? 'failed'
      : workerStatus === 'online' && vectorStatus === 'available' && modelStatus === 'configured'
        ? 'ready'
        : 'degraded'
  const degradedReason = status === 'degraded'
    ? workerStatus === 'offline'
      ? 'worker_offline'
      : modelStatus !== 'configured'
        ? 'model_unavailable'
        : vectorStatus !== 'available'
          ? 'vector_unavailable'
          : 'rag_query_degraded'
    : undefined
  return Object.freeze({
    status,
    text,
    vector: Object.freeze({ status: vectorStatus }),
    model: Object.freeze({ status: modelStatus }),
    pcWorker: Object.freeze({ status: workerStatus }),
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
    limit: Number.isSafeInteger(retrieval?.limit) ? retrieval.limit : undefined
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
  hybridRetrieverFactory = defaultHybridRetrieverFactory,
  hybridRetriever = null,
  answerServiceFactory = defaultAnswerServiceFactory,
  answerService = null,
  taskStoreProvider = defaultTaskStoreProvider,
  workerAvailable = defaultWorkerAvailable,
  vectorAvailable = () => false,
  model = undefined,
  retrievalConfig = {},
  answerConfig = {},
  requestIdFactory = () => crypto.randomUUID()
} = {}) {
  const router = express.Router()
  router.use(requireOwner)
  const trackedQueries = new Map()
  const resolveConfiguredModel = () => model === undefined ? readRagAnswerModelFromEnv() : model

  const resolvedCandidateProvider = retrieveCandidates ?? candidateProvider ?? ((options) => defaultCandidateProvider({
    ...options,
    textIndexServiceFactory
  }))
  const resolvedHybridRetrieverFactory = hybridRetriever ?? hybridRetrieverFactory
  const resolvedAnswerServiceFactory = answerService ?? answerServiceFactory

  router.get('/status', async (req, res) => {
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const status = await readRagStatus({
        database,
        req,
        workerAvailable: (context) => workerAvailable({ ...context, database, req }),
        vectorAvailable: (context) => vectorAvailable({ ...context, database, req }),
        model: resolveConfiguredModel()
      })
      return res.json({ data: status })
    } catch {
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
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
        retrievalConfig
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

      const evidence = authorizedRetrieval.data
      let answer
      let taskStore = null
      let resolvedAnswerService = null
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
      } else {
        taskStore = await Promise.resolve(taskStoreProvider({ database, req }))
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
      const response = projectAnswer(answer, authorizedRetrieval, runId)
      if (requiresRunId && response.cancellable === true) {
        response.cancellable = typeof taskStore?.cancel === 'function'
      }
      if ((answer?.status === 'queued' || answer?.status === 'active') && runId !== null) {
        rememberTrackedQuery(trackedQueries, {
          runId,
          ownerScope: ownerScope(req),
          query: input.query,
          evidence,
          retrieval: authorizedRetrieval,
          checks,
          answerService: resolvedAnswerService,
          taskStore,
          task: isPlainObject(answer.task) ? answer.task : null,
          taskKey: taskKey(answer.task),
          initialAnswer: answer,
          status: answer.status
        })
      }
      const httpStatus = response.status === 'queued' || response.status === 'active' ? 202 : 200
      return res.status(httpStatus).json({ data: response })
    } catch (error) {
      return queryError(res, error)
    }
  })

  router.get('/queries/:runId', async (req, res) => {
    const runId = normalizeRunId(req.params.runId)
    pruneTrackedQueries(trackedQueries)
    const entry = runId === null ? null : trackedQueries.get(runId)
    if (!entry || entry.ownerScope !== ownerScope(req)) {
      return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
    }
    entry.expiresAt = nowMs() + TRACKED_QUERY_TTL_MS
    try {
      const database = await Promise.resolve(databaseProvider(req))
      const loaded = await readTrackedTask(entry, { database, req, taskStoreProvider })
      if (loaded.persistent && loaded.task === null) {
        trackedQueries.delete(runId)
        return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
      }
      if (loaded.store) entry.taskStore = loaded.store
      if (loaded.task) entry.task = loaded.task
      const data = await projectTrackedQuery(entry, loaded.task ?? entry.task, req)
      return res.json({ data })
    } catch {
      return sendCode(res, 503, RAG_ROUTE_ERROR_CODES.UNAVAILABLE)
    }
  })

  router.post('/queries/:runId/cancel', async (req, res) => {
    const runId = normalizeRunId(req.params.runId)
    pruneTrackedQueries(trackedQueries)
    const entry = runId === null ? null : trackedQueries.get(runId)
    if (!entry || entry.ownerScope !== ownerScope(req)) {
      return sendCode(res, 404, RAG_ROUTE_ERROR_CODES.NOT_FOUND)
    }
    entry.expiresAt = nowMs() + TRACKED_QUERY_TTL_MS
    try {
      const database = await Promise.resolve(databaseProvider(req))
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

export { normalizeQueryBody }
export const createRagQueryRouter = createRagRouter
export default createRagRouter()
