import { createHash } from 'node:crypto'

import { getDatabase } from '../config/database.js'
import { getDocumentStorageRuntime } from './documentStorageRuntime.js'
import { getResourceStorageRuntime } from './resourceStorageRuntime.js'

export const RESOURCE_DOMAIN_IMPORT_TASK_TYPE = 'resource.domain.adapt'
export const RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION = 'v1'
export const RESOURCE_DOMAIN_IMPORT_EXECUTION_CLASS = 'disk'

export const RESOURCE_DOMAIN_IMPORT_SCOPES = Object.freeze([
  'all',
  'documents',
  'ebooks',
  'music'
])

const DOMAIN_CONFIG = Object.freeze({
  documents: Object.freeze({
    table: 'documents',
    domainType: 'document',
    resourceType: 'document',
    storageKind: 'documents'
  }),
  ebooks: Object.freeze({
    table: 'books',
    domainType: 'ebook',
    resourceType: 'ebook',
    storageKind: 'ebooks'
  }),
  music: Object.freeze({
    table: 'music',
    domainType: 'music',
    resourceType: 'audio',
    storageKind: 'music'
  })
})

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u
const MAX_BATCH_SIZE = 1000
const DEFAULT_BATCH_SIZE = 250
const MAX_TITLE_LENGTH = 10000

export const RESOURCE_DOMAIN_IMPORT_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RESOURCE_DOMAIN_INPUT_INVALID',
  DATABASE_INVALID: 'RESOURCE_DOMAIN_DATABASE_INVALID',
  DATABASE_BUSY: 'RESOURCE_DOMAIN_DATABASE_BUSY',
  TABLE_UNAVAILABLE: 'RESOURCE_DOMAIN_TABLE_UNAVAILABLE',
  CONTENT_MISSING: 'RESOURCE_DOMAIN_CONTENT_MISSING',
  CONTENT_INVALID: 'RESOURCE_DOMAIN_CONTENT_INVALID',
  CONTENT_INTEGRITY_FAILED: 'RESOURCE_DOMAIN_CONTENT_INTEGRITY_FAILED',
  CONTENT_UNAVAILABLE: 'RESOURCE_DOMAIN_CONTENT_UNAVAILABLE',
  DOMAIN_CONFLICT: 'RESOURCE_DOMAIN_CONFLICT',
  VERSION_INVALID: 'RESOURCE_DOMAIN_VERSION_INVALID',
  CANCELLED: 'RESOURCE_DOMAIN_CANCELLED'
})

export class ResourceDomainAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ResourceDomainAdapterError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new ResourceDomainAdapterError(code, message, cause ? { cause } : undefined)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizePositiveInteger(value, fieldName, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1
  const normalized = typeof value === 'string' && (allowZero ? /^(?:0|[1-9]\d*)$/u : POSITIVE_INTEGER_PATTERN.test(value.trim()))
    ? Number(value)
    : value
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function normalizeScope(value) {
  if (value === undefined || value === null) return 'all'
  if (typeof value !== 'string') fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'scope is invalid.')
  const normalized = value.normalize('NFKC').trim().toLowerCase()
  if (!RESOURCE_DOMAIN_IMPORT_SCOPES.includes(normalized)) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'scope is invalid.')
  }
  return normalized
}

function normalizeCursor(value) {
  if (value === undefined || value === null || value === '') return null
  return normalizePositiveInteger(value, 'cursor', { allowZero: true })
}

function normalizeBatchSize(value) {
  if (value === undefined || value === null) return DEFAULT_BATCH_SIZE
  const normalized = normalizePositiveInteger(value, 'batchSize')
  if (normalized > MAX_BATCH_SIZE) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'batchSize is invalid.')
  }
  return normalized
}

