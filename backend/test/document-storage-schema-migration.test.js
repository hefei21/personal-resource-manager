import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables, listMigrationAttempts } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
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
const migrations = applicationMigrationRegistry.migrations.filter(({ id }) => id === '0048_document_versions_storage_shape' || id === '0049_documents_storage_shape')

function createLegacyDatabase(layout) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    INSERT INTO categories (id, name) VALUES (7, '资料');
  `)
  database.exec(`
      CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
      CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      ALTER TABLE documents ADD COLUMN category_id INTEGER;
      ALTER TABLE documents ADD COLUMN storage_key TEXT;
      ALTER TABLE documents ADD COLUMN content_sha256 TEXT;
      ALTER TABLE documents ADD COLUMN content_bytes INTEGER;
      ALTER TABLE documents ADD COLUMN original_name TEXT;
      ALTER TABLE document_versions ADD COLUMN storage_key TEXT;
      ALTER TABLE document_versions ADD COLUMN content_sha256 TEXT;
      ALTER TABLE document_versions ADD COLUMN content_bytes INTEGER;
    `)
  database.prepare(`INSERT INTO documents
    (id, title, category, subcategory, category_id, tags, file_path, version, created_at, updated_at)
    VALUES (11, '旧文档', '资料', '', 7, 'a,b', '/legacy/doc.txt', 2.5, '2026-01-01', '2026-02-01')`).run()
  database.prepare(`INSERT INTO document_versions
    (id, document_id, version, file_path, note, created_at)
    VALUES (13, 11, 2, '/legacy/doc-v2.txt', '旧版本', '2026-01-15')`).run()
  ensureMigrationControlTables(database)
  return database
}

for (const layout of ['appended']) {
  test(`migrates ${layout} document storage tables without losing rows or identities`, nativeTestOptions, () => {
    const database = createLegacyDatabase(layout)
    try {
      const registry = createMigrationRegistry(migrations)
      let summary
      try {
        summary = executeMigrationBatch({
          database,
          registry,
          plan: createMigrationPlan(registry, []),
          lock: { state: 'active' },
          now: () => '2026-08-13T00:00:00.000Z'
        })
      } catch (error) {
        assert.fail(JSON.stringify({
          code: error?.code,
          machineCode: error?.machineCode,
          attempts: listMigrationAttempts(database)
        }))
      }
      assert.equal(summary.executedCount, 2)
      assert.deepEqual(database.prepare('SELECT * FROM documents WHERE id = 11').get(), {
        id: 11, title: '旧文档', category: '资料', subcategory: '', category_id: 7,
        tags: 'a,b', file_path: '/legacy/doc.txt', storage_key: null, content_sha256: null,
        content_bytes: null, original_name: null, version: 2.5,
        created_at: '2026-01-01', updated_at: '2026-02-01'
      })
      assert.equal(database.prepare('SELECT note FROM document_versions WHERE id = 13').get().note, '旧版本')
      assert.deepEqual(database.pragma('foreign_key_check'), [])
      assert.equal(database.pragma('table_xinfo(documents)').find(({ name }) => name === 'file_path').notnull, 0)
      assert.equal(database.pragma('table_xinfo(document_versions)').find(({ name }) => name === 'file_path').notnull, 0)
      database.prepare(`INSERT INTO documents
        (title, category_id, file_path, storage_key, content_sha256, content_bytes)
        VALUES ('新文档', 7, NULL, ?, ?, 9)`).run('documents/aa/' + 'a'.repeat(64), 'a'.repeat(64))
      database.prepare(`INSERT INTO document_versions
        (document_id, version, file_path, storage_key, content_sha256, content_bytes)
        VALUES (last_insert_rowid(), 1, NULL, ?, ?, 9)`).run('documents/aa/' + 'a'.repeat(64), 'a'.repeat(64))
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })
}
