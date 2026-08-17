const RESOURCE_TYPE = 'ebook'
const RETENTION_DAYS = 30

export class EbookTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EbookTrashError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new EbookTrashError(code, message, cause ? { cause } : undefined)
}

function ebookId(value) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('EBOOK_ID_INVALID', 'Ebook ID is invalid.')
  return parsed
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail('EBOOK_TRASH_TIME_INVALID', 'Trash time is invalid.')
  return value
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('EBOOK_TRASH_DATABASE_INVALID', 'Ebook trash database is invalid.')
  }
}

function trashRow(database, id) {
  return database.prepare(`
    SELECT resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json
    FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?
  `).get(RESOURCE_TYPE, id)
}

function trashMetadata(row) {
  try {
    const parsed = row?.metadata_json ? JSON.parse(row.metadata_json) : { state: 'deleted', tokens: [] }
    if (!parsed || !['deleted', 'purging'].includes(parsed.state) || !Array.isArray(parsed.tokens)) throw new Error('invalid')
    return parsed
  } catch (error) {
    fail('EBOOK_TRASH_METADATA_INVALID', 'Ebook trash metadata is invalid.', error)
  }
}

function insertTrash(database, id, timestamp) {
  const book = database.prepare(`
    SELECT b.id, b.category_id, c.name AS category_name
    FROM books b LEFT JOIN book_categories c ON c.id = b.category_id WHERE b.id = ?
  `).get(id)
  if (!book) fail('EBOOK_NOT_FOUND', 'Ebook does not exist.')
  if (trashRow(database, id)) fail('EBOOK_ALREADY_TRASHED', 'Ebook is already in trash.')
  const purgeAfter = new Date(timestamp.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
  database.prepare(`
    INSERT INTO resource_trash_entries
      (resource_type, resource_id, original_parent_id, original_path, deleted_at, purge_after, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    RESOURCE_TYPE,
    id,
    book.category_id,
    book.category_name,
    timestamp.toISOString(),
    purgeAfter.toISOString(),
    JSON.stringify({ state: 'deleted', tokens: [] })
  )
  return Object.freeze({ id, deletedAt: timestamp.toISOString(), purgeAfter: purgeAfter.toISOString() })
}

export function softDeleteEbook({ database, id, now } = {}) {
  assertDatabase(database)
  const normalizedId = ebookId(id)
  const timestamp = nowDate(now)
  return database.transaction(() => insertTrash(database, normalizedId, timestamp))()
}

export function softDeleteEbooks({ database, ids, now } = {}) {
  assertDatabase(database)
  if (!Array.isArray(ids) || ids.length === 0) fail('EBOOK_IDS_INVALID', 'Ebook IDs are invalid.')
  const normalized = [...new Set(ids.map(ebookId))]
  const timestamp = nowDate(now)
  return database.transaction(() => normalized.map((id) => insertTrash(database, id, timestamp)))()
}

export function listDeletedEbooks(database) {
  assertDatabase(database)
  return database.prepare(`
    SELECT b.id, b.title, b.author, b.original_name, b.file_type,
           t.original_parent_id, t.original_path, t.deleted_at, t.purge_after
    FROM resource_trash_entries t JOIN books b ON b.id = t.resource_id
    WHERE t.resource_type = ? ORDER BY t.deleted_at DESC, b.id DESC
  `).all(RESOURCE_TYPE).map((row) => Object.freeze({
    id: row.id,
    title: row.title,
    author: row.author,
    originalName: row.original_name,
    fileType: row.file_type,
    originalCategoryId: row.original_parent_id,
    originalCategoryName: row.original_path,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after
  }))
}

export function restoreEbookFromTrash({ database, id } = {}) {
  assertDatabase(database)
  const normalizedId = ebookId(id)
  return database.transaction(() => {
    const row = trashRow(database, normalizedId)
    if (!row) fail('EBOOK_TRASH_NOT_FOUND', 'Ebook trash entry does not exist.')
    if (trashMetadata(row).state !== 'deleted') fail('EBOOK_TRASH_PURGE_IN_PROGRESS', 'Ebook is being permanently deleted.')
    if (!database.prepare('SELECT 1 FROM books WHERE id = ?').get(normalizedId)) fail('EBOOK_NOT_FOUND', 'Ebook does not exist.')
    const category = Number.isSafeInteger(row.original_parent_id)
      ? database.prepare('SELECT id FROM book_categories WHERE id = ?').get(row.original_parent_id)
      : null
    database.prepare('UPDATE books SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(category?.id ?? null, normalizedId)
    database.prepare('DELETE FROM resource_trash_entries WHERE resource_type = ? AND resource_id = ?')
      .run(RESOURCE_TYPE, normalizedId)
    return Object.freeze({ id: normalizedId, categoryId: category?.id ?? null })
  })()
}

async function restoreMoved(storageService, tokens) {
  const failures = []
  for (const token of [...tokens].reverse()) {
    try { await storageService.restoreTrashed(token.trashToken) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) fail('EBOOK_TRASH_ROLLBACK_FAILED', 'Ebook trash rollback failed.', new AggregateError(failures))
}

export async function permanentlyDeleteEbook({ database, storageService, id } = {}) {
  assertDatabase(database)
  if (!storageService || typeof storageService.trashObject !== 'function' || typeof storageService.purgeTrashed !== 'function') {
    fail('EBOOK_TRASH_STORAGE_INVALID', 'Ebook trash storage is invalid.')
  }
  const normalizedId = ebookId(id)
  const row = trashRow(database, normalizedId)
  if (!row) fail('EBOOK_TRASH_NOT_FOUND', 'Ebook trash entry does not exist.')
  let state = trashMetadata(row)
  if (state.state === 'deleted') {
    const book = database.prepare('SELECT file_path, storage_key FROM books WHERE id = ?').get(normalizedId)
    if (!book) fail('EBOOK_NOT_FOUND', 'Ebook does not exist.')
    if (book.file_path && !book.storage_key) {
      fail('EBOOK_TRASH_LEGACY_MIGRATION_REQUIRED', 'Legacy ebook content must be migrated before permanent deletion.')
    }
    const tokens = []
    try {
      if (book.storage_key) {
        const references = database.prepare('SELECT COUNT(*) AS count FROM books WHERE id != ? AND storage_key = ?')
          .get(normalizedId, book.storage_key).count
        if (references === 0) tokens.push(await storageService.trashObject({ storageKey: book.storage_key, activeReferenceCount: 0 }))
      }
      database.transaction(() => {
        database.prepare('DELETE FROM books WHERE id = ?').run(normalizedId)
        database.prepare(`
          UPDATE resource_trash_entries SET metadata_json = ? WHERE resource_type = ? AND resource_id = ?
        `).run(JSON.stringify({ state: 'purging', tokens }), RESOURCE_TYPE, normalizedId)
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
    .run(RESOURCE_TYPE, normalizedId)
  return Object.freeze({ id: normalizedId, purgedObjects: state.tokens.length })
}
