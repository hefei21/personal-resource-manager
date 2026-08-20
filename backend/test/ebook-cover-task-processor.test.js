import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { enqueueExclusiveRun, getTaskById } from '../src/services/taskStore.js'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-ebook-cover-task-tests-'))
const previousDataPath = process.env.DATA_PATH
const previousBooksPath = process.env.BOOKS_PATH
process.env.DATA_PATH = path.join(testRoot, 'data')
process.env.BOOKS_PATH = path.join(testRoot, 'books')

const coverService = await import('../src/services/ebookCoverService.js')
const processorModule = await import('../src/services/ebookCoverTaskProcessor.js')
const routeModule = await import('../src/routes/books.js')

const {
  EbookCoverError
} = coverService
const {
  createEbookCoverTaskProcessor,
  EBOOK_COVER_EXECUTION_CLASS,
  EBOOK_COVER_PROCESSOR_VERSION,
  EBOOK_COVER_SUBJECT_TYPE,
  EBOOK_COVER_TASK_TYPE,
  EBOOK_COVER_TASK_TYPES
} = processorModule
const { waitForEbookCoverTask } = routeModule

let NativeDatabase = null
try {
  const databaseModule = await import('better-sqlite3')
  const probe = new databaseModule.default(':memory:')
  probe.close()
  NativeDatabase = databaseModule.default
} catch {
  // better-sqlite3 is built in the Linux CI acceptance environment.
}

const DATABASE_TEST_OPTIONS = NativeDatabase ? {} : {
  skip: 'better-sqlite3 native bindings are unavailable in the local checkout'
}

const jpeg = (...bytes) => Buffer.from([0xFF, 0xD8, 0xFF, ...bytes])

