const RESOLUTIONS = new Set(['create', 'new_version'])

export class DocumentConflictError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DocumentConflictError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details) {
  throw new DocumentConflictError(code, message, details)
}

function positiveId(value, code = 'DOCUMENT_ID_INVALID') {
  const id = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail(code, code === 'DOCUMENT_ID_INVALID' ? 'Document ID is invalid.' : 'Conflict target document ID is invalid.')
  }
  return id
}

export function normalizeDocumentTitle(value) {
  if (typeof value !== 'string') fail('DOCUMENT_TITLE_INVALID', 'Document title is invalid.')
  const title = value.normalize('NFKC').trim()
  if (title === '') fail('DOCUMENT_TITLE_INVALID', 'Document title is invalid.')
  return title
}

function categoryFields(category) {
  if (!category) return { categoryId: null, category: null, subcategory: null }
  const categoryId = positiveId(category.id)
  if (typeof category.path !== 'string' || category.path.trim() === '') {
    fail('DOCUMENT_CATEGORY_INVALID', 'Document category is invalid.')
  }
  const parts = category.path.split('/').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) fail('DOCUMENT_CATEGORY_INVALID', 'Document category is invalid.')
  return {
    categoryId,
    category: parts[0],
    subcategory: parts.length === 1 ? null : parts.slice(1).join('/')
  }
}

function categoryPath(row) {
  if (typeof row.category_path === 'string' && row.category_path.trim() !== '') {
    return row.category_path
  }
  return [row.category, row.subcategory].filter((value) => typeof value === 'string' && value !== '').join('/') || null
}

function safeInteger(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function candidate(row, contentSha256) {
  const categoryId = safeInteger(row.category_id)
  const currentVersion = row.version === null || row.version === undefined ? null : Number(row.version)
  return Object.freeze({
    id: safeInteger(row.id),
    title: row.title,
    categoryId,
    categoryPath: categoryPath(row),
    currentVersion: Number.isFinite(currentVersion) ? currentVersion : null,
    updatedAt: row.updated_at ?? null,
    contentBytes: safeInteger(row.content_bytes),
    hashMatches: typeof contentSha256 === 'string' &&
      typeof row.content_sha256 === 'string' &&
      row.content_sha256.toLowerCase() === contentSha256.toLowerCase()
  })
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    fail('DOCUMENT_CONFLICT_DATABASE_INVALID', 'Document conflict database is invalid.')
  }
}

export function findDocumentUploadConflicts(database, { title, category, contentSha256, excludeDocumentId } = {}) {
  assertDatabase(database)
  const normalizedTitle = normalizeDocumentTitle(title)
  const fields = categoryFields(category)
  const parameters = [normalizedTitle]
  let sql = `
    SELECT d.id, d.title, d.category_id, d.category, d.subcategory,
           d.version, d.updated_at, d.content_bytes, d.content_sha256,
           c.path AS category_path
      FROM documents d
      LEFT JOIN categories c ON c.id = d.category_id
     WHERE d.title = ?
  `
  if (fields.categoryId === null) {
    sql += ' AND d.category_id IS NULL AND d.category IS ? AND d.subcategory IS ?'
    parameters.push(fields.category, fields.subcategory)
  } else {
    sql += `
       AND (
         d.category_id = ?
         OR (d.category_id IS NULL AND d.category IS ? AND d.subcategory IS ?)
       )
    `
    parameters.push(fields.categoryId, fields.category, fields.subcategory)
  }
  if (excludeDocumentId !== undefined && excludeDocumentId !== null) {
    const id = positiveId(excludeDocumentId)
    sql += ' AND d.id <> ?'
    parameters.push(id)
  }
  sql += ' ORDER BY d.id ASC'
  return Object.freeze(database.prepare(sql).all(...parameters).map((row) => candidate(row, contentSha256)))
}

export function suggestDocumentTitle(database, title, category) {
  const normalizedTitle = normalizeDocumentTitle(title)
  let suffix = 1
  while (suffix <= 100000) {
    const suggested = `${normalizedTitle} (${suffix})`
    if (findDocumentUploadConflicts(database, { title: suggested, category }).length === 0) return suggested
    suffix += 1
  }
  fail('DOCUMENT_TITLE_INVALID', 'A unique document title could not be suggested.')
}

export function normalizeDocumentConflictResolution(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !RESOLUTIONS.has(value.trim())) {
    fail('DOCUMENT_CONFLICT_RESOLUTION_INVALID', 'Document upload conflict resolution is invalid.')
  }
  return value.trim()
}

export function selectDocumentConflictTarget(candidates, value) {
  if (!Array.isArray(candidates)) fail('DOCUMENT_CONFLICT_TARGET_INVALID', 'Conflict candidates are invalid.')
  const id = positiveId(value, 'DOCUMENT_CONFLICT_TARGET_INVALID')
  const target = candidates.find((item) => item.id === id)
  if (!target) fail('DOCUMENT_CONFLICT_TARGET_INVALID', 'Target document is not a current upload conflict candidate.')
  return target
}

export function documentUploadConflict({ database, title, category, contentSha256 } = {}) {
  const candidates = findDocumentUploadConflicts(database, { title, category, contentSha256 })
  if (candidates.length === 0) return null
  return new DocumentConflictError(
    'DOCUMENT_UPLOAD_CONFLICT',
    'A document with the same title already exists in this category.',
    {
      candidates,
      suggestedTitle: suggestDocumentTitle(database, title, category)
    }
  )
}

export const findDocumentConflicts = findDocumentUploadConflicts
