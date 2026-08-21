import express from 'express'

import { requireOwner } from '../middlewares/auth.js'
import {
  countTasks as defaultCountTasks,
  executeTaskCleanup as defaultExecuteTaskCleanup,
  getTaskById as defaultGetTaskById,
  listTasks as defaultListTasks,
  previewTaskCleanup as defaultPreviewTaskCleanup
} from '../services/taskStore.js'
import { getTaskRuntime as defaultGetTaskRuntime } from '../services/taskRuntime.js'
import {
  createTaskRetrySpec,
  getTaskTypeDefinition,
  KNOWN_TASK_TYPES,
  projectTask,
  TASK_CENTER_STATUSES
} from '../services/taskTypeCatalog.js'

export const TASK_QUERY_INVALID_CODE = 'TASK_QUERY_INVALID'
export const TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND'
export const TASK_QUERY_FAILED_CODE = 'TASK_QUERY_FAILED'
export const TASK_CANCEL_CONFLICT_CODE = 'TASK_CANCEL_CONFLICT'
export const TASK_CANCEL_FAILED_CODE = 'TASK_CANCEL_FAILED'
export const TASK_RETRY_CONFLICT_CODE = 'TASK_RETRY_CONFLICT'
export const TASK_RETRY_FAILED_CODE = 'TASK_RETRY_FAILED'
export const TASK_CLEANUP_INVALID_CODE = 'TASK_CLEANUP_INVALID'
export const TASK_CLEANUP_CONFLICT_CODE = 'TASK_CLEANUP_CONFLICT'
export const TASK_CLEANUP_FAILED_CODE = 'TASK_CLEANUP_FAILED'
export const DEFAULT_TASK_PAGE_SIZE = 50
export const MAX_TASK_PAGE_SIZE = 100
export const MAX_TASK_OFFSET = 1_000_000_000

const ALLOWED_QUERY_KEYS = new Set([
  'status',
  'taskType',
  'page',
  'pageSize',
  'limit',
  'offset',
  'order'
])
const STATUS_SET = new Set(TASK_CENTER_STATUSES)
const KNOWN_TASK_TYPE_SET = new Set(KNOWN_TASK_TYPES)
const CANCELLABLE_STATUS_SET = new Set(['pending', 'leased', 'running'])
const ACTION_NOT_FOUND_ERROR_CODES = new Set(['TASK_NOT_FOUND', 'TASK_ID_INVALID', 'NAS_EXECUTOR_TASK_ID_INVALID'])
const ACTION_CONFLICT_ERROR_CODES = new Set([
  'TASK_INVALID_STATE',
  'TASK_STATE_CONFLICT',
  'TASK_LEASE_MISMATCH',
  'TASK_LEASE_EXPIRED',
  'TASK_ERROR_LEASE_EXPIRED',
  'TASK_LEASE_CREDENTIALS_INVALID',
  'TASK_IDEMPOTENCY_CONFLICT',
  'TASK_EXCLUSIVE_TASK_TYPES_INVALID',
  'TASK_INPUT_INVALID',
  'TASK_STORE_INPUT_INVALID',
  'TASK_IDENTITY_INVALID',
  'TASK_PROCESSOR_IDENTITY_INVALID',
  'TASK_SUBJECT_ID_INVALID',
  'TASK_SUBJECT_VERSION_INVALID',
  'TASK_EXECUTION_CLASS_INVALID',
  'TASK_NUMBER_INVALID',
  'TASK_TIMESTAMP_INVALID',
  'TASK_JSON_INVALID',
  'TASK_STORE_DATA_INVALID',
  TASK_CANCEL_CONFLICT_CODE,
  TASK_RETRY_CONFLICT_CODE
])
const CLEANUP_INPUT_ERROR_CODES = new Set([
  TASK_CLEANUP_INVALID_CODE,
  'TASK_CLEANUP_INPUT_INVALID',
  'TASK_NUMBER_INVALID',
  'TASK_TIMESTAMP_INVALID',
  'TASK_INPUT_INVALID',
  'TASK_STORE_INPUT_INVALID'
])

async function defaultDatabaseProvider(req) {
  const { getDatabase } = await import('../config/database.js')
  return getDatabase(req)
}

function queryError(message) {
  const error = new Error(message)
  error.code = TASK_QUERY_INVALID_CODE
  return error
}

function getSingleQueryValue(query, key) {
  const value = query[key]
  if (Array.isArray(value)) throw queryError(`${key} must be a single value.`)
  return value
}

function parseIntegerQuery(query, key, { defaultValue, min, max }) {
  const raw = getSingleQueryValue(query, key)
  if (raw === undefined) return defaultValue
  const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(text)) {
    throw queryError(`${key} is invalid.`)
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw queryError(`${key} is invalid.`)
  }
  return value
}

