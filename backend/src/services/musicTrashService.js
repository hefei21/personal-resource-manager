const RESOURCE_TYPE = 'music'
const RETENTION_DAYS = 30
const STORAGE_TRASH_TOKEN_PATTERN = /^[a-f0-9]{32}$/u

export class MusicTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'MusicTrashError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new MusicTrashError(code, message, cause ? { cause } : undefined)
}

function musicId(value) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('MUSIC_ID_INVALID', 'Music ID is invalid.')
  return parsed
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('MUSIC_TRASH_TIME_INVALID', 'Trash time is invalid.')
  }
  return value
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('MUSIC_TRASH_DATABASE_INVALID', 'Music trash database is invalid.')
  }
}

function assertStorageService(storageService) {
  if (!storageService || typeof storageService.trashObject !== 'function' ||
      typeof storageService.restoreTrashed !== 'function' ||
      typeof storageService.purgeTrashed !== 'function') {
    fail('MUSIC_TRASH_STORAGE_INVALID', 'Music trash storage is invalid.')
  }
}

function trashRow(database, id) {
  return database.prepare(`
    SELECT resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json
    FROM resource_trash_entries
    WHERE resource_type = ? AND resource_id = ?
  `).get(RESOURCE_TYPE, id)
}

function storageTrashToken(value) {
  const token = typeof value === 'string' ? value : value?.trashToken
  if (!STORAGE_TRASH_TOKEN_PATTERN.test(token ?? '')) {
    fail('MUSIC_TRASH_STORAGE_INVALID', 'Music trash storage returned an invalid token.')
  }
  return token
}

function trashMetadata(row) {
  try {
    const parsed = row?.metadata_json ? JSON.parse(row.metadata_json) : { state: 'deleted', tokens: [] }
    if (!parsed || !['deleted', 'purging'].includes(parsed.state) || !Array.isArray(parsed.tokens)) {
      throw new Error('invalid')
    }
    const tokens = parsed.tokens.map((token) => storageTrashToken(token))
    return Object.freeze({ state: parsed.state, tokens })
  } catch (error) {
    if (error instanceof MusicTrashError) throw error
    fail('MUSIC_TRASH_METADATA_INVALID', 'Music trash metadata is invalid.', error)
  }
}