export function normalizeResourceDomainImportInput(input = {}) {
  if (!isPlainObject(input)) fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'Import input is invalid.')
  const allowed = new Set(['scope', 'cursor', 'batchSize'])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'Import input contains unsupported fields.')
  }
  const scope = normalizeScope(input.scope)
  const cursor = normalizeCursor(input.cursor)
  if (scope === 'all' && cursor !== null) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID, 'cursor requires one explicit domain scope.')
  }
  return Object.freeze({
    scope,
    cursor,
    batchSize: normalizeBatchSize(input.batchSize)
  })
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_INVALID, 'A SQLite database connection is required.')
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED, 'Resource domain import was cancelled.')
}

function isDatabaseBusy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' || error?.code === 'SQLITE_BUSY_SNAPSHOT'
}

function mapRecordError(error) {
  const code = String(error?.code ?? '')
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED) throw error
  if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(
    RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY,
    'Resource domain import storage is temporarily busy.',
    { cause: error }
  )
  if (code === 'RESOURCE_CONTENT_MISSING' || code === 'DOCUMENT_CONTENT_MISSING') {
    return RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_MISSING
  }
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_MISSING ||
      code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID ||
      code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED ||
      code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE) {
    return code
  }
  if (code === 'RESOURCE_CONTENT_INTEGRITY_FAILED' || code === 'DOCUMENT_CONTENT_INTEGRITY_FAILED' ||
      code === 'STORAGE_OBJECT_HASH_MISMATCH' || code === 'STORAGE_OBJECT_COLLISION') {
    return RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED
  }
  if (code === 'RESOURCE_CONTENT_REFERENCE_MISSING' || code === 'DOCUMENT_CONTENT_REFERENCE_MISSING' ||
      code === 'RESOURCE_CONTENT_SERVICES_INVALID' || code === 'DOCUMENT_CONTENT_SERVICES_INVALID' ||
      code === 'RESOURCE_STORAGE_METADATA_INCOMPLETE' || code === 'DOCUMENT_STORAGE_METADATA_INCOMPLETE') {
    return RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID
  }
  if (code.startsWith('RESOURCE_CONTENT_') || code.startsWith('DOCUMENT_CONTENT_') || code.startsWith('STORAGE_') || code.startsWith('LEGACY_')) {
    return RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE
  }
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.VERSION_INVALID) return code
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT) return code
  return RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE
}

function safeTitle(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return String(value).normalize('NFKC').slice(0, MAX_TITLE_LENGTH) || null
  const normalized = value.normalize('NFKC').trim()
  return normalized ? normalized.slice(0, MAX_TITLE_LENGTH) : null
}

function stableExternalId(domainType, domainId) {
  const digest = createHash('sha256')
    .update(`${domainType}:${domainId}`, 'utf8')
    .digest('hex')
  return `domain-${digest}`
}

function lifecycleStatus(database, domainType, domainId) {
  const trashed = database.prepare(`
    SELECT 1
      FROM resource_trash_entries
     WHERE resource_type = ? AND resource_id = ?
     LIMIT 1
  `).get(domainType, domainId)
  return trashed ? 'trashed' : 'active'
}

function normalizeContentMetadata(metadata, expectedStorageKey = null) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID, 'Content metadata is invalid.')
  }
  const sha256 = typeof metadata.sha256 === 'string' ? metadata.sha256.toLowerCase() : ''
  const bytes = metadata.bytes
  if (!HASH_PATTERN.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID, 'Content metadata is invalid.')
  }
  const storageKey = metadata.storageKey ?? expectedStorageKey ?? null
  if (storageKey !== null && (typeof storageKey !== 'string' || storageKey.trim() === '')) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID, 'Content storage metadata is invalid.')
  }
  return Object.freeze({ sha256, bytes, storageKey })
}

