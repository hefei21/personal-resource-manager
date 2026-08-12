import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { coordinateStorageCommit } from './storageCommitCoordinator.js'

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

function requestedVersion(value) {
  if (value === undefined || value === null || value === '') return null
  const version = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(version) || version <= 0) {
    fail('DOCUMENT_VERSION_INVALID', 'Document version must be a positive integer.')
  }
  return version
}

function note(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 500) {
    fail('DOCUMENT_VERSION_NOTE_INVALID', 'Document version note is invalid.')
  }
  return value.trim()
}

function assertDependencies(database, runtime) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DOCUMENT_VERSION_DATABASE_INVALID', 'Document version database is invalid.')
  }
  if (
    !runtime?.storageService || typeof runtime.storageService.stageFromStream !== 'function' ||
    !runtime?.contentService || typeof runtime.contentService.createReadStream !== 'function'
  ) {
    fail('DOCUMENT_VERSION_STORAGE_INVALID', 'Document version storage is invalid.')
  }
}

function nextVersion(database, id, explicitVersion) {
  const row = database.prepare(`
    SELECT MAX(version) AS maximum
    FROM (
      SELECT CAST(version AS INTEGER) AS version FROM documents WHERE id = ?
      UNION ALL
      SELECT CAST(version AS INTEGER) AS version FROM document_versions WHERE document_id = ?
    )
  `).get(id, id)
  const maximum = Number.isSafeInteger(row?.maximum) ? row.maximum : Number(row?.maximum ?? 0)
  const next = explicitVersion ?? maximum + 1
  if (!Number.isSafeInteger(next) || next <= maximum) {
    fail('DOCUMENT_VERSION_NOT_GREATER', `Document version must be greater than ${maximum}.`)
  }
  return next
}

async function commitVersionObject({ database, runtime, id, staged, explicitVersion, versionNote, originalName }) {
  let result
  await coordinateStorageCommit({
    database,
    storageService: runtime.storageService,
    idempotencyKey: `document-version:${randomUUID()}`,
    stagingToken: staged.token,
    kind: 'documents',
    expectedSha256: staged.sha256,
    expectedBytes: staged.bytes,
    writeDatabase: ({ storageKey, sha256, bytes }) => {
      const existing = database.prepare('SELECT id FROM documents WHERE id = ?').get(id)
      if (!existing) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
      const version = nextVersion(database, id, explicitVersion)
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
      `).run(id, version, storageKey, sha256, bytes, note(versionNote, `版本 ${version}`))
      result = Object.freeze({
        documentId: id,
        versionId: Number(inserted.lastInsertRowid),
        version,
        storageKey,
        sha256,
        bytes
      })
    }
  })
  return result
}

export async function updateDocumentContent({ database, runtime, id: rawId, content, version, versionNote } = {}) {
  assertDependencies(database, runtime)
  const id = documentId(rawId)
  if (typeof content !== 'string' || content.length === 0) {
    fail('DOCUMENT_CONTENT_INVALID', 'Document content must be non-empty text.')
  }
  const staged = await runtime.storageService.stageFromStream(Readable.from([Buffer.from(content, 'utf8')]))
  try {
    return await commitVersionObject({
      database,
      runtime,
      id,
      staged,
      explicitVersion: requestedVersion(version),
      versionNote
    })
  } catch (error) {
    try { runtime.storageService.discardStaged(staged.token) } catch {}
    throw error
  }
}

export async function restoreDocumentVersion({ database, runtime, id: rawId, versionId: rawVersionId, versionNote } = {}) {
  assertDependencies(database, runtime)
  const id = documentId(rawId)
  const versionId = documentId(rawVersionId)
  const source = database.prepare(`
    SELECT v.*, d.original_name
    FROM document_versions v
    JOIN documents d ON d.id = v.document_id
    WHERE v.id = ? AND v.document_id = ?
  `).get(versionId, id)
  if (!source) fail('DOCUMENT_VERSION_NOT_FOUND', 'Document version does not exist.')

  const { stream } = await runtime.contentService.createReadStream(source)
  const staged = await runtime.storageService.stageFromStream(stream)
  try {
    return await commitVersionObject({
      database,
      runtime,
      id,
      staged,
      explicitVersion: null,
      versionNote: note(versionNote, `恢复自版本 ${source.version}`),
      originalName: source.original_name
    })
  } catch (error) {
    try { runtime.storageService.discardStaged(staged.token) } catch {}
    throw error
  }
}