function parseCsvQuery(query, key) {
  const raw = getSingleQueryValue(query, key)
  if (raw === undefined) return null
  if (typeof raw !== 'string' || raw.length === 0) throw queryError(`${key} is invalid.`)
  const values = raw.split(',').map((value) => value.trim())
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw queryError(`${key} is invalid.`)
  }
  return [...new Set(values)]
}

function parseTaskQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw queryError('Query is invalid.')
  if (Object.keys(query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    throw queryError('Query contains unsupported fields.')
  }

  const rawStatuses = parseCsvQuery(query, 'status')
  const statuses = rawStatuses === null
    ? null
    : rawStatuses.map((status) => {
        if (!STATUS_SET.has(status)) throw queryError('status is invalid.')
        return status
      })

  const rawTaskTypes = parseCsvQuery(query, 'taskType')
  const taskTypes = rawTaskTypes === null
    ? KNOWN_TASK_TYPES
    : rawTaskTypes.map((taskType) => {
        if (!KNOWN_TASK_TYPE_SET.has(taskType) || !getTaskTypeDefinition(taskType)) {
          throw queryError('taskType is invalid.')
        }
        return taskType
      })

  const hasPage = query.page !== undefined
  const hasPageSize = query.pageSize !== undefined
  const hasLimit = query.limit !== undefined
  const hasOffset = query.offset !== undefined
  if ((hasPage || hasPageSize) && (hasLimit || hasOffset)) {
    throw queryError('page/pageSize and limit/offset cannot be combined.')
  }

  let page
  let pageSize
  let limit
  let offset
  if (hasPage || hasPageSize) {
    page = parseIntegerQuery(query, 'page', { defaultValue: 1, min: 1, max: MAX_TASK_OFFSET })
    pageSize = parseIntegerQuery(query, 'pageSize', {
      defaultValue: DEFAULT_TASK_PAGE_SIZE,
      min: 1,
      max: MAX_TASK_PAGE_SIZE
    })
    offset = (page - 1) * pageSize
    if (!Number.isSafeInteger(offset) || offset > MAX_TASK_OFFSET) throw queryError('page is invalid.')
    limit = pageSize
  } else {
    limit = parseIntegerQuery(query, 'limit', {
      defaultValue: DEFAULT_TASK_PAGE_SIZE,
      min: 1,
      max: MAX_TASK_PAGE_SIZE
    })
    offset = parseIntegerQuery(query, 'offset', {
      defaultValue: 0,
      min: 0,
      max: MAX_TASK_OFFSET
    })
    pageSize = limit
    page = Math.floor(offset / pageSize) + 1
  }

  const rawOrder = getSingleQueryValue(query, 'order')
  const order = rawOrder === undefined ? 'desc' : rawOrder
  if (order !== 'asc' && order !== 'desc') throw queryError('order is invalid.')

  return Object.freeze({
    statuses,
    taskTypes: Object.freeze([...taskTypes]),
    page,
    pageSize,
    limit,
    offset,
    order
  })
}

function listOptions(query) {
  return {
    ...(query.statuses === null ? {} : { status: query.statuses }),
    taskTypes: query.taskTypes,
    limit: query.limit,
    offset: query.offset,
    order: query.order
  }
}

function sendQueryError(res) {
  return res.status(400).json({ code: TASK_QUERY_INVALID_CODE })
}

function sendNotFound(res) {
  return res.status(404).json({ code: TASK_NOT_FOUND_CODE })
}

function sendQueryFailure(res) {
  return res.status(500).json({ code: TASK_QUERY_FAILED_CODE })
}

function sendActionConflict(res, code) {
  return res.status(409).json({ code })
}

function sendActionFailure(res, code) {
  return res.status(500).json({ code })
}

function sendActionError(res, error, { conflictCode, failureCode }) {
  if (ACTION_NOT_FOUND_ERROR_CODES.has(error?.code)) return sendNotFound(res)
  if (ACTION_CONFLICT_ERROR_CODES.has(error?.code)) return sendActionConflict(res, conflictCode)
  return sendActionFailure(res, failureCode)
}

function cleanupInputError(message) {
  const error = new Error(message)
  error.code = TASK_CLEANUP_INVALID_CODE
  return error
}

function parseCleanupPreviewBody(body) {
  const source = body === undefined || body === null ? {} : body
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw cleanupInputError('Cleanup preview body is invalid.')
  }
  if (Object.keys(source).length > 0) throw cleanupInputError('Cleanup preview body must be empty.')
  return {}
}

function parseCleanupExecuteBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw cleanupInputError('Cleanup execute body is invalid.')
  }
  const allowed = new Set(['previewedAt', 'expectedCount'])
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw cleanupInputError('Cleanup execute body contains unsupported fields.')
  }
  if (!Object.hasOwn(body, 'previewedAt') || !Object.hasOwn(body, 'expectedCount')) {
    throw cleanupInputError('Cleanup execute body is incomplete.')
  }
  return {
    previewedAt: body.previewedAt,
    expectedCount: body.expectedCount
  }
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function projectCleanupPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const retentionDays = policy.retentionDays
  const cutoffAt = policy.cutoffAt
  if (!retentionDays || typeof retentionDays !== 'object' || Array.isArray(retentionDays) ||
    !cutoffAt || typeof cutoffAt !== 'object' || Array.isArray(cutoffAt) ||
    !isNonNegativeSafeInteger(policy.batchLimit)) return null
  const statuses = ['succeeded', 'failed', 'cancelled']
  if (statuses.some((status) =>
    !isNonNegativeSafeInteger(retentionDays[status]) || typeof cutoffAt[status] !== 'string')) return null
  return {
    retentionDays: Object.fromEntries(statuses.map((status) => [status, retentionDays[status]])),
    cutoffAt: Object.fromEntries(statuses.map((status) => [status, cutoffAt[status]])),
    batchLimit: policy.batchLimit
  }
}

function projectCleanupReport(report, mode) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
    typeof report.previewedAt !== 'string' || !isNonNegativeSafeInteger(report.eligibleCount) ||
    !isNonNegativeSafeInteger(report.selectedCount)) return null
  const policy = projectCleanupPolicy(report.policy)
  if (!policy) return null
  const data = {
    previewedAt: report.previewedAt,
    eligibleCount: report.eligibleCount,
    selectedCount: report.selectedCount,
    policy
  }
  if (mode === 'execute') {
    if (typeof report.executedAt !== 'string' || !isNonNegativeSafeInteger(report.deletedCount)) return null
    data.executedAt = report.executedAt
    data.deletedCount = report.deletedCount
  }
  return data
}

function sendCleanupError(res, error) {
  if (error?.code === TASK_CLEANUP_CONFLICT_CODE || error?.code === 'TASK_CLEANUP_CONFLICT') {
    return res.status(409).json({ code: TASK_CLEANUP_CONFLICT_CODE })
  }
  if (CLEANUP_INPUT_ERROR_CODES.has(error?.code)) {
    return res.status(400).json({ code: TASK_CLEANUP_INVALID_CODE })
  }
  return res.status(500).json({ code: TASK_CLEANUP_FAILED_CODE })
}

function resolveActionRuntime(taskRuntime, getTaskRuntime) {
  const runtime = taskRuntime ?? getTaskRuntime()
  if (!runtime || typeof runtime.getStore !== 'function') {
    const error = new Error('Task runtime is invalid.')
    error.code = 'TASK_RUNTIME_INVALID'
    throw error
  }
  return runtime
}

function safeProjectTask(task) {
  try {
    return projectTask(task)
  } catch {
    return null
  }
}

