import path from 'node:path'

import AdmZip from 'adm-zip'

import { getDatabase } from '../config/database.js'
import { validateArchiveEntries } from './uploadSecurity.js'
import { TaskProcessorError } from './taskProcessorError.js'

export const EBOOK_METADATA_TASK_TYPE = 'ebook.metadata.reparse'
export const EBOOK_METADATA_PROCESSOR_VERSION = 'v1'
export const EBOOK_METADATA_PARSER_VERSION = 'epub-parser-v1'
export const EBOOK_METADATA_EXECUTION_CLASS = 'cpu'
export const EBOOK_METADATA_SUBJECT_TYPE = 'ebook'
export const EBOOK_METADATA_TASK_TYPES = Object.freeze([EBOOK_METADATA_TASK_TYPE])

export const EBOOK_METADATA_FIELDS = Object.freeze([
  'title',
  'author',
  'publisher',
  'year',
  'isbn',
  'description'
])

const TASK_ID_PATTERN = /^[1-9]\d*$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const METADATA_VALUE_MAX_LENGTH = 100_000
const PARSE_TIMEOUT_MS = 30_000
const STABLE_ERROR_CODES = new Set([
  'EBOOK_METADATA_BOOK_NOT_FOUND',
  'EBOOK_METADATA_NOT_EPUB',
  'EBOOK_METADATA_SOURCE_MISSING',
  'EBOOK_METADATA_SOURCE_INVALID',
  'EBOOK_METADATA_CONTENT_HASH_MISSING',
  'EBOOK_METADATA_CONTENT_CHANGED',
  'EBOOK_METADATA_ARCHIVE_INVALID',
  'EBOOK_METADATA_OPF_MISSING',
  'EBOOK_METADATA_NO_FIELDS',
  'EBOOK_METADATA_PARSE_FAILED',
  'EBOOK_METADATA_PARSE_TIMEOUT',
  'EBOOK_METADATA_INPUT_INVALID',
  'EBOOK_METADATA_DATABASE_UNAVAILABLE',
  'EBOOK_METADATA_CANCELLED'
])

export class EbookMetadataError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'EbookMetadataError'
    this.code = code
  }
}

function metadataError(code, message, cause) {
  return new EbookMetadataError(code, message, cause ? { cause } : undefined)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

function normalizeMetadataValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).normalize('NFKC').trim()
  if (!normalized || normalized.length > METADATA_VALUE_MAX_LENGTH) return null
  return normalized
}

function decodeXmlText(value) {
  return String(value)
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => {
      const number = Number.parseInt(code, 16)
      return Number.isFinite(number) ? String.fromCodePoint(number) : ''
    })
    .replace(/&#(\d+);/gu, (_, code) => {
      const number = Number.parseInt(code, 10)
      return Number.isFinite(number) ? String.fromCodePoint(number) : ''
    })
    .replace(/\s+/gu, ' ')
    .trim()
}

function extractXmlText(xml, localName) {
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
    'iu'
  )
  const match = String(xml).match(pattern)
  return match ? normalizeMetadataValue(decodeXmlText(match[1])) : null
}

function attributeValue(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'iu')
  return tag.match(pattern)?.[1] ?? null
}

function normalizedEntryName(value) {
  return path.posix.normalize(String(value || '').replace(/\\/gu, '/')).replace(/^\/+/, '')
}

function findEntry(entries, name) {
  const expected = normalizedEntryName(name)
  return entries.find(entry => normalizedEntryName(entry.entryName) === expected) ?? null
}

