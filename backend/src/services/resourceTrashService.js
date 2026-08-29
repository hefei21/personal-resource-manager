const SUPPORTED_TYPES = Object.freeze(['document', 'ebook', 'music'])
const SUPPORTED_TYPE_SET = new Set(SUPPORTED_TYPES)
const EXPIRY_FILTERS = new Set(['all', 'protected', 'expired'])
const SORT_ORDERS = new Set(['deleted_desc', 'deleted_asc', 'purge_asc'])

export class ResourceTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ResourceTrashError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new ResourceTrashError(code, message, cause ? { cause } : undefined)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    fail('RESOURCE_TRASH_DATABASE_INVALID', 'Resource trash database is invalid.')
  }
}

function positiveInteger(value, fallback, field, maximum) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    fail('RESOURCE_TRASH_QUERY_INVALID', `${field} is invalid.`)
  }
  return parsed
}

function optionalTimestamp(value, field, endOfDay = false) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(text)
    ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : text
  const milliseconds = Date.parse(normalized)
  if (!Number.isFinite(milliseconds)) fail('RESOURCE_TRASH_QUERY_INVALID', `${field} is invalid.`)
  return milliseconds
}

function normalizedType(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return 'all'
  if (!SUPPORTED_TYPE_SET.has(value)) fail('RESOURCE_TRASH_TYPE_UNSUPPORTED', 'Resource trash type is unsupported.')
  return value
}

function normalizedNow(now) {
  const value = typeof now === 'function' ? now() : (now || new Date())
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('RESOURCE_TRASH_TIME_INVALID', 'Resource trash time is invalid.')
  }
  return value
}

function parseState(metadataJson) {
  if (!metadataJson) return { state: 'deleted', issueCode: null }
  try {
    const parsed = JSON.parse(metadataJson)
    if (!parsed || !['deleted', 'purging'].includes(parsed.state)) throw new Error('invalid state')
    return { state: parsed.state, issueCode: null }
  } catch {
    return { state: 'error', issueCode: 'RESOURCE_TRASH_METADATA_INVALID' }
  }
}

function publicItem(row, nowMilliseconds) {
  const state = parseState(row.metadata_json)
  const purgeMilliseconds = row.purge_after ? Date.parse(row.purge_after) : Number.NaN
  const resourceExists = Boolean(row.resource_exists)
  const title = row.title || row.original_name || `已删除的${row.resource_type} #${row.resource_id}`
  const subtitle = row.subtitle || row.original_name || ''
  const issueCode = state.issueCode || (!resourceExists && state.state !== 'purging'
    ? 'RESOURCE_TRASH_RECORD_MISSING'
    : null)

  return Object.freeze({
    key: `${row.resource_type}:${row.resource_id}`,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    title,
    subtitle,
    originalName: row.original_name || null,
    originalLocation: row.original_path || null,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    isExpired: Number.isFinite(purgeMilliseconds) && purgeMilliseconds <= nowMilliseconds,
    state: state.state,
    issueCode,
    canRestore: state.state === 'deleted' && resourceExists,
    canPermanentlyDelete: state.state === 'purging' || resourceExists
  })
}

function allTrashRows(database) {
  return database.prepare(`
    SELECT
      t.resource_type,
      t.resource_id,
      t.original_path,
      t.deleted_at,
      t.purge_after,
      t.metadata_json,
      CASE t.resource_type
        WHEN 'document' THEN d.title
        WHEN 'ebook' THEN b.title
        WHEN 'music' THEN m.title
      END AS title,
      CASE t.resource_type
        WHEN 'document' THEN d.original_name
        WHEN 'ebook' THEN b.original_name
        WHEN 'music' THEN m.original_name
      END AS original_name,
      CASE t.resource_type
        WHEN 'document' THEN '版本 ' || COALESCE(d.version, 1)
        WHEN 'ebook' THEN b.author
        WHEN 'music' THEN m.artist
      END AS subtitle,
      CASE t.resource_type
        WHEN 'document' THEN d.id IS NOT NULL
        WHEN 'ebook' THEN b.id IS NOT NULL
        WHEN 'music' THEN m.id IS NOT NULL
        ELSE 0
      END AS resource_exists
    FROM resource_trash_entries t
    LEFT JOIN documents d ON t.resource_type = 'document' AND d.id = t.resource_id
    LEFT JOIN books b ON t.resource_type = 'ebook' AND b.id = t.resource_id
    LEFT JOIN music m ON t.resource_type = 'music' AND m.id = t.resource_id
    WHERE t.resource_type IN ('document', 'ebook', 'music')
  `).all()
}

