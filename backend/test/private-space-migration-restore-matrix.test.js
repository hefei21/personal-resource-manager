import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createDatabaseBackupSync,
  prepareIsolatedRestoreDirectory,
  restoreDatabaseBackup
} from '../src/config/databaseBackup.js'
import { createBackupSetManifest, verifyBackupSet } from '../src/config/backupSet.js'
import {
  applicationMigrationRegistry,
  CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL
} from '../src/config/databaseMigrations.js'
import {
  DOCUMENTS_STORAGE_TARGET_DDL,
  DOCUMENT_VERSIONS_STORAGE_TARGET_DDL
} from '../src/config/documentStorageSchema.js'
import { createResourceBackup, restoreResourceBackup } from '../src/config/resourceBackup.js'
import { createDocumentStorageRuntime } from '../src/services/documentStorageRuntime.js'
import { expandPrivateSpace, verifyPrivateSpace } from '../src/services/privateSpaceMigration.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/u.test(
    String(error?.message ?? '')
  )
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
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value)).digest('hex')
}

function deterministicRandomBytes() {
  return Buffer.alloc(16, 0xef)
}

function createTokenRandomBytes() {
  let counter = 0
  return () => {
    counter = (counter % 250) + 1
    return Buffer.alloc(16, counter)
  }
}

function strictDescendant(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function assertInside(rootPath, candidatePath) {
  assert.equal(strictDescendant(rootPath, candidatePath), true)
}

function assertDisjoint(leftPath, rightPath) {
  assert.equal(strictDescendant(leftPath, rightPath), false)
  assert.equal(strictDescendant(rightPath, leftPath), false)
  assert.notEqual(path.resolve(leftPath), path.resolve(rightPath))
}

function fileTreeSnapshot(rootPath) {
  const root = path.resolve(rootPath)
  const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name)
      const relative = path.relative(root, fullPath)
      if (entry.isDirectory()) {
        return [{ relative, type: 'directory' }, ...visit(fullPath)]
      }
      const stat = fs.lstatSync(fullPath)
      return [{
        relative,
        type: entry.isSymbolicLink() ? 'symlink' : 'file',
        bytes: stat.size,
        sha256: entry.isSymbolicLink() ? null : sha256(fs.readFileSync(fullPath))
      }]
    })
  return visit(root)
}

function databaseSnapshot(database) {
  return Buffer.from(database.serialize()).toString('base64')
}

function privateDocumentsSnapshot(database) {
  return {
    rows: database.prepare('SELECT * FROM private_documents ORDER BY id').all(),
    schema: database.pragma('table_xinfo(private_documents)')
  }
}

function readStreamText(stream) {
  return (async () => {
    const chunks = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  })()
}

function createSourceDatabase(databasePath, records) {
  const database = new Database(databasePath)
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
    ${DOCUMENTS_STORAGE_TARGET_DDL};
    ${DOCUMENT_VERSIONS_STORAGE_TARGET_DDL};
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
    CREATE TABLE demo_private_documents (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL
    );
    ${CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL};
  `)

  const insert = database.prepare(`
    INSERT INTO private_documents
      (id, title, file_path, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const record of records) {
    insert.run(
      record.id,
      record.title,
      record.filePath,
      Buffer.byteLength(record.content),
      record.createdAt,
      record.updatedAt
    )
  }
  database.prepare("INSERT INTO private_settings (id, password) VALUES (1, 'backup-only-password')").run()
  database.prepare("INSERT INTO demo_private_documents (id, title) VALUES (1, 'demo-only-record')").run()
  return database
}

function rebaseRestoredLegacyPaths(database, sourceLegacyRoot, restoredLegacyRoot) {
  const rows = database.prepare('SELECT id, file_path FROM private_documents ORDER BY id').all()
  const update = database.prepare('UPDATE private_documents SET file_path = ? WHERE id = ?')
  for (const row of rows) {
    const relative = path.relative(path.resolve(sourceLegacyRoot), path.resolve(row.file_path))
    assertInside(sourceLegacyRoot, row.file_path)
    const restoredPath = path.resolve(restoredLegacyRoot, relative)
    assertInside(restoredLegacyRoot, restoredPath)
    assert.equal(fs.statSync(restoredPath).isFile(), true)
    update.run(restoredPath, row.id)
  }
}

