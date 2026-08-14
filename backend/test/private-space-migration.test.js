import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applicationMigrationRegistry,
  CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL,
  PRIVATE_DOCUMENT_MIGRATION_TABLE
} from '../src/config/databaseMigrations.js'
import { LegacyStorageAdapter } from '../src/services/legacyStorageAdapter.js'
import {
  expandPrivateSpace,
  verifyPrivateSpace
} from '../src/services/privateSpaceMigration.js'
import {
  createStorageKey,
  StorageService
} from '../src/services/storageService.js'

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

const TARGET_DOCUMENTS_SQL = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  category_id INTEGER,
  tags TEXT,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
)
`

const TARGET_VERSIONS_SQL = `
CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
)
`

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value)).digest('hex')
}

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-private-space-migration-'))
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

function createDatabase({ withMapping = true } = {}) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      path TEXT NOT NULL DEFAULT '',
      level INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    ${TARGET_DOCUMENTS_SQL};
    ${TARGET_VERSIONS_SQL};
    CREATE TABLE private_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE private_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE demo_private_documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    ${withMapping ? `${CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL};` : ''}
  `)
  return database
}

function createFixture(options = {}) {
  const root = temporaryRoot()
  const legacyRoot = path.join(root, 'legacy')
  const storageRoot = path.join(root, 'storage')
  fs.mkdirSync(legacyRoot)
  const database = createDatabase(options)
  let tokenCounter = 0
  const runtime = {
    storageService: new StorageService({
      rootPath: storageRoot,
      randomBytes: () => {
        tokenCounter = (tokenCounter % 250) + 1
        return Buffer.alloc(16, tokenCounter)
      }
    }),
    legacyStorageAdapter: new LegacyStorageAdapter({ roots: [legacyRoot] })
  }
  return { root, legacyRoot, database, runtime }
}

function closeFixture(fixture) {
  fixture.database.close()
  cleanup(fixture.root)
}

