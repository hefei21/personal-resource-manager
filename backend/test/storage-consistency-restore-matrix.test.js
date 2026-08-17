import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBackupSetManifest, verifyBackupSet } from '../src/config/backupSet.js'
import {
  createDatabaseBackupSync,
  prepareIsolatedRestoreDirectory,
  restoreDatabaseBackup
} from '../src/config/databaseBackup.js'
import { createResourceBackup, restoreResourceBackup } from '../src/config/resourceBackup.js'
import { StorageConsistencyService } from '../src/services/storageConsistencyService.js'
import { createStorageKey, StorageService } from '../src/services/storageService.js'
import {
  CONSISTENCY_FIXTURE_MARKER,
  injectConsistencyFaultMatrix,
  prepareConsistencyFaultRoot
} from './fixtures/storage-consistency-faults.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(String(error?.message ?? ''))
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

function sha256(value) { return createHash('sha256').update(Buffer.from(value)).digest('hex') }
function deterministicRandomBytes() { return Buffer.alloc(16, 0xcd) }

function writeObject(service, content, kind = 'documents') {
  const hash = sha256(content)
  const storageKey = createStorageKey(kind, hash)
  const filePath = service.objectFile(storageKey, { createParents: true })
  fs.writeFileSync(filePath, content)
  return { storageKey, hash, bytes: Buffer.byteLength(content), filePath }
}

function storageSnapshot(directory) {
  const visit = current => fs.readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const full = path.join(current, entry.name)
      const relative = path.relative(directory, full)
      if (entry.isDirectory()) return [{ relative, type: 'directory' }, ...visit(full)]
      const stat = fs.lstatSync(full)
      return [{ relative, type: entry.isSymbolicLink() ? 'symlink' : 'file', bytes: stat.size,
        hash: entry.isSymbolicLink() ? null : sha256(fs.readFileSync(full)) }]
    })
  return visit(directory)
}

