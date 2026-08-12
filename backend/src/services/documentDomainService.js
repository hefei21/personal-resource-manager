import { parseStorageKey } from './storageService.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/

export class DocumentDomainError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'DocumentDomainError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new DocumentDomainError(code, message, cause ? { cause } : undefined)
}

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizeTag(value) {
  if (typeof value !== 'string') fail('DOCUMENT_TAGS_INVALID', 'Document tags must contain text values.')
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

export function normalizeDocumentTags(value) {
  if (value === undefined || value === null || value === '') {
    return Object.freeze({ values: Object.freeze([]), serialized: null })
  }
  const input = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.normalize('NFKC').split(',')
      : null
  if (!input) fail('DOCUMENT_TAGS_INVALID', 'Document tags must be text or an array of text.')

  const tags = new Map()
  for (const raw of input) {
    const display = normalizeTag(raw)
    if (display === '') continue
    if (display.includes(',')) fail('DOCUMENT_TAGS_INVALID', 'A document tag must not contain a comma.')
    const key = display.toLocaleLowerCase('und')
    if (!tags.has(key)) tags.set(key, display)
  }
  const values = [...tags.entries()]
    .sort(([leftKey, left], [rightKey, right]) => compareText(leftKey, rightKey) || compareText(left, right))
    .map(([, display]) => display)
  return Object.freeze({
    values: Object.freeze(values),
    serialized: values.length === 0 ? null : values.join(',')
  })
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() === '') {
    fail('DOCUMENT_REFERENCE_INVALID', `${field} is invalid.`)
  }
  return value
}

export function resolveDocumentContentReference(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('DOCUMENT_RECORD_INVALID', 'Document record is invalid.')
  }
  const storageKey = optionalText(document.storage_key, 'storage_key')
  const legacyPath = optionalText(document.file_path, 'file_path')

  if (storageKey !== null) {
    let parsed
    try { parsed = parseStorageKey(storageKey) } catch (error) {
      fail('DOCUMENT_STORAGE_METADATA_INVALID', 'Document storage metadata is invalid.', error)
    }
    if (parsed.kind !== 'documents') {
      fail('DOCUMENT_STORAGE_KIND_INVALID', 'Document storage key has an invalid resource kind.')
    }
    if (
      typeof document.content_sha256 !== 'string' ||
      !HASH_PATTERN.test(document.content_sha256) ||
      !Number.isSafeInteger(document.content_bytes) ||
      document.content_bytes < 0
    ) {
      fail('DOCUMENT_STORAGE_METADATA_INCOMPLETE', 'Document storage metadata is incomplete.')
    }
    if (parsed.sha256 !== document.content_sha256) {
      fail('DOCUMENT_STORAGE_METADATA_MISMATCH', 'Document storage key and hash do not match.')
    }
    return Object.freeze({
      source: 'storage',
      storageKey,
      sha256: document.content_sha256,
      bytes: document.content_bytes
    })
  }

  if (legacyPath !== null) {
    return Object.freeze({ source: 'legacy', filePath: legacyPath })
  }
  fail('DOCUMENT_CONTENT_REFERENCE_MISSING', 'Document has no readable content reference.')
}

function assertContentServices(storageService, legacyStorageAdapter) {
  if (
    !storageService ||
    typeof storageService.stat !== 'function' ||
    typeof storageService.createReadStream !== 'function' ||
    !legacyStorageAdapter ||
    typeof legacyStorageAdapter.stat !== 'function' ||
    typeof legacyStorageAdapter.createReadStream !== 'function'
  ) {
    fail('DOCUMENT_CONTENT_SERVICES_INVALID', 'Document content services are invalid.')
  }
}

function mapContentError(error) {
  if (error instanceof DocumentDomainError) return error
  const code = String(error?.code ?? '')
  if (code === 'STORAGE_OBJECT_MISSING' || code === 'LEGACY_STORAGE_FILE_MISSING') {
    return new DocumentDomainError('DOCUMENT_CONTENT_MISSING', 'Document content does not exist.', { cause: error })
  }
  if (code === 'STORAGE_RANGE_INVALID' || code === 'LEGACY_STORAGE_RANGE_INVALID') {
    return new DocumentDomainError('DOCUMENT_CONTENT_RANGE_INVALID', 'Document content range is invalid.', { cause: error })
  }
  if (code === 'STORAGE_OBJECT_HASH_MISMATCH' || code === 'STORAGE_OBJECT_COLLISION') {
    return new DocumentDomainError('DOCUMENT_CONTENT_INTEGRITY_FAILED', 'Document content integrity verification failed.', { cause: error })
  }
  return new DocumentDomainError('DOCUMENT_CONTENT_UNAVAILABLE', 'Document content is unavailable.', { cause: error })
}

