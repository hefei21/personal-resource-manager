import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import {
  authenticateWorkerAccess,
  createWorkerEnrollment,
  enrollWorker,
  listWorkers,
  refreshWorkerCredentials,
  revokeWorker,
  updateWorkerProfile
} from '../services/pcWorkerAuth.js'
import {
  PC_WORKER_EXECUTION_CLASS,
  PC_WORKER_PROCESSOR_VERSION,
  PC_WORKER_TASK_TYPE,
  projectWorkerTask,
  normalizeWorkerTaskResult,
  resolveWorkerTaskInput,
  supportedRemoteProcessors
} from '../services/pcWorkerContract.js'
import { lookupPcWorkerProcessor } from '../services/pcWorkerProcessorCatalog.js'
import { createRagArtifactStore } from '../services/ragArtifactStore.js'
import { getResourceStorageRuntime } from '../services/resourceStorageRuntime.js'
import { getTaskRuntime } from '../services/taskRuntime.js'
import { projectTask } from '../services/taskTypeCatalog.js'

const POSITIVE_ID = /^[1-9]\d*$/u
const WORKER_ERROR_CODE = /^WORKER_[A-Z0-9_.-]{1,56}$/u
const LEASE_DURATION_MS = 60_000

function sendCode(res, status, code) {
  return res.status(status).json({ code })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function positiveId(value) {
  if (typeof value === 'string' && POSITIVE_ID.test(value)) value = Number(value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function targetLimit(value) {
  if (value === undefined) return 50
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/u.test(value)) return null
  const parsed = Number(value)
  return parsed <= 100 ? parsed : null
}

function bearerToken(req) {
  const authorization = req.get('authorization')
  if (typeof authorization !== 'string') return null
  const match = /^Bearer ([^\s]+)$/u.exec(authorization)
  return match?.[1] ?? null
}

function mapError(res, error) {
  const code = error?.code
  if (['PC_WORKER_INPUT_INVALID', 'PC_WORKER_PROTOCOL_UNSUPPORTED', 'PC_WORKER_ID_INVALID',
    'PC_WORKER_PROCESSOR_INPUT_INVALID', 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE',
    'RAG_ARTIFACT_INVALID', 'RAG_ARTIFACT_UNSUPPORTED',
    'TASK_ID_INVALID', 'TASK_PROGRESS_INVALID', 'TASK_ERROR_INVALID'].includes(code)) {
    return sendCode(res, 400, code)
  }
  if (['PC_WORKER_AUTH_INVALID', 'PC_WORKER_ENROLLMENT_INVALID'].includes(code)) {
    return sendCode(res, 401, code)
  }
  if (code === 'PC_WORKER_TASK_FORBIDDEN') return sendCode(res, 403, code)
  if (['PC_WORKER_NOT_FOUND', 'PC_WORKER_CONTENT_NOT_FOUND', 'TASK_NOT_FOUND'].includes(code)) {
    return sendCode(res, 404, code)
  }
  if (['PC_WORKER_REFRESH_REPLAYED', 'PC_WORKER_CAPABILITY_UNAVAILABLE', 'PC_WORKER_CONTENT_UNAVAILABLE',
    'PC_WORKER_RESULT_SCHEMA_INVALID', 'PC_WORKER_RESULT_PROCESSOR_INVALID', 'PC_WORKER_RESULT_INPUT_MISMATCH',
    'PC_WORKER_PROCESSOR_RESULT_SCHEMA_INVALID', 'PC_WORKER_PROCESSOR_RESULT_PROCESSOR_INVALID',
    'PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH', 'PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID',
    'PC_WORKER_PROCESSOR_RESULT_DIMENSIONS_INVALID', 'PC_WORKER_PROCESSOR_RESULT_MODEL_MISMATCH',
    'PC_WORKER_PROCESSOR_RESULT_INVALID', 'PC_WORKER_PROCESSOR_RESULT_TOO_LARGE',
    'PC_WORKER_PROCESSOR_RESULT_STALE', 'PC_WORKER_RESULT_STALE',
    'RAG_ARTIFACT_STALE', 'RAG_ARTIFACT_MISSING', 'RAG_ARTIFACT_CONFLICT', 'RAG_ARTIFACT_TOO_LARGE',
    'TASK_INVALID_STATE', 'TASK_LEASE_MISMATCH', 'TASK_LEASE_EXPIRED', 'TASK_STATE_CONFLICT',
    'TASK_IDEMPOTENCY_CONFLICT'].includes(code)) {
    return sendCode(res, 409, code)
  }
  if (code === 'PC_WORKER_RUNTIME_UNAVAILABLE') return sendCode(res, 503, code)
  return sendCode(res, 500, 'PC_WORKER_REQUEST_FAILED')
}

function databaseProvider(req) {
  return getDatabase(req)
}

function runtimeStore(runtimeProvider) {
  let runtime
  try { runtime = runtimeProvider() } catch {}
  const store = runtime?.getStore?.()
  if (!store) {
    const error = new Error('Worker task runtime is unavailable.')
    error.code = 'PC_WORKER_RUNTIME_UNAVAILABLE'
    throw error
  }
  return store
}

function contentRecord(database, task) {
  const input = task?.input
  if (task?.taskType === 'rag.content.extract') {
    const sourceId = positiveId(input?.sourceId)
    const domainType = input?.sourceType === 'document' ? 'document' : input?.sourceType === 'ebook' ? 'ebook' : null
    if (sourceId === null || domainType === null) return null
    const row = database.prepare(`
      SELECT rv.id AS resource_version_id, rv.resource_id, rv.content_object_id,
             c.sha256, c.bytes, c.managed_storage_key, r.lifecycle_status
        FROM resource_domain_links link
        JOIN resources r ON r.id = link.resource_id
        JOIN resource_versions rv ON rv.resource_id = r.id AND rv.is_current = 1
        JOIN content_objects c ON c.id = rv.content_object_id
       WHERE link.domain_type = ? AND link.domain_id = ?
       ORDER BY rv.id DESC
       LIMIT 1
    `).get(domainType, sourceId)
    if (!row || row.lifecycle_status !== 'active' || row.managed_storage_key === null ||
        row.sha256 !== input.sourceContentSha256 || row.sha256 !== task.subjectContentHash ||
        Number(row.bytes) !== input.contentBytes) return null
    return row
  }
  const resourceVersionId = positiveId(input?.resourceVersionId)
  const contentObjectId = positiveId(input?.contentObjectId)
  if (resourceVersionId === null || contentObjectId === null) return null
  const row = database.prepare(`
    SELECT rv.id AS resource_version_id, rv.resource_id, rv.content_object_id,
           c.sha256, c.bytes, c.managed_storage_key, r.lifecycle_status
    FROM resource_versions rv
    JOIN content_objects c ON c.id = rv.content_object_id
    JOIN resources r ON r.id = rv.resource_id
    WHERE rv.id = ? AND rv.content_object_id = ?
  `).get(resourceVersionId, contentObjectId)
  if (!row || row.lifecycle_status !== 'active' || row.managed_storage_key === null ||
    String(row.resource_version_id) !== task.subjectId || row.sha256 !== task.subjectContentHash) return null
  return row
}

function authorizedTask(store, worker, taskId, leaseToken, statuses) {
  const id = positiveId(taskId)
  if (id === null || typeof leaseToken !== 'string') {
    const error = new Error('Worker task credentials are invalid.')
    error.code = 'PC_WORKER_TASK_FORBIDDEN'
    throw error
  }
  const task = store.getById(id)
  const definition = lookupPcWorkerProcessor(task?.taskType, task?.processorVersion)
  const owner = `pcw:${worker.id}`
  if (!task || !definition || task.executionClass !== definition.executionClass || task.leaseOwner !== owner ||
    task.leaseToken !== leaseToken || !statuses.includes(task.status) ||
    typeof task.leaseExpiresAt !== 'string' || task.leaseExpiresAt <= new Date().toISOString()) {
    const error = new Error('Worker task is outside the active lease.')
    error.code = 'PC_WORKER_TASK_FORBIDDEN'
    throw error
  }
  return task
}

function processorInput(task) {
  const input = resolveWorkerTaskInput(task)
  if (input === null) {
    const error = new Error('Worker task input is not authorized.')
    error.code = 'PC_WORKER_PROCESSOR_INPUT_INVALID'
    throw error
  }
  return input
}

function staleResultError() {
  const error = new Error('Worker result is stale.')
  error.code = 'PC_WORKER_RESULT_STALE'
  return error
}

function currentSnapshotIdentity(database, task, input) {
  if (!['rag.embedding.generate', 'rag.content.extract'].includes(task.taskType)) return input
  try {
    if (task.taskType === 'rag.content.extract') {
      return contentRecord(database, task) ? { ...input } : null
    }
    if (task.taskType === 'rag.embedding.generate') {
      const row = database.prepare(`
        SELECT snapshot.id, snapshot.source_type, snapshot.source_id,
               snapshot.source_version_id, snapshot.source_content_sha256
          FROM rag_source_snapshots snapshot
          JOIN rag_source_state state
            ON state.source_type = snapshot.source_type AND state.source_id = snapshot.source_id
           AND state.active_snapshot_id = snapshot.id
         WHERE snapshot.id = ?
           AND snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
      `).get(input.snapshotId)
      if (!row || row.source_type !== input.sourceType || Number(row.source_id) !== input.sourceId ||
          row.source_version_id !== input.sourceVersionId || row.source_content_sha256 !== input.sourceContentSha256) return null
      return { ...input, snapshotId: Number(row.id), model: input.model }
    }
  } catch {
    return null
  }
}

function workerAuth({ database = databaseProvider, authenticate = authenticateWorkerAccess } = {}) {
  return async (req, res, next) => {
    try {
      const token = bearerToken(req)
      if (!token) return sendCode(res, 401, 'PC_WORKER_AUTH_INVALID')
      req.pcWorker = await Promise.resolve(authenticate(await database(req), token))
      return next()
    } catch (error) {
      return mapError(res, error)
    }
  }
}

export function createPcWorkerOwnerRouter({
  database = databaseProvider,
  runtime = getTaskRuntime,
  createEnrollment = createWorkerEnrollment,
  workerList = listWorkers,
  workerRevoke = revokeWorker
} = {}) {
  const router = express.Router()
  router.use(requireOwner)

  router.get('/', async (req, res) => {
    try { return res.json({ data: await Promise.resolve(workerList(await database(req))) }) } catch (error) { return mapError(res, error) }
  })

  router.get('/content-inspection-targets', async (req, res) => {
    try {
      const limit = targetLimit(req.query.limit)
      if (limit === null || Object.keys(req.query).some((key) => key !== 'limit')) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const rows = (await database(req)).prepare(`
        SELECT rv.id AS resource_version_id, rv.resource_id, rv.version_number,
               r.resource_type, r.title, c.sha256, c.bytes
        FROM resource_versions rv
        JOIN content_objects c ON c.id = rv.content_object_id
        JOIN resources r ON r.id = rv.resource_id
        WHERE r.lifecycle_status = 'active'
          AND c.managed_storage_key IS NOT NULL
        ORDER BY rv.created_at DESC, rv.id DESC
        LIMIT ?
      `).all(limit)
      const data = rows.map((row) => ({
        resourceVersionId: row.resource_version_id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
        title: typeof row.title === 'string' ? row.title.slice(0, 256) : null,
        versionNumber: row.version_number,
        sha256: row.sha256,
        bytes: row.bytes
      }))
      return res.json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/enrollments', requireWritePermission, async (req, res) => {
    try {
      const body = req.body ?? {}
      if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'ttlMinutes')) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const ttlMs = body.ttlMinutes === undefined ? undefined : body.ttlMinutes * 60_000
      const data = await Promise.resolve(createEnrollment(await database(req), ttlMs === undefined ? {} : { ttlMs }))
      return res.status(201).json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/:workerId/revoke', requireWritePermission, async (req, res) => {
    try {
      const data = await Promise.resolve(workerRevoke(await database(req), req.params.workerId))
      return data ? res.json({ data }) : sendCode(res, 404, 'PC_WORKER_NOT_FOUND')
    } catch (error) { return mapError(res, error) }
  })

  router.post('/content-inspection-tasks', requireWritePermission, async (req, res) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1) return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      const resourceVersionId = positiveId(req.body.resourceVersionId)
      if (resourceVersionId === null) return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      const db = await database(req)
      const row = db.prepare(`
        SELECT rv.id AS resource_version_id, rv.resource_id, rv.content_object_id,
               c.sha256, c.bytes, c.managed_storage_key, r.lifecycle_status
        FROM resource_versions rv
        JOIN content_objects c ON c.id = rv.content_object_id
        JOIN resources r ON r.id = rv.resource_id
        WHERE rv.id = ?
      `).get(resourceVersionId)
      if (!row) return sendCode(res, 404, 'PC_WORKER_CONTENT_NOT_FOUND')
      if (row.lifecycle_status !== 'active' || row.managed_storage_key === null) {
        return sendCode(res, 409, 'PC_WORKER_CONTENT_UNAVAILABLE')
      }
      const store = runtimeStore(runtime)
      const outcome = await Promise.resolve(store.enqueue({
        taskType: PC_WORKER_TASK_TYPE,
        processorVersion: PC_WORKER_PROCESSOR_VERSION,
        subjectType: 'resource-version',
        subjectId: String(row.resource_version_id),
        subjectVersionId: String(row.content_object_id),
        subjectContentSha256: row.sha256,
        executionClass: PC_WORKER_EXECUTION_CLASS,
        input: {
          schemaVersion: 1,
          resourceVersionId: row.resource_version_id,
          contentObjectId: row.content_object_id
        }
      }))
      const data = projectTask(outcome?.task)
      return data ? res.status(outcome.created ? 202 : 200).json({ data, created: outcome.created }) : sendCode(res, 500, 'PC_WORKER_REQUEST_FAILED')
    } catch (error) { return mapError(res, error) }
  })

  return router
}