function parseYear(opfContent) {
  const datePatterns = [
    /<(?:[A-Za-z_][\w.-]*:)?date\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?date>/iu,
    /<meta\b[^>]*property=["']dcterms:modified["'][^>]*>([\s\S]*?)<\/meta>/iu,
    /<meta\b[^>]*name=["']date["'][^>]*content=["']([^"']+)["'][^>]*>/iu
  ]
  for (const pattern of datePatterns) {
    const value = opfContent.match(pattern)?.[1]
    const year = String(value || '').match(/\b(\d{4})\b/u)?.[1]
    if (year) return year
  }
  return null
}

function parseIsbn(opfContent) {
  const identifiers = opfContent.match(/<(?:[A-Za-z_][\w.-]*:)?identifier\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?identifier>/giu) || []
  for (const identifier of identifiers) {
    const value = decodeXmlText(identifier)
    const isbn = value.match(/\b(?:ISBN(?:-\d+)?\s*[:\s]*)?((?:97[89][\s-]?)?[0-9][0-9\s-]{8,}[0-9X])\b/iu)?.[1]
    if (isbn) return isbn.replace(/[\s-]/gu, '')
  }
  return opfContent.match(/\bISBN\s*[:\s]*(97[89][\d-]{10,})\b/iu)?.[1]?.replace(/-/gu, '') ?? null
}

function readEpubMetadataArchive(epubPath) {
  let archive
  try {
    archive = new AdmZip(epubPath)
  } catch (error) {
    throw metadataError('EBOOK_METADATA_ARCHIVE_INVALID', '电子书文件无效。', error)
  }

  let entries
  try {
    entries = archive.getEntries()
    validateArchiveEntries(entries, {
      maxEntries: 20_000,
      maxEntryBytes: 100 * 1024 * 1024,
      maxExpandedBytes: 1024 * 1024 * 1024,
      maxCompressionRatio: 200
    })
  } catch (error) {
    throw metadataError('EBOOK_METADATA_ARCHIVE_INVALID', '电子书文件无效。', error)
  }

  const containerEntry = findEntry(entries, 'META-INF/container.xml')
  let opfPath = null
  if (containerEntry) {
    try {
      const containerXml = containerEntry.getData().toString('utf8')
      opfPath = containerXml.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/iu)?.[1] ?? null
    } catch (error) {
      throw metadataError('EBOOK_METADATA_ARCHIVE_INVALID', '电子书文件无效。', error)
    }
  }

  const opfEntry = (opfPath ? findEntry(entries, opfPath) : null) ||
    entries.find(entry => normalizedEntryName(entry.entryName).toLowerCase().endsWith('.opf'))
  if (!opfEntry) throw metadataError('EBOOK_METADATA_OPF_MISSING', '电子书元数据目录不存在。')

  try {
    return opfEntry.getData().toString('utf8')
  } catch (error) {
    throw metadataError('EBOOK_METADATA_ARCHIVE_INVALID', '电子书文件无效。', error)
  }
}

function normalizeParsedMetadata(metadata) {
  if (!isPlainObject(metadata)) {
    throw metadataError('EBOOK_METADATA_PARSE_FAILED', '电子书元数据解析失败。')
  }
  const normalized = Object.fromEntries(EBOOK_METADATA_FIELDS.map(field => [
    field,
    normalizeMetadataValue(metadata[field])
  ]))
  if (EBOOK_METADATA_FIELDS.every(field => normalized[field] === null)) {
    throw metadataError('EBOOK_METADATA_NO_FIELDS', '电子书未包含可用元数据。')
  }
  return Object.freeze(normalized)
}

export function parseEpubMetadata(epubPath) {
  if (typeof epubPath !== 'string' || !epubPath.trim()) {
    throw metadataError('EBOOK_METADATA_SOURCE_INVALID', '电子书源文件暂时不可读。')
  }
  const opfContent = readEpubMetadataArchive(epubPath)
  const metadata = {
    title: extractXmlText(opfContent, 'title'),
    author: extractXmlText(opfContent, 'creator'),
    publisher: extractXmlText(opfContent, 'publisher'),
    year: parseYear(opfContent),
    isbn: parseIsbn(opfContent),
    description: extractXmlText(opfContent, 'description')
  }
  if (!metadata.author) {
    const creators = [...opfContent.matchAll(/<(?:[A-Za-z_][\w.-]*:)?creator\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?creator>/giu)]
      .map(match => normalizeMetadataValue(decodeXmlText(match[1])))
      .filter(Boolean)
    if (creators.length > 0) metadata.author = creators.join(', ')
  }
  if (!metadata.description) {
    const description = opfContent.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/iu)?.[1]
    metadata.description = normalizeMetadataValue(decodeXmlText(description || ''))
  }
  return normalizeParsedMetadata(metadata)
}

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function errorSummary(code) {
  switch (code) {
    case 'EBOOK_METADATA_BOOK_NOT_FOUND': return '电子书不存在或已回收。'
    case 'EBOOK_METADATA_NOT_EPUB': return '该资源不是 EPUB 电子书。'
    case 'EBOOK_METADATA_SOURCE_MISSING': return '电子书源文件不存在。'
    case 'EBOOK_METADATA_SOURCE_INVALID': return '电子书源文件暂时不可读。'
    case 'EBOOK_METADATA_CONTENT_HASH_MISSING': return '电子书内容身份缺失。'
    case 'EBOOK_METADATA_CONTENT_CHANGED': return '电子书内容已变化，请重新解析。'
    case 'EBOOK_METADATA_ARCHIVE_INVALID': return '电子书文件无效。'
    case 'EBOOK_METADATA_OPF_MISSING': return '电子书元数据目录不存在。'
    case 'EBOOK_METADATA_NO_FIELDS': return '电子书未包含可用元数据。'
    case 'EBOOK_METADATA_PARSE_TIMEOUT': return '电子书元数据解析超时。'
    case 'EBOOK_METADATA_PARSE_FAILED': return '电子书元数据解析失败。'
    case 'EBOOK_METADATA_INPUT_INVALID': return '电子书元数据任务输入无效。'
    case 'EBOOK_METADATA_DATABASE_UNAVAILABLE': return '电子书元数据数据库暂时不可用。'
    case 'EBOOK_METADATA_CANCELLED': return '电子书元数据解析已取消。'
    case 'TASK_CANCELLED': return '电子书元数据任务已取消。'
    default: return '电子书元数据解析暂时失败。'
  }
}

function mapProcessorError(error) {
  if (error instanceof TaskProcessorError) {
    return taskError(error.code, errorSummary(error.code), error.retryable)
  }
  if (error instanceof EbookMetadataError) {
    const code = STABLE_ERROR_CODES.has(error.code) ? error.code : 'EBOOK_METADATA_PARSE_FAILED'
    const retryable = code === 'EBOOK_METADATA_PARSE_TIMEOUT' || code === 'EBOOK_METADATA_SOURCE_INVALID'
    return taskError(code, errorSummary(code), retryable)
  }
  return taskError('EBOOK_METADATA_PARSE_FAILED', errorSummary('EBOOK_METADATA_PARSE_FAILED'), true)
}

function databaseError() {
  return taskError('EBOOK_METADATA_DATABASE_UNAVAILABLE', errorSummary('EBOOK_METADATA_DATABASE_UNAVAILABLE'), true)
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw taskError('TASK_CANCELLED', errorSummary('TASK_CANCELLED'), false)
}

function normalizeTaskId(task) {
  const value = String(task?.id ?? '')
  if (!TASK_ID_PATTERN.test(value)) {
    throw taskError('EBOOK_METADATA_INPUT_INVALID', errorSummary('EBOOK_METADATA_INPUT_INVALID'), false)
  }
  return value
}

export function normalizeEbookMetadataTaskInput(task) {
  if (task?.taskType !== undefined && task.taskType !== EBOOK_METADATA_TASK_TYPE) {
    throw taskError('TASK_TYPE_UNSUPPORTED', '电子书元数据任务类型不受支持。', false)
  }
  const input = task?.input
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'bookId') ||
    !Number.isSafeInteger(input.bookId) || input.bookId <= 0) {
    throw taskError('EBOOK_METADATA_INPUT_INVALID', errorSummary('EBOOK_METADATA_INPUT_INVALID'), false)
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

function currentContentHash(book) {
  const value = String(book?.content_sha256 || '').toLowerCase()
  return HASH_PATTERN.test(value) ? value : null
}

function taskContentHash(task) {
  const value = task?.subjectContentHash ?? task?.subjectContentSha256
  const normalized = String(value || '').toLowerCase()
  return HASH_PATTERN.test(normalized) ? normalized : null
}

function taskIdentityIsCompatible(task, bookId, contentHash) {
  if (task?.taskType !== undefined && task.taskType !== EBOOK_METADATA_TASK_TYPE) return false
  if (task?.processorVersion !== undefined && task.processorVersion !== EBOOK_METADATA_PROCESSOR_VERSION) return false
  if (task?.executionClass !== undefined && task.executionClass !== EBOOK_METADATA_EXECUTION_CLASS) return false
  if (task?.subjectType !== undefined && task.subjectType !== EBOOK_METADATA_SUBJECT_TYPE) return false
  if (task?.subjectId !== undefined && String(task.subjectId) !== String(bookId)) return false
  return taskContentHash(task) === contentHash
}

function updateMetadataStatus(database, bookId, contentHash, status, errorCode) {
  const result = database.prepare(`
    UPDATE books
       SET metadata_status = ?,
           metadata_error_code = ?,
           metadata_parser_version = ?,
           metadata_updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND content_sha256 = ?
  `).run(status, errorCode ?? null, EBOOK_METADATA_PARSER_VERSION, bookId, contentHash)
  if (result.changes !== 1) {
    throw taskError('EBOOK_METADATA_CONTENT_CHANGED', errorSummary('EBOOK_METADATA_CONTENT_CHANGED'), false)
  }
}

function fallbackTitle(book) {
  const originalName = String(book?.original_name || '').trim()
  if (!originalName) return null
  const value = path.basename(originalName, path.extname(originalName)).normalize('NFKC').trim()
  return value || null
}

function computeMetadataUpdates(book, metadata) {
  const updates = {}
  const fallback = fallbackTitle(book)
  for (const field of EBOOK_METADATA_FIELDS) {
    const parsedValue = normalizeMetadataValue(metadata[field])
    if (parsedValue === null) continue
    if (field === 'title') {
      if (isBlank(book.title) || (fallback !== null && book.title === fallback)) updates[field] = parsedValue
      continue
    }
    if (isBlank(book[field])) updates[field] = parsedValue
  }
  return updates
}

function metadataStatusFor(book, updates) {
  const values = { ...book, ...updates }
  return EBOOK_METADATA_FIELDS.every(field => !isBlank(values[field])) ? 'ready' : 'partial'
}

function applyParsedMetadata(database, bookId, contentHash, metadata) {
  const run = () => {
    const book = readActiveBook(database, bookId)
    if (!book) throw taskError('EBOOK_METADATA_BOOK_NOT_FOUND', errorSummary('EBOOK_METADATA_BOOK_NOT_FOUND'), false)
    if (currentContentHash(book) !== contentHash) {
      throw taskError('EBOOK_METADATA_CONTENT_CHANGED', errorSummary('EBOOK_METADATA_CONTENT_CHANGED'), false)
    }
    const updates = computeMetadataUpdates(book, metadata)
    const metadataStatus = metadataStatusFor(book, updates)
    const assignments = EBOOK_METADATA_FIELDS
      .filter(field => Object.hasOwn(updates, field))
      .map(field => `${field} = ?`)
    const parameters = EBOOK_METADATA_FIELDS
      .filter(field => Object.hasOwn(updates, field))
      .map(field => updates[field])
    assignments.push(
      'metadata_status = ?',
      'metadata_error_code = NULL',
      'metadata_parser_version = ?',
      'metadata_updated_at = CURRENT_TIMESTAMP',
      'updated_at = CURRENT_TIMESTAMP'
    )
    parameters.push(metadataStatus, EBOOK_METADATA_PARSER_VERSION, bookId, contentHash)
    const result = database.prepare(`
      UPDATE books SET ${assignments.join(', ')}
       WHERE id = ? AND content_sha256 = ?
    `).run(...parameters)
    if (result.changes !== 1) {
      throw taskError('EBOOK_METADATA_CONTENT_CHANGED', errorSummary('EBOOK_METADATA_CONTENT_CHANGED'), false)
    }
    return { bookId, updatedFields: Object.keys(updates).length, metadataStatus }
  }
  return typeof database.transaction === 'function' ? database.transaction(run)() : run()
}

function parseTimeoutError() {
  return metadataError('EBOOK_METADATA_PARSE_TIMEOUT', '电子书元数据解析超时。')
}

async function parseWithTimeout(parseMetadata, filePath, signal, timeoutMs) {
  throwIfAborted(signal)
  const parsing = Promise.resolve().then(() => parseMetadata(filePath, { signal }))
  if (timeoutMs === null) return parsing
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : PARSE_TIMEOUT_MS
  let timer
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(parseTimeoutError()), timeout)
  })
  try {
    return await Promise.race([parsing, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export function createEbookMetadataTaskProcessor({
  database,
  databaseProvider = getDatabase,
  resolveBookPath,
  parseMetadata = parseEpubMetadata,
  parseTimeoutMs = PARSE_TIMEOUT_MS
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof resolveBookPath !== 'function') throw new TypeError('resolveBookPath must be a function')
  if (typeof parseMetadata !== 'function') throw new TypeError('parseMetadata must be a function')

  return async function processEbookMetadataTask(context = {}) {
    const signal = context.signal
    throwIfAborted(signal)
    const task = context.task
    normalizeTaskId(task)
    const bookId = normalizeEbookMetadataTaskInput(task)

    let databaseConnection
    try {
      databaseConnection = await getDatabaseForTask()
    } catch {
      throw databaseError()
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function') throw databaseError()

    let book
    try {
      book = readActiveBook(databaseConnection, bookId)
    } catch {
      throw databaseError()
    }
    if (!book) throw taskError('EBOOK_METADATA_BOOK_NOT_FOUND', errorSummary('EBOOK_METADATA_BOOK_NOT_FOUND'), false)
    if (!isEpubBook(book)) throw taskError('EBOOK_METADATA_NOT_EPUB', errorSummary('EBOOK_METADATA_NOT_EPUB'), false)

    const contentHash = currentContentHash(book)
    if (!contentHash) {
      throw taskError('EBOOK_METADATA_CONTENT_HASH_MISSING', errorSummary('EBOOK_METADATA_CONTENT_HASH_MISSING'), false)
    }
    if (!taskIdentityIsCompatible(task, bookId, contentHash)) {
      throw taskError('EBOOK_METADATA_INPUT_INVALID', errorSummary('EBOOK_METADATA_INPUT_INVALID'), false)
    }

    try {
      updateMetadataStatus(databaseConnection, bookId, contentHash, 'pending', null)
    } catch (error) {
      if (error instanceof TaskProcessorError) throw error
      throw databaseError()
    }

    let filePath
    try {
      filePath = await resolveBookPath(book)
    } catch (error) {
      const code = error?.code === 'RESOURCE_CONTENT_MISSING'
        ? 'EBOOK_METADATA_SOURCE_MISSING'
        : 'EBOOK_METADATA_SOURCE_INVALID'
      const mapped = taskError(code, errorSummary(code), code === 'EBOOK_METADATA_SOURCE_INVALID')
      try { updateMetadataStatus(databaseConnection, bookId, contentHash, 'failed', code) } catch (statusError) {
        if (statusError instanceof TaskProcessorError) throw statusError
        throw databaseError()
      }
      throw mapped
    }

    try {
      const metadata = await parseWithTimeout(parseMetadata, filePath, signal, parseTimeoutMs)
      throwIfAborted(signal)
      const normalized = normalizeParsedMetadata(metadata)
      return applyParsedMetadata(databaseConnection, bookId, contentHash, normalized)
    } catch (error) {
      if (error instanceof TaskProcessorError && error.code === 'TASK_CANCELLED') {
        try {
          updateMetadataStatus(databaseConnection, bookId, contentHash, 'failed', 'EBOOK_METADATA_CANCELLED')
        } catch (statusError) {
          if (statusError instanceof TaskProcessorError) throw statusError
          throw databaseError()
        }
        throw error
      }
      const mapped = mapProcessorError(error)
      try {
        updateMetadataStatus(databaseConnection, bookId, contentHash, 'failed', mapped.code)
      } catch (statusError) {
        if (statusError instanceof TaskProcessorError) throw statusError
        throw databaseError()
      }
      throw mapped
    }
  }
}

export default createEbookMetadataTaskProcessor
