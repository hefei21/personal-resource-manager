import express from 'express'

import {
  countTasks as defaultCountTasks,
  getTaskById as defaultGetTaskById,
  listTasks as defaultListTasks
} from '../services/taskStore.js'
import {
  getTaskTypeDefinition,
  KNOWN_TASK_TYPES,
  projectTask,
  TASK_CENTER_STATUSES
} from '../services/taskTypeCatalog.js'

export const TASK_QUERY_INVALID_CODE = 'TASK_QUERY_INVALID'
export const TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND'
export const TASK_QUERY_FAILED_CODE = 'TASK_QUERY_FAILED'
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

function normalizeTaskIdParam(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function createTasksRouter({
  databaseProvider = defaultDatabaseProvider,
  listTasks = defaultListTasks,
  countTasks = defaultCountTasks,
  getTaskById = defaultGetTaskById
} = {}) {
  const router = express.Router()

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
