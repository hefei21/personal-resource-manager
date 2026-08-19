import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createDatabaseBackupSync,
  prepareIsolatedRestoreDirectory,
  restoreDatabaseBackup
} from '../src/config/databaseBackup.js'
import { createResourceBackup, restoreResourceBackup } from '../src/config/resourceBackup.js'
import { createBackupSetManifest, verifyBackupSet } from '../src/config/backupSet.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(
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

function deterministicRandomBytes() { return Buffer.alloc(16, 0xef) }

test('restores a database, representative document, and immutable version into isolated directories', nativeTestOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-backup-set-'))
  let sourceDatabase
  let restoredDatabase
  try {
    const sourceDirectory = path.join(root, 'source')
    const documentsRoot = path.join(sourceDirectory, 'documents')
    const versionsRoot = path.join(sourceDirectory, 'versions')
    const databaseDirectory = path.join(sourceDirectory, 'database')
    fs.mkdirSync(documentsRoot, { recursive: true })
    fs.mkdirSync(versionsRoot, { recursive: true })
    fs.mkdirSync(databaseDirectory, { recursive: true })

    const documentFile = path.join(documentsRoot, 'document.txt')
    const versionFile = path.join(versionsRoot, 'document-v1.txt')
    fs.writeFileSync(documentFile, 'current document')
    fs.writeFileSync(versionFile, 'immutable version one')

    const databasePath = path.join(databaseDirectory, 'app.db')
    sourceDatabase = new Database(databasePath)
    sourceDatabase.pragma('journal_mode = WAL')
    sourceDatabase.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL
      );
      CREATE TABLE document_versions (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL,
        version REAL NOT NULL,
        file_path TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id)
      );
    `)
    sourceDatabase.prepare('INSERT INTO documents VALUES (?, ?, ?)').run(7, 'Restore proof', documentFile)
    sourceDatabase.prepare('INSERT INTO document_versions VALUES (?, ?, ?, ?)').run(11, 7, 1, versionFile)

    const backupRoot = path.join(root, 'backups')
    const databaseBackup = createDatabaseBackupSync({
      database: sourceDatabase,
      sourceDbPath: databasePath,
      backupRoot,
      migrations: [{ id: '0038_reading_progress_owner_rebuild', checksum: 'a'.repeat(64) }],
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-12T03:04:05.006Z')
    })
    createResourceBackup({
      backupDirectory: databaseBackup.backupDirectory,
      entries: [
        { kind: 'documents', rootPath: documentsRoot, sourcePath: documentFile },
        { kind: 'versions', rootPath: versionsRoot, sourcePath: versionFile }
      ]
    })
    createBackupSetManifest({ backupDirectory: databaseBackup.backupDirectory })
    assert.equal(verifyBackupSet({ backupDirectory: databaseBackup.backupDirectory }).manifest.kind, 'backup-set')

    const preparedDatabase = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restored-database'),
      randomBytes: deterministicRandomBytes
    })
    const restoredDb = restoreDatabaseBackup({
      backupDirectory: databaseBackup.backupDirectory,
      targetDirectory: preparedDatabase.targetDirectory,
      token: preparedDatabase.token
    })
    const resources = restoreResourceBackup({
      backupDirectory: databaseBackup.backupDirectory,
      targetDirectory: path.join(root, 'restored-resources')
    })

    restoredDatabase = new Database(restoredDb.restoredFile, { readonly: true })
    assert.deepEqual(restoredDatabase.prepare('SELECT id, title FROM documents').get(), {
      id: 7,
      title: 'Restore proof'
    })
    assert.deepEqual(restoredDatabase.prepare('SELECT id, document_id, version FROM document_versions').get(), {
      id: 11,
      document_id: 7,
      version: 1
    })
    assert.equal(restoredDatabase.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(
      fs.readFileSync(path.join(resources.targetDirectory, 'documents', 'document.txt'), 'utf8'),
      'current document'
    )
    assert.equal(
      fs.readFileSync(path.join(resources.targetDirectory, 'versions', 'document-v1.txt'), 'utf8'),
      'immutable version one'
    )
    assert.deepEqual(restoredDb.manifest.migrations, [
      { id: '0038_reading_progress_owner_rebuild', checksum: 'a'.repeat(64) }
    ])
  } finally {
    restoredDatabase?.close()
    sourceDatabase?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
