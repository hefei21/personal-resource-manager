import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import api from '@/api'

export const TASK_ACTIVE_STATUSES = Object.freeze(['pending', 'leased', 'running'])

export const TASK_ERROR_CODE_WHITELIST = Object.freeze([
  'TASK_QUERY_INVALID',
  'TASK_QUERY_FAILED',
  'TASK_NOT_FOUND',
  'TASK_CANCEL_CONFLICT',
  'TASK_CANCEL_FAILED',
  'TASK_RETRY_CONFLICT',
  'TASK_RETRY_FAILED',
  'TASK_CLEANUP_INVALID',
  'TASK_CLEANUP_CONFLICT',
  'TASK_CLEANUP_FAILED',
  'TASK_ACTION_CONFLICT',
  'TASK_INPUT_INVALID',
  'TASK_ID_INVALID',
  'TASK_IDEMPOTENCY_CONFLICT',
  'TASK_LEASE_EXPIRED',
  'TASK_PROCESSOR_FAILED',
  'TASK_HEARTBEAT_FAILED',
  'TASK_PROGRESS_REJECTED',
  'TASK_CANCELLED',
  'TASK_TYPE_UNSUPPORTED',
  'EBOOK_COVER_TASK_TIMEOUT',
  'EBOOK_COVER_TASK_MISSING',
  'EBOOK_COVER_TASK_FAILED',
  'PROXY_DNS_FAILED',
  'PROXY_CONNECTION_FAILED',
  'SESSION_REQUIRED',
  'OWNER_REQUIRED',
  'TASK_NETWORK_ERROR',
  'TASK_REQUEST_FAILED',
  'TASK_ACTION_IN_PROGRESS'
])

const ERROR_CODE_SET = new Set(TASK_ERROR_CODE_WHITELIST)
const TASK_ID_PATTERN = /^[1-9]\d*$/u

function normalizeFilterValue(value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))]
  }
  return typeof value === 'string' ? value.trim() : ''
}

function asCsv(value) {
  if (Array.isArray(value)) return value.join(',') || null
  return value || null
}

function normalizeInteger(value, fallback, { min = 1, max = 100 } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}

function normalizeTaskId(id) {
  const value = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : String(id ?? '')
  return TASK_ID_PATTERN.test(value) ? value : null
}

function safeTaskErrorCode(error, fallback = 'TASK_REQUEST_FAILED') {
  const responseCode = error?.response?.data?.code
  if (typeof responseCode === 'string' && ERROR_CODE_SET.has(responseCode)) return responseCode
  if (typeof error?.code === 'string' && ERROR_CODE_SET.has(error.code)) return error.code

  const status = error?.response?.status
  if (status === 401) return 'SESSION_REQUIRED'
  if (status === 403) return 'OWNER_REQUIRED'
  if (status === 404) return 'TASK_NOT_FOUND'
  if (status === 409) return 'TASK_ACTION_CONFLICT'
  if (!error?.response && error?.request) return 'TASK_NETWORK_ERROR'
  return fallback
}

