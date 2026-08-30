const VALID_SORT_FIELDS = new Set(['updated_at', 'title', 'file_type', 'size'])
const VALID_SORT_ORDERS = new Set(['asc', 'desc'])

function scalar(value) {
  return Array.isArray(value) ? value[0] : value
}

function positiveInteger(value, fallback) {
  const parsed = Number(scalar(value))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseDocumentListRouteState(query = {}) {
  const tags = String(scalar(query.tags) || '').split(',').map(value => value.trim()).filter(Boolean)
  const from = String(scalar(query.from) || '')
  const to = String(scalar(query.to) || '')
  const sort = String(scalar(query.sort) || 'updated_at')
  const order = String(scalar(query.order) || 'desc').toLowerCase()
  return Object.freeze({
    categoryId: positiveInteger(query.categoryId, null),
    keyword: String(scalar(query.q) || '').trim(),
    tags,
    dateRange: from && to ? [from, to] : [],
    sortBy: VALID_SORT_FIELDS.has(sort) ? sort : 'updated_at',
    sortOrder: VALID_SORT_ORDERS.has(order) ? order : 'desc',
    page: positiveInteger(query.page, 1),
    pageSize: Math.min(100, positiveInteger(query.pageSize, 30))
  })
}

export function serializeDocumentListRouteState(state = {}, currentQuery = {}) {
  const query = { ...currentQuery }
  for (const key of ['categoryId', 'q', 'tags', 'from', 'to', 'sort', 'order', 'page', 'pageSize']) delete query[key]

  if (Number.isSafeInteger(Number(state.categoryId)) && Number(state.categoryId) > 0) query.categoryId = String(state.categoryId)
  if (String(state.keyword || '').trim()) query.q = String(state.keyword).trim()
  if (Array.isArray(state.tags) && state.tags.length > 0) query.tags = state.tags.join(',')
  if (Array.isArray(state.dateRange) && state.dateRange.length === 2 && state.dateRange[0] && state.dateRange[1]) {
    query.from = String(state.dateRange[0])
    query.to = String(state.dateRange[1])
  }
  if (state.sortBy && state.sortBy !== 'updated_at') query.sort = state.sortBy
  if (state.sortOrder && state.sortOrder !== 'desc') query.order = state.sortOrder
  if (Number(state.page) > 1) query.page = String(state.page)
  if (Number(state.pageSize) !== 30) query.pageSize = String(state.pageSize)
  return query
}
