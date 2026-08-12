import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export const DATABASE_BACKUP_FORMAT_VERSION = 1
export const DATABASE_BACKUP_FILE = 'database.sqlite'
export const DATABASE_BACKUP_MANIFEST_FILE = 'manifest.json'
export const RESTORE_MARKER_FILE = '.prm-isolated-restore.json'

const TOKEN_PATTERN = /^[a-f0-9]{32}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class DatabaseBackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'DatabaseBackupError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new DatabaseBackupError(code, message, cause ? { cause } : undefined)
}

function resolvePath(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, 'A non-empty filesystem path is required.')
  }
  return path.resolve(value)
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right)
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertSeparatePaths(left, right) {
  if (pathsOverlap(left, right) || pathsOverlap(right, left)) {
    fail('DATABASE_BACKUP_PATH_OVERLAP', 'Backup and database paths must not overlap.')
  }
}

function realDirectoryPath(directoryPath, code) {
  try {
    const stat = fs.statSync(directoryPath)
    if (!stat.isDirectory()) fail(code, 'Expected path to be a directory.')
    return fs.realpathSync.native(directoryPath)
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error
    fail(code, 'Directory path could not be resolved.', error)
  }
}

function assertDatabasePath(database, sourceDbPath) {
  if (typeof database.name !== 'string' || database.name === ':memory:') {
    fail('DATABASE_BACKUP_SOURCE_INVALID', 'A file-backed SQLite database is required.')
  }
  let connectionPath
  let suppliedPath
  try {
    connectionPath = fs.realpathSync.native(path.resolve(database.name))
    suppliedPath = fs.realpathSync.native(sourceDbPath)
  } catch (error) {
    fail('DATABASE_BACKUP_SOURCE_INVALID', 'Database source path is not a readable file.', error)
  }
  if (connectionPath !== suppliedPath) {
    fail('DATABASE_BACKUP_SOURCE_MISMATCH', 'Database source path does not match the connection.')
  }
  return suppliedPath
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  const file = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(file)
  }
  return hash.digest('hex')
}

function verifySqliteFile(filePath) {
  let database
  try {
    database = new Database(filePath, { readonly: true, fileMustExist: true })
    const rows = database.pragma('integrity_check')
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
      fail('DATABASE_BACKUP_INTEGRITY_FAILED', 'SQLite integrity verification failed.')
    }
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error
    fail('DATABASE_BACKUP_INTEGRITY_FAILED', 'SQLite integrity verification failed.', error)
  } finally {
    database?.close()
  }
}

function createToken(bytes = randomBytes) {
  let value
  try {
    value = bytes(16)
  } catch (error) {
    fail('DATABASE_BACKUP_RANDOM_INVALID', 'Secure random bytes could not be generated.', error)
  }
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    fail('DATABASE_BACKUP_RANDOM_INVALID', 'Secure random bytes must return exactly 16 bytes.')
  }
  return value.toString('hex')
}

function timestampName(now) {
  return now.toISOString().replace(/[-:.TZ]/g, '')
}

function normalizeNow(value) {
  const now = value ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail('DATABASE_BACKUP_TIME_INVALID', 'Backup time must be a valid Date.')
  }
  return now
}

function readManifest(backupDirectory) {
  const manifestPath = path.join(backupDirectory, DATABASE_BACKUP_MANIFEST_FILE)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail('DATABASE_BACKUP_MANIFEST_INVALID', 'Backup manifest is missing or invalid.', error)
  }
  if (
    !manifest || manifest.formatVersion !== DATABASE_BACKUP_FORMAT_VERSION ||
    manifest.kind !== 'sqlite' || manifest.database?.file !== DATABASE_BACKUP_FILE ||
    !Number.isSafeInteger(manifest.database?.bytes) || manifest.database.bytes < 1 ||
    !SHA256_PATTERN.test(manifest.database?.sha256 ?? '') ||
    manifest.database.integrityCheck !== 'ok' || typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt))
  ) {
    fail('DATABASE_BACKUP_MANIFEST_INVALID', 'Backup manifest does not match the supported format.')
  }
  return manifest
}

export function prepareIsolatedRestoreDirectory(options = {}) {
  const targetDirectory = resolvePath(options.targetDirectory, 'DATABASE_RESTORE_TARGET_INVALID')
  const token = createToken(options.randomBytes)
  const createdAt = normalizeNow(options.now).toISOString()
  const markerPath = path.join(targetDirectory, RESTORE_MARKER_FILE)
  let directoryCreated = false
  try {
    fs.mkdirSync(targetDirectory)
    directoryCreated = true
    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ formatVersion: 1, token, createdAt })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch (error) {
    if (directoryCreated) {
      try { fs.rmSync(markerPath, { force: true }) } catch {}
      try { fs.rmdirSync(targetDirectory) } catch {}
    }
    fail('DATABASE_RESTORE_TARGET_NOT_EMPTY', 'Restore target must be a new isolated directory.', error)
  }
  return Object.freeze({ targetDirectory, token })
}