function normalizeTaskIdParam(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function createTasksRouter({
  databaseProvider = defaultDatabaseProvider,
  listTasks = defaultListTasks,
  countTasks = defaultCountTasks,
  getTaskById = defaultGetTaskById,
  previewTaskCleanup = defaultPreviewTaskCleanup,
  executeTaskCleanup = defaultExecuteTaskCleanup,
  getTaskRuntime = defaultGetTaskRuntime,
  taskRuntime = null
} = {}) {
  const router = express.Router()

  // Keep the router safe when it is mounted without the shared app boundary.
  router.use(requireOwner)

  router.post('/cleanup/preview', async (req, res) => {
    let body
    try {
      body = parseCleanupPreviewBody(req.body)
    } catch (error) {
      return sendCleanupError(res, error)
    }

    try {
      const database = await databaseProvider(req)
      const report = await Promise.resolve(previewTaskCleanup(database, body))
      const data = projectCleanupReport(report, 'preview')
      return data ? res.json({ data }) : sendCleanupError(res, new Error('Cleanup preview projection failed.'))
    } catch (error) {
      return sendCleanupError(res, error)
    }
  })

  router.post('/cleanup/execute', async (req, res) => {
    let body
    try {
      body = parseCleanupExecuteBody(req.body)
    } catch (error) {
      return sendCleanupError(res, error)
    }

    try {
      const database = await databaseProvider(req)
      const report = await Promise.resolve(executeTaskCleanup(database, body))
      const data = projectCleanupReport(report, 'execute')
      return data ? res.json({ data }) : sendCleanupError(res, new Error('Cleanup execute projection failed.'))
    } catch (error) {
      return sendCleanupError(res, error)
    }
  })

  router.get('/', async (req, res) => {
    let query
    try {
      query = parseTaskQuery(req.query)
    } catch {
      return sendQueryError(res)
    }

    try {
      const database = await databaseProvider(req)
      const options = listOptions(query)
      const total = countTasks(database, options)
      const tasks = listTasks(database, options)
      const data = tasks.map(projectTask).filter((task) => task !== null)
      const totalPages = total === 0 ? 0 : Math.ceil(total / query.pageSize)
      return res.json({
        data,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          limit: query.limit,
          offset: query.offset,
          order: query.order,
          total,
          totalPages
        },
        total
      })
    } catch (error) {
      if (error?.code === TASK_QUERY_INVALID_CODE) return sendQueryError(res)
      return sendQueryFailure(res)
    }
  })

  router.post('/:id/cancel', async (req, res) => {
    const id = normalizeTaskIdParam(req.params.id)
    if (id === null) return sendNotFound(res)

    try {
      const runtime = resolveActionRuntime(taskRuntime, getTaskRuntime)
      const store = runtime.getStore()
      if (!store || typeof store.getById !== 'function' || typeof runtime.cancelTask !== 'function') {
        const error = new Error('Task runtime action contract is invalid.')
        error.code = 'TASK_RUNTIME_INVALID'
        throw error
      }
      const current = await Promise.resolve(store.getById(id))
      const currentProjection = safeProjectTask(current)
      if (currentProjection === null || currentProjection.id !== id) return sendNotFound(res)
      if (!CANCELLABLE_STATUS_SET.has(current.status)) {
        return sendActionConflict(res, TASK_CANCEL_CONFLICT_CODE)
      }

      const cancelled = await Promise.resolve(runtime.cancelTask(id))
      const data = safeProjectTask(cancelled)
      if (!data || data.status !== 'cancelled') return sendActionFailure(res, TASK_CANCEL_FAILED_CODE)
      return res.json({ data })
    } catch (error) {
      return sendActionError(res, error, {
        conflictCode: TASK_CANCEL_CONFLICT_CODE,
        failureCode: TASK_CANCEL_FAILED_CODE
      })
    }
  })

  router.post('/:id/retry', async (req, res) => {
    const id = normalizeTaskIdParam(req.params.id)
    if (id === null) return sendNotFound(res)

    try {
      const runtime = resolveActionRuntime(taskRuntime, getTaskRuntime)
      const store = runtime.getStore()
      if (!store || typeof store.getById !== 'function' || typeof store.enqueueExclusiveRun !== 'function') {
        const error = new Error('Task runtime retry contract is invalid.')
        error.code = 'TASK_RUNTIME_INVALID'
        throw error
      }
      const current = await Promise.resolve(store.getById(id))
      const currentProjection = safeProjectTask(current)
      if (currentProjection === null || currentProjection.id !== id) return sendNotFound(res)
      if (current.status !== 'failed') return sendActionConflict(res, TASK_RETRY_CONFLICT_CODE)

      let spec
      try {
        spec = createTaskRetrySpec(current)
      } catch {
        return sendActionConflict(res, TASK_RETRY_CONFLICT_CODE)
      }
      if (spec === null) return sendActionConflict(res, TASK_RETRY_CONFLICT_CODE)

      const outcome = await Promise.resolve(store.enqueueExclusiveRun({
        identity: spec.identity,
        input: spec.input,
        executionClass: spec.executionClass
      }, { mutexTaskTypes: spec.mutexTaskTypes }))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict' || outcome.created !== true) {
        return sendActionConflict(res, TASK_RETRY_CONFLICT_CODE)
      }

      const data = safeProjectTask(outcome.task)
      if (!data) return sendActionFailure(res, TASK_RETRY_FAILED_CODE)
      return res.status(202).json({ data })
    } catch (error) {
      return sendActionError(res, error, {
        conflictCode: TASK_RETRY_CONFLICT_CODE,
        failureCode: TASK_RETRY_FAILED_CODE
      })
    }
  })

  router.get('/:id', async (req, res) => {
    const id = normalizeTaskIdParam(req.params.id)
    if (id === null) return sendNotFound(res)

    try {
      const task = getTaskById(await databaseProvider(req), id)
      const data = projectTask(task)
      return data === null ? sendNotFound(res) : res.json({ data })
    } catch (error) {
      if (error?.code === 'TASK_NOT_FOUND' || error?.code === 'TASK_ID_INVALID') return sendNotFound(res)
      return sendQueryFailure(res)
    }
  })

  return router
}

export { parseTaskQuery }

export default createTasksRouter()
