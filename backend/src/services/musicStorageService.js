import { randomUUID } from 'node:crypto'

import { coordinateStorageCommit } from './storageCommitCoordinator.js'

export class MusicStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'MusicStorageError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new MusicStorageError(code, message, cause ? { cause } : undefined)
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('MUSIC_UPLOAD_INVALID', `${field} is invalid.`)
  return value.trim()
}

function metadataState(music) {
  const status = music.metadataStatus ?? 'ready'
  if (!['ready', 'partial', 'failed'].includes(status)) {
    fail('MUSIC_UPLOAD_INVALID', 'metadataStatus is invalid.')
  }
  const errorCode = music.metadataErrorCode ?? null
  if (errorCode !== null && (typeof errorCode !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/u.test(errorCode))) {
    fail('MUSIC_UPLOAD_INVALID', 'metadataErrorCode is invalid.')
  }
  const parserVersion = music.metadataParserVersion ?? null
  if (parserVersion !== null && (typeof parserVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(parserVersion))) {
    fail('MUSIC_UPLOAD_INVALID', 'metadataParserVersion is invalid.')
  }
  return Object.freeze({ status, errorCode, parserVersion })
}

export async function commitMusicUpload({ database, storageService, staged, music, idempotencyKey } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('MUSIC_UPLOAD_DATABASE_INVALID', 'Music upload database is invalid.')
  }
  if (!storageService || typeof storageService.commitStaged !== 'function') {
    fail('MUSIC_UPLOAD_STORAGE_INVALID', 'Music upload storage is invalid.')
  }
  if (!staged || typeof staged.token !== 'string' || !/^[a-f0-9]{64}$/u.test(staged.sha256 ?? '') ||
    !Number.isSafeInteger(staged.bytes) || staged.bytes < 0) {
    fail('MUSIC_UPLOAD_STAGING_INVALID', 'Music upload staging metadata is invalid.')
  }
  if (!music || typeof music !== 'object') fail('MUSIC_UPLOAD_INVALID', 'Music upload metadata is invalid.')
  const title = requiredText(music.title, 'title')
  const originalName = requiredText(music.originalName, 'originalName')
  const fileType = requiredText(music.fileType, 'fileType')
  const metadata = metadataState(music)
  let result = null
  await coordinateStorageCommit({
    database,
    storageService,
    idempotencyKey: idempotencyKey ?? `music-upload:${randomUUID()}`,
    stagingToken: staged.token,
    kind: 'music',
    expectedSha256: staged.sha256,
    expectedBytes: staged.bytes,
    writeDatabase: ({ storageKey, sha256, bytes }) => {
      const inserted = database.prepare(`
        INSERT INTO music
          (title, artist, album, duration, file_path, storage_key, content_sha256,
           content_bytes, original_name, file_size, file_type, cover_image,
           metadata_status, metadata_error_code, metadata_parser_version, metadata_updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        title,
        music.artist ?? null,
        music.album ?? null,
        music.duration ?? 0,
        storageKey,
        sha256,
        bytes,
        originalName,
        bytes,
        fileType,
        music.coverImage ?? null,
        metadata.status,
        metadata.errorCode,
        metadata.parserVersion
      )
      const id = Number(inserted.lastInsertRowid)
      result = Object.freeze({ id, title, storageKey, sha256, bytes })
    }
  })
  if (!result) fail('MUSIC_UPLOAD_RESULT_UNAVAILABLE', 'Music upload result is unavailable for a completed operation.')
  return result
}
