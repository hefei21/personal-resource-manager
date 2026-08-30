import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'

import { coordinateStorageCommit } from './storageCommitCoordinator.js'
import { documentOriginalName } from './documentStorageRuntime.js'

export class DocumentVersionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'DocumentVersionError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new DocumentVersionError(code, message, cause ? { cause } : undefined)
}

function documentId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(id) || id <= 0) fail('DOCUMENT_ID_INVALID', 'Document ID is invalid.')
  return id
}

function versionNote(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 500) {
    fail('DOCUMENT_VERSION_NOTE_INVALID', 'Document version note is invalid.')
  }
  return value.trim()
}

export const normalizeDocumentVersionNote = versionNote

function normalizedDocumentExtension(fileName) {
  const extension = path.extname(fileName || '').toLowerCase()
  return ({ '.markdown': '.md', '.jpeg': '.jpg', '.htm': '.html' })[extension] || extension
}

export function assertMatchingDocumentVersionFileType(currentFileName, nextFileName) {
  const currentExtension = normalizedDocumentExtension(currentFileName)
  const nextExtension = normalizedDocumentExtension(nextFileName)
  if (!currentExtension || !nextExtension || currentExtension !== nextExtension) {
    fail(
      'DOCUMENT_VERSION_FILE_TYPE_MISMATCH',
      'Document version file type does not match the current document.'
    )
  }
  return currentExtension
}

function assertDependencies(database, runtime) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DOCUMENT_VERSION_DATABASE_INVALID', 'Document version database is invalid.')
  }
  if (
    !runtime?.storageService || typeof runtime.storageService.stageFromStream !== 'function' ||
    typeof runtime.storageService.discardStaged !== 'function' ||
    !runtime?.contentService || typeof runtime.contentService.createReadStream !== 'function'
  ) {
    fail('DOCUMENT_VERSION_STORAGE_INVALID', 'Document version storage is invalid.')
  }
}

function currentDocument(database, id) {
  const row = database.prepare(`
    SELECT id, content_sha256, original_name, version
    FROM documents
    WHERE id = ?
  `).get(id)
  if (!row) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
  return row
}

function assertVersionDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    fail('DOCUMENT_VERSION_DATABASE_INVALID', 'Document version database is invalid.')
  }
}

export function assertDocumentVersionNotTrashed(database, rawVersionId) {
  assertVersionDatabase(database)
  const versionId = documentId(rawVersionId)
  const trashed = database.prepare(`
    SELECT 1
    FROM resource_trash_entries
    WHERE resource_type = 'document_version' AND resource_id = ?
  `).get(versionId)
  if (trashed) fail('DOCUMENT_VERSION_TRASHED', 'The document version is protected in trash.')
  return versionId
}

function isSameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

function stagedValue(value) {
  if (
    !value || typeof value !== 'object' ||
    typeof value.token !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 0
  ) {
    fail('DOCUMENT_CONTENT_INVALID', 'Staged document content is invalid.')
  }
  return Object.freeze({ token: value.token, sha256: value.sha256, bytes: value.bytes })
}

export const normalizeDocumentVersionStaged = stagedValue

function discardStaged(runtime, staged) {
  if (!staged?.token || typeof runtime?.storageService?.discardStaged !== 'function') return
  try { runtime.storageService.discardStaged(staged.token) } catch {}
}

function nextVersion(database, id) {
  const row = database.prepare(`
    SELECT MAX(version_value) AS maximum
    FROM (
      SELECT CAST(version AS REAL) AS version_value FROM documents WHERE id = ?
      UNION ALL
      SELECT CAST(version AS REAL) AS version_value FROM document_versions WHERE document_id = ?
    )
  `).get(id, id)
  const maximum = Number(row?.maximum ?? 0)
  if (!Number.isFinite(maximum) || maximum < 0) {
    fail('DOCUMENT_VERSION_INVALID', 'Stored document version is invalid.')
  }
  const next = Math.floor(maximum) + 1
  if (!Number.isSafeInteger(next) || next <= maximum) {
    fail('DOCUMENT_VERSION_INVALID', 'A managed document version could not be generated.')
  }
  return next
}

