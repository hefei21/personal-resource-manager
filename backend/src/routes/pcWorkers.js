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
  normalizeContentInspectionResult,
  PC_WORKER_EXECUTION_CLASS,
  PC_WORKER_PROCESSOR_VERSION,
  PC_WORKER_TASK_TYPE,
  projectWorkerTask,
  supportedRemoteProcessors
} from '../services/pcWorkerContract.js'
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

function bearerToken(req) {
  const authorization = req.get('authorization')
  if (typeof authorization !== 'string') return null
  const match = /^Bearer ([^\s]+)$/u.exec(authorization)
  return match?.[1] ?? null
}

function mapError(res, error) {
  const code = error?.code
  if (['PC_WORKER_INPUT_INVALID', 'PC_WORKER_PROTOCOL_UNSUPPORTED', 'PC_WORKER_ID_INVALID',
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
  const owner = `pcw:${worker.id}`
  if (!task || task.taskType !== PC_WORKER_TASK_TYPE || task.executionClass !== PC_WORKER_EXECUTION_CLASS ||
    task.processorVersion !== PC_WORKER_PROCESSOR_VERSION || task.leaseOwner !== owner ||
    task.leaseToken !== leaseToken || !statuses.includes(task.status) ||
    typeof task.leaseExpiresAt !== 'string' || task.leaseExpiresAt <= new Date().toISOString()) {
    const error = new Error('Worker task is outside the active lease.')
    error.code = 'PC_WORKER_TASK_FORBIDDEN'
    throw error
  }
  return task
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
  updateProfile = updateWorkerProfile
} = {}) {
  const router = express.Router()

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

  router.post('/tasks/:taskId/complete', async (req, res) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).length !== 2 || typeof req.body.leaseToken !== 'string') {
        return sendCode(res, 400, 'PC_WORKER_INPUT_INVALID')
      }
      const store = runtimeStore(runtime)
      const task = authorizedTask(store, req.pcWorker, req.params.taskId, req.body.leaseToken, ['running'])
      const row = contentRecord(await database(req), task)
      if (!row) return sendCode(res, 409, 'PC_WORKER_CONTENT_UNAVAILABLE')
      const result = normalizeContentInspectionResult(req.body.result, { sha256: row.sha256, bytes: row.bytes })
      const succeeded = await Promise.resolve(store.succeed({
        id: task.id,
        owner: `pcw:${req.pcWorker.id}`,
        token: req.body.leaseToken,
        result
      }))
      return res.json({ data: { id: succeeded.id, status: succeeded.status, progress: succeeded.progress } })
    } catch (error) { return mapError(res, error) }
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
      return res.json({ data: { id: outcome.task.id, status: outcome.task.status, retryScheduled: outcome.retryScheduled } })
    } catch (error) { return mapError(res, error) }
  })

  return router
}

export default createPcWorkerOwnerRouter()
