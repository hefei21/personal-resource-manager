import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-ebook-metadata-tests-'))
const previousDataPath = process.env.DATA_PATH
const previousBooksPath = process.env.BOOKS_PATH
process.env.DATA_PATH = path.join(testRoot, 'data')
process.env.BOOKS_PATH = path.join(testRoot, 'books')

const processorModule = await import('../src/services/ebookMetadataTaskProcessor.js')
const migrationModule = await import('../src/config/databaseMigrations.js')
const {
  EBOOK_METADATA_EXECUTION_CLASS,
  EBOOK_METADATA_PARSER_VERSION,
  EBOOK_METADATA_PROCESSOR_VERSION,
  EBOOK_METADATA_SUBJECT_TYPE,
  EBOOK_METADATA_TASK_TYPE,
  createEbookMetadataTaskProcessor,
  parseEpubMetadata
} = processorModule
const { applicationMigrationRegistry } = migrationModule

const HASH = 'a'.repeat(64)
const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}
const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }
const taskMigration = applicationMigrationRegistry.migrations.find(({ id }) => id === '0054_persistent_tasks')

test.after(() => {
  if (previousDataPath === undefined) delete process.env.DATA_PATH
  else process.env.DATA_PATH = previousDataPath
  if (previousBooksPath === undefined) delete process.env.BOOKS_PATH
  else process.env.BOOKS_PATH = previousBooksPath
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function makeBook(overrides = {}) {
  return {
    id: 7,
    title: 'book',
    author: '用户作者',
    publisher: null,
    year: null,
    isbn: null,
    description: null,
    cover_image: '/private/cover.jpg',
    original_name: 'book.epub',
    file_type: 'epub',
    content_sha256: HASH,
    metadata_status: 'pending',
    metadata_error_code: 'EBOOK_METADATA_PARSE_FAILED',
    metadata_parser_version: null,
    metadata_updated_at: null,
    ...overrides
  }
}

function createFakeDatabase(book) {
  const database = {
    book,
    updates: [],
    prepare(sql) {
      if (/^\s*SELECT\s+b\.\*/u.test(sql)) {
        return { get: () => database.book }
      }
      if (/^\s*UPDATE\s+books\s+SET/u.test(sql)) {
        return {
          run: (...parameters) => {
            database.updates.push({ sql, parameters })
            if (sql.includes('metadata_error_code = NULL')) {
              const fields = ['title', 'author', 'publisher', 'year', 'isbn', 'description']
                .filter(field => new RegExp(`${field} = \\?`, 'u').test(sql))
              const fieldValues = parameters.slice(0, fields.length)
              fields.forEach((field, index) => { database.book[field] = fieldValues[index] })
              database.book.metadata_status = parameters[fields.length]
              database.book.metadata_error_code = null
              database.book.metadata_parser_version = parameters[fields.length + 1]
              return { changes: parameters.at(-2) === database.book.id && parameters.at(-1) === HASH ? 1 : 0 }
            }
            const [status, errorCode, parserVersion, bookId, contentHash] = parameters
            if (bookId === database.book.id && contentHash === HASH) {
              database.book.metadata_status = status
              database.book.metadata_error_code = errorCode
              database.book.metadata_parser_version = parserVersion
              return { changes: 1 }
            }
            return { changes: 0 }
          }
        }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    transaction(callback) {
      return (...args) => callback(...args)
    }
  }
  return database
}

function task(overrides = {}) {
  return {
    id: 1,
    taskType: EBOOK_METADATA_TASK_TYPE,
    processorVersion: EBOOK_METADATA_PROCESSOR_VERSION,
    executionClass: EBOOK_METADATA_EXECUTION_CLASS,
    subjectType: EBOOK_METADATA_SUBJECT_TYPE,
    subjectId: '7',
    subjectVersionId: `${EBOOK_METADATA_PARSER_VERSION}:run-1`,
    subjectContentHash: HASH,
    input: { bookId: 7 },
    ...overrides
  }
}

function createProcessor(database, overrides = {}) {
  return createEbookMetadataTaskProcessor({
    database,
    resolveBookPath: async () => 'verified.epub',
    parseMetadata: async () => ({
      title: '解析标题',
      author: '解析作者',
      publisher: '出版社',
      year: '2026',
      isbn: '9780000000000',
      description: '简介'
    }),
    ...overrides
  })
}

test('parses EPUB metadata without exposing source paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-metadata-'))
  const filePath = path.join(root, 'book.epub')
  try {
    const archive = new AdmZip()
    archive.addFile('META-INF/container.xml', Buffer.from(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>'
    ))
    archive.addFile('OPS/package.opf', Buffer.from(
      '<package><metadata><dc:title xmlns:dc="x">示例书</dc:title>' +
      '<dc:creator xmlns:dc="x">作者</dc:creator><dc:date xmlns:dc="x">2024-01-01</dc:date>' +
      '<dc:description xmlns:dc="x">简介</dc:description></metadata></package>'
    ))
    archive.writeZip(filePath)

    assert.deepEqual(parseEpubMetadata(filePath), {
      title: '示例书',
      author: '作者',
      publisher: null,
      year: '2024',
      isbn: null,
      description: '简介'
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('successful reparse fills only empty metadata and may replace the filename fallback title', async () => {
  const book = makeBook()
  const database = createFakeDatabase(book)
  const processor = createProcessor(database)

  const result = await processor({ task: task(), signal: new AbortController().signal })

  assert.deepEqual(result, { bookId: 7, updatedFields: 5, metadataStatus: 'ready' })
  assert.equal(book.title, '解析标题')
  assert.equal(book.author, '用户作者')
  assert.equal(book.publisher, '出版社')
  assert.equal(book.year, '2026')
  assert.equal(book.isbn, '9780000000000')
  assert.equal(book.description, '简介')
  assert.equal(book.cover_image, '/private/cover.jpg')
  assert.equal(book.metadata_status, 'ready')
  assert.equal(book.metadata_error_code, null)
})

test('reparse never replaces a user title or non-empty user fields', async () => {
  const book = makeBook({ title: '用户标题', publisher: '用户出版社' })
  const database = createFakeDatabase(book)
  const processor = createProcessor(database)

  await processor({ task: task(), signal: new AbortController().signal })

  assert.equal(book.title, '用户标题')
  assert.equal(book.author, '用户作者')
  assert.equal(book.publisher, '用户出版社')
  assert.equal(book.metadata_status, 'ready')
})

test('parser failures persist a stable failed status without exposing raw errors', async () => {
  const book = makeBook()
  const database = createFakeDatabase(book)
  const processor = createProcessor(database, {
    parseMetadata: async () => {
      throw new Error('/private/storage/book.epub: parser stack')
    }
  })

  await assert.rejects(
    () => processor({ task: task(), signal: new AbortController().signal }),
    error => error.code === 'EBOOK_METADATA_PARSE_FAILED' &&
      error.retryable === true &&
      !error.message.includes('/private/storage') &&
      !error.message.includes('parser stack')
  )
  assert.equal(book.metadata_status, 'failed')
  assert.equal(book.metadata_error_code, 'EBOOK_METADATA_PARSE_FAILED')
  assert.equal(database.updates.length >= 2, true)
})

test('parser timeout persists failed status with a stable timeout code', async () => {
  const book = makeBook()
  const database = createFakeDatabase(book)
  const processor = createProcessor(database, {
    parseTimeoutMs: 5,
    parseMetadata: () => new Promise(() => {})
  })

  await assert.rejects(
    () => processor({ task: task(), signal: new AbortController().signal }),
    error => error.code === 'EBOOK_METADATA_PARSE_TIMEOUT' && error.retryable === true
  )
  assert.equal(book.metadata_status, 'failed')
  assert.equal(book.metadata_error_code, 'EBOOK_METADATA_PARSE_TIMEOUT')
})

test('cancellation after parsing starts does not leave metadata pending', async () => {
  const book = makeBook()
  const database = createFakeDatabase(book)
  const controller = new AbortController()
  const processor = createProcessor(database, {
    parseMetadata: async () => {
      controller.abort()
      return { title: '不会写入' }
    }
  })

  await assert.rejects(
    () => processor({ task: task(), signal: controller.signal }),
    error => error.code === 'TASK_CANCELLED' && error.retryable === false
  )
  assert.equal(book.metadata_status, 'failed')
  assert.equal(book.metadata_error_code, 'EBOOK_METADATA_CANCELLED')
  assert.equal(book.title, 'book')
})

test('content hash mismatch is rejected before metadata mutation', async () => {
  const book = makeBook()
  const database = createFakeDatabase(book)
  const processor = createProcessor(database)

  await assert.rejects(
    () => processor({
      task: task({ subjectContentHash: 'b'.repeat(64) }),
      signal: new AbortController().signal
    }),
    error => error.code === 'EBOOK_METADATA_INPUT_INVALID' && error.retryable === false
  )
  assert.equal(database.updates.length, 0)
  assert.equal(book.metadata_status, 'pending')
})

test('books route exposes the owner-only asynchronous reparse contract and safe task projection', () => {
  const source = fs.readFileSync(new URL('../src/routes/books.js', import.meta.url), 'utf8')
  assert.match(source, /router\.post\('\/:id\/reparse-metadata', authenticateToken, requireWritePermission/u)
  assert.match(source, /subjectContentSha256: normalizedHash/u)
  assert.match(source, /projectEbookMetadataTask\(outcome\.task\)/u)
  assert.match(source, /metadataStatus: metadataResult\.metadataStatus/u)
  assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{ message: '解析失败', error: error\.message \}\)/u)
})

test('upload recovery atomically persists pending state with one content-bound task', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        metadata_status TEXT NOT NULL DEFAULT 'ready',
        metadata_error_code TEXT,
        metadata_parser_version TEXT,
        metadata_updated_at TEXT
      );
      INSERT INTO books (id) VALUES (7);
      ${taskMigration.source}
    `)
    const { completeEbookMetadataUpload } = await import('../src/routes/books.js')
    const result = completeEbookMetadataUpload({
      database,
      bookId: 7,
      originalName: 'book.epub',
      contentSha256: HASH,
      metadataState: {
        status: 'pending',
        errorCode: 'EBOOK_METADATA_PARSE_FAILED'
      }
    })

    assert.equal(result.metadataStatus, 'pending')
    assert.equal(result.metadataErrorCode, 'EBOOK_METADATA_PARSE_FAILED')
    assert.equal(result.metadataTask.taskType, 'ebook.metadata.reparse')
    assert.equal(result.metadataTask.subject.id, '7')
    assert.deepEqual(result.metadataTask.input, { bookId: 7 })
    assert.deepEqual(database.prepare(`
      SELECT metadata_status, metadata_error_code, metadata_parser_version
        FROM books WHERE id = 7
    `).get(), {
      metadata_status: 'pending',
      metadata_error_code: 'EBOOK_METADATA_PARSE_FAILED',
      metadata_parser_version: EBOOK_METADATA_PARSER_VERSION
    })
    assert.deepEqual(database.prepare(`
      SELECT task_type, subject_type, subject_id, subject_content_sha256, status
        FROM tasks
    `).all(), [{
      task_type: 'ebook.metadata.reparse',
      subject_type: 'ebook',
      subject_id: '7',
      subject_content_sha256: HASH,
      status: 'pending'
    }])
  } finally {
    database.close()
  }
})

test('upload recovery records failed instead of leaving pending when task enqueue fails', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        metadata_status TEXT NOT NULL DEFAULT 'ready',
        metadata_error_code TEXT,
        metadata_parser_version TEXT,
        metadata_updated_at TEXT
      );
      INSERT INTO books (id) VALUES (7);
    `)
    const { completeEbookMetadataUpload } = await import('../src/routes/books.js')
    const result = completeEbookMetadataUpload({
      database,
      bookId: 7,
      originalName: 'book.epub',
      contentSha256: HASH,
      metadataState: {
        status: 'pending',
        errorCode: 'EBOOK_METADATA_PARSE_FAILED'
      }
    })

    assert.equal(result.metadataStatus, 'failed')
    assert.equal(result.metadataErrorCode, 'EBOOK_METADATA_TASK_ENQUEUE_FAILED')
    assert.equal(result.metadataTask, null)
    assert.deepEqual(database.prepare(`
      SELECT metadata_status, metadata_error_code FROM books WHERE id = 7
    `).get(), {
      metadata_status: 'failed',
      metadata_error_code: 'EBOOK_METADATA_TASK_ENQUEUE_FAILED'
    })
  } finally {
    database.close()
  }
})