export async function createDatabaseBackup(options = {}) {
  const { database } = options
  if (!database || typeof database.backup !== 'function') {
    fail('DATABASE_BACKUP_CONNECTION_INVALID', 'An open SQLite connection is required.')
  }
  const requestedSourceDbPath = resolvePath(options.sourceDbPath, 'DATABASE_BACKUP_SOURCE_INVALID')
  const sourceDbPath = assertDatabasePath(database, requestedSourceDbPath)
  const requestedBackupRoot = resolvePath(options.backupRoot, 'DATABASE_BACKUP_ROOT_INVALID')
  try {
    fs.mkdirSync(requestedBackupRoot, { recursive: true })
  } catch (error) {
    fail('DATABASE_BACKUP_ROOT_INVALID', 'Backup root could not be prepared.', error)
  }
  const backupRoot = realDirectoryPath(requestedBackupRoot, 'DATABASE_BACKUP_ROOT_INVALID')
  assertSeparatePaths(sourceDbPath, backupRoot)

  const now = normalizeNow(options.now)
  const suffix = createToken(options.randomBytes).slice(0, 12)
  const directoryName = `${timestampName(now)}-${suffix}`
  const finalDirectory = path.join(backupRoot, directoryName)
  const temporaryDirectory = path.join(backupRoot, `.${directoryName}.tmp`)
  if (fs.existsSync(finalDirectory) || fs.existsSync(temporaryDirectory)) {
    fail('DATABASE_BACKUP_TARGET_EXISTS', 'Backup target already exists.')
  }

  try {
    fs.mkdirSync(temporaryDirectory)
    const databaseFile = path.join(temporaryDirectory, DATABASE_BACKUP_FILE)
    await database.backup(databaseFile)
    verifySqliteFile(databaseFile)
    const stat = fs.statSync(databaseFile)
    const manifest = {
      formatVersion: DATABASE_BACKUP_FORMAT_VERSION,
      kind: 'sqlite',
      createdAt: now.toISOString(),
      database: {
        file: DATABASE_BACKUP_FILE,
        bytes: stat.size,
        sha256: sha256File(databaseFile),
        integrityCheck: 'ok'
      }
    }
    fs.writeFileSync(
      path.join(temporaryDirectory, DATABASE_BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    fs.renameSync(temporaryDirectory, finalDirectory)
    return Object.freeze({ backupDirectory: finalDirectory, manifest })
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    if (error instanceof DatabaseBackupError) throw error
    fail('DATABASE_BACKUP_CREATE_FAILED', 'Database backup could not be created.', error)
  }
}

function verifyRestoreMarker(targetDirectory, token) {
  if (!TOKEN_PATTERN.test(token ?? '')) {
    fail('DATABASE_RESTORE_TOKEN_INVALID', 'Restore token is invalid.')
  }
  let marker
  try {
    const entries = fs.readdirSync(targetDirectory)
    if (entries.length !== 1 || entries[0] !== RESTORE_MARKER_FILE) {
      fail('DATABASE_RESTORE_TARGET_NOT_EMPTY', 'Restore target is not an empty prepared directory.')
    }
    marker = JSON.parse(fs.readFileSync(path.join(targetDirectory, RESTORE_MARKER_FILE), 'utf8'))
  } catch (error) {
    if (error instanceof DatabaseBackupError) throw error
    fail('DATABASE_RESTORE_MARKER_INVALID', 'Restore marker is missing or invalid.', error)
  }
  if (marker?.formatVersion !== 1 || marker.token !== token) {
    fail('DATABASE_RESTORE_MARKER_INVALID', 'Restore marker does not match the supplied token.')
  }
}

export function restoreDatabaseBackup(options = {}) {
  const targetDirectory = realDirectoryPath(
    resolvePath(options.targetDirectory, 'DATABASE_RESTORE_TARGET_INVALID'),
    'DATABASE_RESTORE_TARGET_INVALID'
  )
  verifyRestoreMarker(targetDirectory, options.token)
  const backupDirectory = realDirectoryPath(
    resolvePath(options.backupDirectory, 'DATABASE_BACKUP_SOURCE_INVALID'),
    'DATABASE_BACKUP_SOURCE_INVALID'
  )
  assertSeparatePaths(backupDirectory, targetDirectory)

  const manifest = readManifest(backupDirectory)
  const sourceFile = path.join(backupDirectory, DATABASE_BACKUP_FILE)
  let sourceStat
  try {
    sourceStat = fs.lstatSync(sourceFile)
  } catch (error) {
    fail('DATABASE_BACKUP_FILE_MISSING', 'Backup database file is missing.', error)
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    fail('DATABASE_BACKUP_FILE_INVALID', 'Backup database must be a regular file.')
  }
  if (sourceStat.size !== manifest.database.bytes || sha256File(sourceFile) !== manifest.database.sha256) {
    fail('DATABASE_BACKUP_HASH_MISMATCH', 'Backup database does not match its manifest.')
  }
  verifySqliteFile(sourceFile)

  const temporaryFile = path.join(targetDirectory, '.database.sqlite.restore.tmp')
  const restoredFile = path.join(targetDirectory, DATABASE_BACKUP_FILE)
  try {
    fs.copyFileSync(sourceFile, temporaryFile, fs.constants.COPYFILE_EXCL)
    verifySqliteFile(temporaryFile)
    if (sha256File(temporaryFile) !== manifest.database.sha256) {
      fail('DATABASE_RESTORE_HASH_MISMATCH', 'Restored database does not match the backup.')
    }
    fs.renameSync(temporaryFile, restoredFile)
    return Object.freeze({ restoredFile, manifest })
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true })
    if (error instanceof DatabaseBackupError) throw error
    fail('DATABASE_RESTORE_FAILED', 'Database could not be restored.', error)
  }
}
