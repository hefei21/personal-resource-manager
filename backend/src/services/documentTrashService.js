import { categoryCompatibilityFields } from './documentDomainService.js'

const RESOURCE_TYPE = 'document'
const RETENTION_DAYS = 30

export class DocumentTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'DocumentTrashError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new DocumentTrashError(code, message, cause ? { cause } : undefined)
}

function id(value) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('DOCUMENT_ID_INVALID', 'Document ID is invalid.')
  return parsed
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('DOCUMENT_TRASH_TIME_INVALID', 'Trash time is invalid.')
  return value
}

function assertDependencies(database, storageService) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DOCUMENT_TRASH_DATABASE_INVALID', 'Document trash database is invalid.')
  }
  if (storageService && (
    typeof storageService.trashObject !== 'function' ||
    typeof storageService.restoreTrashed !== 'function' ||
    typeof storageService.purgeTrashed !== 'function'
  )) fail('DOCUMENT_TRASH_STORAGE_INVALID', 'Document trash storage is invalid.')
}

function trashRow(database, documentId) {
  return database.prepare(`
    SELECT resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json
    FROM resource_trash_entries
    WHERE resource_type = ? AND resource_id = ?
  `).get(RESOURCE_TYPE, documentId)
}

function metadata(row) {
  if (!row?.metadata_json) return { state: 'deleted', tokens: [] }
  try {
    const parsed = JSON.parse(row.metadata_json)
    if (!parsed || !['deleted', 'purging'].includes(parsed.state) || !Array.isArray(parsed.tokens)) throw new Error('invalid')
    return parsed
  } catch (error) {
    fail('DOCUMENT_TRASH_METADATA_INVALID', 'Document trash metadata is invalid.', error)
  }
}

export function softDeleteDocument({ database, id: rawId, now } = {}) {
  assertDependencies(database)
  const documentId = id(rawId)
  const timestamp = nowDate(now)
  const purgeAfter = new Date(timestamp.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return database.transaction(() => {
    const document = database.prepare(`
      SELECT id, category_id, category, subcategory
      FROM documents WHERE id = ?
    `).get(documentId)
    if (!document) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
    if (trashRow(database, documentId)) fail('DOCUMENT_ALREADY_TRASHED', 'Document is already in trash.')
    const originalPath = [document.category, document.subcategory].filter(Boolean).join('/') || null
    database.prepare(`
      INSERT INTO resource_trash_entries
        (resource_type, resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      RESOURCE_TYPE,
      documentId,
      document.category_id,
      originalPath,
      timestamp.toISOString(),
      purgeAfter.toISOString(),
      JSON.stringify({ state: 'deleted', tokens: [] })
    )
    return Object.freeze({ documentId, deletedAt: timestamp.toISOString(), purgeAfter: purgeAfter.toISOString() })
  })()
}

function restoreCategory(database, row) {
  if (Number.isSafeInteger(row.original_parent_id)) {
    const original = database.prepare('SELECT id, path FROM categories WHERE id = ?').get(row.original_parent_id)
    if (original) return original
  }
  if (typeof row.original_path !== 'string' || row.original_path.trim() === '') return null
  const parts = row.original_path.split('/').map((part) => part.trim()).filter(Boolean)
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = database.prepare('SELECT id, path FROM categories WHERE path = ?').get(parts.slice(0, length).join('/'))
    if (candidate) return candidate
  }
  return null
}

export function restoreDocumentFromTrash({ database, id: rawId } = {}) {
  assertDependencies(database)
  const documentId = id(rawId)
  return database.transaction(() => {
    const row = trashRow(database, documentId)
    if (!row) fail('DOCUMENT_TRASH_NOT_FOUND', 'Document trash entry does not exist.')
    if (metadata(row).state !== 'deleted') fail('DOCUMENT_TRASH_PURGE_IN_PROGRESS', 'Document is being permanently deleted.')
    const document = database.prepare('SELECT id FROM documents WHERE id = ?').get(documentId)
    if (!document) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
    const category = restoreCategory(database, row)
    const compatibility = categoryCompatibilityFields(category)
    database.prepare(`
      UPDATE documents SET category_id = ?, category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(category?.id ?? null, compatibility.category, compatibility.subcategory, documentId)
    database.prepare('DELETE FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?')
      .run(RESOURCE_TYPE, documentId)
    return Object.freeze({ documentId, categoryId: category?.id ?? null })
  })()
}

export function listDeletedDocuments(database) {
  assertDependencies(database)
  return database.prepare(`
    SELECT d.id, d.title, d.original_name, d.version, t.original_parent_id, t.original_path,
           t.deleted_at, t.purge_after
    FROM resource_trash_entries t
    JOIN documents d ON d.id = t.resource_id
    WHERE t.resource_type = ?
    ORDER BY t.deleted_at DESC, d.id DESC
  `).all(RESOURCE_TYPE).map((row) => Object.freeze({
    id: row.id,
    title: row.title,
    originalName: row.original_name,
    version: row.version,
    originalCategoryId: row.original_parent_id,
    originalPath: row.original_path,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after
  }))
}

function objectReferences(database, documentId) {
  return database.prepare(`
    SELECT storage_key FROM documents WHERE id = ? AND storage_key IS NOT NULL
    UNION
    SELECT storage_key FROM document_versions WHERE document_id = ? AND storage_key IS NOT NULL
  `).all(documentId, documentId).map(({ storage_key: storageKey }) => storageKey)
}

function outsideReferenceCount(database, documentId, storageKey) {
  return database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents WHERE id != ? AND storage_key = ?) +
      (SELECT COUNT(*) FROM document_versions WHERE document_id != ? AND storage_key = ?) AS count
  `).get(documentId, storageKey, documentId, storageKey).count
}

function assertNoLegacyOnlyContent(database, documentId) {
  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT file_path, storage_key FROM documents WHERE id = ?
      UNION ALL
      SELECT file_path, storage_key FROM document_versions WHERE document_id = ?
    ) WHERE file_path IS NOT NULL AND storage_key IS NULL
  `).get(documentId, documentId)
  if (row.count !== 0) fail('DOCUMENT_TRASH_LEGACY_MIGRATION_REQUIRED', 'Legacy document content must be migrated before permanent deletion.')
}