async function hashReadable(stream, signal) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE, 'Content stream is unavailable.')
  }
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buffer)
      bytes += buffer.length
      if (!Number.isSafeInteger(bytes)) fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INVALID, 'Content size is invalid.')
    }
  } catch (error) {
    if (error instanceof ResourceDomainAdapterError) throw error
    if (error?.name === 'AbortError') fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED, 'Resource domain import was cancelled.', error)
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE, 'Content stream could not be read.', error)
  }
  return Object.freeze({ sha256: hash.digest('hex'), bytes, storageKey: null })
}

function resolveContentService({ domain, documentContentService, resourceContentServices, resourceRuntime }) {
  if (domain === 'documents') {
    if (documentContentService) return documentContentService
    return getDocumentStorageRuntime().contentService
  }
  if (resourceContentServices instanceof Map && resourceContentServices.has(domain)) {
    return resourceContentServices.get(domain)
  }
  if (resourceContentServices && typeof resourceContentServices[domain]?.stat === 'function') {
    return resourceContentServices[domain]
  }
  if (typeof resourceContentServices === 'function') {
    const service = resourceContentServices(domain)
    if (service) return service
  }
  const runtime = resourceRuntime ?? getResourceStorageRuntime()
  if (typeof runtime.contentServiceFor === 'function') {
    return runtime.contentServiceFor(DOMAIN_CONFIG[domain].storageKind)
  }
  return null
}

async function inspectContent(record, domain, dependencies, signal) {
  const service = resolveContentService({ domain, ...dependencies })
  if (!service || typeof service.stat !== 'function' || typeof service.createReadStream !== 'function') {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_UNAVAILABLE, 'Content service is unavailable.')
  }

  let metadata
  try {
    metadata = await service.stat(record)
  } catch (error) {
    throw new ResourceDomainAdapterError(mapRecordError(error), 'Content could not be verified.', { cause: error })
  }
  const storageKey = typeof metadata?.storageKey === 'string'
    ? metadata.storageKey
    : typeof record.storage_key === 'string' && record.storage_key.trim() !== ''
      ? record.storage_key
      : null

  if (metadata?.source === 'storage') {
    return normalizeContentMetadata({
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      storageKey
    })
  }

  let readable
  try {
    readable = await service.createReadStream(record)
  } catch (error) {
    throw new ResourceDomainAdapterError(mapRecordError(error), 'Content could not be opened.', { cause: error })
  }
  const hashed = await hashReadable(readable?.stream ?? readable, signal)
  if (Number.isSafeInteger(metadata?.bytes) && metadata.bytes !== hashed.bytes) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED, 'Content size changed while importing.')
  }
  let after
  try {
    after = await service.stat(record)
  } catch (error) {
    throw new ResourceDomainAdapterError(mapRecordError(error), 'Content changed while importing.', { cause: error })
  }
  if (Number.isSafeInteger(after?.bytes) && after.bytes !== hashed.bytes) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED, 'Content changed while importing.')
  }
  if (metadata?.modifiedAt !== undefined && after?.modifiedAt !== undefined &&
    String(metadata.modifiedAt) !== String(after.modifiedAt)) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED, 'Content changed while importing.')
  }
  return normalizeContentMetadata(hashed)
}

function readDomainRows(database, scope, cursor, batchSize) {
  const domains = scope === 'all' ? Object.keys(DOMAIN_CONFIG) : [scope]
  const rows = []
  for (const domain of domains) {
    const config = DOMAIN_CONFIG[domain]
    try {
      const domainRows = database.prepare(`
        SELECT * FROM ${config.table}
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?
      `).all(cursor ?? 0, batchSize)
      rows.push(...domainRows.map((row) => Object.freeze({ domain, row })))
    } catch (error) {
      if (String(error?.code ?? '') === 'SQLITE_ERROR' && /no such table/iu.test(String(error?.message ?? ''))) {
        throw new ResourceDomainAdapterError(
          RESOURCE_DOMAIN_IMPORT_ERROR_CODES.TABLE_UNAVAILABLE,
          'A legacy domain table is unavailable.',
          { cause: error }
        )
      }
      throw error
    }
  }
  return rows
}

