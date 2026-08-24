import { randomUUID } from 'node:crypto'
import express from 'express'

import { getDatabase } from '../config/database.js'
import { requireOwner, requireWritePermission } from '../middlewares/auth.js'
import { createSearchIndexService, SEARCH_INDEX_ERROR_CODES, SearchIndexError } from '../services/searchIndexService.js'
import { createHybridSearchService } from '../services/hybridSearchService.js'
import { collectSearchEntries } from '../services/searchSourceCollector.js'
import {
  SEARCH_INDEX_EXECUTION_CLASS,
  SEARCH_INDEX_PROCESSOR_VERSION,
  SEARCH_INDEX_TASK_TYPE
} from '../services/searchIndexTaskProcessor.js'
import { enqueueExclusiveRun } from '../services/taskStore.js'
import { getTaskRuntime as defaultGetTaskRuntime } from '../services/taskRuntime.js'
import { projectTask } from '../services/taskTypeCatalog.js'

const SUBJECT_TYPE = 'search-index'
const SUBJECT_ID = 'owner'

export const SEARCH_ROUTE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'SEARCH_INPUT_INVALID',
  INDEX_MISSING: 'SEARCH_INDEX_MISSING',
  INDEX_UNAVAILABLE: 'SEARCH_INDEX_UNAVAILABLE',
  REFRESH_CONFLICT: 'SEARCH_INDEX_REFRESH_CONFLICT',
  REFRESH_FAILED: 'SEARCH_INDEX_REFRESH_FAILED'
})

function sendError(res, status, code) {
  return res.status(status).json({ code })
}

function normalizeRefreshBody(body) {
  const source = body === undefined || body === null ? {} : body
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).some((key) => !['rebuild', 'includeCodeFiles'].includes(key))) {
    const error = new Error('Search refresh input is invalid.')
    error.code = SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID
    throw error
  }
  const rebuild = source.rebuild === undefined ? false : source.rebuild
  const includeCodeFiles = source.includeCodeFiles === undefined ? true : source.includeCodeFiles
  if (typeof rebuild !== 'boolean' || typeof includeCodeFiles !== 'boolean') {
    const error = new Error('Search refresh input is invalid.')
    error.code = SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID
    throw error
  }
  return Object.freeze({ rebuild, includeCodeFiles })
}

function queryError(res, error) {
  if (error?.code === SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID) return sendError(res, 400, SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID)
  if (error instanceof SearchIndexError) {
    if (error.code === SEARCH_INDEX_ERROR_CODES.INPUT_INVALID) return sendError(res, 400, SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID)
    if (error.code === SEARCH_INDEX_ERROR_CODES.INDEX_MISSING) return sendError(res, 503, SEARCH_ROUTE_ERROR_CODES.INDEX_MISSING)
  }
  return sendError(res, 500, SEARCH_ROUTE_ERROR_CODES.INDEX_UNAVAILABLE)
}

function defaultDatabaseProvider(req) {
  return getDatabase(req)
}

export function createSearchRouter({
  databaseProvider = defaultDatabaseProvider,
  collectEntries = collectSearchEntries,
  serviceFactory = createSearchIndexService,
  queryServiceFactory,
  taskRuntimeProvider = defaultGetTaskRuntime,
  enqueue = enqueueExclusiveRun,
  runIdentityFactory = randomUUID
} = {}) {
  const router = express.Router()
  const resolvedQueryServiceFactory = queryServiceFactory ??
    (serviceFactory === createSearchIndexService ? createHybridSearchService : serviceFactory)
  router.use(requireOwner)

  router.get('/status', async (req, res) => {
    try {
      const database = await databaseProvider(req)
      const service = resolvedQueryServiceFactory({ database, collectEntries })
      return res.json({ data: service.getStatus() })
    } catch (error) {
      return queryError(res, error)
    }
  })

  router.post('/index/refresh', requireWritePermission, async (req, res) => {
    let input
    try { input = normalizeRefreshBody(req.body) } catch { return sendError(res, 400, SEARCH_ROUTE_ERROR_CODES.INPUT_INVALID) }
    try {
      const database = await databaseProvider(req)
      const runtime = taskRuntimeProvider()
      const store = runtime?.getStore?.()
      const enqueueOperation = store && typeof store.enqueueExclusiveRun === 'function'
        ? (value, options) => store.enqueueExclusiveRun(value, options)
        : (value, options) => enqueue(database, value, options)
      const taskInput = {
        taskType: SEARCH_INDEX_TASK_TYPE,
        processorVersion: SEARCH_INDEX_PROCESSOR_VERSION,
        subjectType: SUBJECT_TYPE,
        subjectId: SUBJECT_ID,
        subjectVersionId: String(runIdentityFactory()).slice(0, 128),
        executionClass: SEARCH_INDEX_EXECUTION_CLASS,
        input
      }
      const outcome = await Promise.resolve(enqueueOperation(taskInput, { mutexTaskTypes: [SEARCH_INDEX_TASK_TYPE] }))
      if (!outcome || outcome.activeConflict === true || outcome.outcome === 'active-conflict') {
        return sendError(res, 409, SEARCH_ROUTE_ERROR_CODES.REFRESH_CONFLICT)
      }
      const data = projectTask(outcome.task)
      if (!data || data.taskType !== SEARCH_INDEX_TASK_TYPE) return sendError(res, 500, SEARCH_ROUTE_ERROR_CODES.REFRESH_FAILED)
      return res.status(202).json({ data })
    } catch (error) {
      if (error?.code === 'TASK_STATE_CONFLICT') return sendError(res, 409, SEARCH_ROUTE_ERROR_CODES.REFRESH_CONFLICT)
      return sendError(res, 500, SEARCH_ROUTE_ERROR_CODES.REFRESH_FAILED)
    }
  })

  router.get('/', async (req, res) => {
    try {
      const database = await databaseProvider(req)
      const service = resolvedQueryServiceFactory({ database, collectEntries })
      return res.json(service.query({ ...req.query, q: req.query.q ?? req.query.keyword }))
    } catch (error) {
      return queryError(res, error)
    }
  })

  return router
}

export { normalizeRefreshBody as normalizeSearchRefreshBody }
export default createSearchRouter()
