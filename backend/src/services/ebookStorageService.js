import { randomUUID } from 'node:crypto'

import { coordinateStorageCommit } from './storageCommitCoordinator.js'

export class EbookStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EbookStorageError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new EbookStorageError(code, message, cause ? { cause } : undefined)
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('EBOOK_UPLOAD_INVALID', `${field} is invalid.`)
  return value.trim()
}

function metadataState(ebook) {
  const status = ebook.metadataStatus ?? 'ready'
  if (!['ready', 'partial', 'failed'].includes(status)) {
    fail('EBOOK_UPLOAD_INVALID', 'metadataStatus is invalid.')
  }
  const errorCode = ebook.metadataErrorCode ?? null
  if (errorCode !== null && (typeof errorCode !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/u.test(errorCode))) {
    fail('EBOOK_UPLOAD_INVALID', 'metadataErrorCode is invalid.')
  }
  const parserVersion = ebook.metadataParserVersion ?? null
  if (parserVersion !== null && (typeof parserVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(parserVersion))) {
    fail('EBOOK_UPLOAD_INVALID', 'metadataParserVersion is invalid.')
  }
  return Object.freeze({ status, errorCode, parserVersion })
}

export async function commitEbookUpload({ database, storageService, staged, ebook, idempotencyKey } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('EBOOK_UPLOAD_DATABASE_INVALID', 'Ebook upload database is invalid.')
  }
  if (!storageService || typeof storageService.commitStaged !== 'function') {
    fail('EBOOK_UPLOAD_STORAGE_INVALID', 'Ebook upload storage is invalid.')
  }
  if (!staged || typeof staged.token !== 'string' || !/^[a-f0-9]{64}$/u.test(staged.sha256 ?? '') ||
    !Number.isSafeInteger(staged.bytes) || staged.bytes < 0) {
    fail('EBOOK_UPLOAD_STAGING_INVALID', 'Ebook upload staging metadata is invalid.')
  }
  if (!ebook || typeof ebook !== 'object') fail('EBOOK_UPLOAD_INVALID', 'Ebook upload metadata is invalid.')
  const title = requiredText(ebook.title, 'title')
  const originalName = requiredText(ebook.originalName, 'originalName')
  const fileType = requiredText(ebook.fileType, 'fileType')
  const metadata = metadataState(ebook)
  let result = null
  await coordinateStorageCommit({
    database,
    storageService,
    idempotencyKey: idempotencyKey ?? `ebook-upload:${randomUUID()}`,
    stagingToken: staged.token,
    kind: 'ebooks',
    expectedSha256: staged.sha256,
    expectedBytes: staged.bytes,
    writeDatabase: ({ storageKey, sha256, bytes }) => {
      const inserted = database.prepare(`
        INSERT INTO books
          (title, author, year, publisher, isbn, description, category_id, file_path,
           storage_key, content_sha256, content_bytes, original_name, file_type, file_size,
           total_pages, cover_image, metadata_status, metadata_error_code,
           metadata_parser_version, metadata_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        title,
        ebook.author ?? null,
        ebook.year ?? null,
        ebook.publisher ?? null,
        ebook.isbn ?? null,
        ebook.description ?? null,
        ebook.categoryId ?? null,
        storageKey,
        sha256,
        bytes,
        originalName,
        fileType,
        bytes,
        ebook.totalPages ?? 0,
        ebook.coverImagePath ?? null,
        metadata.status,
        metadata.errorCode,
        metadata.parserVersion
      )
      const id = Number(inserted.lastInsertRowid)
      database.prepare(`
        INSERT INTO reading_progress (book_id, current_page, progress, font_size)
        VALUES (?, 0, 0, 16)
      `).run(id)
      result = Object.freeze({ id, title, storageKey, sha256, bytes })
    }
  })
  if (!result) fail('EBOOK_UPLOAD_RESULT_UNAVAILABLE', 'Ebook upload result is unavailable for a completed operation.')
  return result
}
