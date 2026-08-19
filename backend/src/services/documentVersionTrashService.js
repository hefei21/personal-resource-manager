import { documentOriginalName } from './documentStorageRuntime.js'
import {
  commitDocumentVersionObject,
  normalizeDocumentVersionNote,
  normalizeDocumentVersionStaged
} from './documentVersionService.js'

const RESOURCE_TYPE = 'document_version'
const RETENTION_DAYS = 30

export class DocumentVersionTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'DocumentVersionTrashError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new DocumentVersionTrashError(code, message, cause ? { cause } : undefined)
}

function identifier(value) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail('DOCUMENT_ID_INVALID', 'Document or version ID is invalid.')
  }
  return parsed
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('DOCUMENT_VERSION_TRASH_TIME_INVALID', 'Document version trash time is invalid.')
  }
  return value
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DOCUMENT_VERSION_TRASH_DATABASE_INVALID', 'Document version trash database is invalid.')
  }
}

function assertRuntime(runtime) {
  if (
    !runtime?.storageService || typeof runtime.storageService.stageFromStream !== 'function' ||
    typeof runtime.storageService.discardStaged !== 'function' ||
    !runtime?.contentService || typeof runtime.contentService.createReadStream !== 'function'
  ) {
    fail('DOCUMENT_VERSION_TRASH_STORAGE_INVALID', 'Document version trash storage is invalid.')
  }
}

function versionRow(database, documentId, versionId) {
  return database.prepare(`
    SELECT v.id, v.document_id, v.version, v.file_path, v.storage_key,
           v.content_sha256, v.content_bytes, v.note, v.created_at,
           d.title, d.original_name, d.version AS current_version
    FROM document_versions v
    JOIN documents d ON d.id = v.document_id
    WHERE v.id = ? AND v.document_id = ?
  `).get(versionId, documentId)
}

function trashRow(database, versionId) {
  return database.prepare(`
    SELECT resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json
    FROM resource_trash_entries
    WHERE resource_type = ? AND resource_id = ?
  `).get(RESOURCE_TYPE, versionId)
}

function trashState(row) {
  if (!row?.metadata_json) return 'deleted'
  try {
    const parsed = JSON.parse(row.metadata_json)
    if (!parsed || typeof parsed.state !== 'string') throw new Error('invalid')
    if (parsed.state !== 'deleted') {
      fail('DOCUMENT_VERSION_PURGE_BLOCKED', 'Document version cleanup is blocked.')
    }
    return parsed.state
  } catch (error) {
    if (error instanceof DocumentVersionTrashError) throw error
    fail('DOCUMENT_VERSION_PURGE_BLOCKED', 'Document version cleanup is blocked.', error)
  }
}

function isCurrentVersion(row) {
  return Number.isFinite(Number(row?.version)) &&
    Number.isFinite(Number(row?.current_version)) &&
    Number(row.version) === Number(row.current_version)
}

function documentIdFromOptions(options) {
  return identifier(options.id ?? options.documentId)
}

function discardStaged(runtime, staged) {
  if (!staged?.token || typeof runtime?.storageService?.discardStaged !== 'function') return
  try { runtime.storageService.discardStaged(staged.token) } catch {}
}

export function softDeleteDocumentVersion(options = {}) {
  const { database, versionId: rawVersionId, now } = options
  assertDatabase(database)
  const documentId = documentIdFromOptions(options)
  const versionId = identifier(rawVersionId)
  const timestamp = nowDate(now)
  const purgeAfter = new Date(timestamp.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)

  return database.transaction(() => {
    const version = versionRow(database, documentId, versionId)
    if (!version) fail('DOCUMENT_VERSION_NOT_FOUND', 'Document version does not exist.')
    if (isCurrentVersion(version)) {
      fail('DOCUMENT_VERSION_IS_CURRENT', 'The current document version cannot be deleted.')
    }
    if (trashRow(database, versionId)) {
      fail('DOCUMENT_VERSION_TRASHED', 'The document version is already protected in trash.')
    }

    database.prepare(`
      INSERT INTO resource_trash_entries
        (resource_type, resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run(
      RESOURCE_TYPE,
      versionId,
      documentId,
      timestamp.toISOString(),
      purgeAfter.toISOString(),
      JSON.stringify({ state: 'deleted', tokens: [] })
    )

    return Object.freeze({
      documentId,
      versionId,
      version: version.version,
      deletedAt: timestamp.toISOString(),
      purgeAfter: purgeAfter.toISOString()
    })
  })()
}

export function listDeletedDocumentVersions(database, rawDocumentId) {
  assertDatabase(database)
  const parameters = [RESOURCE_TYPE]
  let documentFilter = ''
  if (rawDocumentId !== undefined) {
    documentFilter = ' AND v.document_id = ?'
    parameters.push(identifier(rawDocumentId))
  }

  const rows = database.prepare(`
    SELECT v.id, v.document_id, v.version, v.file_path, v.note, v.created_at,
           d.original_name, d.title, d.version AS current_version,
           t.deleted_at, t.purge_after
    FROM resource_trash_entries t
    JOIN document_versions v ON v.id = t.resource_id
    JOIN documents d ON d.id = v.document_id
    WHERE t.resource_type = ?${documentFilter}
    ORDER BY t.deleted_at DESC, v.id DESC
  `).all(...parameters)

  return rows.map((row) => Object.freeze({
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    version: row.version,
    filePath: documentOriginalName(row.original_name || row.file_path || `version-${row.version}`),
    note: row.note,
    createdAt: row.created_at,
    isCurrent: isCurrentVersion(row),
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after
  }))
}

export async function restoreDocumentVersionFromTrash(options = {}) {
  const { database, runtime, versionId: rawVersionId, versionNote: rawVersionNote } = options
  assertDatabase(database)
  assertRuntime(runtime)
  const documentId = documentIdFromOptions(options)
  const versionId = identifier(rawVersionId)
  const source = versionRow(database, documentId, versionId)
  if (!source) fail('DOCUMENT_VERSION_NOT_FOUND', 'Document version does not exist.')
  if (isCurrentVersion(source)) {
    fail('DOCUMENT_VERSION_IS_CURRENT', 'The current document version cannot be restored.')
  }
  const trash = trashRow(database, versionId)
  if (!trash) fail('DOCUMENT_VERSION_NOT_TRASHED', 'The document version is not protected in trash.')
  trashState(trash)

  const noteText = normalizeDocumentVersionNote(rawVersionNote) ?? `恢复自版本 ${source.version}`
  const { stream } = await runtime.contentService.createReadStream(source)
  const stagedRaw = await runtime.storageService.stageFromStream(stream)
  let staged
  try {
    staged = normalizeDocumentVersionStaged(stagedRaw)
    return await commitDocumentVersionObject({
      database,
      runtime,
      id: documentId,
      staged,
      versionNoteText: noteText,
      originalName: source.original_name,
      rejectIdentical: false,
      onDatabaseWrite: () => {
        const deleted = database.prepare(`
          DELETE FROM resource_trash_entries
          WHERE resource_type = ? AND resource_id = ?
        `).run(RESOURCE_TYPE, versionId)
        if (deleted.changes !== 1) {
          fail('DOCUMENT_VERSION_NOT_TRASHED', 'The document version is not protected in trash.')
        }
      }
    })
  } catch (error) {
    discardStaged(runtime, staged ?? stagedRaw)
    throw error
  }
}

export const deleteDocumentVersion = softDeleteDocumentVersion
export const restoreTrashedDocumentVersion = restoreDocumentVersionFromTrash