async function commitVersionObject({
  database,
  runtime,
  id,
  staged,
  versionNoteText,
  originalName,
  rejectIdentical = true,
  onDatabaseWrite
} = {}) {
  let result
  try {
    await coordinateStorageCommit({
      database,
      storageService: runtime.storageService,
      idempotencyKey: `document-version:${randomUUID()}`,
      stagingToken: staged.token,
      kind: 'documents',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes,
      writeDatabase: ({ storageKey, sha256, bytes }) => {
        const existing = currentDocument(database, id)
        if (rejectIdentical && isSameHash(existing.content_sha256, sha256)) {
          fail('DOCUMENT_CONTENT_IDENTICAL', 'Document content is identical to the current version.')
        }
        const version = nextVersion(database, id)
        const update = database.prepare(`
          UPDATE documents
          SET file_path = NULL, storage_key = ?, content_sha256 = ?, content_bytes = ?,
              original_name = COALESCE(?, original_name), version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(storageKey, sha256, bytes, originalName ?? null, version, id)
        if (update.changes !== 1) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
        const inserted = database.prepare(`
          INSERT INTO document_versions
            (document_id, version, file_path, storage_key, content_sha256, content_bytes, note)
          VALUES (?, ?, NULL, ?, ?, ?, ?)
        `).run(
          id,
          version,
          storageKey,
          sha256,
          bytes,
          versionNoteText ?? `版本 ${version}`
        )
        const committed = Object.freeze({
          documentId: id,
          versionId: Number(inserted.lastInsertRowid),
          version,
          storageKey,
          sha256,
          bytes
        })
        if (typeof onDatabaseWrite === 'function') onDatabaseWrite(committed)
        result = committed
      }
    })
  } catch (error) {
    discardStaged(runtime, staged)
    throw error
  }
  return result
}

export async function commitDocumentVersionObject(options = {}) {
  assertDependencies(options.database, options.runtime)
  return commitVersionObject(options)
}

export function listDocumentVersions(database, rawId) {
  assertVersionDatabase(database)
  const id = documentId(rawId)
  const rows = database.prepare(`
    SELECT v.*, d.original_name, d.version AS current_version
    FROM document_versions v
    JOIN documents d ON d.id = v.document_id
    WHERE v.document_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM resource_trash_entries t
        WHERE t.resource_type = 'document_version' AND t.resource_id = v.id
      )
    ORDER BY v.version DESC
  `).all(id)

  return rows.map((row) => Object.freeze({
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    filePath: documentOriginalName(row.original_name || row.file_path || `version-${row.version}`),
    contentBytes: row.content_bytes !== null && row.content_bytes !== undefined && row.content_bytes !== '' &&
      Number.isSafeInteger(Number(row.content_bytes)) && Number(row.content_bytes) >= 0
      ? Number(row.content_bytes)
      : null,
    note: row.note,
    createdAt: row.created_at,
    isCurrent: Number.isFinite(Number(row.current_version)) &&
      Number(row.version) === Number(row.current_version)
  }))
}

export async function updateDocumentContent(options = {}) {
  const { database, runtime, id: rawId, content, versionNote: rawVersionNote } = options
  assertDependencies(database, runtime)
  if (Object.prototype.hasOwnProperty.call(options, 'version') ||
    Object.prototype.hasOwnProperty.call(options, 'newVersion')) {
    fail('DOCUMENT_VERSION_MANAGED', 'Document version numbers are managed by the system.')
  }
  const id = documentId(rawId)
  if (typeof content !== 'string' || content.length === 0) {
    fail('DOCUMENT_CONTENT_INVALID', 'Document content must be non-empty text.')
  }
  const noteText = versionNote(rawVersionNote)
  const current = currentDocument(database, id)
  const stagedRaw = await runtime.storageService.stageFromStream(
    Readable.from([Buffer.from(content, 'utf8')])
  )
  let staged
  try {
    staged = stagedValue(stagedRaw)
    if (isSameHash(current.content_sha256, staged.sha256)) {
      fail('DOCUMENT_CONTENT_IDENTICAL', 'Document content is identical to the current version.')
    }
    return await commitVersionObject({ database, runtime, id, staged, versionNoteText: noteText })
  } catch (error) {
    discardStaged(runtime, staged ?? stagedRaw)
    throw error
  }
}

export async function appendDocumentVersion({ database, runtime, id: rawId, staged: rawStaged, versionNote: rawVersionNote } = {}) {
  let staged
  try {
    staged = stagedValue(rawStaged)
    assertDependencies(database, runtime)
    const id = documentId(rawId)
    const noteText = versionNote(rawVersionNote)
    const current = currentDocument(database, id)
    if (isSameHash(current.content_sha256, staged.sha256)) {
      fail('DOCUMENT_CONTENT_IDENTICAL', 'Document content is identical to the current version.')
    }
    return await commitVersionObject({ database, runtime, id, staged, versionNoteText: noteText })
  } catch (error) {
    discardStaged(runtime, staged ?? rawStaged)
    throw error
  }
}

export const updateDocumentFromStaged = appendDocumentVersion

export async function restoreDocumentVersion({ database, runtime, id: rawId, versionId: rawVersionId, versionNote: rawVersionNote } = {}) {
  assertDependencies(database, runtime)
  const id = documentId(rawId)
  const versionId = documentId(rawVersionId)
  const source = database.prepare(`
    SELECT v.*, d.original_name, d.version AS current_version
    FROM document_versions v
    JOIN documents d ON d.id = v.document_id
    WHERE v.id = ? AND v.document_id = ?
  `).get(versionId, id)
  if (!source) fail('DOCUMENT_VERSION_NOT_FOUND', 'Document version does not exist.')
  const sourceVersion = Number(source.version)
  const currentVersion = Number(source.current_version)
  if (Number.isFinite(sourceVersion) && Number.isFinite(currentVersion) && sourceVersion === currentVersion) {
    fail('DOCUMENT_VERSION_IS_CURRENT', 'The current document version cannot be restored.')
  }
  assertDocumentVersionNotTrashed(database, versionId)
  const noteText = versionNote(rawVersionNote) ?? `恢复自版本 ${source.version}`
  const { stream } = await runtime.contentService.createReadStream(source)
  const stagedRaw = await runtime.storageService.stageFromStream(stream)
  let staged
  try {
    staged = stagedValue(stagedRaw)
    return await commitVersionObject({
      database,
      runtime,
      id,
      staged,
      versionNoteText: noteText,
      originalName: source.original_name,
      rejectIdentical: false
    })
  } catch (error) {
    discardStaged(runtime, staged ?? stagedRaw)
    throw error
  }
}
