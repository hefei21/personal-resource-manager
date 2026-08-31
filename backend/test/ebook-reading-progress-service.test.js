import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  EbookReadingProgressError,
  getEbookReadingProgress,
  saveEbookReadingProgress
} from '../src/services/ebookReadingProgressService.js'

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

function setup() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      last_read_at TEXT
    );
    CREATE TABLE resource_trash_entries (
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL
    );
    CREATE TABLE reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      current_page INTEGER DEFAULT 0,
      cfi TEXT,
      progress REAL DEFAULT 0,
      font_size INTEGER DEFAULT 16,
      chapter_fraction REAL,
      revision INTEGER NOT NULL DEFAULT 0,
      last_mutation_id TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(book_id, user_id)
    );
    INSERT INTO books (id, title) VALUES (7, '跨端阅读测试');
  `)
  return database
}

test('reading progress starts at revision zero and advances atomically', nativeTestOptions, () => {
  const database = setup()
  try {
    assert.deepEqual(getEbookReadingProgress({ database, bookId: 7, userId: 3 }), {
      currentPage: 0,
      cfi: null,
      progress: 0,
      fontSize: 16,
      chapterFraction: null,
      revision: 0,
      updatedAt: null
    })
    const saved = saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: {
        currentPage: 4,
        cfi: 'epubcfi(/6/10!/4/2:8)',
        progress: 27.345,
        chapterFraction: 0.625,
        fontSize: 18,
        revision: 0,
        mutationId: 'pc-session:mutation-0001'
      }
    })
    assert.equal(saved.progress.revision, 1)
    assert.equal(saved.progress.currentPage, 4)
    assert.equal(saved.progress.progress, 27.35)
    assert.equal(saved.progress.chapterFraction, 0.625)
    assert.equal(saved.progress.fontSize, 18)
    assert.ok(database.prepare('SELECT last_read_at FROM books WHERE id = 7').get().last_read_at)
  } finally {
    database.close()
  }
})

test('retries are idempotent and stale clients receive the latest position', nativeTestOptions, () => {
  const database = setup()
  try {
    const input = {
      currentPage: 2,
      cfi: null,
      progress: 12,
      revision: 0,
      mutationId: 'mobile-session:mutation-0001'
    }
    const first = saveEbookReadingProgress({ database, bookId: 7, userId: 3, input })
    const retry = saveEbookReadingProgress({ database, bookId: 7, userId: 3, input })
    assert.equal(first.progress.revision, 1)
    assert.equal(retry.progress.revision, 1)
    assert.equal(retry.idempotent, true)

    assert.throws(() => saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: {
        currentPage: 8,
        progress: 48,
        revision: 0,
        mutationId: 'pc-session:mutation-0002'
      }
    }), (error) => {
      assert.ok(error instanceof EbookReadingProgressError)
      assert.equal(error.code, 'EBOOK_PROGRESS_CONFLICT')
      assert.equal(error.details.latest.currentPage, 2)
      assert.equal(error.details.latest.revision, 1)
      return true
    })
  } finally {
    database.close()
  }
})

test('an explicit conflict decision can keep the local position', nativeTestOptions, () => {
  const database = setup()
  try {
    saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: { currentPage: 1, progress: 5, revision: 0, mutationId: 'mobile-session:mutation-0003' }
    })
    const forced = saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: { currentPage: 6, progress: 39, revision: 1, mutationId: 'pc-session:mutation-0004', force: true }
    })
    assert.equal(forced.forced, true)
    assert.equal(forced.progress.currentPage, 6)
    assert.equal(forced.progress.revision, 2)

    assert.throws(() => saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: { currentPage: 9, progress: 60, revision: 0, mutationId: 'pc-session:mutation-0005', force: true }
    }), { code: 'EBOOK_PROGRESS_CONFLICT' })
  } finally {
    database.close()
  }
})

test('invalid and trashed progress writes fail closed', nativeTestOptions, () => {
  const database = setup()
  try {
    assert.throws(() => saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: { currentPage: -1, progress: 101, revision: 0, mutationId: 'bad-input' }
    }), { code: 'EBOOK_PROGRESS_INPUT_INVALID' })
    assert.throws(() => saveEbookReadingProgress({
      database,
      bookId: 7,
      userId: 3,
      input: { currentPage: 1, progress: 20, chapterFraction: 1.2, revision: 0, mutationId: 'bad-fraction' }
    }), { code: 'EBOOK_PROGRESS_INPUT_INVALID' })
    database.prepare("INSERT INTO resource_trash_entries (resource_type, resource_id) VALUES ('ebook', 7)").run()
    assert.throws(() => getEbookReadingProgress({ database, bookId: 7, userId: 3 }), {
      code: 'EBOOK_PROGRESS_BOOK_NOT_FOUND'
    })
  } finally {
    database.close()
  }
})
