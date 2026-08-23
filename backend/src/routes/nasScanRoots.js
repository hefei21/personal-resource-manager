import { randomUUID } from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import { enqueueExclusiveRun } from '../services/taskStore.js'
import { getTaskRuntime as defaultGetTaskRuntime } from '../services/taskRuntime.js'
import { projectTask } from '../services/taskTypeCatalog.js'
import {
  NAS_SCAN_ROOT_ERROR_CODES,
  createNasScanRootService,
  nasScanRootService
} from '../services/nasScanRootService.js'

const TASK_TYPES = Object.freeze(['nas.resource.scan', 'nas.resource.repair'])
const ROOT_MUTEX_TASK_TYPES = Object.freeze([...TASK_TYPES, 'code.repository.git_nas.discover'])
const POSITIVE_ID = /^[1-9]\d*$/u

const TASK_ACTION_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'NAS_SCAN_TASK_INPUT_INVALID',
  NOT_FOUND: 'NAS_SCAN_TASK_ROOT_NOT_FOUND',
  CONFLICT: 'NAS_SCAN_TASK_CONFLICT',
  RUNTIME: 'NAS_SCAN_TASK_RUNTIME_UNAVAILABLE',
  FAILED: 'NAS_SCAN_TASK_ENQUEUE_FAILED'
})

function defaultDatabaseProvider(req) {
  return getDatabase(req)
}