function insertTrash(database, id, timestamp) {
  const music = database.prepare('SELECT id FROM music WHERE id = ?').get(id)
  if (!music) fail('MUSIC_NOT_FOUND', 'Music does not exist.')
  if (trashRow(database, id)) fail('MUSIC_ALREADY_TRASHED', 'Music is already in trash.')

  const purgeAfter = new Date(timestamp.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
  database.prepare(`
    INSERT INTO resource_trash_entries
      (resource_type, resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json)
    VALUES (?, ?, NULL, NULL, ?, ?, ?)
  `).run(
    RESOURCE_TYPE,
    id,
    timestamp.toISOString(),
    purgeAfter.toISOString(),
    JSON.stringify({ state: 'deleted', tokens: [] })
  )

  return Object.freeze({ id, deletedAt: timestamp.toISOString(), purgeAfter: purgeAfter.toISOString() })
}

export function softDeleteMusic({ database, id, now } = {}) {
  assertDatabase(database)
  const normalizedId = musicId(id)
  const timestamp = nowDate(now)
  return database.transaction(() => insertTrash(database, normalizedId, timestamp))()
}

export function softDeleteMusics({ database, ids, now } = {}) {
  assertDatabase(database)
  if (!Array.isArray(ids) || ids.length === 0) fail('MUSIC_IDS_INVALID', 'Music IDs are invalid.')
  const normalizedIds = [...new Set(ids.map(musicId))]
  const timestamp = nowDate(now)
  return database.transaction(() => normalizedIds.map((id) => insertTrash(database, id, timestamp)))()
}

export function listDeletedMusic(database) {
  assertDatabase(database)
  return database.prepare(`
    SELECT m.id, m.title, m.artist, m.album, m.duration, m.original_name, m.file_type,
           t.deleted_at, t.purge_after
    FROM resource_trash_entries t
    JOIN music m ON m.id = t.resource_id
    WHERE t.resource_type = ?
    ORDER BY t.deleted_at DESC, m.id DESC
  `).all(RESOURCE_TYPE).map((row) => Object.freeze({
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    originalName: row.original_name,
    fileType: row.file_type,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after
  }))
}

export function restoreMusicFromTrash({ database, id } = {}) {
  assertDatabase(database)
  const normalizedId = musicId(id)
  return database.transaction(() => {
    const row = trashRow(database, normalizedId)
    if (!row) fail('MUSIC_TRASH_NOT_FOUND', 'Music trash entry does not exist.')
    if (trashMetadata(row).state !== 'deleted') {
      fail('MUSIC_TRASH_PURGE_IN_PROGRESS', 'Music is being permanently deleted.')
    }
    if (!database.prepare('SELECT 1 FROM music WHERE id = ?').get(normalizedId)) {
      fail('MUSIC_NOT_FOUND', 'Music does not exist.')
    }

    // playlist_songs is deliberately preserved during soft delete. Removing only
    // this marker restores both library and playlist visibility without needing
    // relationship data in the generic trash schema.
    database.prepare('DELETE FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?')
      .run(RESOURCE_TYPE, normalizedId)
    return Object.freeze({ id: normalizedId })
  })()
}

async function restoreMoved(storageService, tokens) {
  const failures = []
  for (const token of [...tokens].reverse()) {
    try { await storageService.restoreTrashed(token) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) {
    fail('MUSIC_TRASH_ROLLBACK_FAILED', 'Music trash rollback failed.', new AggregateError(failures))
  }
}

function outsideReferenceCount(database, musicIdValue, storageKey) {
  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM music
    WHERE id != ? AND storage_key = ?
  `).get(musicIdValue, storageKey).count
}

export async function permanentlyDeleteMusic({ database, storageService, id } = {}) {
  assertDatabase(database)
  assertStorageService(storageService)
  const normalizedId = musicId(id)
  const row = trashRow(database, normalizedId)
  if (!row) fail('MUSIC_TRASH_NOT_FOUND', 'Music trash entry does not exist.')
  let state = trashMetadata(row)

  if (state.state === 'deleted') {
    const music = database.prepare('SELECT file_path, storage_key FROM music WHERE id = ?').get(normalizedId)
    if (!music) fail('MUSIC_NOT_FOUND', 'Music does not exist.')
    if (music.file_path && !music.storage_key) {
      fail('MUSIC_TRASH_LEGACY_MIGRATION_REQUIRED', 'Legacy music content must be migrated before permanent deletion.')
    }
    if (!music.storage_key) {
      fail('MUSIC_TRASH_CONTENT_REFERENCE_MISSING', 'Music content reference is missing.')
    }

    const tokens = []
    try {
      if (outsideReferenceCount(database, normalizedId, music.storage_key) === 0) {
        const moved = await storageService.trashObject({
          storageKey: music.storage_key,
          activeReferenceCount: 0
        })
        tokens.push(storageTrashToken(moved))
      }

      database.transaction(() => {
        database.prepare('DELETE FROM playlist_songs WHERE music_id = ?').run(normalizedId)
        database.prepare('DELETE FROM music WHERE id = ?').run(normalizedId)
        database.prepare(`
          UPDATE resource_trash_entries SET metadata_json = ?
          WHERE resource_type = ? AND resource_id = ?
        `).run(JSON.stringify({ state: 'purging', tokens }), RESOURCE_TYPE, normalizedId)
      })()
      state = { state: 'purging', tokens }
    } catch (error) {
      await restoreMoved(storageService, tokens)
      throw error
    }
  }

  for (const token of state.tokens) {
    try { await storageService.purgeTrashed(token) } catch (error) {
      if (error?.code !== 'STORAGE_TRASH_MISSING') throw error
    }
  }
  database.prepare('DELETE FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?')
    .run(RESOURCE_TYPE, normalizedId)
  return Object.freeze({ id: normalizedId, purgedObjects: state.tokens.length })
}
