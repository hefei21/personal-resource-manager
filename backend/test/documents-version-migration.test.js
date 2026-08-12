import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import {
  ensureMigrationControlTables,
  getAppliedMigration,
  listMigrationAttempts
} from '../src/config/migrationControlStore.js'
import { executeMigrationBatch, MigrationExecutorError } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  const message = String(error?.message ?? '')
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(message)
}

let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

const ACTIVE_LOCK = Object.freeze({ state: 'active' })
const FIXED_NOW = '2026-08-11T00:00:00.000Z'
const documentsMigration = applicationMigrationRegistry.migrations.find(
  ({ id }) => id === '0036_documents_version_real'
)
assert.ok(documentsMigration, '0036_documents_version_real must be registered')

const LEGACY_DOCUMENTS_DDL = `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version INTEGER DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

const DOCUMENT_VERSIONS_DDL = `CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
)`

function openLegacyDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  database.exec(`${LEGACY_DOCUMENTS_DDL};${DOCUMENT_VERSIONS_DDL};`)
  database.prepare(`
    INSERT INTO documents
      (id, title, category, subcategory, tags, file_path, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(5, 'first', 'docs', 'notes', 'one,two', '/synthetic/first.md', 2, '2024-01-01 00:00:00', '2024-01-02 00:00:00')
  database.prepare(`
    INSERT INTO documents
      (id, title, category, subcategory, tags, file_path, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(6, 'second', null, null, null, '/synthetic/second.md', 1.5, '2024-02-01 00:00:00', '2024-02-02 00:00:00')
  database.prepare('INSERT INTO documents (id, title, file_path, version) VALUES (?, ?, ?, ?)')
    .run(9, 'nullable', '/synthetic/nullable.md', null)
  database.prepare('INSERT INTO documents (id, title, file_path, version) VALUES (?, ?, ?, ?)')
    .run(11, 'deleted', '/synthetic/deleted.md', 3)
  database.prepare('DELETE FROM documents WHERE id = ?').run(11)
  database.prepare(`
    INSERT INTO document_versions (id, document_id, version, file_path, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(7, 5, 1, '/synthetic/first-v1.md', 'initial', '2024-01-01 00:00:00')
  database.prepare(`
    INSERT INTO document_versions (id, document_id, version, file_path, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(8, 6, 1, '/synthetic/second-v1.md', null, '2024-02-01 00:00:00')
  return database
}

function executeDocumentsMigration(database) {
  const registry = createMigrationRegistry([documentsMigration])
  const plan = createMigrationPlan(registry, [])
  return executeMigrationBatch({
    database,
    registry,
    plan,
    lock: ACTIVE_LOCK,
    now: () => FIXED_NOW
  })
}

function expectFailedMigration(database, action, expectedMachineCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof MigrationExecutorError)
    assert.equal(error.code, 'MIGRATION_EXECUTION_FAILED')
    assert.equal(error.machineCode, expectedMachineCode)
    assert.doesNotMatch(error.message, /documents|version|synthetic|not-a-version/)
    return true
  })
  assert.equal(getAppliedMigration(database, documentsMigration.id), null)
  assert.deepEqual(listMigrationAttempts(database).map(({ status, errorCategory, errorSummary }) => ({
    status,
    errorCategory,
    errorSummary
  })), [{ status: 'failed', errorCategory: 'database', errorSummary: expectedMachineCode }])
}

test('rebuilds known INTEGER documents as REAL without losing rows, versions, IDs, timestamps, or sequence', nativeTestOptions, () => {
  const database = openLegacyDatabase()
  try {
    const beforeDocuments = database.prepare('SELECT * FROM documents ORDER BY id').all()
    const beforeVersions = database.prepare('SELECT * FROM document_versions ORDER BY id').all()
    assert.equal(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'documents'").get().seq, 11)

    const result = executeDocumentsMigration(database)

    assert.deepEqual(result.executed, [{ id: '0036_documents_version_real', status: 'applied' }])
    assert.equal(database.pragma('table_xinfo(documents)').find(({ name }) => name === 'version').type, 'REAL')
    assert.deepEqual(database.prepare('SELECT * FROM documents ORDER BY id').all(), beforeDocuments)
    assert.deepEqual(database.prepare('SELECT * FROM document_versions ORDER BY id').all(), beforeVersions)
    assert.deepEqual(
      database.prepare('SELECT id, typeof(version) AS storage_type FROM documents ORDER BY id').all(),
      [{ id: 5, storage_type: 'real' }, { id: 6, storage_type: 'real' }, { id: 9, storage_type: 'null' }]
    )
    assert.equal(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'documents'").get().seq, 11)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name LIKE 'prm_documents_v0036_%' OR name = 'documents_migration_0036'
    `).get().count, 0)
    assert.equal(getAppliedMigration(database, documentsMigration.id).checksum, documentsMigration.checksum)
    assert.deepEqual(listMigrationAttempts(database).map(({ status }) => ({ status })), [{ status: 'applied' }])
  } finally {
    database.close()
  }
})

test('rejects non-numeric version values and rolls back every migration artifact', nativeTestOptions, () => {
  const database = openLegacyDatabase()
  try {
    database.prepare("UPDATE documents SET version = 'not-a-version' WHERE id = 5").run()
    const beforeSql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'documents'").get().sql
    const beforeDocuments = database.prepare('SELECT * FROM documents ORDER BY id').all()
    const beforeVersions = database.prepare('SELECT * FROM document_versions ORDER BY id').all()

    expectFailedMigration(database, () => executeDocumentsMigration(database), 'SQLITE_CONSTRAINT')

    assert.equal(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'documents'").get().sql, beforeSql)
    assert.deepEqual(database.prepare('SELECT * FROM documents ORDER BY id').all(), beforeDocuments)
    assert.deepEqual(database.prepare('SELECT * FROM document_versions ORDER BY id').all(), beforeVersions)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'prm_documents_v0036_%'").get().count, 0)
  } finally {
    database.close()
  }
})

test('rejects unknown incoming document foreign keys before destructive statements', nativeTestOptions, () => {
  const database = openLegacyDatabase()
  try {
    database.exec(`
      CREATE TABLE document_links (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      INSERT INTO document_links (id, document_id) VALUES (1, 5);
    `)

    expectFailedMigration(database, () => executeDocumentsMigration(database), 'SQLITE_CONSTRAINT')

    assert.deepEqual(database.prepare('SELECT * FROM document_links').all(), [{ id: 1, document_id: 5 }])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 3)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count, 2)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})
