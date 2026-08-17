import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  BOOKS_STORAGE_KNOWN_INDEXES,
  BOOKS_STORAGE_LEGACY_DDL,
  BOOKS_STORAGE_TARGET_DDL,
  BOOKS_STORAGE_TARGET_SHAPE
} from '../src/config/ebookStorageSchema.js'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables, listAppliedMigrations } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'

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

const migration = applicationMigrationRegistry.migrations.find(({ id }) => id === '0052_books_storage_shape')
const registry = createMigrationRegistry([migration])

const readingProgressDdl = `CREATE TABLE reading_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  user_id INTEGER,
  current_page INTEGER DEFAULT 0,
  cfi TEXT,
  progress REAL DEFAULT 0,
  font_size INTEGER DEFAULT 16,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, user_id)
)`

const bookChaptersDdl = `CREATE TABLE book_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  start_position INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
)`

function createLegacyDatabase({ indexes = true, unknownColumn = false, unknownIndex = false, childTrigger = false } = {}) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE book_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    INSERT INTO book_categories (id, name) VALUES (3, '技术');
    ${BOOKS_STORAGE_LEGACY_DDL};
    ${readingProgressDdl};
    ${bookChaptersDdl};
  `)
  if (indexes) {
    database.exec('CREATE INDEX idx_books_title ON books(title); CREATE INDEX idx_books_created_at ON books(created_at);')
  }
  if (unknownColumn) database.exec('ALTER TABLE books ADD COLUMN unexpected TEXT;')
  if (unknownIndex) database.exec('CREATE INDEX idx_books_unexpected ON books(author);')
  database.prepare(`INSERT INTO books
    (id, title, author, category_id, file_path, file_size, total_pages, content_cache)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(17, '旧书', '作者', 3, '/legacy/book.epub', 42, 9, 'cached')
  database.prepare(`INSERT INTO reading_progress
    (id, book_id, user_id, current_page, cfi, progress) VALUES (?, ?, ?, ?, ?, ?)`).run(
    19, 17, 5, 4, 'epubcfi(/6/2)', 0.4
  )
  database.prepare(`INSERT INTO book_chapters
    (id, book_id, title, chapter_index, start_position) VALUES (?, ?, ?, ?, ?)`).run(
    23, 17, '第一章', 0, 0
  )
  if (childTrigger) {
    database.exec(`CREATE TRIGGER reading_progress_delete_side_effect
      AFTER DELETE ON reading_progress BEGIN
        UPDATE books SET title = title || '-deleted' WHERE id = OLD.book_id;
      END`)
  }
  database.prepare("UPDATE sqlite_sequence SET seq = 41 WHERE name = 'books'").run()
  database.prepare("UPDATE sqlite_sequence SET seq = 43 WHERE name = 'reading_progress'").run()
  database.prepare("UPDATE sqlite_sequence SET seq = 47 WHERE name = 'book_chapters'").run()
  ensureMigrationControlTables(database)
  return database
}

function runMigration(database) {
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-17T00:00:00.000Z'
  })
}

test('registers the ebook table transition and keeps the base target shape aligned', nativeTestOptions, () => {
  assert.ok(migration)
  assert.deepEqual(migration.compatibility.target, BOOKS_STORAGE_TARGET_SHAPE)
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    database.exec('CREATE TABLE book_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
    database.exec(BOOKS_STORAGE_TARGET_DDL)
    assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
      status: 'satisfied', kind: 'table-transition', table: 'books', reason: 'matched'
    })
    assert.equal(database.pragma('table_xinfo(books)').find(({ name }) => name === 'file_path').notnull, 0)
    assert.deepEqual(
      database.pragma('table_xinfo(books)').map(({ name }) => name),
      BOOKS_STORAGE_TARGET_SHAPE.columns.map(({ name }) => name)
    )
  } finally {
    database.close()
  }
})

test('migrates books without losing rows, identities, sequences, indexes, or inbound foreign keys', nativeTestOptions, () => {
  const database = createLegacyDatabase()
  try {
    assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
      status: 'missing', kind: 'table-transition', table: 'books', reason: 'legacy-matched',
      proofKey: 'legacy-known-indexes'
    })
    const summary = runMigration(database)
    assert.equal(summary.executedCount, 1)
    assert.deepEqual(database.prepare('SELECT id, title, file_path, storage_key, content_sha256, content_bytes, original_name FROM books').get(), {
      id: 17,
      title: '旧书',
      file_path: '/legacy/book.epub',
      storage_key: null,
      content_sha256: null,
      content_bytes: null,
      original_name: null
    })
    assert.deepEqual(database.prepare('SELECT id, book_id, current_page, cfi FROM reading_progress').get(), {
      id: 19, book_id: 17, current_page: 4, cfi: 'epubcfi(/6/2)'
    })
    assert.deepEqual(database.prepare('SELECT id, book_id, title FROM book_chapters').get(), {
      id: 23, book_id: 17, title: '第一章'
    })
    assert.equal(database.pragma('table_xinfo(books)').find(({ name }) => name === 'file_path').notnull, 0)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'books' ORDER BY name").all(),
      BOOKS_STORAGE_KNOWN_INDEXES.map(({ name }) => ({ name })).sort((left, right) => left.name.localeCompare(right.name))
    )
    assert.deepEqual(
      database.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('books', 'reading_progress', 'book_chapters') ORDER BY name").all(),
      [
        { name: 'book_chapters', seq: 47 },
        { name: 'books', seq: 41 },
        { name: 'reading_progress', seq: 43 }
      ]
    )
    const second = executeMigrationBatch({
      database,
      registry,
      plan: createMigrationPlan(registry, listAppliedMigrations(database)),
      lock: { state: 'active' },
      now: () => '2026-08-17T00:01:00.000Z'
    })
    assert.deepEqual(second, {
      executed: [],
      skipped: [{ id: '0052_books_storage_shape', status: 'skipped' }],
      executedCount: 0,
      skippedCount: 1,
      total: 1
    })
  } finally {
    database.close()
  }
})

test('rejects unknown books schema and rolls back all transition artifacts', nativeTestOptions, () => {
  for (const options of [{ unknownColumn: true }, { unknownIndex: true }]) {
    const database = createLegacyDatabase({ indexes: false, ...options })
    try {
      assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'incompatible')
      assert.throws(() => runMigration(database))
      assert.equal(database.prepare('SELECT file_path FROM books WHERE id = 17').get().file_path, '/legacy/book.epub')
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reading_progress').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM book_chapters').get().count, 1)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'prm_books_v0052_%'").get().count, 0)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'books_migration_0052'").get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
    } finally {
      database.close()
    }
  }
})

test('rejects child-table delete triggers before rebuilding books and rolls back cleanly', nativeTestOptions, () => {
  const database = createLegacyDatabase({ childTrigger: true })
  try {
    assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'missing')
    assert.throws(() => runMigration(database))
    assert.equal(database.prepare('SELECT title FROM books WHERE id = 17').get().title, '旧书')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reading_progress').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM book_chapters').get().count, 1)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'prm_books_v0052_%'").get().count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'books_migration_0052'").get().count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
  } finally {
    database.close()
  }
})