export function normalizeResourceTrashSelection(value, { maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    fail('RESOURCE_TRASH_SELECTION_INVALID', 'Resource trash selection is invalid.')
  }
  const seen = new Set()
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('RESOURCE_TRASH_SELECTION_INVALID', 'Resource trash selection is invalid.')
    }
    const resourceType = normalizedType(item.resourceType)
    if (resourceType === 'all') fail('RESOURCE_TRASH_SELECTION_INVALID', 'Resource trash selection is invalid.')
    if (item.resourceId === undefined || item.resourceId === null || item.resourceId === '') {
      fail('RESOURCE_TRASH_SELECTION_INVALID', 'Resource trash selection is invalid.')
    }
    const resourceId = positiveInteger(item.resourceId, null, 'resourceId', Number.MAX_SAFE_INTEGER)
    const key = `${resourceType}:${resourceId}`
    if (seen.has(key)) fail('RESOURCE_TRASH_SELECTION_DUPLICATE', 'Resource trash selection contains duplicates.')
    seen.add(key)
    return Object.freeze({ resourceType, resourceId, key })
  })
}

export function listResourceTrash({ database, filters = {}, now } = {}) {
  assertDatabase(database)
  const currentTime = normalizedNow(now)
  const resourceType = normalizedType(filters.type)
  const expiry = filters.expiry || 'all'
  if (!EXPIRY_FILTERS.has(expiry)) fail('RESOURCE_TRASH_QUERY_INVALID', 'expiry is invalid.')
  const sort = filters.sort || 'deleted_desc'
  if (!SORT_ORDERS.has(sort)) fail('RESOURCE_TRASH_QUERY_INVALID', 'sort is invalid.')
  const page = positiveInteger(filters.page, 1, 'page', 100000)
  const pageSize = positiveInteger(filters.pageSize, 20, 'pageSize', 100)
  const deletedAfter = optionalTimestamp(filters.deletedAfter, 'deletedAfter')
  const deletedBefore = optionalTimestamp(filters.deletedBefore, 'deletedBefore', true)
  if (deletedAfter !== null && deletedBefore !== null && deletedAfter > deletedBefore) {
    fail('RESOURCE_TRASH_QUERY_INVALID', 'Deleted time range is invalid.')
  }
  const source = typeof filters.source === 'string' ? filters.source.trim().toLocaleLowerCase('zh-CN') : ''
  const query = typeof filters.q === 'string' ? filters.q.trim().toLocaleLowerCase('zh-CN') : ''
  if (query.length > 100 || source.length > 100) fail('RESOURCE_TRASH_QUERY_INVALID', 'Trash search is too long.')

  const allItems = allTrashRows(database).map((row) => publicItem(row, currentTime.getTime()))
  const counts = Object.fromEntries(SUPPORTED_TYPES.map((type) => [
    type,
    allItems.filter((item) => item.resourceType === type).length
  ]))
  const sources = [...new Set(allItems.map((item) => item.originalLocation).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))

  const filtered = allItems.filter((item) => {
    if (resourceType !== 'all' && item.resourceType !== resourceType) return false
    if (expiry === 'protected' && item.isExpired) return false
    if (expiry === 'expired' && !item.isExpired) return false
    const deletedAt = Date.parse(item.deletedAt)
    if (deletedAfter !== null && (!Number.isFinite(deletedAt) || deletedAt < deletedAfter)) return false
    if (deletedBefore !== null && (!Number.isFinite(deletedAt) || deletedAt > deletedBefore)) return false
    if (source && (item.originalLocation || '').toLocaleLowerCase('zh-CN') !== source) return false
    if (!query) return true
    return [item.title, item.subtitle, item.originalName, item.originalLocation]
      .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query))
  })

  filtered.sort((left, right) => {
    if (sort === 'deleted_asc') return Date.parse(left.deletedAt) - Date.parse(right.deletedAt)
    if (sort === 'purge_asc') {
      const leftTime = Date.parse(left.purgeAfter) || Number.MAX_SAFE_INTEGER
      const rightTime = Date.parse(right.purgeAfter) || Number.MAX_SAFE_INTEGER
      return leftTime - rightTime
    }
    return Date.parse(right.deletedAt) - Date.parse(left.deletedAt)
  })

  const total = filtered.length
  const offset = (page - 1) * pageSize
  return Object.freeze({
    items: Object.freeze(filtered.slice(offset, offset + pageSize)),
    summary: Object.freeze({
      total: allItems.length,
      filteredTotal: total,
      expired: allItems.filter((item) => item.isExpired).length,
      restorable: allItems.filter((item) => item.canRestore).length,
      byType: Object.freeze(counts),
      sources: Object.freeze(sources)
    }),
    pagination: Object.freeze({ page, pageSize, total })
  })
}

export const RESOURCE_TRASH_TYPES = SUPPORTED_TYPES