test('restores a 2.3 backup set, injects the isolated fault matrix, and reports every expected code read-only', nativeTestOptions, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-storage-consistency-'))
  let sourceDatabase
  let restoredDatabase
  try {
    const fixtureToken = '1'.repeat(32)
    prepareConsistencyFaultRoot({ rootPath: root, token: fixtureToken })
    const sourceRoot = path.join(root, 'source')
    const sourceDatabaseRoot = path.join(sourceRoot, 'database')
    const sourceStorageRoot = path.join(sourceRoot, 'storage')
    fs.mkdirSync(sourceDatabaseRoot, { recursive: true })
    fs.mkdirSync(sourceStorageRoot, { recursive: true })
    const sourceStorage = new StorageService({ rootPath: sourceStorageRoot })
    const healthy = writeObject(sourceStorage, 'healthy restored content')
    const corruptTarget = writeObject(sourceStorage, 'corruption target')
    const healthyEbook = writeObject(sourceStorage, 'healthy restored ebook', 'ebooks')
    const healthyMusic = writeObject(sourceStorage, 'healthy restored music', 'music')

    const sourceDatabasePath = path.join(sourceDatabaseRoot, 'app.db')
    sourceDatabase = new Database(sourceDatabasePath)
    sourceDatabase.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        file_path TEXT,
        storage_key TEXT,
        content_sha256 TEXT,
        content_bytes INTEGER
      );
      CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL,
        file_path TEXT,
        storage_key TEXT,
        content_sha256 TEXT,
        content_bytes INTEGER
      );
      CREATE TABLE storage_commit_operations (
        staging_token TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
      CREATE TABLE books (
        id INTEGER PRIMARY KEY,
        storage_key TEXT,
        content_sha256 TEXT,
        content_bytes INTEGER
      );
      CREATE TABLE music (
        id INTEGER PRIMARY KEY,
        storage_key TEXT,
        content_sha256 TEXT,
        content_bytes INTEGER
      );
    `)
    const insertDocument = sourceDatabase.prepare(`
      INSERT INTO documents (id, title, file_path, storage_key, content_sha256, content_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    insertDocument.run(1, 'healthy', null, healthy.storageKey, healthy.hash, healthy.bytes)
    insertDocument.run(2, 'legacy', '/legacy/private-name.txt', null, null, null)
    sourceDatabase.prepare(`
      INSERT INTO document_versions (id, document_id, file_path, storage_key, content_sha256, content_bytes)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run(1, 1, healthy.storageKey, healthy.hash, healthy.bytes)
    sourceDatabase.prepare(`
      INSERT INTO document_versions (id, document_id, file_path, storage_key, content_sha256, content_bytes)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run(2, 1, corruptTarget.storageKey, corruptTarget.hash, corruptTarget.bytes)
    sourceDatabase.prepare(`
      INSERT INTO books (id, storage_key, content_sha256, content_bytes) VALUES (?, ?, ?, ?)
    `).run(1, healthyEbook.storageKey, healthyEbook.hash, healthyEbook.bytes)
    sourceDatabase.prepare(`
      INSERT INTO music (id, storage_key, content_sha256, content_bytes) VALUES (?, ?, ?, ?)
    `).run(1, healthyMusic.storageKey, healthyMusic.hash, healthyMusic.bytes)

    const backupRoot = path.join(root, 'backups')
    const databaseBackup = createDatabaseBackupSync({
      database: sourceDatabase,
      sourceDbPath: sourceDatabasePath,
      backupRoot,
      migrations: [{ id: '0050_resource_trash', checksum: 'a'.repeat(64) }],
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-14T00:00:00.000Z')
    })
    createResourceBackup({
      backupDirectory: databaseBackup.backupDirectory,
      entries: [healthy, corruptTarget, healthyEbook, healthyMusic].map(value => ({
        kind: 'storage', rootPath: sourceStorage.rootPath, sourcePath: value.filePath
      }))
    })
    createBackupSetManifest({ backupDirectory: databaseBackup.backupDirectory })
    assert.equal(verifyBackupSet({ backupDirectory: databaseBackup.backupDirectory }).manifest.kind, 'backup-set')

    const preparedDatabase = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restored-database'),
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-14T00:00:00.000Z')
    })
    const restoredDb = restoreDatabaseBackup({
      backupDirectory: databaseBackup.backupDirectory,
      targetDirectory: preparedDatabase.targetDirectory,
      token: preparedDatabase.token
    })
    const restoredResources = restoreResourceBackup({
      backupDirectory: databaseBackup.backupDirectory,
      targetDirectory: path.join(root, 'restored-resources')
    })
    const restoredStorage = new StorageService({
      rootPath: path.join(restoredResources.targetDirectory, 'storage')
    })
    restoredDatabase = new Database(restoredDb.restoredFile)
    const injection = injectConsistencyFaultMatrix({
      rootPath: root,
      token: fixtureToken,
      databaseRoot: preparedDatabase.targetDirectory,
      restoreToken: preparedDatabase.token,
      database: restoredDatabase,
      storageService: restoredStorage,
      now: new Date('2026-08-14T00:00:00.000Z')
    })
    assert.equal(path.relative(root, injection.databaseRoot).startsWith('..'), false)
    assert.equal(path.relative(root, injection.storageRoot).startsWith('..'), false)

    const beforeStorage = storageSnapshot(restoredStorage.rootPath)
    const beforeDatabase = restoredDatabase.serialize()
    const report = await new StorageConsistencyService({
      database: restoredDatabase,
      storageService: restoredStorage,
      now: new Date('2026-08-14T00:00:00.000Z'),
      stagingMaxAgeMs: 24 * 60 * 60 * 1000
    }).inspect()
    const actualCodes = [...new Set(report.issues.map(issue => issue.code))].sort()
    assert.deepEqual(actualCodes, [...injection.expectedCodes].sort())
    assert.deepEqual(storageSnapshot(restoredStorage.rootPath), beforeStorage)
    assert.deepEqual(restoredDatabase.serialize(), beforeDatabase)
    assert.equal(JSON.stringify(report).includes(root), false)
    assert.equal(JSON.stringify(report).includes('private-name.txt'), false)
    assert.equal(report.issues.some(issue => issue.code === 'ORPHAN_OBJECT' &&
      ['ebooks', 'music'].includes(issue.resourceType)), false)
  } finally {
    restoredDatabase?.close()
    sourceDatabase?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fault injector rejects unmarked roots and mismatched restore markers before mutation', nativeTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-storage-consistency-'))
  let database
  try {
    const databaseRoot = path.join(root, 'database')
    const storageRoot = path.join(root, 'storage')
    fs.mkdirSync(databaseRoot)
    fs.writeFileSync(path.join(databaseRoot, '.prm-isolated-restore.json'), JSON.stringify({
      formatVersion: 1, token: '2'.repeat(32)
    }))
    database = new Database(path.join(databaseRoot, 'fixture.db'))
    database.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER);
      CREATE TABLE document_versions (id INTEGER PRIMARY KEY, document_id INTEGER, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER);
      CREATE TABLE storage_commit_operations (staging_token TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE books (id INTEGER PRIMARY KEY, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER);
      CREATE TABLE music (id INTEGER PRIMARY KEY, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER);
    `)
    const storageService = new StorageService({ rootPath: storageRoot })
    assert.throws(() => injectConsistencyFaultMatrix({
      rootPath: root,
      token: '1'.repeat(32),
      databaseRoot,
      restoreToken: '2'.repeat(32),
      database,
      storageService,
      now: new Date('2026-08-14T00:00:00.000Z')
    }), { code: 'CONSISTENCY_FIXTURE_MARKER_INVALID' })

    fs.writeFileSync(path.join(root, CONSISTENCY_FIXTURE_MARKER), JSON.stringify({
      formatVersion: 1,
      kind: 'storage-consistency-fixture',
      token: '1'.repeat(32)
    }))
    const beforeStorage = storageSnapshot(storageRoot)
    const beforeDatabase = database.serialize()
    assert.throws(() => injectConsistencyFaultMatrix({
      rootPath: root,
      token: '1'.repeat(32),
      databaseRoot,
      restoreToken: '3'.repeat(32),
      database,
      storageService,
      now: new Date('2026-08-14T00:00:00.000Z')
    }), { code: 'CONSISTENCY_RESTORE_MARKER_INVALID' })
    assert.deepEqual(storageSnapshot(storageRoot), beforeStorage)
    assert.deepEqual(database.serialize(), beforeDatabase)
  } finally {
    database?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