function fixture() {
  const root = fs.mkdtempSync(path.join(testRoot, 'fixture-'))
  const booksRoot = path.join(root, 'books')
  fs.mkdirSync(booksRoot, { recursive: true })
  return {
    root,
    booksRoot,
    sourcePath: path.join(booksRoot, 'book.epub'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

function fakeDatabase(book) {
  return {
    prepare() {
      return { get: () => book }
    }
  }
}

function createProcessor(database, booksRoot, overrides = {}) {
  return createEbookCoverTaskProcessor({
    database,
    booksRoot,
    resolveBookPath: async () => path.join(booksRoot, 'book.epub'),
    extractCover: async () => ({ data: Buffer.from('raw-cover'), ext: '.png' }),
    compressCover: async () => jpeg(1, 2),
    updateCoverPath: async (coverPath) => {
      database.book.cover_image = coverPath
    },
    ...overrides
  })
}

function task(bookId = 7, overrides = {}) {
  return {
    id: 1,
    taskType: EBOOK_COVER_TASK_TYPE,
    processorVersion: EBOOK_COVER_PROCESSOR_VERSION,
    executionClass: EBOOK_COVER_EXECUTION_CLASS,
    subjectType: EBOOK_COVER_SUBJECT_TYPE,
    subjectId: String(bookId),
    input: { bookId },
    ...overrides
  }
}

test.after(() => {
  if (previousDataPath === undefined) delete process.env.DATA_PATH
  else process.env.DATA_PATH = previousDataPath
  if (previousBooksPath === undefined) delete process.env.BOOKS_PATH
  else process.env.BOOKS_PATH = previousBooksPath
  fs.rmSync(testRoot, { recursive: true, force: true })
})

test('processor result is minimal and a retry recognizes an already generated cover', async () => {
  const value = fixture()
  const book = { id: 7, original_name: 'book.epub', file_type: 'epub', cover_image: null }
  const database = fakeDatabase(book)
  database.book = book
  fs.writeFileSync(value.sourcePath, 'epub')
  let resolveCalls = 0
  try {
    const processor = createProcessor(database, value.booksRoot, {
      resolveBookPath: async () => {
        resolveCalls += 1
        return value.sourcePath
      }
    })

    const first = await processor({ task: task(), signal: new AbortController().signal })
    const second = await processor({ task: task(), signal: new AbortController().signal })

    assert.deepEqual(first, { bookId: 7, generated: true })
    assert.deepEqual(second, { bookId: 7, generated: true })
    assert.equal(resolveCalls, 1)
    assert.equal(JSON.stringify(first).includes('filePath'), false)
    assert.equal(JSON.stringify(first).includes('booksRoot'), false)
    assert.equal(fs.existsSync(book.cover_image), true)
  } finally {
    value.cleanup()
  }
})

test('stable ebook cover failures are non-retryable and infrastructure failures are retryable', async () => {
  const value = fixture()
  try {
    const missingBook = createEbookCoverTaskProcessor({
      database: fakeDatabase(null),
      booksRoot: value.booksRoot,
      resolveBookPath: async () => value.sourcePath,
      extractCover: async () => ({ data: Buffer.from('raw') }),
      compressCover: async () => jpeg(1),
      updateCoverPath: async () => {}
    })
    await assert.rejects(
      () => missingBook({ task: task(), signal: new AbortController().signal }),
      error => error.code === 'EBOOK_COVER_BOOK_NOT_FOUND' && error.retryable === false
    )

    const noCoverBook = { id: 7, original_name: 'book.epub', file_type: 'epub', cover_image: null }
    const noCover = createProcessor(fakeDatabase(noCoverBook), value.booksRoot, {
      extractCover: async () => null
    })
    await assert.rejects(
      () => noCover({ task: task(), signal: new AbortController().signal }),
      error => error.code === 'EBOOK_COVER_NOT_FOUND' && error.retryable === false
    )

    const archiveInvalidBook = { id: 7, original_name: 'book.epub', file_type: 'epub', cover_image: null }
    const archiveInvalid = createProcessor(fakeDatabase(archiveInvalidBook), value.booksRoot, {
      extractCover: async () => {
        throw new EbookCoverError('EBOOK_COVER_ARCHIVE_INVALID', 'archive path leaked')
      }
    })
    await assert.rejects(
      () => archiveInvalid({ task: task(), signal: new AbortController().signal }),
      error => error.code === 'EBOOK_COVER_ARCHIVE_INVALID' &&
        error.retryable === false && !error.message.includes('path')
    )

    const infrastructureBook = { id: 7, original_name: 'book.epub', file_type: 'epub', cover_image: null }
    const infrastructure = createProcessor(fakeDatabase(infrastructureBook), value.booksRoot, {
      compressCover: async () => {
        throw new Error(path.join(value.root, 'private', 'cover-cache', 'sharp.tmp'))
      }
    })
    await assert.rejects(
      () => infrastructure({ task: task(), signal: new AbortController().signal }),
      error => error.code === 'EBOOK_COVER_REBUILD_FAILED' &&
        error.retryable === true && !error.message.includes('cover-cache')
    )
  } finally {
    value.cleanup()
  }
})

test('different run identities share one active ebook cover task and terminal tasks can be re-enqueued', DATABASE_TEST_OPTIONS, () => {
  const database = new NativeDatabase(':memory:')
  try {
    database.exec(CREATE_TASK_SCHEMA_SQL)
    const input = (subjectVersionId) => ({
      taskType: EBOOK_COVER_TASK_TYPE,
      processorVersion: EBOOK_COVER_PROCESSOR_VERSION,
      subjectType: EBOOK_COVER_SUBJECT_TYPE,
      subjectId: '7',
      subjectVersionId,
      input: { bookId: 7 },
      executionClass: EBOOK_COVER_EXECUTION_CLASS
    })
    const first = enqueueExclusiveRun(database, input('run-a'), { taskTypes: EBOOK_COVER_TASK_TYPES })
    const activeConflict = enqueueExclusiveRun(database, input('run-b'), { taskTypes: EBOOK_COVER_TASK_TYPES })

    assert.equal(first.created, true)
    assert.equal(activeConflict.activeConflict, true)
    assert.equal(activeConflict.task.id, first.task.id)
    assert.deepEqual(first.task.input, { bookId: 7 })
    assert.equal(JSON.stringify(first.task.input).includes('filePath'), false)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)

    database.prepare(
      "UPDATE tasks SET status = 'succeeded', result_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(JSON.stringify({ bookId: 7, generated: true }), first.task.id)
    const persisted = getTaskById(database, first.task.id)
    assert.deepEqual(persisted.result, { bookId: 7, generated: true })

    const afterTerminal = enqueueExclusiveRun(database, input('run-c'), { taskTypes: EBOOK_COVER_TASK_TYPES })
    assert.equal(afterTerminal.created, true)
    assert.notEqual(afterTerminal.task.id, first.task.id)
  } finally {
    database.close()
  }
})

test('persistent task waiter polls after a restart, times out with a stable outcome, and stops on abort', async () => {
  let clock = 0
  let reads = 0
  const recovered = await waitForEbookCoverTask({
    taskId: 19,
    readTask: () => ({ status: ++reads < 3 ? 'pending' : 'succeeded' }),
    intervalMs: 10,
    timeoutMs: 100,
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds }
  })
  assert.equal(recovered.task.status, 'succeeded')
  assert.equal(recovered.timedOut, false)

  let restartedStatus = 'pending'
  clock = 0
  const timedOut = await waitForEbookCoverTask({
    taskId: 19,
    readTask: () => ({ status: restartedStatus }),
    intervalMs: 10,
    timeoutMs: 20,
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds }
  })
  assert.equal(timedOut.task, null)
  assert.equal(timedOut.timedOut, true)

  const controller = new AbortController()
  const aborted = await waitForEbookCoverTask({
    taskId: 19,
    readTask: () => ({ status: 'pending' }),
    intervalMs: 100,
    timeoutMs: 1000,
    signal: controller.signal,
    sleep: async () => controller.abort()
  })
  assert.equal(aborted.aborted, true)
  assert.equal(aborted.timedOut, false)

  restartedStatus = 'succeeded'
  const afterRestart = await waitForEbookCoverTask({
    taskId: 19,
    readTask: () => ({ status: restartedStatus }),
    timeoutMs: 10,
    intervalMs: 5,
    sleep: async () => {}
  })
  assert.equal(afterRestart.task.status, 'succeeded')
})

test('cover route retired the in-process request map and checks existing covers before enqueueing', () => {
  const routeSource = fs.readFileSync(new URL('../src/routes/books.js', import.meta.url), 'utf8')
  const coverRouteStart = routeSource.indexOf("router.get('/:id/cover'")
  const coverRoute = routeSource.slice(coverRouteStart)
  assert.doesNotMatch(routeSource, /ebookCoverRequests/u)
  assert.match(coverRoute, /resolveExistingEbookCover/u)
  assert.match(coverRoute, /enqueueEbookCoverTask/u)
  assert.ok(coverRoute.indexOf('resolveExistingEbookCover') < coverRoute.indexOf('enqueueEbookCoverTask'))
  assert.match(coverRoute, /requestAbortController/u)
  assert.match(routeSource, /target\.once\(eventName, abort\)/u)
  assert.doesNotMatch(routeSource, /\[req, 'close'\]/u)
  assert.match(routeSource, /input: \{ bookId \}/u)
})