function restoreCopy({ root, backupDirectory, sourceLegacyRoot, label }) {
  const isolatedRoot = path.join(root, 'isolated')
  fs.mkdirSync(isolatedRoot, { recursive: true })
  const databaseTarget = path.join(isolatedRoot, `${label}-database`)
  const resourcesTarget = path.join(isolatedRoot, `${label}-resources`)
  const storageTarget = path.join(isolatedRoot, `${label}-storage`)
  const preparedDatabase = prepareIsolatedRestoreDirectory({
    targetDirectory: databaseTarget,
    randomBytes: deterministicRandomBytes,
    now: new Date('2026-08-14T00:00:00.000Z')
  })
  const restoredDb = restoreDatabaseBackup({
    backupDirectory,
    targetDirectory: preparedDatabase.targetDirectory,
    token: preparedDatabase.token
  })
  const restoredResources = restoreResourceBackup({
    backupDirectory,
    targetDirectory: resourcesTarget
  })
  const database = new Database(restoredDb.restoredFile)
  database.pragma('foreign_keys = ON')
  const legacyRoot = path.join(restoredResources.targetDirectory, 'legacy')
  rebaseRestoredLegacyPaths(database, sourceLegacyRoot, legacyRoot)
  const runtime = createDocumentStorageRuntime({
    storageRoot: storageTarget,
    legacyRoots: [legacyRoot],
    randomBytes: createTokenRandomBytes()
  })
  return Object.freeze({
    database,
    databaseRoot: preparedDatabase.targetDirectory,
    resourcesRoot: restoredResources.targetDirectory,
    legacyRoot,
    storageRoot: runtime.storageService.rootPath,
    runtime
  })
}

async function assertMigratedContent(copy, records) {
  const mappings = copy.database.prepare(`
    SELECT legacy_private_document_id, document_id, version_id, storage_key
    FROM private_document_migration_map
    ORDER BY legacy_private_document_id
  `).all()
  const documents = copy.database.prepare(`
    SELECT id, storage_key, content_sha256, content_bytes
    FROM documents
    ORDER BY id
  `).all()
  const versions = copy.database.prepare(`
    SELECT id, document_id, storage_key, content_sha256, content_bytes
    FROM document_versions
    ORDER BY id
  `).all()
  assert.equal(mappings.length, records.length)
  assert.equal(documents.length, records.length)
  assert.equal(versions.length, records.length)

  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const versionsById = new Map(versions.map((version) => [version.id, version]))
  const mappingsByLegacyId = new Map(mappings.map((mapping) => [mapping.legacy_private_document_id, mapping]))
  for (const record of records) {
    const mapping = mappingsByLegacyId.get(record.id)
    assert.equal(mapping.status, 'migrated')
    const document = documentsById.get(mapping.document_id)
    const version = versionsById.get(mapping.version_id)
    assert.ok(document)
    assert.ok(version)
    assert.equal(version.document_id, document.id)
    assert.equal(document.storage_key, mapping.storage_key)
    assert.equal(version.storage_key, mapping.storage_key)
    assert.equal(document.content_sha256, sha256(record.content))
    assert.equal(version.content_sha256, sha256(record.content))
    assert.equal(document.content_bytes, Buffer.byteLength(record.content))
    assert.equal(version.content_bytes, Buffer.byteLength(record.content))

    const documentContent = await readStreamText(
      await copy.runtime.storageService.createReadStream(document.storage_key)
    )
    const versionContent = await readStreamText(
      await copy.runtime.storageService.createReadStream(version.storage_key)
    )
    assert.equal(documentContent, record.content)
    assert.equal(versionContent, record.content)
  }
  return { mappings, documents, versions }
}