export function createPcWorkerAgentRouter({
  database = databaseProvider,
  runtime = getTaskRuntime,
  storageRuntime = getResourceStorageRuntime,
  enroll = enrollWorker,
  refresh = refreshWorkerCredentials,
  authenticate = authenticateWorkerAccess,
  updateProfile = updateWorkerProfile,
  artifactStore = null
} = {}) {
  const router = express.Router()
  let resolvedArtifactStore = artifactStore
  const getArtifactStore = () => {
    resolvedArtifactStore ??= createRagArtifactStore()
    return resolvedArtifactStore
  }

  router.post('/enroll', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || !Object.hasOwn(req.body, 'enrollmentToken') || !Object.hasOwn(req.body, 'profile') ||
        Object.keys(req.body).some((key) => !['enrollmentToken', 'profile'].includes(key))) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const data = await Promise.resolve(enroll(await database(req), req.body.enrollmentToken, req.body.profile))
      return res.status(201).json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/refresh', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'refreshToken')) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const data = await Promise.resolve(refresh(await database(req), req.body.refreshToken))
      return res.json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.use(workerAuth({ database, authenticate }))

  router.put('/profile', async (req, res) => {
    try {
      const data = await Promise.resolve(updateProfile(await database(req), req.pcWorker.id, req.body))
      return res.json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/tasks/claim', async (req, res) => {
    try {
      if (req.body !== undefined && (!isPlainObject(req.body) || Object.keys(req.body).length !== 0)) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const processors = supportedRemoteProcessors(req.pcWorker.capabilities)
      if (processors.length === 0) return sendCode(res, 409, 'PC_WORKER_CAPABILITY_UNAVAILABLE')
      const task = await Promise.resolve(runtimeStore(runtime).leaseNext({
        owner: `pcw:${req.pcWorker.id}`,
        leaseDurationMs: LEASE_DURATION_MS,
        executionClass: PC_WORKER_EXECUTION_CLASS,
        supportedProcessors: processors
      }))
      if (!task) return res.status(204).end()
      const data = projectWorkerTask(task)
      if (!data) {
        await Promise.resolve(runtimeStore(runtime).fail({
          id: task.id,
          owner: `pcw:${req.pcWorker.id}`,
          token: task.leaseToken,
          errorCode: 'WORKER_TASK_CONTRACT_INVALID',
          errorSummary: 'Worker task contract is invalid.'
        }))
        return sendCode(res, 500, 'PC_WORKER_REQUEST_FAILED')
      }
      return res.json({ data })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/tasks/:taskId/start', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.leaseToken !== 'string') {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const task = await Promise.resolve(runtimeStore(runtime).markRunning({
        id: req.params.taskId,
        owner: `pcw:${req.pcWorker.id}`,
        token: req.body.leaseToken
      }))
      return res.json({ data: { id: task.id, status: task.status, leaseExpiresAt: task.leaseExpiresAt } })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/tasks/:taskId/heartbeat', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || typeof req.body.leaseToken !== 'string' ||
        Object.keys(req.body).some((key) => !['leaseToken', 'progress'].includes(key))) {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const store = runtimeStore(runtime)
      let task = await Promise.resolve(store.heartbeat({
        id: req.params.taskId,
        owner: `pcw:${req.pcWorker.id}`,
        token: req.body.leaseToken,
        leaseDurationMs: LEASE_DURATION_MS
      }))
      if (req.body.progress !== undefined) {
        task = await Promise.resolve(store.updateProgress({
          id: req.params.taskId,
          owner: `pcw:${req.pcWorker.id}`,
          token: req.body.leaseToken,
          progress: req.body.progress
        }))
      }
      return res.json({ data: { id: task.id, status: task.status, progress: task.progress, leaseExpiresAt: task.leaseExpiresAt } })
    } catch (error) { return mapError(res, error) }
  })

  router.get('/tasks/:taskId/input', async (req, res, next) => {
    try {
      const leaseToken = req.get('x-worker-lease')
      const store = runtimeStore(runtime)
      const task = authorizedTask(store, req.pcWorker, req.params.taskId, leaseToken, ['running'])
      processorInput(task)
      const row = contentRecord(await database(req), task)
      if (!row) return sendCode(res, 409, 'PC_WORKER_CONTENT_UNAVAILABLE')
      const stream = await storageRuntime().storageService.createReadStream(row.managed_storage_key)
      res.set({
        'content-type': 'application/octet-stream',
        'content-length': String(row.bytes),
        etag: `"sha256-${row.sha256}"`,
        'cache-control': 'no-store',
        'x-content-sha256': row.sha256
      })
      stream.once('error', next)
      return stream.pipe(res)
    } catch (error) { return mapError(res, error) }
  })

  router.post('/tasks/:taskId/artifact', async (req, res) => {
    try {
      if (req.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const store = runtimeStore(runtime)
      const leaseToken = req.get('x-worker-lease')
      const task = authorizedTask(store, req.pcWorker, req.params.taskId, leaseToken, ['running'])
      const input = processorInput(task)
      if (task.taskType !== 'rag.content.extract') return sendCode(res, 400, 'RAG_ARTIFACT_UNSUPPORTED')
      const definition = lookupPcWorkerProcessor(task.taskType, task.processorVersion)
      const databaseValue = await database(req)
      const row = contentRecord(databaseValue, task)
      if (!row) return sendCode(res, 409, 'PC_WORKER_CONTENT_UNAVAILABLE')
      const current = {
        sourceVersionId: input.sourceVersionId,
        sourceContentSha256: row.sha256,
        contentBytes: row.bytes
      }
      if (!definition.staleGuard(current, input)) throw staleResultError()
      const outcome = await getArtifactStore().stage({
        task,
        stream: req,
        current,
        metadata: {
          sourceVersionId: input.sourceVersionId,
          sourceContentSha256: input.sourceContentSha256,
          artifactSha256: req.get('x-artifact-sha256'),
          artifactBytes: req.get('x-artifact-bytes'),
          sectionCount: req.get('x-artifact-section-count'),
          format: req.get('x-artifact-format')
        }
      })
      return res.status(201).json({ data: outcome })
    } catch (error) { return mapError(res, error) }
  })

  router.post('/tasks/:taskId/complete', async (req, res) => {
    let task
    let artifactStoreValue
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length !== 2 || typeof req.body.leaseToken !== 'string') {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const store = runtimeStore(runtime)
      task = authorizedTask(store, req.pcWorker, req.params.taskId, req.body.leaseToken, ['running'])
      const input = processorInput(task)
      const definition = lookupPcWorkerProcessor(task.taskType, task.processorVersion)
      const databaseValue = await database(req)
      const needsContent = task.taskType === PC_WORKER_TASK_TYPE || task.taskType === 'rag.content.extract'
      const row = needsContent ? contentRecord(databaseValue, task) : null
      if (needsContent && !row) return sendCode(res, 409, 'PC_WORKER_CONTENT_UNAVAILABLE')
      const current = task.taskType === PC_WORKER_TASK_TYPE
        ? {
            resourceVersionId: row.resource_version_id,
            contentObjectId: row.content_object_id,
            sha256: row.sha256,
            bytes: row.bytes
          }
        : task.taskType === 'rag.content.extract'
          ? { sourceVersionId: input.sourceVersionId, sourceContentSha256: row.sha256, contentBytes: row.bytes }
        : currentSnapshotIdentity(databaseValue, task, input)
      if (!current || !definition.staleGuard(current, task.taskType === PC_WORKER_TASK_TYPE
        ? { ...input, sha256: row.sha256, bytes: row.bytes }
        : input)) throw staleResultError()
      const result = normalizeWorkerTaskResult(task, req.body.result,
        task.taskType === PC_WORKER_TASK_TYPE ? { sha256: row.sha256, bytes: row.bytes } : input)
      if (task.taskType === 'rag.content.extract') {
        artifactStoreValue = getArtifactStore()
        await artifactStoreValue.commit({
          task,
          metadata: result.output,
          current: { sourceVersionId: input.sourceVersionId, sourceContentSha256: row.sha256, contentBytes: row.bytes }
        })
      }
      const succeeded = await Promise.resolve(store.succeed({
        id: task.id,
        owner: `pcw:${req.pcWorker.id}`,
        token: req.body.leaseToken,
        result
      }))
      return res.json({ data: { id: succeeded.id, status: succeeded.status, progress: succeeded.progress } })
    } catch (error) {
      if (task?.taskType === 'rag.content.extract' && artifactStoreValue) await artifactStoreValue.discardTask(task.id).catch(() => {})
      return mapError(res, error)
    }
  })

  router.post('/tasks/:taskId/fail', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => !['leaseToken', 'errorCode', 'errorSummary', 'retryable'].includes(key)) ||
        typeof req.body.leaseToken !== 'string' || typeof req.body.errorCode !== 'string' ||
        !WORKER_ERROR_CODE.test(req.body.errorCode) || typeof req.body.errorSummary !== 'string' ||
        !req.body.errorSummary.trim() || req.body.errorSummary.length > 256 || /[\\/\u0000-\u001f\u007f]/u.test(req.body.errorSummary) ||
        typeof req.body.retryable !== 'boolean') {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const store = runtimeStore(runtime)
      const task = authorizedTask(store, req.pcWorker, req.params.taskId, req.body.leaseToken, ['leased', 'running'])
      const retryDelay = Math.min(5 * 60_000, 5_000 * (2 ** Math.max(0, task.attemptCount - 1)))
      const outcome = await Promise.resolve(store.fail({
        id: task.id,
        owner: `pcw:${req.pcWorker.id}`,
        token: req.body.leaseToken,
        errorCode: req.body.errorCode,
        errorSummary: req.body.errorSummary.trim(),
        ...(req.body.retryable ? { retryAt: new Date(Date.now() + retryDelay).toISOString() } : {})
      }))
      if (task.taskType === 'rag.content.extract') await getArtifactStore().discardTask(task.id)
      return res.json({ data: { id: outcome.task.id, status: outcome.task.status, retryScheduled: outcome.retryScheduled } })
    } catch (error) { return mapError(res, error) }
  })

  return router
}

export default createPcWorkerOwnerRouter()
