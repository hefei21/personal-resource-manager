import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import test from 'node:test'

import { ENSURE_STORAGE_COMMIT_OPERATIONS_SQL } from '../src/config/storageCommitSchema.js'
import { commitEbookUpload } from '../src/services/ebookStorageService.js'
import { StorageService } from '../src/services/storageService.js'

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

function setup({ readingProgress = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ebook-storage-'))
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      year TEXT,
      publisher TEXT,
      isbn TEXT,
      description TEXT,
      category_id INTEGER,
      file_path TEXT,
      storage_key TEXT,
      content_sha256 TEXT,
      content_bytes INTEGER,
      original_name TEXT,
      file_type TEXT,
      file_size INTEGER DEFAULT 0,
      total_pages INTEGER DEFAULT 0,
      cover_image TEXT
    );
    ${ENSURE_STORAGE_COMMIT_OPERATIONS_SQL};
  `)
  if (readingProgress) database.exec(`
    CREATE TABLE reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      current_page INTEGER DEFAULT 0,
      progress REAL DEFAULT 0,
      font_size INTEGER DEFAULT 16,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
  `)
  return {
    root,
    database,
    storageService: new StorageService({ rootPath: path.join(root, 'storage') }),
    cleanup() {
      database.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

async function stage(storageService, content = 'ebook-content') {
  return storageService.stageFromStream(Readable.from([content]))
}

test('commits a staged ebook and its initial progress in one database transaction', nativeTestOptions, async () => {
  const value = setup()
  try {
    const staged = await stage(value.storageService)
    const result = await commitEbookUpload({
      database: value.database,
      storageService: value.storageService,
      staged,
      idempotencyKey: 'ebook-upload:test-success',
      ebook: { title: '测试书', originalName: 'test.epub', fileType: 'epub', totalPages: 9 }
    })
    const book = value.database.prepare(`
      SELECT title, file_path, storage_key, content_sha256, content_bytes, original_name, file_size
      FROM books WHERE id = ?
    `).get(result.id)
    assert.equal(book.title, '测试书')
    assert.equal(book.file_path, null)
    assert.equal(book.storage_key, result.storageKey)
    assert.equal(book.content_sha256, result.sha256)
    assert.equal(book.content_bytes, 13)
    assert.equal(book.file_size, 13)
    assert.equal(book.original_name, 'test.epub')
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM reading_progress WHERE book_id = ?').get(result.id).count, 1)
    assert.equal((await value.storageService.stat(result.storageKey)).bytes, 13)
  } finally {
    value.cleanup()
  }
})

test('database failure records an orphan and retry commits without requiring the removed staging file', nativeTestOptions, async () => {
  const value = setup({ readingProgress: false })
  try {
    const staged = await stage(value.storageService, 'retry-content')
    const request = {
      database: value.database,
      storageService: value.storageService,
      staged,
      idempotencyKey: 'ebook-upload:test-retry',
      ebook: { title: '重试书', originalName: 'retry.txt', fileType: 'txt' }
    }
    await assert.rejects(commitEbookUpload(request), { code: 'STORAGE_COMMIT_DATABASE_FAILED' })
    assert.equal(value.database.prepare("SELECT state FROM storage_commit_operations WHERE idempotency_key = ?").get(request.idempotencyKey).state, 'orphaned')
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM books').get().count, 0)
    value.database.exec(`
      CREATE TABLE reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        current_page INTEGER DEFAULT 0,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )
    `)
    const result = await commitEbookUpload(request)
    assert.equal(result.title, '重试书')
    assert.equal(value.database.prepare('SELECT COUNT(*) AS count FROM books').get().count, 1)
    assert.equal(value.database.prepare("SELECT state FROM storage_commit_operations WHERE idempotency_key = ?").get(request.idempotencyKey).state, 'database_committed')
  } finally {
    value.cleanup()
  }
})