test('migrates private space only on a real 2.3 backup-set restore and keeps source/legacy copies unchanged', nativeTestOptions, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-private-restore-matrix-'))
  let sourceDatabase
  let healthyDatabase
  let faultDatabase
  try {
    const sourceRoot = path.join(root, 'source')
    const sourceDatabaseRoot = path.join(sourceRoot, 'database')
    const sourceLegacyRoot = path.join(sourceRoot, 'legacy')
    const backupRoot = path.join(root, 'backups')
    fs.mkdirSync(sourceDatabaseRoot, { recursive: true })
    fs.mkdirSync(sourceLegacyRoot, { recursive: true })

    const records = [
      {
        id: 1,
        title: 'Private Alpha',
        relativePath: path.join('alpha', 'same-one.txt'),
        content: 'duplicate-private-content',
        createdAt: '2026-08-14T01:02:03.000Z',
        updatedAt: '2026-08-14T01:02:04.000Z'
      },
      {
        id: 2,
        title: 'Private Beta',
        relativePath: path.join('beta', 'same-two.txt'),
        content: 'duplicate-private-content',
        createdAt: '2026-08-14T02:02:03.000Z',
        updatedAt: '2026-08-14T02:02:04.000Z'
      },
      {
        id: 3,
        title: 'Private Gamma',
        relativePath: path.join('gamma', 'unique.txt'),
        content: 'unique-private-content',
        createdAt: '2026-08-14T03:02:03.000Z',
        updatedAt: '2026-08-14T03:02:04.000Z'
      }
    ].map((record) => ({
      ...record,
      filePath: path.join(sourceLegacyRoot, record.relativePath)
    }))
    for (const record of records) {
      fs.mkdirSync(path.dirname(record.filePath), { recursive: true })
      fs.writeFileSync(record.filePath, record.content)
    }

    const sourceDatabasePath = path.join(sourceDatabaseRoot, 'app.db')
    sourceDatabase = createSourceDatabase(sourceDatabasePath, records)
    const sourceDatabaseBefore = databaseSnapshot(sourceDatabase)
    const sourceLegacyBefore = fileTreeSnapshot(sourceLegacyRoot)
    const databaseBackup = createDatabaseBackupSync({
      database: sourceDatabase,
      sourceDbPath: sourceDatabasePath,
      backupRoot,
      migrations: applicationMigrationRegistry.migrations.map(({ id, checksum }) => ({ id, checksum })),
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-14T04:05:06.000Z')
    })
    createResourceBackup({
      backupDirectory: databaseBackup.backupDirectory,
      entries: records.map((record) => ({
        kind: 'legacy',
        rootPath: sourceLegacyRoot,
        sourcePath: record.filePath
      }))
    })
    createBackupSetManifest({ backupDirectory: databaseBackup.backupDirectory })
    assert.equal(verifyBackupSet({ backupDirectory: databaseBackup.backupDirectory }).manifest.kind, 'backup-set')

    const healthy = restoreCopy({
      root,
      backupDirectory: databaseBackup.backupDirectory,
      sourceLegacyRoot,
      label: 'healthy'
    })
    healthyDatabase = healthy.database
    const healthyLegacyBefore = fileTreeSnapshot(healthy.legacyRoot)
    const healthyPrivateDocumentsBefore = privateDocumentsSnapshot(healthy.database)
    assertInside(root, healthy.databaseRoot)
    assertInside(root, healthy.legacyRoot)
    assertInside(root, healthy.storageRoot)
    assertDisjoint(healthy.databaseRoot, healthy.legacyRoot)
    assertDisjoint(healthy.databaseRoot, healthy.storageRoot)
    assertDisjoint(healthy.legacyRoot, healthy.storageRoot)

    const first = await expandPrivateSpace({ database: healthy.database, runtime: healthy.runtime })
    assert.equal(first.verified, true)
    assert.equal(first.stats.recordCount, 3)
    assert.equal(first.stats.migratedCount, 3)
    assert.equal(first.stats.skippedCount, 0)
    assert.equal(first.stats.failedCount, 0)
    assert.equal(first.stats.duplicateContentCount, 1)
    assert.equal(first.stats.uniqueObjectCount, 2)
    assert.deepEqual(first.records.map(({ status }) => status), ['migrated', 'migrated', 'migrated'])
    assert.equal(JSON.stringify(first).includes(root), false)
    for (const record of records) {
      assert.equal(JSON.stringify(first).includes(record.title), false)
      assert.equal(JSON.stringify(first).includes(path.basename(record.filePath)), false)
      assert.equal(JSON.stringify(first).includes(record.content), false)
    }
    assert.equal(JSON.stringify(first).includes('backup-only-password'), false)

    const migrated = await assertMigratedContent(healthy, records)
    assert.equal(new Set(migrated.documents.map(({ storage_key: storageKey }) => storageKey)).size, 2)
    assert.equal(healthy.database.prepare('SELECT COUNT(*) AS count FROM private_documents').get().count, 3)
    assert.equal(healthy.database.prepare('SELECT password FROM private_settings WHERE id = 1').get().password, 'backup-only-password')
    assert.equal(healthy.database.prepare('SELECT COUNT(*) AS count FROM demo_private_documents').get().count, 1)
    assert.equal(healthy.database.prepare("SELECT COUNT(*) AS count FROM documents WHERE title = 'demo-only-record'").get().count, 0)

    const verified = await verifyPrivateSpace({ database: healthy.database, runtime: healthy.runtime })
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

    const second = await expandPrivateSpace({ database: healthy.database, runtime: healthy.runtime })
    assert.equal(second.verified, true)
    assert.equal(second.stats.migratedCount, 0)
    assert.equal(second.stats.skippedCount, 3)
    assert.equal(second.stats.failedCount, 0)
    assert.deepEqual(second.records.map(({ status }) => status), ['skipped', 'skipped', 'skipped'])
    assert.equal(healthy.database.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 3)
    assert.equal(healthy.database.prepare('SELECT COUNT(*) AS count FROM document_versions').get().count, 3)
    assert.deepEqual(fileTreeSnapshot(healthy.legacyRoot), healthyLegacyBefore)
    assert.deepEqual(privateDocumentsSnapshot(healthy.database), healthyPrivateDocumentsBefore)

    const fault = restoreCopy({
      root,
      backupDirectory: databaseBackup.backupDirectory,
      sourceLegacyRoot,
      label: 'fault'
    })
    faultDatabase = fault.database
    const faultPrivateDocumentsBefore = privateDocumentsSnapshot(fault.database)
    const missingPath = path.join(fault.legacyRoot, records[2].relativePath)
    fs.rmSync(missingPath)
    const faultExpand = await expandPrivateSpace({ database: fault.database, runtime: fault.runtime })
    assert.equal(faultExpand.verified, false)
    assert.ok(faultExpand.issues.some(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_MISSING'))
    assert.equal(faultExpand.records.every(({ status }) => ['migrated', 'skipped', 'failed'].includes(status)), true)
    const faultVerify = await verifyPrivateSpace({ database: fault.database, runtime: fault.runtime })
    assert.equal(faultVerify.verified, false)
    assert.equal(faultVerify.checks.fileExistence, false)
    assert.ok(faultVerify.issues.some(({ code }) => code === 'PRIVATE_MIGRATION_SOURCE_MISSING'))
    assert.equal(fault.database.prepare('SELECT password FROM private_settings WHERE id = 1').get().password, 'backup-only-password')
    assert.deepEqual(privateDocumentsSnapshot(fault.database), faultPrivateDocumentsBefore)

    assert.deepEqual(databaseSnapshot(sourceDatabase), sourceDatabaseBefore)
    assert.deepEqual(fileTreeSnapshot(sourceLegacyRoot), sourceLegacyBefore)
    assert.equal(verifyBackupSet({ backupDirectory: databaseBackup.backupDirectory }).manifest.kind, 'backup-set')
  } finally {
    faultDatabase?.close()
    healthyDatabase?.close()
    sourceDatabase?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
