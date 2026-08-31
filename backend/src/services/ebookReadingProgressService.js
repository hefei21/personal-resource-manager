const MAX_CFI_LENGTH = 8192
const MAX_PAGE_INDEX = 1_000_000
const MUTATION_ID = /^[A-Za-z0-9:._-]{8,128}$/u

export class EbookReadingProgressError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'EbookReadingProgressError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new EbookReadingProgressError(code, message, details)
}

function positiveId(value, field) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('EBOOK_PROGRESS_INPUT_INVALID', `${field} is invalid.`)
  return parsed
}

function progressInput(input) {
  if (!input || typeof input !== 'object') fail('EBOOK_PROGRESS_INPUT_INVALID', 'Progress input is invalid.')
  const currentPage = Number(input.currentPage)
  const progress = Number(input.progress)
  const revision = Number(input.revision)
  const fontSize = input.fontSize === undefined || input.fontSize === null ? null : Number(input.fontSize)
  const cfi = input.cfi === undefined || input.cfi === null || input.cfi === '' ? null : String(input.cfi)
  const mutationId = String(input.mutationId || '')

  if (!Number.isSafeInteger(currentPage) || currentPage < 0 || currentPage > MAX_PAGE_INDEX) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'currentPage is invalid.')
  }
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'progress is invalid.')
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'revision is invalid.')
  }
  if (fontSize !== null && (!Number.isSafeInteger(fontSize) || fontSize < 12 || fontSize > 40)) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'fontSize is invalid.')
  }
  if (cfi !== null && (cfi.length > MAX_CFI_LENGTH || cfi.includes('\0'))) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'cfi is invalid.')
  }
  if (!MUTATION_ID.test(mutationId)) {
    fail('EBOOK_PROGRESS_INPUT_INVALID', 'mutationId is invalid.')
  }

  return Object.freeze({
    currentPage,
    progress: Math.round(progress * 100) / 100,
    revision,
    fontSize,
    cfi,
    mutationId,
    force: input.force === true
  })
}

function activeBook(database, bookId) {
  return database.prepare(`
    SELECT b.id FROM books b
    WHERE b.id = ? AND NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'ebook' AND t.resource_id = b.id
    )
  `).get(bookId)
}

function progressRow(database, bookId, userId) {
  return database.prepare(`
    SELECT current_page, cfi, progress, font_size, revision, last_mutation_id, updated_at
    FROM reading_progress WHERE book_id = ? AND user_id = ?
  `).get(bookId, userId)
}

function publicProgress(row) {
  if (!row) {
    return Object.freeze({
      currentPage: 0,
      cfi: null,
      progress: 0,
      fontSize: 16,
      revision: 0,
      updatedAt: null
    })
  }
  return Object.freeze({
    currentPage: Number(row.current_page) || 0,
    cfi: row.cfi || null,
    progress: Number(row.progress) || 0,
    fontSize: Number(row.font_size) || 16,
    revision: Number(row.revision) || 0,
    updatedAt: row.updated_at || null
  })
}

function assertContext(database, bookId, userId) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('EBOOK_PROGRESS_DATABASE_INVALID', 'Progress database is invalid.')
  }
  const normalizedBookId = positiveId(bookId, 'bookId')
  const normalizedUserId = positiveId(userId, 'userId')
  if (!activeBook(database, normalizedBookId)) fail('EBOOK_PROGRESS_BOOK_NOT_FOUND', 'Book does not exist.')
  return Object.freeze({ bookId: normalizedBookId, userId: normalizedUserId })
}

export function getEbookReadingProgress({ database, bookId, userId } = {}) {
  const normalized = assertContext(database, bookId, userId)
  return publicProgress(progressRow(database, normalized.bookId, normalized.userId))
}

export function saveEbookReadingProgress({ database, bookId, userId, input } = {}) {
  const normalized = assertContext(database, bookId, userId)
  const next = progressInput(input)

  return database.transaction(() => {
    const current = progressRow(database, normalized.bookId, normalized.userId)
    const currentPublic = publicProgress(current)

    if (current?.last_mutation_id === next.mutationId) {
      return Object.freeze({ progress: currentPublic, idempotent: true, forced: false })
    }
    // Even an explicit "keep this device" decision must be based on the latest
    // revision returned by the conflict response. `force` records the user's
    // decision; it is not permission to overwrite an unseen newer position.
    if (next.revision !== currentPublic.revision) {
      fail('EBOOK_PROGRESS_CONFLICT', 'Reading progress changed on another client.', { latest: currentPublic })
    }

    const nextRevision = currentPublic.revision + 1
    const nextFontSize = next.fontSize ?? currentPublic.fontSize
    if (current) {
      const result = database.prepare(`
        UPDATE reading_progress
        SET current_page = ?, cfi = ?, progress = ?, font_size = ?, revision = ?,
            last_mutation_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE book_id = ? AND user_id = ? AND revision = ?
      `).run(
        next.currentPage,
        next.cfi,
        next.progress,
        nextFontSize,
        nextRevision,
        next.mutationId,
        normalized.bookId,
        normalized.userId,
        currentPublic.revision
      )
      if (result.changes !== 1) {
        const latest = publicProgress(progressRow(database, normalized.bookId, normalized.userId))
        fail('EBOOK_PROGRESS_CONFLICT', 'Reading progress changed on another client.', { latest })
      }
    } else {
      database.prepare(`
        INSERT INTO reading_progress
          (book_id, user_id, current_page, cfi, progress, font_size, revision, last_mutation_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        normalized.bookId,
        normalized.userId,
        next.currentPage,
        next.cfi,
        next.progress,
        nextFontSize,
        nextRevision,
        next.mutationId
      )
    }

    database.prepare('UPDATE books SET last_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized.bookId)
    const saved = publicProgress(progressRow(database, normalized.bookId, normalized.userId))
    return Object.freeze({ progress: saved, idempotent: false, forced: next.force })
  })()
}