function versionNumber(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < 1) {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.VERSION_INVALID, 'Legacy version number is invalid.')
  }
  return number
}

function ensureResourceProjection(database, { domain, row, contentState }) {
  const config = DOMAIN_CONFIG[domain]
  const domainId = row.id
  const externalId = stableExternalId(config.domainType, domainId)
  const status = lifecycleStatus(database, config.domainType, domainId)
  const title = safeTitle(row.title)

  const existing = database.prepare(`
    SELECT r.id, r.resource_type, l.domain_type, l.domain_id
      FROM resource_domain_links l
      JOIN resources r ON r.id = l.resource_id
     WHERE l.domain_type = ? AND l.domain_id = ?
  `).get(config.domainType, domainId)

  let resourceId
  let resourceCreated = false
  if (existing) {
    if (existing.resource_type !== config.resourceType) {
      fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT, 'Domain resource mapping conflicts with its resource type.')
    }
    resourceId = existing.id
    const updated = database.prepare(`
      UPDATE resources
         SET title = ?, lifecycle_status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(title, status, resourceId)
    if (updated.changes !== 1) fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT, 'Domain resource mapping could not be updated.')
  } else {
    const inserted = database.prepare(`
      INSERT INTO resources (resource_type, title, lifecycle_status)
      VALUES (?, ?, ?)
    `).run(config.resourceType, title, status)
    resourceId = Number(inserted.lastInsertRowid)
    database.prepare(`
      INSERT INTO resource_domain_links (resource_id, domain_type, domain_id)
      VALUES (?, ?, ?)
    `).run(resourceId, config.domainType, domainId)
    resourceCreated = true
  }

  const source = database.prepare(`
    SELECT id, external_id, state
      FROM resource_sources
     WHERE resource_id = ? AND source_kind = 'domain_record'
     LIMIT 1
  `).get(resourceId)
  const sourceState = contentState === 'valid' ? 'active' : 'missing'
  let sourceCreated = false
  if (!source) {
    database.prepare(`
      INSERT INTO resource_sources (resource_id, source_kind, external_id, state)
      VALUES (?, 'domain_record', ?, ?)
    `).run(resourceId, externalId, sourceState)
    sourceCreated = true
  } else {
    if (source.external_id !== externalId) {
      fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT, 'Domain resource source identity conflicts.')
    }
    database.prepare(`
      UPDATE resource_sources
         SET state = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(sourceState, source.id)
  }

  return Object.freeze({ resourceId, resourceCreated, sourceCreated, externalId })
}

function ensureContentObject(database, content) {
  const byHash = database.prepare(`
    SELECT id, sha256, bytes, managed_storage_key
      FROM content_objects
     WHERE sha256 = ? AND bytes = ?
     LIMIT 1
  `).get(content.sha256, content.bytes)
  if (byHash) {
    // Distinct domain records may legitimately point at different managed
    // keys containing identical verified bytes. Reuse the content identity
    // without overwriting the first physical-key hint or merging resources.
    if (content.storageKey && !byHash.managed_storage_key) {
      const collision = database.prepare(`
        SELECT id FROM content_objects WHERE managed_storage_key = ? AND id != ?
      `).get(content.storageKey, byHash.id)
      if (collision) fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED, 'Managed content metadata conflicts.')
      database.prepare('UPDATE content_objects SET managed_storage_key = ? WHERE id = ?')
        .run(content.storageKey, byHash.id)
    }
    return Object.freeze({ id: byHash.id, created: false })
  }

  if (content.storageKey) {
    const byStorageKey = database.prepare(`
      SELECT id, sha256, bytes
        FROM content_objects
       WHERE managed_storage_key = ?
       LIMIT 1
    `).get(content.storageKey)
    if (byStorageKey && (byStorageKey.sha256 !== content.sha256 || byStorageKey.bytes !== content.bytes)) {
      fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CONTENT_INTEGRITY_FAILED, 'Managed content metadata conflicts.')
    }
    if (byStorageKey) return Object.freeze({ id: byStorageKey.id, created: false })
  }

  const inserted = database.prepare(`
    INSERT INTO content_objects (sha256, bytes, managed_storage_key)
    VALUES (?, ?, ?)
  `).run(content.sha256, content.bytes, content.storageKey)
  return Object.freeze({ id: Number(inserted.lastInsertRowid), created: true })
}

