import path from 'node:path'

import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import {
  EbookCoverError,
  encodeEbookCoverJpeg,
  ensureEbookCover
} from './ebookCoverService.js'
import { TaskProcessorError } from './taskProcessorError.js'

export const EBOOK_COVER_TASK_TYPE = 'ebook.cover.generate'
export const EBOOK_COVER_PROCESSOR_VERSION = 'v1'
export const EBOOK_COVER_EXECUTION_CLASS = 'cpu'
export const EBOOK_COVER_SUBJECT_TYPE = 'ebook'
export const EBOOK_COVER_TASK_TYPES = Object.freeze([EBOOK_COVER_TASK_TYPE])

const TASK_ID_PATTERN = /^[1-9]\d*$/u
const STABLE_ERROR_CODES = new Set([
  'EBOOK_COVER_BOOK_NOT_FOUND',
  'EBOOK_COVER_NOT_FOUND',
  'EBOOK_COVER_SOURCE_MISSING',
  'EBOOK_COVER_TOO_LARGE',
  'EBOOK_COVER_ARCHIVE_INVALID',
  'EBOOK_COVER_UPDATE_CONFLICT',
  'EBOOK_COVER_INPUT_INVALID'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw taskError('TASK_CANCELLED', '封面生成任务已取消。', false)
  }
}

function taskIdentityIsCompatible(task, bookId) {
  if (task?.subjectType !== undefined && task.subjectType !== EBOOK_COVER_SUBJECT_TYPE) return false
  if (task?.subjectId !== undefined && String(task.subjectId) !== String(bookId)) return false
  if (task?.processorVersion !== undefined && task.processorVersion !== EBOOK_COVER_PROCESSOR_VERSION) return false
  if (task?.executionClass !== undefined && task.executionClass !== EBOOK_COVER_EXECUTION_CLASS) return false
  return true
}

function normalizeTaskId(task) {
  const value = String(task?.id ?? '')
  if (!TASK_ID_PATTERN.test(value)) {
    throw taskError('EBOOK_COVER_INPUT_INVALID', '封面任务标识无效。', false)
  }
  return value
}

export function normalizeEbookCoverTaskInput(task) {
  if (task?.taskType !== undefined && task.taskType !== EBOOK_COVER_TASK_TYPE) {
    throw taskError('TASK_TYPE_UNSUPPORTED', '封面任务类型不受支持。', false)
  }

  const input = task?.input
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'bookId')) {
    throw taskError('EBOOK_COVER_INPUT_INVALID', '封面任务输入必须仅包含 bookId。', false)
  }
  if (!Number.isSafeInteger(input.bookId) || input.bookId <= 0) {
    throw taskError('EBOOK_COVER_INPUT_INVALID', '封面任务的书籍编号无效。', false)
  }
  return input.bookId
}

function readActiveBook(database, bookId) {
  return database.prepare(`
    SELECT b.* FROM books b WHERE b.id = ? AND NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'ebook' AND t.resource_id = b.id
    )
  `).get(bookId)
}

function isEpubBook(book) {
  const extension = path.extname(String(book?.original_name || book?.file_path || '')).toLowerCase()
  return extension === '.epub' || String(book?.file_type || '').toLowerCase() === 'epub'
}

function errorSummary(code) {
  switch (code) {
    case 'EBOOK_COVER_BOOK_NOT_FOUND': return '电子书不存在或已回收。'
    case 'EBOOK_COVER_NOT_FOUND': return '电子书不包含可重建封面。'
    case 'EBOOK_COVER_SOURCE_MISSING': return '电子书源文件不存在。'
    case 'EBOOK_COVER_TOO_LARGE': return '封面文件过大。'
    case 'EBOOK_COVER_ARCHIVE_INVALID': return '电子书文件无效。'
    case 'EBOOK_COVER_UPDATE_CONFLICT': return '封面状态已发生变化。'
    case 'EBOOK_COVER_INPUT_INVALID': return '封面任务输入无效。'
    case 'EBOOK_COVER_ROOT_INVALID': return '封面存储暂时不可用。'
    case 'EBOOK_COVER_DATABASE_UNAVAILABLE': return '封面数据库暂时不可用。'
    case 'EBOOK_COVER_REBUILD_FAILED': return '封面生成暂时失败。'
    case 'EBOOK_COVER_SOURCE_INVALID': return '电子书源文件暂时不可读。'
    case 'TASK_CANCELLED': return '封面生成任务已取消。'
    default: return '封面生成暂时失败。'
  }
}