function normalizeId(value) {
  if (typeof value !== 'string' || !POSITIVE_ID.test(value.trim())) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function sendCode(res, status, code) {
  return res.status(status).json({ code })
}

function rootServiceErrorResponse(res, error) {
  switch (error?.code) {
    case NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID:
    case NAS_SCAN_ROOT_ERROR_CODES.PATH_INVALID:
    case NAS_SCAN_ROOT_ERROR_CODES.RULES_INVALID:
      return sendCode(res, 400, error.code)
    case NAS_SCAN_ROOT_ERROR_CODES.NOT_FOUND:
      return sendCode(res, 404, error.code)
    case NAS_SCAN_ROOT_ERROR_CODES.CONFLICT:
      return sendCode(res, 409, error.code)
    default:
      return sendCode(res, 500, NAS_SCAN_ROOT_ERROR_CODES.WRITE_FAILED)
  }
}

function actionErrorResponse(res, error) {
  switch (error?.code) {
    case 'NAS_SCAN_ROOT_NOT_FOUND':
      return sendCode(res, 404, TASK_ACTION_ERROR_CODES.NOT_FOUND)
    case 'NAS_SCAN_ROOT_DISABLED':
      return sendCode(res, 409, TASK_ACTION_ERROR_CODES.CONFLICT)
    case 'NAS_SCAN_CONFIG_CONFLICT':
    case 'NAS_SCAN_TASK_CONFLICT':
      return sendCode(res, 409, TASK_ACTION_ERROR_CODES.CONFLICT)
    case 'NAS_SCAN_INPUT_INVALID':
      return sendCode(res, 400, TASK_ACTION_ERROR_CODES.INPUT_INVALID)
    default:
      return sendCode(res, 500, TASK_ACTION_ERROR_CODES.FAILED)
  }
}

function projectQueuedTask(task) {
  const projected = projectTask(task)
  return projected && TASK_TYPES.includes(projected.taskType) ? projected : null
}

function createActionInput(root, taskType, runIdentityFactory = randomUUID) {
  const generation = Number(root.lastSuccessfulGeneration) + 1
  const rulesVersion = Number(root.rulesVersion)
  if (!Number.isSafeInteger(generation) || generation < 1 ||
    !Number.isSafeInteger(rulesVersion) || rulesVersion < 1) {
    const error = new Error('NAS scan root generation is invalid.')
    error.code = 'NAS_SCAN_CONFIG_CONFLICT'
    throw error
  }
  return {
    taskType,
    processorVersion: 'v1',
    subjectType: 'nas-scan-root',
    subjectId: String(root.id),
    // Configuration and generation remain explicit in the identity, while a
    // per-run suffix lets an Owner start the same generation again after a
    // cancelled/failed terminal task. Active runs are still protected by the
    // cross-type subject mutex.
    subjectVersionId: `${rulesVersion}-${generation}-${runIdentityFactory()}`,
    executionClass: 'disk',
    input: {
      scanRootId: root.id,
      rulesVersion,
      generation
    }
  }
}

export function createNasScanRootsRouter({
  databaseProvider = defaultDatabaseProvider,
  rootService = nasScanRootService,
  taskRuntimeProvider = null,
  getTaskRuntime = defaultGetTaskRuntime,
  taskRuntime = null,
  enqueue = enqueueExclusiveRun,
  runIdentityFactory = randomUUID
} = {}) {
  const router = express.Router()
  const resolveTaskRuntime = taskRuntimeProvider ?? getTaskRuntime

  // The application mounts this router behind authenticateToken + requireOwner;
  // retain the owner guard here so direct mounts cannot accidentally become public.
  router.use(requireOwner)

  router.get('/', async (req, res) => {
    try {
      const data = await Promise.resolve(rootService.list(await databaseProvider(req)))
      return res.json({ data })
    } catch (error) {
      return rootServiceErrorResponse(res, error)
    }
  })

  router.post('/', requireWritePermission, async (req, res) => {
    try {
      const data = await Promise.resolve(rootService.create(await databaseProvider(req), req.body))
      return res.status(201).json({ data })
    } catch (error) {
      return rootServiceErrorResponse(res, error)
    }
  })

  async function updateRoot(req, res) {
    const id = normalizeId(req.params.id)
    if (id === null) return sendCode(res, 400, NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID)
    try {
      const data = await Promise.resolve(rootService.update(await databaseProvider(req), id, req.body))
      return data ? res.json({ data }) : sendCode(res, 404, NAS_SCAN_ROOT_ERROR_CODES.NOT_FOUND)
    } catch (error) {
      return rootServiceErrorResponse(res, error)
    }
  }

  router.put('/:id', requireWritePermission, updateRoot)
  router.patch('/:id', requireWritePermission, updateRoot)

  router.delete('/:id', requireWritePermission, async (req, res) => {
    const id = normalizeId(req.params.id)
    if (id === null) return sendCode(res, 400, NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID)
    try {
      const data = await Promise.resolve(rootService.disable(await databaseProvider(req), id))
      return data ? res.json({ data }) : sendCode(res, 404, NAS_SCAN_ROOT_ERROR_CODES.NOT_FOUND)
    } catch (error) {
      return rootServiceErrorResponse(res, error)
    }
  })

  async function getRootStatus(req, res) {
    const id = normalizeId(req.params.id)
    if (id === null) return sendCode(res, 400, NAS_SCAN_ROOT_ERROR_CODES.INPUT_INVALID)
    try {
      const data = await Promise.resolve(rootService.status(await databaseProvider(req), id))
      return data ? res.json({ data }) : sendCode(res, 404, NAS_SCAN_ROOT_ERROR_CODES.NOT_FOUND)
    } catch (error) {
      return rootServiceErrorResponse(res, error)
    }
  }

  router.get('/:id/status', getRootStatus)
  router.get('/:id', getRootStatus)

  async function enqueueScan(req, res) {
    const id = normalizeId(req.params.id)
    if (id === null) return sendCode(res, 400, TASK_ACTION_ERROR_CODES.INPUT_INVALID)
    const taskType = req.params.action === 'repair' ? 'nas.resource.repair' : 'nas.resource.scan'
    try {
      const database = await databaseProvider(req)
      const root = await Promise.resolve(rootService.status(database, id))
      if (!root) return sendCode(res, 404, TASK_ACTION_ERROR_CODES.NOT_FOUND)
      if (!root.enabled) return sendCode(res, 409, TASK_ACTION_ERROR_CODES.CONFLICT)
      const runtime = taskRuntime ?? resolveTaskRuntime()
      const store = runtime?.getStore?.()
      const enqueueOperation = store && typeof store.enqueueExclusiveRun === 'function'
        ? (inputValue, options) => store.enqueueExclusiveRun(inputValue, options)
        : typeof enqueue === 'function'
          ? (inputValue, options) => enqueue(database, inputValue, options)
          : null
      if (!enqueueOperation) {
        const error = new Error('NAS scan task runtime is unavailable.')
        error.code = TASK_ACTION_ERROR_CODES.RUNTIME
        throw error
      }
      const input = createActionInput(root, taskType, runIdentityFactory)
      const outcome = await Promise.resolve(enqueueOperation(input, {
        mutexTaskTypes: ROOT_MUTEX_TASK_TYPES
      }))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict') {
        return sendCode(res, 409, TASK_ACTION_ERROR_CODES.CONFLICT)
      }
      const data = projectQueuedTask(outcome.task)
      if (!data) return sendCode(res, 500, TASK_ACTION_ERROR_CODES.FAILED)
      return res.status(202).json({ data })
    } catch (error) {
      return actionErrorResponse(res, error)
    }
  }

  router.post('/:id/scan', requireWritePermission, (req, res, next) => {
    req.params.action = 'scan'
    return enqueueScan(req, res, next)
  })
  router.post('/:id/repair', requireWritePermission, (req, res, next) => {
    req.params.action = 'repair'
    return enqueueScan(req, res, next)
  })

  return router
}

export default createNasScanRootsRouter()