function taskError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function normalizePagination(body, filter) {
  const source = body?.pagination && typeof body.pagination === 'object' ? body.pagination : {}
  const total = Number.isSafeInteger(source.total)
    ? Math.max(0, source.total)
    : Number.isSafeInteger(body?.total)
      ? Math.max(0, body.total)
      : 0
  const pageSize = normalizeInteger(source.pageSize, filter.pageSize)
  const page = normalizeInteger(source.page, filter.page, { min: 1, max: 1_000_000_000 })
  const totalPages = Number.isSafeInteger(source.totalPages)
    ? Math.max(0, source.totalPages)
    : total === 0 ? 0 : Math.ceil(total / pageSize)

  return {
    page,
    pageSize,
    limit: normalizeInteger(source.limit, pageSize),
    offset: Number.isSafeInteger(source.offset) && source.offset >= 0 ? source.offset : (page - 1) * pageSize,
    order: source.order === 'asc' ? 'asc' : 'desc',
    total,
    totalPages
  }
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref([])
  const pagination = reactive({
    page: 1,
    pageSize: 20,
    limit: 20,
    offset: 0,
    order: 'desc',
    total: 0,
    totalPages: 0
  })
  const loading = ref(false)
  const error = ref(null)
  const filter = reactive({
    status: '',
    taskType: '',
    page: 1,
    pageSize: 20,
    order: 'desc'
  })
  const actionLoading = reactive({})
  const cleanupLoading = ref(false)

  let requestSequence = 0
  let activeRequest = null

  const hasActiveTasks = computed(() => tasks.value.some((task) => TASK_ACTIVE_STATUSES.includes(task?.status)))

  function buildQuery() {
    const query = {
      page: filter.page,
      pageSize: filter.pageSize,
      order: filter.order
    }
    const status = asCsv(filter.status)
    const taskType = asCsv(filter.taskType)
    if (status) query.status = status
    if (taskType) query.taskType = taskType
    return query
  }

  async function fetchTasks() {
    const params = buildQuery()
    const key = JSON.stringify(params)
    if (activeRequest?.key === key) return activeRequest.promise

    const requestId = ++requestSequence
    loading.value = true
    error.value = null

    const promise = api.tasks.list(params)
      .then((response) => {
        if (requestId !== requestSequence) return { success: false, stale: true }

        const body = response?.data
        if (!body || !Array.isArray(body.data)) throw taskError('TASK_QUERY_FAILED')

        const nextPagination = normalizePagination(body, filter)
        tasks.value = body.data
        Object.assign(pagination, nextPagination)

        const lastPage = nextPagination.totalPages > 0 ? nextPagination.totalPages : 1
        if (filter.page > lastPage) {
          filter.page = lastPage
          return fetchTasks()
        }

        return {
          success: true,
          data: tasks.value,
          pagination: { ...pagination },
          total: pagination.total
        }
      })
      .catch((requestError) => {
        if (requestId !== requestSequence) return { success: false, stale: true }
        const code = safeTaskErrorCode(requestError)
        error.value = code
        return { success: false, code }
      })
      .finally(() => {
        if (requestId === requestSequence) loading.value = false
        if (activeRequest?.requestId === requestId) activeRequest = null
      })

    activeRequest = { key, promise, requestId }
    return promise
  }

  function refresh() {
    return fetchTasks()
  }

  function setFilters(nextFilters = {}) {
    const filterKeys = ['status', 'taskType', 'page', 'pageSize', 'order']
    const resetsPage = ['status', 'taskType', 'pageSize', 'order']
      .some((key) => Object.hasOwn(nextFilters, key)) && !Object.hasOwn(nextFilters, 'page')

    for (const key of filterKeys) {
      if (!Object.hasOwn(nextFilters, key)) continue
      if (key === 'status' || key === 'taskType') {
        filter[key] = normalizeFilterValue(nextFilters[key])
      } else if (key === 'page') {
        filter.page = normalizeInteger(nextFilters.page, 1, { min: 1, max: 1_000_000_000 })
      } else if (key === 'pageSize') {
        filter.pageSize = normalizeInteger(nextFilters.pageSize, filter.pageSize)
      } else if (key === 'order') {
        filter.order = nextFilters.order === 'asc' ? 'asc' : 'desc'
      }
    }
    if (resetsPage) filter.page = 1
    return fetchTasks()
  }

  async function runAction(action, id) {
    const taskId = normalizeTaskId(id)
    if (taskId === null) return { success: false, code: 'TASK_ID_INVALID' }
    if (actionLoading[taskId]) return { success: false, code: 'TASK_ACTION_IN_PROGRESS' }

    actionLoading[taskId] = action
    try {
      const response = action === 'cancel'
        ? await api.tasks.cancel(taskId)
        : await api.tasks.retry(taskId)
      const body = response?.data
      if (!body || !body.data) {
        return {
          success: false,
          code: action === 'cancel' ? 'TASK_CANCEL_FAILED' : 'TASK_RETRY_FAILED'
        }
      }
      const refreshResult = await refresh()
      return { success: true, data: body.data, refresh: refreshResult }
    } catch (requestError) {
      const fallback = action === 'cancel' ? 'TASK_CANCEL_FAILED' : 'TASK_RETRY_FAILED'
      return { success: false, code: safeTaskErrorCode(requestError, fallback) }
    } finally {
      delete actionLoading[taskId]
    }
  }

  function cancel(id) {
    return runAction('cancel', id)
  }

  function retry(id) {
    return runAction('retry', id)
  }

  function isActionLoading(id) {
    const taskId = normalizeTaskId(id)
    return taskId !== null && Boolean(actionLoading[taskId])
  }

  async function previewCleanup() {
    if (cleanupLoading.value) return { success: false, code: 'TASK_ACTION_IN_PROGRESS' }
    cleanupLoading.value = true
    try {
      const response = await api.tasks.cleanupPreview()
      const data = response?.data?.data
      if (!data || typeof data.previewedAt !== 'string' ||
        !Number.isSafeInteger(data.eligibleCount) || !Number.isSafeInteger(data.selectedCount) ||
        !data.policy || !Number.isSafeInteger(data.policy.batchLimit)) {
        return { success: false, code: 'TASK_CLEANUP_FAILED' }
      }
      return { success: true, data }
    } catch (requestError) {
      return { success: false, code: safeTaskErrorCode(requestError, 'TASK_CLEANUP_FAILED') }
    } finally {
      cleanupLoading.value = false
    }
  }

  async function executeCleanup(preview) {
    if (cleanupLoading.value) return { success: false, code: 'TASK_ACTION_IN_PROGRESS' }
    if (!preview || typeof preview.previewedAt !== 'string' || !Number.isSafeInteger(preview.eligibleCount)) {
      return { success: false, code: 'TASK_CLEANUP_INVALID' }
    }
    cleanupLoading.value = true
    try {
      const response = await api.tasks.cleanupExecute({
        previewedAt: preview.previewedAt,
        expectedCount: preview.eligibleCount
      })
      const data = response?.data?.data
      if (!data || !Number.isSafeInteger(data.deletedCount)) {
        return { success: false, code: 'TASK_CLEANUP_FAILED' }
      }
      const refreshResult = await refresh()
      return { success: true, data, refresh: refreshResult }
    } catch (requestError) {
      return { success: false, code: safeTaskErrorCode(requestError, 'TASK_CLEANUP_FAILED') }
    } finally {
      cleanupLoading.value = false
    }
  }

  return {
    tasks,
    pagination,
    loading,
    error,
    filter,
    actionLoading,
    cleanupLoading,
    hasActiveTasks,
    fetch: fetchTasks,
    refresh,
    setFilters,
    retry,
    cancel,
    previewCleanup,
    executeCleanup,
    isActionLoading
  }
})

export { safeTaskErrorCode }