export class DocumentContentService {
  constructor({ storageService, legacyStorageAdapter } = {}) {
    assertContentServices(storageService, legacyStorageAdapter)
    this.storageService = storageService
    this.legacyStorageAdapter = legacyStorageAdapter
  }

  async stat(document) {
    const reference = resolveDocumentContentReference(document)
    try {
      if (reference.source === 'storage') {
        const metadata = await this.storageService.stat(reference.storageKey)
        if (metadata.sha256 !== reference.sha256 || metadata.bytes !== reference.bytes) {
          fail('DOCUMENT_CONTENT_INTEGRITY_FAILED', 'Document content does not match recorded metadata.')
        }
        return Object.freeze({ ...metadata, source: 'storage' })
      }
      const metadata = await this.legacyStorageAdapter.stat(reference.filePath)
      return Object.freeze({ source: 'legacy', bytes: metadata.bytes, modifiedAt: metadata.modifiedAt })
    } catch (error) {
      throw mapContentError(error)
    }
  }

  async createReadStream(document, range = {}) {
    const reference = resolveDocumentContentReference(document)
    try {
      const stream = reference.source === 'storage'
        ? await this.storageService.createReadStream(reference.storageKey, range)
        : await this.legacyStorageAdapter.createReadStream(reference.filePath, range)
      return Object.freeze({ source: reference.source, stream })
    } catch (error) {
      throw mapContentError(error)
    }
  }
}

function normalizeCategoryId(value) {
  if (value === undefined || value === null || value === '') return null
  const id = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail('DOCUMENT_CATEGORY_ID_INVALID', 'Document category ID is invalid.')
  }
  return id
}

export function resolveDocumentCategory(database, categoryId) {
  if (!database || typeof database.prepare !== 'function') {
    fail('DOCUMENT_CATEGORY_DATABASE_INVALID', 'Document category database is invalid.')
  }
  const id = normalizeCategoryId(categoryId)
  if (id === null) return null
  let category
  try {
    category = database.prepare(
      'SELECT id, name, parent_id, path, level FROM categories WHERE id = ?'
    ).get(id)
  } catch (error) {
    fail('DOCUMENT_CATEGORY_LOOKUP_FAILED', 'Document category could not be resolved.', error)
  }
  if (!category) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Document category does not exist.')
  if (
    category.id !== id ||
    typeof category.name !== 'string' || category.name.trim() === '' ||
    (category.parent_id !== null && (!Number.isSafeInteger(category.parent_id) || category.parent_id <= 0)) ||
    typeof category.path !== 'string' || category.path.trim() === '' ||
    !Number.isSafeInteger(category.level) || category.level < 0
  ) {
    fail('DOCUMENT_CATEGORY_INVALID', 'Document category is invalid.')
  }
  return Object.freeze({
    id: category.id,
    name: category.name,
    parentId: category.parent_id,
    path: category.path,
    level: category.level
  })
}

export function resolveDocumentCategoryInput(database, { categoryId, category, subcategory } = {}) {
  const explicitId = normalizeCategoryId(categoryId)
  if (explicitId !== null) return resolveDocumentCategory(database, explicitId)
  const root = typeof category === 'string' ? category.normalize('NFKC').trim() : ''
  const child = typeof subcategory === 'string' ? subcategory.normalize('NFKC').trim() : ''
  if (root === '' && child === '') return null
  if (root === '' || (child !== '' && child.split('/').some((part) => part.trim() === ''))) {
    fail('DOCUMENT_CATEGORY_PATH_INVALID', 'Document category path is invalid.')
  }
  const categoryPath = child === '' ? root : `${root}/${child}`
  let row
  try {
    row = database.prepare('SELECT id FROM categories WHERE path = ?').get(categoryPath)
  } catch (error) {
    fail('DOCUMENT_CATEGORY_LOOKUP_FAILED', 'Document category could not be resolved.', error)
  }
  if (!row) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Document category does not exist.')
  return resolveDocumentCategory(database, row.id)
}

export function categoryCompatibilityFields(category) {
  if (category === null) return Object.freeze({ category: null, subcategory: null })
  if (!category || typeof category.path !== 'string' || category.path.trim() === '') {
    fail('DOCUMENT_CATEGORY_INVALID', 'Document category is invalid.')
  }
  const parts = category.path.split('/').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) fail('DOCUMENT_CATEGORY_INVALID', 'Document category path is invalid.')
  return Object.freeze({
    category: parts[0],
    subcategory: parts.length === 1 ? null : parts.slice(1).join('/')
  })
}
