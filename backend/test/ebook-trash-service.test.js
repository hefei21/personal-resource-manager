import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  listDeletedEbooks,
  permanentlyDeleteEbook,
  restoreEbookFromTrash,
  softDeleteEbook,
  softDeleteEbooks
} from '../src/services/ebookTrashService.js'

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

function fixture() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE book_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      category_id INTEGER,
      file_path TEXT,
      storage_key TEXT,
      content_sha256 TEXT,
      content_bytes INTEGER,
      original_name TEXT,
      file_type TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
    );
    CREATE TABLE reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE TABLE resource_trash_entries (
      resource_type TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      original_parent_id INTEGER,
      original_path TEXT,
      deleted_at TEXT NOT NULL,
      purge_after TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (resource_type, resource_id)
    );
    INSERT INTO book_categories (id, name) VALUES (3, '技术');
  `)
  return database
}

function insertManaged(database, { id, storageKey = `ebooks/aa/${'a'.repeat(64)}` } = {}) {
  database.prepare(`
    INSERT INTO books
      (id, title, category_id, file_path, storage_key, content_sha256, content_bytes, original_name, file_type)
    VALUES (?, ?, 3, NULL, ?, ?, 7, ?, 'epub')
  `).run(id, `书-${id}`, storageKey, storageKey.split('/').pop(), `book-${id}.epub`)
  database.prepare('INSERT INTO reading_progress (book_id) VALUES (?)').run(id)
}

test('soft delete hides lifecycle state in one generic trash entry and restore preserves content references', nativeTestOptions, () => {
  const database = fixture()
  try {
    insertManaged(database, { id: 1 })
    const before = database.prepare('SELECT storage_key, content_sha256, content_bytes FROM books WHERE id = 1').get()
    const deleted = softDeleteEbook({ database, id: 1, now: () => new Date('2026-08-17T00:00:00.000Z') })
    assert.equal(deleted.id, 1)
    assert.deepEqual(listDeletedEbooks(database).map(({ id, originalCategoryId }) => ({ id, originalCategoryId })), [
      { id: 1, originalCategoryId: 3 }
    ])
    assert.deepEqual(database.prepare('SELECT storage_key, content_sha256, content_bytes FROM books WHERE id = 1').get(), before)
    assert.deepEqual(restoreEbookFromTrash({ database, id: 1 }), { id: 1, categoryId: 3 })
    assert.equal(listDeletedEbooks(database).length, 0)
    assert.deepEqual(database.prepare('SELECT storage_key, content_sha256, content_bytes FROM books WHERE id = 1').get(), before)
  } finally {
    database.close()
  }
})

test('batch delete is atomic and does not delete ebook rows or reading progress', nativeTestOptions, () => {
  const database = fixture()
  try {
    insertManaged(database, { id: 1 })
    insertManaged(database, { id: 2, storageKey: `ebooks/bb/${'b'.repeat(64)}` })
    assert.throws(() => softDeleteEbooks({ database, ids: [1, 99] }), { code: 'EBOOK_NOT_FOUND' })
    assert.equal(listDeletedEbooks(database).length, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM books').get().count, 2)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reading_progress').get().count, 2)
    assert.equal(softDeleteEbooks({ database, ids: [1, 2] }).length, 2)
    assert.equal(listDeletedEbooks(database).length, 2)
  } finally {
    database.close()
  }
})

test('permanent delete rejects legacy-only content and never calls storage', nativeTestOptions, async () => {
  const database = fixture()
  try {
    database.prepare(`
      INSERT INTO books (id, title, file_path, file_type) VALUES (1, '旧书', '/legacy/book.epub', 'epub')
    `).run()
    softDeleteEbook({ database, id: 1 })
    let called = false
    await assert.rejects(permanentlyDeleteEbook({
      database,
      id: 1,
      storageService: {
        async trashObject() { called = true },
        async purgeTrashed() { called = true }
      }
    }), { code: 'EBOOK_TRASH_LEGACY_MIGRATION_REQUIRED' })
    assert.equal(called, false)
    assert.ok(database.prepare('SELECT 1 FROM books WHERE id = 1').get())
  } finally {
    database.close()
  }
})

test('shared managed objects survive the first purge and the final reference purges exactly once', nativeTestOptions, async () => {
  const database = fixture()
  const storageKey = `ebooks/aa/${'a'.repeat(64)}`
  const calls = []
  const storageService = {
    async trashObject(input) {
      calls.push(['trash', input])
      return { trashToken: 'a'.repeat(32), storageKey }
    },
    async purgeTrashed(token) { calls.push(['purge', token]) },
    async restoreTrashed() {}
  }
  try {
    insertManaged(database, { id: 1, storageKey })
    insertManaged(database, { id: 2, storageKey })
    softDeleteEbook({ database, id: 1 })
    softDeleteEbook({ database, id: 2 })
    assert.deepEqual(await permanentlyDeleteEbook({ database, storageService, id: 1 }), { id: 1, purgedObjects: 0 })
    assert.deepEqual(calls, [])
    assert.ok(database.prepare('SELECT 1 FROM books WHERE id = 2').get())
    assert.deepEqual(await permanentlyDeleteEbook({ database, storageService, id: 2 }), { id: 2, purgedObjects: 1 })
    assert.deepEqual(calls, [
      ['trash', { storageKey, activeReferenceCount: 0 }],
      ['purge', 'a'.repeat(32)]
    ])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM books').get().count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resource_trash_entries').get().count, 0)
  } finally {
    database.close()
  }
})