function mapProcessorError(error) {
  if (error instanceof TaskProcessorError) {
    return taskError(error.code, errorSummary(error.code), error.retryable)
  }
  if (error instanceof EbookCoverError) {
    const code = error.code
    return taskError(code, errorSummary(code), STABLE_ERROR_CODES.has(code) ? false : true)
  }
  return taskError('EBOOK_COVER_PROCESSOR_FAILED', '封面生成暂时失败。', true)
}

function databaseError() {
  return taskError('EBOOK_COVER_DATABASE_UNAVAILABLE', errorSummary('EBOOK_COVER_DATABASE_UNAVAILABLE'), true)
}

export function createEbookCoverTaskProcessor({
  database,
  databaseProvider = getDatabase,
  booksRoot,
  booksRootProvider = () => getStoragePath('books'),
  resolveBookPath,
  extractCover,
  compressCover = encodeEbookCoverJpeg,
  updateCoverPath,
  ensureCover = ensureEbookCover
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  const getBooksRootForTask = booksRoot === undefined ? booksRootProvider : () => booksRoot

  if (typeof getDatabaseForTask !== 'function') {
    throw new TypeError('databaseProvider must be a function')
  }
  if (typeof getBooksRootForTask !== 'function') {
    throw new TypeError('booksRootProvider must be a function')
  }
  if (typeof resolveBookPath !== 'function') {
    throw new TypeError('resolveBookPath must be a function')
  }
  if (typeof extractCover !== 'function') {
    throw new TypeError('extractCover must be a function')
  }
  if (typeof compressCover !== 'function') {
    throw new TypeError('compressCover must be a function')
  }
  if (typeof updateCoverPath !== 'function') {
    throw new TypeError('updateCoverPath must be a function')
  }
  if (typeof ensureCover !== 'function') {
    throw new TypeError('ensureCover must be a function')
  }

  return async function processEbookCoverTask(context = {}) {
    const signal = context.signal
    throwIfAborted(signal)
    const task = context.task
    normalizeTaskId(task)
    const bookId = normalizeEbookCoverTaskInput(task)
    if (!taskIdentityIsCompatible(task, bookId)) {
      throw taskError('EBOOK_COVER_INPUT_INVALID', '封面任务身份无效。', false)
    }

    let databaseConnection
    try {
      databaseConnection = await getDatabaseForTask()
    } catch {
      throw databaseError()
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function') {
      throw databaseError()
    }

    let book
    try {
      book = readActiveBook(databaseConnection, bookId)
    } catch {
      throw databaseError()
    }
    if (!book) {
      throw taskError('EBOOK_COVER_BOOK_NOT_FOUND', errorSummary('EBOOK_COVER_BOOK_NOT_FOUND'), false)
    }
    if (!isEpubBook(book)) {
      throw taskError('EBOOK_COVER_NOT_FOUND', errorSummary('EBOOK_COVER_NOT_FOUND'), false)
    }

    let resolvedBooksRoot
    try {
      resolvedBooksRoot = await getBooksRootForTask()
    } catch {
      throw taskError('EBOOK_COVER_ROOT_INVALID', errorSummary('EBOOK_COVER_ROOT_INVALID'), true)
    }

    try {
      await ensureCover({
        book,
        booksRoot: resolvedBooksRoot,
        resolveBookPath,
        extractCover,
        compressCover,
        updateCoverPath: (coverPath, previousCoverPath) => updateCoverPath(
          coverPath,
          previousCoverPath,
          Object.freeze({ database: databaseConnection, book, signal })
        )
      })
      throwIfAborted(signal)
      return { bookId, generated: true }
    } catch (error) {
      throw mapProcessorError(error)
    }
  }
}

export default createEbookCoverTaskProcessor
