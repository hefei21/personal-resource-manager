import { randomUUID } from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import { enqueueExclusiveRun } from '../services/taskStore.js'
import { getTaskRuntime as defaultGetTaskRuntime } from '../services/taskRuntime.js'
import { projectTask as projectCatalogTask } from '../services/taskTypeCatalog.js'
import {
  GIT_NAS_CANDIDATE_SUBJECT_TYPE,
  GIT_NAS_DISCOVER_TASK_TYPE,
  GIT_NAS_EXECUTION_CLASS,
  GIT_NAS_IMPORT_TASK_TYPE,
  GIT_NAS_PROCESSOR_VERSION,
  GIT_NAS_ROOT_MUTEX_TASK_TYPES,
  GIT_NAS_ROOT_SUBJECT_TYPE,
  GitNasRepositoryError,
  listGitNasCandidates
} from '../services/gitNasRepositoryService.js'
import { nasScanRootService } from '../services/nasScanRootService.js'

const POSITIVE_ID = /^[1-9]\d*$/u

const TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'GIT_NAS_TASK_INPUT_INVALID',
  NOT_FOUND: 'GIT_NAS_TASK_NOT_FOUND',
  CONFLICT: 'GIT_NAS_TASK_CONFLICT',
  FAILED: 'GIT_NAS_TASK_ENQUEUE_FAILED'
})

function defaultDatabaseProvider(req) {
  return getDatabase(req)
}