function projectResourceVersion(database, { resourceId, version, content, note, isCurrent }) {
  const existing = database.prepare(`
    SELECT id, content_object_id, is_current
      FROM resource_versions
     WHERE resource_id = ? AND version_number = ?
     LIMIT 1
  `).get(resourceId, version)
  const contentObject = ensureContentObject(database, content)
  if (existing) {
    if (existing.content_object_id !== contentObject.id) {
      fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT, 'Resource version content conflicts.')
    }
    if (isCurrent) {
      database.prepare('UPDATE resource_versions SET is_current = 0 WHERE resource_id = ? AND id != ?')
        .run(resourceId, existing.id)
    }
    database.prepare('UPDATE resource_versions SET is_current = ? WHERE id = ?')
      .run(isCurrent ? 1 : 0, existing.id)
    return Object.freeze({ versionCreated: false, contentCreated: contentObject.created })
  }
  if (isCurrent) {
    database.prepare('UPDATE resource_versions SET is_current = 0 WHERE resource_id = ?')
      .run(resourceId)
  }
  database.prepare(`
    INSERT INTO resource_versions
      (resource_id, content_object_id, version_number, is_current, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(resourceId, contentObject.id, version, isCurrent ? 1 : 0, note ?? null)
  return Object.freeze({ versionCreated: true, contentCreated: contentObject.created })
}

function documentVersionRows(database, document) {
  const historical = database.prepare(`
    SELECT id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at
      FROM document_versions
     WHERE document_id = ?
     ORDER BY version ASC, id ASC
  `).all(document.id)
  return [
    {
      id: null,
      document_id: document.id,
      version: document.version,
      file_path: document.file_path,
      storage_key: document.storage_key,
      content_sha256: document.content_sha256,
      content_bytes: document.content_bytes,
      note: '当前版本',
      created_at: document.updated_at ?? document.created_at
    },
    ...historical
  ]
}

function addCounts(target, values) {
  for (const [key, value] of Object.entries(values)) target[key] += value
}

export function reconcileMissingDomainRecords(database, rawScope) {
  assertDatabase(database)
  const scope = normalizeScope(rawScope)
  if (scope === 'all') {
    return Object.freeze(Object.fromEntries(
      Object.keys(DOMAIN_CONFIG).map((domain) => [domain, reconcileMissingDomainRecords(database, domain).missingRecords])
    ))
  }
  const config = DOMAIN_CONFIG[scope]
  try {
    const missingRecords = database.transaction(() => {
      const missing = database.prepare(`
        SELECT l.resource_id
          FROM resource_domain_links l
         WHERE l.domain_type = ?
           AND NOT EXISTS (SELECT 1 FROM ${config.table} d WHERE d.id = l.domain_id)
      `).all(config.domainType)
      if (missing.length === 0) return 0
      const ids = missing.map((row) => Number(row.resource_id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
      if (ids.length === 0) return 0
      const placeholders = ids.map(() => '?').join(', ')
      database.prepare(`
        UPDATE resource_sources
           SET state = 'missing', updated_at = CURRENT_TIMESTAMP
         WHERE source_kind = 'domain_record' AND resource_id IN (${placeholders})
      `).run(...ids)
      database.prepare(`
        UPDATE resources
           SET lifecycle_status = 'trashed', updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})
      `).run(...ids)
      return ids.length
    })()
    return Object.freeze({ missingRecords })
  } catch (error) {
    if (isDatabaseBusy(error)) {
      throw new ResourceDomainAdapterError(
        RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY,
        'Resource domain import storage is temporarily busy.',
        { cause: error }
      )
    }
    throw error
  }
}

async function adaptDocument(database, document, dependencies, signal) {
  let currentContent
  let currentError = null
  try {
    currentContent = await inspectContent(document, 'documents', dependencies, signal)
  } catch (error) {
    if (error instanceof ResourceDomainAdapterError && error.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED) throw error
    currentError = mapRecordError(error)
  }

  const result = {
    processed: 1,
    resourcesCreated: 0,
    resourcesReused: 0,
    sourcesCreated: 0,
    versionsCreated: 0,
    versionsReused: 0,
    contentObjectsCreated: 0,
    contentObjectsReused: 0,
    missingContent: currentContent ? 0 : 1,
    errors: currentError ? 1 : 0,
    conflicts: 0,
    skipped: 0
  }

  let projection
  try {
    projection = database.transaction(() => ensureResourceProjection(database, {
      domain: 'documents',
      row: document,
      contentState: currentContent ? 'valid' : 'missing'
    }))()
    result.resourcesCreated += projection.resourceCreated ? 1 : 0
    result.resourcesReused += projection.resourceCreated ? 0 : 1
    result.sourcesCreated += projection.sourceCreated ? 1 : 0
    if (!currentContent) {
      database.prepare('UPDATE resource_versions SET is_current = 0 WHERE resource_id = ?')
        .run(projection.resourceId)
    }
  } catch (error) {
    if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', { cause: error })
    result.errors += 1
    result.conflicts += error?.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT ? 1 : 0
    return result
  }

  const versions = documentVersionRows(database, document)
  const currentVersion = Number(document.version)
  for (const versionRow of versions) {
    throwIfAborted(signal)
    let version
    try {
      version = versionNumber(versionRow.version)
    } catch (error) {
      result.errors += 1
      continue
    }
    let content
    try {
      content = await inspectContent(versionRow, 'documents', dependencies, signal)
    } catch (error) {
      if (error instanceof ResourceDomainAdapterError && error.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED) throw error
      result.missingContent += 1
      result.errors += 1
      continue
    }
    try {
      const projected = database.transaction(() => projectResourceVersion(database, {
        resourceId: projection.resourceId,
        version,
        content,
        note: versionRow.note,
        isCurrent: Number.isSafeInteger(currentVersion) && version === currentVersion
      }))()
      if (projected.versionCreated) result.versionsCreated += 1
      else result.versionsReused += 1
      if (projected.contentCreated) result.contentObjectsCreated += 1
      else result.contentObjectsReused += 1
    } catch (error) {
      if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', { cause: error })
      result.errors += 1
      if (error?.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT) result.conflicts += 1
    }
  }
  return result
}

async function adaptSimpleDomain(database, domain, row, dependencies, signal) {
  let content
  let contentError = null
  try {
    content = await inspectContent(row, domain, dependencies, signal)
  } catch (error) {
    if (error instanceof ResourceDomainAdapterError && error.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED) throw error
    contentError = mapRecordError(error)
  }
  const result = {
    processed: 1,
    resourcesCreated: 0,
    resourcesReused: 0,
    sourcesCreated: 0,
    versionsCreated: 0,
    versionsReused: 0,
    contentObjectsCreated: 0,
    contentObjectsReused: 0,
    missingContent: content ? 0 : 1,
    errors: contentError ? 1 : 0,
    conflicts: 0,
    skipped: 0
  }
  let projection
  try {
    projection = database.transaction(() => ensureResourceProjection(database, {
      domain,
      row,
      contentState: content ? 'valid' : 'missing'
    }))()
    result.resourcesCreated += projection.resourceCreated ? 1 : 0
    result.resourcesReused += projection.resourceCreated ? 0 : 1
    result.sourcesCreated += projection.sourceCreated ? 1 : 0
    if (!content) {
      database.prepare('UPDATE resource_versions SET is_current = 0 WHERE resource_id = ?')
        .run(projection.resourceId)
    }
  } catch (error) {
    if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', { cause: error })
    result.errors += 1
    result.conflicts += error?.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT ? 1 : 0
    return result
  }
  if (!content) return result
  try {
    const projected = database.transaction(() => projectResourceVersion(database, {
      resourceId: projection.resourceId,
      version: 1,
      content,
      note: '初始版本',
      isCurrent: true
    }))()
    if (projected.versionCreated) result.versionsCreated += 1
    else result.versionsReused += 1
    if (projected.contentCreated) result.contentObjectsCreated += 1
    else result.contentObjectsReused += 1
  } catch (error) {
    if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', { cause: error })
    result.errors += 1
    if (error?.code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DOMAIN_CONFLICT) result.conflicts += 1
  }
  return result
}

function emptyReport(scope, cursor, batchSize) {
  return {
    scope,
    cursor,
    batchSize,
    processed: 0,
    resourcesCreated: 0,
    resourcesReused: 0,
    sourcesCreated: 0,
    versionsCreated: 0,
    versionsReused: 0,
    contentObjectsCreated: 0,
    contentObjectsReused: 0,
    missingContent: 0,
    missingRecords: 0,
    errors: 0,
    conflicts: 0,
    skipped: 0
  }
}

export function createResourceDomainAdapter({
  database,
  databaseProvider = getDatabase,
  documentContentService,
  resourceContentServices,
  resourceRuntime
} = {}) {
  const getDatabaseForRun = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForRun !== 'function') {
    fail(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_INVALID, 'databaseProvider is invalid.')
  }

  return Object.freeze({
    async adapt(input = {}, options = {}) {
      const normalized = normalizeResourceDomainImportInput(input)
      const signal = options.signal
      throwIfAborted(signal)
      const databaseConnection = await getDatabaseForRun()
      assertDatabase(databaseConnection)
      let rows
      try {
        rows = readDomainRows(databaseConnection, normalized.scope, normalized.cursor, normalized.batchSize)
      } catch (error) {
        if (error instanceof ResourceDomainAdapterError) throw error
        if (isDatabaseBusy(error)) throw new ResourceDomainAdapterError(RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', { cause: error })
        throw error
      }
      const report = emptyReport(normalized.scope, normalized.cursor, normalized.batchSize)
      report.nextCursor = rows.reduce((maximum, item) => Math.max(maximum, Number(item.row.id) || 0), normalized.cursor ?? 0)
      report.hasMore = rows.length >= normalized.batchSize
      const dependencies = { documentContentService, resourceContentServices, resourceRuntime }
      const progress = typeof options.onProgress === 'function' ? options.onProgress : async () => {}
      await progress({ processed: 0, total: rows.length })
      for (const item of rows) {
        throwIfAborted(signal)
        let itemResult
        if (item.domain === 'documents') {
          itemResult = await adaptDocument(databaseConnection, item.row, dependencies, signal)
        } else {
          itemResult = await adaptSimpleDomain(databaseConnection, item.domain, item.row, dependencies, signal)
        }
        addCounts(report, itemResult)
        await progress({ processed: report.processed, total: rows.length })
      }
      return Object.freeze({ ...report })
    }
  })
}

export async function adaptResourceDomains(options = {}) {
  const { input, ...adapterOptions } = options
  const normalizedInput = input ?? {
    ...(Object.hasOwn(options, 'scope') ? { scope: options.scope } : {}),
    ...(Object.hasOwn(options, 'cursor') ? { cursor: options.cursor } : {}),
    ...(Object.hasOwn(options, 'batchSize') ? { batchSize: options.batchSize } : {})
  }
  const adapter = createResourceDomainAdapter(adapterOptions)
  return adapter.adapt(normalizedInput, options)
}

export default createResourceDomainAdapter