function insertLegacy(database, { id, title, filePath, size, createdAt = '2026-08-14T01:02:03.000Z', updatedAt = '2026-08-14T04:05:06.000Z' }) {
  database.prepare(`
    INSERT INTO private_documents (id, title, file_path, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, filePath, size, createdAt, updatedAt)
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
}

function issueCodes(report) {
  return report.issues.map(({ code }) => code)
}

function objectFiles(storageService) {
  let count = 0
  for (const kind of fs.readdirSync(storageService.objectsPath)) {
    const kindPath = path.join(storageService.objectsPath, kind)
    for (const prefix of fs.readdirSync(kindPath)) {
      const prefixPath = path.join(kindPath, prefix)
      count += fs.readdirSync(prefixPath).length
    }
  }
  return count
}

test('0051 expands only the migration map schema and preserves legacy rows/schema', nativeTestOptions, () => {
  const fixture = createFixture({ withMapping: false })
  try {
    insertLegacy(fixture.database, {
      id: 7,
      title: 'legacy-title',
      filePath: path.join(fixture.legacyRoot, 'old.txt'),
      size: 4
    })
    const beforeRows = fixture.database.prepare('SELECT * FROM private_documents').all()
    const beforeSchema = fixture.database.pragma('table_xinfo(private_documents)')
    const migration = applicationMigrationRegistry.migrations.find(
      ({ id }) => id === '0051_private_document_migration_map'
    )

    assert.ok(migration)
    assert.equal(migration.source, CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL)
    fixture.database.exec(migration.source)

    assert.equal(
      fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(PRIVATE_DOCUMENT_MIGRATION_TABLE).count,
      1
    )
    assert.deepEqual(fixture.database.prepare('SELECT * FROM private_documents').all(), beforeRows)
    assert.deepEqual(fixture.database.pragma('table_xinfo(private_documents)'), beforeSchema)
    assert.deepEqual(fixture.database.prepare('SELECT * FROM private_settings').all(), [])
  } finally {
    closeFixture(fixture)
  }
})

test('healthy expand is transactional, preserves legacy data, and is safely rerunnable', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const sourcePath = path.join(fixture.legacyRoot, 'nested', 'report.txt')
    fs.mkdirSync(path.dirname(sourcePath))
    const content = 'private-content'
    fs.writeFileSync(sourcePath, content)
    insertLegacy(fixture.database, {
      id: 1,
      title: 'Private title must be preserved',
      filePath: sourcePath,
      size: Buffer.byteLength(content)
    })
    fixture.database.prepare("INSERT INTO private_settings (id, password) VALUES (1, 'private-password')").run()
    fixture.database.prepare("INSERT INTO demo_private_documents (id, title) VALUES (1, 'demo-only')").run()

    const legacyRowBefore = fixture.database.prepare('SELECT * FROM private_documents WHERE id = 1').get()
    const legacySchemaBefore = fixture.database.pragma('table_xinfo(private_documents)')
    const fileBefore = fs.readFileSync(sourcePath)
    const fileStatBefore = fs.statSync(sourcePath)

    const first = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(first.verified, true)
    assert.equal(first.stats.recordCount, 1)
    assert.equal(first.stats.migratedCount, 1)
    assert.equal(first.stats.skippedCount, 0)
    assert.equal(first.stats.failedCount, 0)
    assert.equal(first.stats.sourceBytes, content.length)
    assert.equal(first.stats.targetBytes, content.length)
    assert.equal(first.stats.uniqueContentCount, 1)
    assert.equal(first.stats.duplicateContentCount, 0)
    assert.deepEqual(first.records.map(({ status }) => status), ['migrated'])
    assert.equal(count(fixture.database, 'documents'), 1)
    assert.equal(count(fixture.database, 'document_versions'), 1)
    assert.equal(count(fixture.database, 'demo_private_documents'), 1)
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM documents WHERE title = 'demo-only'").get().count, 0)

    const document = fixture.database.prepare('SELECT * FROM documents').get()
    const version = fixture.database.prepare('SELECT * FROM document_versions').get()
    const mapping = fixture.database.prepare(`SELECT * FROM ${PRIVATE_DOCUMENT_MIGRATION_TABLE}`).get()
    assert.equal(document.title, 'Private title must be preserved')
    assert.equal(document.file_path, null)
    assert.equal(document.category, null)
    assert.equal(document.category_id, null)
    assert.equal(document.original_name, 'report.txt')
    assert.equal(document.storage_key, mapping.storage_key)
    assert.equal(document.content_sha256, sha256(content))
    assert.equal(document.content_bytes, Buffer.byteLength(content))
    assert.equal(version.document_id, document.id)
    assert.equal(version.file_path, null)
    assert.equal(version.storage_key, mapping.storage_key)
    assert.equal(version.content_sha256, sha256(content))
    assert.equal(version.content_bytes, Buffer.byteLength(content))
    assert.equal(mapping.status, 'migrated')
    assert.equal(mapping.document_id, document.id)
    assert.equal(mapping.version_id, version.id)

    const second = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(second.verified, true)
    assert.equal(second.stats.migratedCount, 0)
    assert.equal(second.stats.skippedCount, 1)
    assert.equal(second.stats.failedCount, 0)
    assert.deepEqual(second.records.map(({ status, disposition }) => ({ status, disposition })), [
      { status: 'skipped', disposition: 'verified-existing' }
    ])
    assert.equal(count(fixture.database, 'documents'), 1)
    assert.equal(count(fixture.database, 'document_versions'), 1)
    assert.deepEqual(fixture.database.prepare('SELECT * FROM private_documents WHERE id = 1').get(), legacyRowBefore)
    assert.deepEqual(fixture.database.pragma('table_xinfo(private_documents)'), legacySchemaBefore)
    assert.deepEqual(fs.readFileSync(sourcePath), fileBefore)
    const fileStatAfter = fs.statSync(sourcePath)
    assert.equal(fileStatAfter.size, fileStatBefore.size)
    assert.equal(fileStatAfter.mtimeMs, fileStatBefore.mtimeMs)

    const verified = await verifyPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(verified.verified, true)
    assert.deepEqual(verified.checks, {
      oldRecordCount: true,
      mappingCount: true,
      sourceTotalBytes: true,
      fileExistence: true,
      sourceHashes: true,
      targetStorage: true,
      duplicateContent: true,
      bounds: true
    })
  } finally {
    closeFixture(fixture)
  }
})

test('duplicate source content creates independent documents and reuses one storage object', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const firstPath = path.join(fixture.legacyRoot, 'first.bin')
    const secondPath = path.join(fixture.legacyRoot, 'second.bin')
    const content = 'duplicate-content'
    fs.writeFileSync(firstPath, content)
    fs.writeFileSync(secondPath, content)
    insertLegacy(fixture.database, { id: 1, title: 'first', filePath: firstPath, size: content.length })
    insertLegacy(fixture.database, { id: 2, title: 'second', filePath: secondPath, size: content.length })

    const report = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(report.verified, true)
    assert.equal(report.stats.migratedCount, 2)
    assert.equal(report.stats.duplicateContentCount, 1)
    assert.equal(report.stats.duplicateContentGroups, 1)
    assert.equal(report.stats.uniqueContentCount, 1)
    assert.equal(report.stats.uniqueObjectCount, 1)
    assert.equal(report.stats.reusedObjectCount, 1)
    assert.equal(count(fixture.database, 'documents'), 2)
    assert.equal(count(fixture.database, 'document_versions'), 2)
    assert.equal(objectFiles(fixture.runtime.storageService), 1)
    assert.notEqual(
      fixture.database.prepare('SELECT document_id FROM private_document_migration_map WHERE legacy_private_document_id = 1').get().document_id,
      fixture.database.prepare('SELECT document_id FROM private_document_migration_map WHERE legacy_private_document_id = 2').get().document_id
    )
  } finally {
    closeFixture(fixture)
  }
})

for (const [name, buildCase] of [
  ['missing source', ({ fixture }) => ({
    filePath: path.join(fixture.legacyRoot, 'missing.txt'),
    size: 4,
    code: 'PRIVATE_MIGRATION_SOURCE_MISSING'
  })],
  ['outside-root source', ({ fixture }) => {
    const filePath = path.join(fixture.root, 'outside.txt')
    fs.writeFileSync(filePath, 'outside')
    return { filePath, size: 7, code: 'PRIVATE_MIGRATION_SOURCE_OUTSIDE_ROOT' }
  }],
  ['directory source', ({ fixture }) => {
    const filePath = path.join(fixture.legacyRoot, 'directory')
    fs.mkdirSync(filePath)
    return { filePath, size: 0, code: 'PRIVATE_MIGRATION_SOURCE_NOT_REGULAR_FILE' }
  }],
  ['recorded size mismatch', ({ fixture }) => {
    const filePath = path.join(fixture.legacyRoot, 'size.txt')
    fs.writeFileSync(filePath, 'actual')
    return { filePath, size: 99, code: 'PRIVATE_MIGRATION_SOURCE_SIZE_MISMATCH' }
  }]
]) {
  test(`rejects ${name} with a stable issue code`, nativeTestOptions, async () => {
    const fixture = createFixture()
    try {
      const current = buildCase({ fixture })
      insertLegacy(fixture.database, { id: 1, title: name, filePath: current.filePath, size: current.size })
      const report = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
      assert.equal(report.verified, false)
      assert.equal(report.stats.failedCount, 1)
      assert.ok(issueCodes(report).includes(current.code))
      assert.ok(report.issues.every(({ severity, disposition }) => severity === 'error' && disposition === 'blocked'))
      assert.equal(count(fixture.database, 'documents'), 0)
      assert.equal(count(fixture.database, 'document_versions'), 0)
    } finally {
      closeFixture(fixture)
    }
  })
}

test('rejects a symlink source when the platform permits symlink fixtures', nativeTestOptions, async (context) => {
  if (process.platform === 'win32') {
    context.skip('symlink branch is covered by Linux CI on Windows hosts without link privileges')
    return
  }
  const fixture = createFixture()
  try {
    const outsidePath = path.join(fixture.root, 'outside.txt')
    const linkPath = path.join(fixture.legacyRoot, 'link.txt')
    fs.writeFileSync(outsidePath, 'secret')
    fs.symlinkSync(outsidePath, linkPath)
    insertLegacy(fixture.database, { id: 1, title: 'symlink', filePath: linkPath, size: 6 })

    const report = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(report.verified, false)
    assert.ok(issueCodes(report).includes('PRIVATE_MIGRATION_SOURCE_SYMLINK'))
    assert.equal(count(fixture.database, 'documents'), 0)
  } finally {
    closeFixture(fixture)
  }
})

test('verify detects source hash drift and target object corruption', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const sourcePath = path.join(fixture.legacyRoot, 'hash.txt')
    fs.writeFileSync(sourcePath, 'before')
    insertLegacy(fixture.database, { id: 1, title: 'hash', filePath: sourcePath, size: 6 })
    const expanded = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(expanded.verified, true)

    fs.writeFileSync(sourcePath, 'after!')
    const sourceDrift = await verifyPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(sourceDrift.verified, false)
    assert.ok(issueCodes(sourceDrift).includes('PRIVATE_MIGRATION_SOURCE_HASH_MISMATCH'))

    fs.writeFileSync(sourcePath, 'before')
    const mapping = fixture.database.prepare('SELECT storage_key FROM private_document_migration_map WHERE legacy_private_document_id = 1').get()
    fs.writeFileSync(fixture.runtime.storageService.objectFile(mapping.storage_key), 'tampered')
    const targetCorruption = await verifyPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(targetCorruption.verified, false)
    assert.ok(issueCodes(targetCorruption).includes('PRIVATE_MIGRATION_TARGET_HASH_MISMATCH'))
  } finally {
    closeFixture(fixture)
  }
})

test('existing mapping conflicts fail without creating duplicate ordinary resources', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const sourcePath = path.join(fixture.legacyRoot, 'conflict.txt')
    fs.writeFileSync(sourcePath, 'conflict')
    insertLegacy(fixture.database, { id: 1, title: 'original', filePath: sourcePath, size: 7 })
    const initial = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(initial.verified, true)
    fixture.database.prepare('UPDATE documents SET title = ? WHERE id = 1').run('changed')

    const report = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    assert.equal(report.verified, false)
    assert.equal(report.stats.failedCount, 1)
    assert.ok(issueCodes(report).includes('PRIVATE_MIGRATION_TARGET_METADATA_MISMATCH'))
    assert.equal(count(fixture.database, 'documents'), 1)
    assert.equal(count(fixture.database, 'document_versions'), 1)
  } finally {
    closeFixture(fixture)
  }
})

test('database write failure leaves the object and rerun reuses it', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const content = 'retry-content'
    const sourcePath = path.join(fixture.legacyRoot, 'retry.txt')
    fs.writeFileSync(sourcePath, content)
    insertLegacy(fixture.database, { id: 1, title: 'retry', filePath: sourcePath, size: content.length })
    let failOnce = true
    const failingDatabase = {
      prepare: (...args) => fixture.database.prepare(...args),
      transaction: (callback) => {
        if (failOnce) {
          failOnce = false
          return () => { throw new Error('synthetic database write failure') }
        }
        return fixture.database.transaction(callback)
      }
    }

    const first = await expandPrivateSpace({ database: failingDatabase, runtime: fixture.runtime })
    assert.equal(first.verified, false)
    assert.ok(issueCodes(first).includes('PRIVATE_MIGRATION_DATABASE_WRITE_FAILED'))
    assert.equal(count(fixture.database, 'documents'), 0)
    assert.equal(count(fixture.database, 'document_versions'), 0)
    assert.equal(objectFiles(fixture.runtime.storageService), 1)
    assert.equal(fixture.database.prepare('SELECT status FROM private_document_migration_map WHERE legacy_private_document_id = 1').get().status, 'failed')

    const second = await expandPrivateSpace({ database: failingDatabase, runtime: fixture.runtime })
    assert.equal(second.verified, true)
    assert.equal(second.stats.migratedCount, 1)
    assert.equal(second.stats.reusedObjectCount, 1)
    assert.equal(count(fixture.database, 'documents'), 1)
    assert.equal(count(fixture.database, 'document_versions'), 1)
    assert.equal(objectFiles(fixture.runtime.storageService), 1)
  } finally {
    closeFixture(fixture)
  }
})

test('migration reports contain only sanitized IDs, statistics, booleans, and stable issue codes', nativeTestOptions, async () => {
  const fixture = createFixture()
  try {
    const title = 'SECRET_TITLE_SHOULD_NOT_APPEAR'
    const fileName = 'secret-original-name.txt'
    const content = 'PRIVATE_CONTENT_SHOULD_NOT_APPEAR'
    const sourcePath = path.join(fixture.legacyRoot, fileName)
    fs.writeFileSync(sourcePath, content)
    insertLegacy(fixture.database, { id: 1, title, filePath: sourcePath, size: Buffer.byteLength(content) })
    fixture.database.prepare("INSERT INTO private_settings (id, password) VALUES (1, 'SECRET_PASSWORD')").run()

    const report = await expandPrivateSpace({ database: fixture.database, runtime: fixture.runtime })
    const serialized = JSON.stringify(report)
    assert.doesNotMatch(serialized, new RegExp(title, 'u'))
    assert.doesNotMatch(serialized, new RegExp(fileName, 'u'))
    assert.doesNotMatch(serialized, new RegExp(content, 'u'))
    assert.doesNotMatch(serialized, /SECRET_PASSWORD/u)
    assert.deepEqual(Object.keys(report).sort(), ['checks', 'issues', 'operation', 'records', 'stats', 'verified'])
    assert.equal(report.records[0].legacyDocumentId, 1)
    assert.equal(report.records[0].status, 'migrated')
    assert.equal(typeof report.records[0].objectId, 'string')
  } finally {
    closeFixture(fixture)
  }
})