function normalizePositiveId(value) {
  if (typeof value === 'string' && POSITIVE_ID.test(value.trim())) value = Number(value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function sendCode(res, status, code) {
  return res.status(status).json({ code })
}

function mapServiceError(res, error) {
  if (!(error instanceof GitNasRepositoryError)) return false
  const status = [
    'GIT_NAS_INPUT_INVALID',
    'GIT_NAS_PATH_INVALID',
    'GIT_NAS_SYMLINK_FORBIDDEN',
    'GIT_NAS_REALPATH_ESCAPE'
  ].includes(error.code)
    ? 400
    : ['GIT_NAS_ROOT_NOT_FOUND', 'GIT_NAS_CANDIDATE_NOT_FOUND'].includes(error.code)
      ? 404
      : ['GIT_NAS_ROOT_DISABLED', 'GIT_NAS_CONFIG_CONFLICT', 'GIT_NAS_CANDIDATE_STATE_INVALID'].includes(error.code)
        ? 409
        : error.code === 'GIT_NAS_DATABASE_BUSY' ? 503 : 500
  return sendCode(res, status, error.code)
}

function actionInput(taskType, root, runIdentityFactory) {
  const scanRootId = normalizePositiveId(root.id)
  const rulesVersion = normalizePositiveId(root.rulesVersion)
  const generation = Number(root.lastSuccessfulGeneration) + 1
  if (scanRootId === null || rulesVersion === null || !Number.isSafeInteger(generation) || generation < 1) {
    const error = new GitNasRepositoryError('GIT_NAS_CONFIG_CONFLICT', 'The NAS scan root configuration changed.')
    throw error
  }
  return {
    taskType,
    processorVersion: GIT_NAS_PROCESSOR_VERSION,
    subjectType: GIT_NAS_ROOT_SUBJECT_TYPE,
    subjectId: String(scanRootId),
    subjectVersionId: `${rulesVersion}-${generation}-${runIdentityFactory()}`,
    executionClass: GIT_NAS_EXECUTION_CLASS,
    input: { scanRootId, rulesVersion, generation }
  }
}

function importInput(candidateId, runIdentityFactory) {
  const id = normalizePositiveId(candidateId)
  if (id === null) {
    const error = new GitNasRepositoryError('GIT_NAS_INPUT_INVALID', 'The NAS Git candidate identifier is invalid.')
    throw error
  }
  return {
    taskType: GIT_NAS_IMPORT_TASK_TYPE,
    processorVersion: GIT_NAS_PROCESSOR_VERSION,
    subjectType: GIT_NAS_CANDIDATE_SUBJECT_TYPE,
    subjectId: String(id),
    subjectVersionId: `candidate-${id}-${runIdentityFactory()}`,
    executionClass: GIT_NAS_EXECUTION_CLASS,
    input: { candidateId: id }
  }
}

export function createGitNasRepositoriesRouter({
  databaseProvider = defaultDatabaseProvider,
  rootService = nasScanRootService,
  taskRuntimeProvider = null,
  getTaskRuntime = defaultGetTaskRuntime,
  taskRuntime = null,
  enqueue = enqueueExclusiveRun,
  runIdentityFactory = randomUUID,
  candidateList = listGitNasCandidates
} = {}) {
  const router = express.Router()
  const resolveTaskRuntime = taskRuntimeProvider ?? getTaskRuntime

  // The application mounts this router behind authenticateToken and ownerOnly;
  // retain the owner check for direct mounts and isolated route tests.
  router.use(requireOwner)

  async function listCandidates(req, res) {
    try {
      const scanRootId = req.query.scanRootId === undefined ? undefined : normalizePositiveId(req.query.scanRootId)
      if (req.query.scanRootId !== undefined && scanRootId === null) return sendCode(res, 400, 'GIT_NAS_INPUT_INVALID')
      const data = candidateList(await databaseProvider(req), { scanRootId })
      return res.json({ data })
    } catch (error) {
      if (mapServiceError(res, error)) return
      return sendCode(res, 500, 'GIT_NAS_WRITE_FAILED')
    }
  }

  router.get('/', listCandidates)

  router.get('/candidates', listCandidates)

  async function enqueueTask(req, res, kind) {
    try {
      const database = await databaseProvider(req)
      const runtime = taskRuntime ?? resolveTaskRuntime()
      const store = runtime?.getStore?.()
      const enqueueOperation = store && typeof store.enqueueExclusiveRun === 'function'
        ? (input, options) => store.enqueueExclusiveRun(input, options)
        : typeof enqueue === 'function'
          ? (input, options) => enqueue(database, input, options)
          : null
      if (!enqueueOperation) return sendCode(res, 503, 'GIT_NAS_TASK_RUNTIME_UNAVAILABLE')

      let input
      let options
      if (kind === 'discover') {
        const scanRootId = normalizePositiveId(req.body?.scanRootId ?? req.params.scanRootId)
        if (scanRootId === null) return sendCode(res, 400, TASK_ERROR_CODES.INPUT_INVALID)
        const root = await Promise.resolve(rootService.status(database, scanRootId))
        if (!root) return sendCode(res, 404, TASK_ERROR_CODES.NOT_FOUND)
        if (!root.enabled) return sendCode(res, 409, TASK_ERROR_CODES.CONFLICT)
        if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
          const allowed = new Set(['scanRootId', 'rulesVersion', 'generation'])
          if (Object.keys(req.body).some((key) => !allowed.has(key))) return sendCode(res, 400, TASK_ERROR_CODES.INPUT_INVALID)
          for (const key of ['rulesVersion', 'generation']) {
            if (req.body[key] !== undefined && normalizePositiveId(req.body[key]) === null) {
              return sendCode(res, 400, TASK_ERROR_CODES.INPUT_INVALID)
            }
          }
          const expectedGeneration = Number(root.lastSuccessfulGeneration) + 1
          if (req.body.rulesVersion !== undefined && Number(req.body.rulesVersion) !== Number(root.rulesVersion)) return sendCode(res, 409, TASK_ERROR_CODES.CONFLICT)
          if (req.body.generation !== undefined && Number(req.body.generation) !== expectedGeneration) return sendCode(res, 409, TASK_ERROR_CODES.CONFLICT)
        }
        input = actionInput(GIT_NAS_DISCOVER_TASK_TYPE, root, runIdentityFactory)
        options = { mutexTaskTypes: GIT_NAS_ROOT_MUTEX_TASK_TYPES }
      } else {
        const candidateId = normalizePositiveId(req.body?.candidateId ?? req.params.candidateId ?? req.params.id)
        if (candidateId === null) return sendCode(res, 400, TASK_ERROR_CODES.INPUT_INVALID)
        if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) &&
          Object.keys(req.body).some((key) => key !== 'candidateId')) return sendCode(res, 400, TASK_ERROR_CODES.INPUT_INVALID)
        input = importInput(candidateId, runIdentityFactory)
        options = { mutexTaskTypes: [GIT_NAS_IMPORT_TASK_TYPE] }
      }
      const outcome = await Promise.resolve(enqueueOperation(input, options))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict') {
        return sendCode(res, 409, TASK_ERROR_CODES.CONFLICT)
      }
      const projected = projectCatalogTask(outcome.task)
      if (!projected) return sendCode(res, 500, TASK_ERROR_CODES.FAILED)
      return res.status(202).json({ data: projected })
    } catch (error) {
      if (mapServiceError(res, error)) return
      return sendCode(res, 500, TASK_ERROR_CODES.FAILED)
    }
  }

  router.post('/discover', requireWritePermission, (req, res, next) => enqueueTask(req, res, 'discover', next))
  router.post('/:scanRootId/discover', requireWritePermission, (req, res, next) => enqueueTask(req, res, 'discover', next))
  router.post('/import', requireWritePermission, (req, res, next) => enqueueTask(req, res, 'import', next))
  router.post('/candidates/:candidateId/import', requireWritePermission, (req, res, next) => enqueueTask(req, res, 'import', next))
  router.post('/:id/import', requireWritePermission, (req, res, next) => enqueueTask(req, res, 'import', next))

  router.get('/candidates/:id', async (req, res) => {
    try {
      const id = normalizePositiveId(req.params.id)
      if (id === null) return sendCode(res, 400, 'GIT_NAS_INPUT_INVALID')
      const data = candidateList(await databaseProvider(req))
        .find((candidate) => candidate.candidateId === id)
      return data ? res.json({ data }) : sendCode(res, 404, 'GIT_NAS_CANDIDATE_NOT_FOUND')
    } catch (error) {
      if (mapServiceError(res, error)) return
      return sendCode(res, 500, 'GIT_NAS_WRITE_FAILED')
    }
  })

  return router
}

export default createGitNasRepositoriesRouter()
