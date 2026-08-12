import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DATABASE_BACKUP_FILE,
  DATABASE_BACKUP_MANIFEST_FILE,
  RESTORE_MARKER_FILE,
  createDatabaseBackup,
  createDatabaseBackupSync,
  prepareIsolatedRestoreDirectory,
  restoreDatabaseBackup
} from '../src/config/databaseBackup.js'

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

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-database-backup-'))
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

function deterministicRandomBytes() {
  return Buffer.alloc(16, 0xab)
}

const migrationSnapshot = [
  { id: '0002_second', checksum: 'b'.repeat(64), source: 'must not leak' },
  { id: '0001_first', checksum: 'a'.repeat(64), compatibility: { secret: true } }
]

function createSourceDatabase(root) {
  const sourceDbPath = path.join(root, 'source', 'app.db')
  fs.mkdirSync(path.dirname(sourceDbPath))
  const database = new Database(sourceDbPath)
  database.pragma('journal_mode = WAL')
  database.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL
    );
    INSERT INTO notes (body) VALUES ('alpha'), ('beta');
  `)
  return { database, sourceDbPath }
}

test('restore preparation refuses an existing directory without deleting its contents', () => {
  const root = makeRoot()
  try {
    const targetDirectory = path.join(root, 'existing')
    fs.mkdirSync(targetDirectory)
    const sentinel = path.join(targetDirectory, 'keep.txt')
    fs.writeFileSync(sentinel, 'keep')

    assert.throws(
      () => prepareIsolatedRestoreDirectory({ targetDirectory }),
      { code: 'DATABASE_RESTORE_TARGET_NOT_EMPTY' }
    )
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep')
  } finally {
    cleanup(root)
  }
})

test('restore preparation creates an opaque marker in a new directory', () => {
  const root = makeRoot()
  try {
    const targetDirectory = path.join(root, 'restore')
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory,
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-12T00:00:00.000Z')
    })
    assert.equal(prepared.token, 'abababababababababababababababab')
    assert.deepEqual(fs.readdirSync(targetDirectory), [RESTORE_MARKER_FILE])
  } finally {
    cleanup(root)
  }
})

test('creates and restores a consistent WAL database with a verified manifest', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  let restored
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const backupRoot = path.join(root, 'backups')
    const result = await createDatabaseBackup({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot,
      migrations: migrationSnapshot,
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-12T01:02:03.004Z')
    })

    assert.equal(path.basename(result.backupDirectory), '20260812010203004-abababababab')
    assert.deepEqual(
      fs.readdirSync(result.backupDirectory).sort(),
      [DATABASE_BACKUP_FILE, DATABASE_BACKUP_MANIFEST_FILE].sort()
    )
    assert.equal(result.manifest.database.integrityCheck, 'ok')
    assert.deepEqual(result.manifest.migrations, [
      { id: '0001_first', checksum: 'a'.repeat(64) },
      { id: '0002_second', checksum: 'b'.repeat(64) }
    ])
    assert.equal(JSON.stringify(result.manifest).includes('must not leak'), false)
    assert.match(result.manifest.database.sha256, /^[a-f0-9]{64}$/)
    assert.equal(
      result.manifest.database.bytes,
      fs.statSync(path.join(result.backupDirectory, DATABASE_BACKUP_FILE)).size
    )

    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    const restoreResult = restoreDatabaseBackup({
      backupDirectory: result.backupDirectory,
      targetDirectory: prepared.targetDirectory,
      token: prepared.token
    })
    restored = new Database(restoreResult.restoredFile, { readonly: true })
    assert.equal(restored.pragma('journal_mode', { simple: true }), 'delete')
    assert.deepEqual(restored.prepare('SELECT id, body FROM notes ORDER BY id').all(), [
      { id: 1, body: 'alpha' },
      { id: 2, body: 'beta' }
    ])
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
  } finally {
    restored?.close()
    database?.close()
    cleanup(root)
  }
})

test('creates a synchronous portable snapshot for the startup gate', nativeTestOptions, () => {
  const root = makeRoot()
  let database
  let snapshot
  try {
    const source = createSourceDatabase(root)
    database = source.database
    database.prepare('INSERT INTO notes (body) VALUES (?)').run('wal-committed')
    const result = createDatabaseBackupSync({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot: path.join(root, 'backups'),
      migrations: migrationSnapshot,
      randomBytes: deterministicRandomBytes,
      now: new Date('2026-08-12T02:03:04.005Z')
    })
    assert.deepEqual(
      fs.readdirSync(result.backupDirectory).sort(),
      [DATABASE_BACKUP_FILE, DATABASE_BACKUP_MANIFEST_FILE].sort()
    )
    snapshot = new Database(path.join(result.backupDirectory, DATABASE_BACKUP_FILE), { readonly: true })
    assert.deepEqual(snapshot.prepare('SELECT body FROM notes ORDER BY id').all(), [
      { body: 'alpha' },
      { body: 'beta' },
      { body: 'wal-committed' }
    ])
    assert.equal(snapshot.pragma('journal_mode', { simple: true }), 'delete')
  } finally {
    snapshot?.close()
    database?.close()
    cleanup(root)
  }
})

test('rejects a source path that does not match the open database', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const otherPath = path.join(root, 'other.db')
    fs.writeFileSync(otherPath, 'not the database')
    await assert.rejects(
      createDatabaseBackup({
        database,
        sourceDbPath: otherPath,
        backupRoot: path.join(root, 'backups')
      }),
      { code: 'DATABASE_BACKUP_SOURCE_MISMATCH' }
    )
  } finally {
    database?.close()
    cleanup(root)
  }
})

test('rejects tampering before writing into the prepared restore directory', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const result = await createDatabaseBackup({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot: path.join(root, 'backups'),
      randomBytes: deterministicRandomBytes
    })
    fs.appendFileSync(path.join(result.backupDirectory, DATABASE_BACKUP_FILE), 'tampered')
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })

    assert.throws(
      () => restoreDatabaseBackup({
        backupDirectory: result.backupDirectory,
        targetDirectory: prepared.targetDirectory,
        token: prepared.token
      }),
      { code: 'DATABASE_BACKUP_HASH_MISMATCH' }
    )
    assert.deepEqual(fs.readdirSync(prepared.targetDirectory), [RESTORE_MARKER_FILE])
  } finally {
    database?.close()
    cleanup(root)
  }
})

test('rejects a wrong restore token and preserves the prepared marker', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const result = await createDatabaseBackup({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot: path.join(root, 'backups'),
      randomBytes: deterministicRandomBytes
    })
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    assert.throws(
      () => restoreDatabaseBackup({
        backupDirectory: result.backupDirectory,
        targetDirectory: prepared.targetDirectory,
        token: 'cd'.repeat(16)
      }),
      { code: 'DATABASE_RESTORE_MARKER_INVALID' }
    )
    assert.deepEqual(fs.readdirSync(prepared.targetDirectory), [RESTORE_MARKER_FILE])
  } finally {
    database?.close()
    cleanup(root)
  }
})

test('rejects an invalid manifest before changing the prepared target', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const result = await createDatabaseBackup({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot: path.join(root, 'backups'),
      randomBytes: deterministicRandomBytes
    })
    fs.writeFileSync(path.join(result.backupDirectory, DATABASE_BACKUP_MANIFEST_FILE), '{}')
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    assert.throws(
      () => restoreDatabaseBackup({
        backupDirectory: result.backupDirectory,
        targetDirectory: prepared.targetDirectory,
        token: prepared.token
      }),
      { code: 'DATABASE_BACKUP_MANIFEST_INVALID' }
    )
    assert.deepEqual(fs.readdirSync(prepared.targetDirectory), [RESTORE_MARKER_FILE])
  } finally {
    database?.close()
    cleanup(root)
  }
})

test('rejects a polluted prepared target before reading backup content', () => {
  const root = makeRoot()
  try {
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    fs.writeFileSync(path.join(prepared.targetDirectory, 'existing.db'), 'keep')
    assert.throws(
      () => restoreDatabaseBackup({
        backupDirectory: path.join(root, 'missing-backup'),
        targetDirectory: prepared.targetDirectory,
        token: prepared.token
      }),
      { code: 'DATABASE_RESTORE_TARGET_NOT_EMPTY' }
    )
    assert.equal(fs.readFileSync(path.join(prepared.targetDirectory, 'existing.db'), 'utf8'), 'keep')
  } finally {
    cleanup(root)
  }
})

test('rejects backup and restore paths that overlap', () => {
  const root = makeRoot()
  try {
    const backupDirectory = path.join(root, 'backup')
    fs.mkdirSync(backupDirectory)
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(backupDirectory, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    assert.throws(
      () => restoreDatabaseBackup({
        backupDirectory,
        targetDirectory: prepared.targetDirectory,
        token: prepared.token
      }),
      { code: 'DATABASE_BACKUP_PATH_OVERLAP' }
    )
  } finally {
    cleanup(root)
  }
})

test('rejects invalid time and random providers without leaving a directory', () => {
  const root = makeRoot()
  try {
    const invalidTimeTarget = path.join(root, 'invalid-time')
    assert.throws(
      () => prepareIsolatedRestoreDirectory({
        targetDirectory: invalidTimeTarget,
        now: new Date('invalid')
      }),
      { code: 'DATABASE_BACKUP_TIME_INVALID' }
    )
    assert.equal(fs.existsSync(invalidTimeTarget), false)

    const invalidRandomTarget = path.join(root, 'invalid-random')
    assert.throws(
      () => prepareIsolatedRestoreDirectory({
        targetDirectory: invalidRandomTarget,
        randomBytes: () => Buffer.alloc(1)
      }),
      { code: 'DATABASE_BACKUP_RANDOM_INVALID' }
    )
    assert.equal(fs.existsSync(invalidRandomTarget), false)
  } finally {
    cleanup(root)
  }
})

test('rejects insufficient backup space before creating snapshot files', nativeTestOptions, () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const backupRoot = path.join(root, 'backups')
    assert.throws(() => createDatabaseBackupSync({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot,
      statfs: () => ({ bavail: 0, bsize: 4096 })
    }), { code: 'DATABASE_BACKUP_SPACE_INSUFFICIENT' })
    assert.deepEqual(fs.readdirSync(backupRoot), [])
  } finally {
    database?.close()
    cleanup(root)
  }
})

test('rejects insufficient restore space before copying the database', nativeTestOptions, async () => {
  const root = makeRoot()
  let database
  try {
    const source = createSourceDatabase(root)
    database = source.database
    const backup = await createDatabaseBackup({
      database,
      sourceDbPath: source.sourceDbPath,
      backupRoot: path.join(root, 'backups'),
      randomBytes: deterministicRandomBytes
    })
    const prepared = prepareIsolatedRestoreDirectory({
      targetDirectory: path.join(root, 'restore'),
      randomBytes: deterministicRandomBytes
    })
    assert.throws(() => restoreDatabaseBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: prepared.targetDirectory,
      token: prepared.token,
      statfs: () => ({ bavail: 0, bsize: 4096 })
    }), { code: 'DATABASE_RESTORE_SPACE_INSUFFICIENT' })
    assert.deepEqual(fs.readdirSync(prepared.targetDirectory), [RESTORE_MARKER_FILE])
  } finally {
    database?.close()
    cleanup(root)
  }
})