async function restoreMoved(storageService, tokens) {
  const failures = []
  for (const { trashToken } of [...tokens].reverse()) {
    try { await storageService.restoreTrashed(trashToken) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) fail('DOCUMENT_TRASH_ROLLBACK_FAILED', 'Document trash rollback failed.', new AggregateError(failures))
}

export async function permanentlyDeleteDocument({ database, storageService, id: rawId } = {}) {
  assertDependencies(database, storageService)
  const documentId = id(rawId)
  let row = trashRow(database, documentId)
  if (!row) fail('DOCUMENT_TRASH_NOT_FOUND', 'Document trash entry does not exist.')
  let state = metadata(row)

  if (state.state === 'deleted') {
    const document = database.prepare('SELECT id FROM documents WHERE id = ?').get(documentId)
    if (!document) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
    assertNoLegacyOnlyContent(database, documentId)
    const tokens = []
    try {
      for (const storageKey of objectReferences(database, documentId)) {
        if (outsideReferenceCount(database, documentId, storageKey) !== 0) continue
        tokens.push(await storageService.trashObject({ storageKey, activeReferenceCount: 0 }))
      }
      database.transaction(() => {
        database.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
        database.prepare(`
          UPDATE resource_trash_entries SET metadata_json = ?
          WHERE resource_type = ? AND resource_id = ?
        `).run(JSON.stringify({ state: 'purging', tokens }), RESOURCE_TYPE, documentId)
      })()
      state = { state: 'purging', tokens }
    } catch (error) {
      await restoreMoved(storageService, tokens)
      throw error
    }
  }

  for (const token of state.tokens) {
    try { await storageService.purgeTrashed(token.trashToken) } catch (error) {
      if (error?.code !== 'STORAGE_TRASH_MISSING') throw error
    }
  }
  database.prepare('DELETE FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?')
    .run(RESOURCE_TYPE, documentId)
  return Object.freeze({ documentId, purgedObjects: state.tokens.length })
}
