import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { EBOOK_READING_PROGRESS_MIGRATIONS } from '../src/config/ebookReadingProgressSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'

const require = createRequire(import.meta.url)
let Database
try { Database = require('better-sqlite3'); new Database(':memory:').close() } catch {}
const nativeTestOptions = Database ? {} : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }
const registry = createMigrationRegistry(EBOOK_READING_PROGRESS_MIGRATIONS)

function migrate(database) {
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-31T00:00:00.000Z'
  })
}

test('reading progress migrations are restart-safe and preserve existing rows', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        current_page INTEGER DEFAULT 0,
        cfi TEXT,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_id, user_id)
      );
      INSERT INTO reading_progress (book_id, user_id, current_page, progress) VALUES (8, 2, 11, 42.5);
    `)
    const first = migrate(database)
    const second = migrate(database)
    assert.deepEqual(first.executed.map(({ id }) => id), EBOOK_READING_PROGRESS_MIGRATIONS.map(({ id }) => id))
    assert.equal(second.executed.length, 0)
    assert.equal(second.skipped.length, 3)
    for (const migration of EBOOK_READING_PROGRESS_MIGRATIONS) {
      assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'satisfied')
    }
    assert.deepEqual(database.prepare('SELECT book_id, user_id, current_page, progress, revision, last_mutation_id, chapter_fraction FROM reading_progress').get(), {
      book_id: 8,
      user_id: 2,
      current_page: 11,
      progress: 42.5,
      revision: 0,
      last_mutation_id: null,
      chapter_fraction: null
    })
  } finally { database.close() }
})
