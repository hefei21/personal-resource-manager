import { randomUUID } from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import { enqueueExclusiveRun } from '../services/taskStore.js'
import { getTaskRuntime as defaultGetTaskRuntime } from '../services/taskRuntime.js'
import { projectTask } from '../services/taskTypeCatalog.js'
import {
  normalizeResourceDomainImportInput,
  RESOURCE_DOMAIN_IMPORT_ERROR_CODES,
  RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION,
  RESOURCE_DOMAIN_IMPORT_TASK_TYPE
} from '../services/resourceDomainAdapter.js'

const SUBJECT_TYPE = 'resource-domain-import'
const SUBJECT_ID = 'owner'

export const RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RESOURCE_DOMAIN_IMPORT_INPUT_INVALID',
  CONFLICT: 'RESOURCE_DOMAIN_IMPORT_CONFLICT',
  RUNTIME: 'RESOURCE_DOMAIN_IMPORT_RUNTIME_UNAVAILABLE',
  ENQUEUE_FAILED: 'RESOURCE_DOMAIN_IMPORT_ENQUEUE_FAILED'
})

function sendCode(res, status, code) {
  return res.status(status).json({ code })
}

function parseBody(body) {
  const source = body === undefined || body === null ? {} : body
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    const error = new Error('Import body is invalid.')
    error.code = RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID
    throw error
  }
  const normalized = normalizeResourceDomainImportInput(source)
  const input = { scope: normalized.scope }
  if (Object.hasOwn(source, 'cursor')) input.cursor = normalized.cursor
  if (Object.hasOwn(source, 'batchSize')) input.batchSize = normalized.batchSize
  return Object.freeze(input)
}

function createActionInput(input, runIdentityFactory) {
  const suffix = runIdentityFactory()
  if (typeof suffix !== 'string' || suffix.trim() === '' || suffix.length > 128 || /[\u0000-\u001f\u007f]/u.test(suffix)) {
    const error = new Error('Import run identity is invalid.')
    error.code = RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.ENQUEUE_FAILED
    throw error
  }
  return Object.freeze({
    taskType: RESOURCE_DOMAIN_IMPORT_TASK_TYPE,
    processorVersion: RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION,
    subjectType: SUBJECT_TYPE,
    subjectId: SUBJECT_ID,
    subjectVersionId: `${input.scope}-${suffix}`,
    executionClass: 'disk',
    input
  })
}

export function projectQueuedResourceDomainTask(task) {
  const projected = projectTask(task)
  return projected?.taskType === RESOURCE_DOMAIN_IMPORT_TASK_TYPE ? projected : null
}

function actionErrorResponse(res, error) {
  switch (error?.code) {
    case RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID:
    case RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.INPUT_INVALID:
      return sendCode(res, 400, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.INPUT_INVALID)
    case 'TASK_SUBJECT_ID_INVALID':
    case 'TASK_SUBJECT_VERSION_INVALID':
    case 'TASK_INPUT_INVALID':
    case 'TASK_IDENTITY_INVALID':
    case 'TASK_EXCLUSIVE_TASK_TYPES_INVALID':
      return sendCode(res, 400, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.INPUT_INVALID)
    case RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.CONFLICT:
    case 'TASK_STATE_CONFLICT':
      return sendCode(res, 409, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.CONFLICT)
    default:
      return sendCode(res, 500, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.ENQUEUE_FAILED)
  }
}

function defaultDatabaseProvider(req) {
  return getDatabase(req)
}

export function createResourceDomainImportsRouter({
  databaseProvider = defaultDatabaseProvider,
  taskRuntimeProvider = null,
  getTaskRuntime = defaultGetTaskRuntime,
  taskRuntime = null,
  enqueue = enqueueExclusiveRun,
  runIdentityFactory = randomUUID
} = {}) {
  const router = express.Router()
  const resolveTaskRuntime = taskRuntimeProvider ?? getTaskRuntime

  // The application mounts this route behind authentication; retain the Owner
  // guard here so a direct mount cannot accidentally expose the import action.
  router.use(requireOwner)

  router.post('/', requireWritePermission, async (req, res) => {
    let input
    try {
      input = parseBody(req.body)
    } catch (error) {
      return actionErrorResponse(res, error)
    }

    try {
      const database = await databaseProvider(req)
      const taskInput = createActionInput(input, runIdentityFactory)
      let runtime = taskRuntime
      if (!runtime) {
        try { runtime = resolveTaskRuntime() } catch {}
      }
      let store = null
      try { store = runtime?.getStore?.() ?? null } catch {}
      const enqueueOperation = store && typeof store.enqueueExclusiveRun === 'function'
        ? (value, options) => store.enqueueExclusiveRun(value, options)
        : typeof enqueue === 'function'
          ? (value, options) => enqueue(database, value, options)
          : null
      if (!enqueueOperation) {
        const error = new Error('Resource domain import task runtime is unavailable.')
        error.code = RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.RUNTIME
        throw error
      }
      const outcome = await Promise.resolve(enqueueOperation(taskInput, {
        mutexTaskTypes: [RESOURCE_DOMAIN_IMPORT_TASK_TYPE]
      }))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict') {
        return sendCode(res, 409, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.CONFLICT)
      }
      const data = projectQueuedResourceDomainTask(outcome.task)
      if (!data) return sendCode(res, 500, RESOURCE_DOMAIN_IMPORT_ROUTE_ERROR_CODES.ENQUEUE_FAILED)
      return res.status(202).json({ data })
    } catch (error) {
      return actionErrorResponse(res, error)
    }
  })

  return router
}

export { parseBody as parseResourceDomainImportBody }
export default createResourceDomainImportsRouter()
