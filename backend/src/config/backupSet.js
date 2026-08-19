import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATABASE_BACKUP_MANIFEST_FILE, verifyDatabaseBackup } from './databaseBackup.js'
import { RESOURCE_BACKUP_MANIFEST_FILE, verifyResourceBackup } from './resourceBackup.js'

export const BACKUP_SET_FORMAT_VERSION = 1
export const BACKUP_SET_MANIFEST_FILE = 'backup-set.json'

export class BackupSetError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'BackupSetError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new BackupSetError(code, message, cause ? { cause } : undefined)
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function backupDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('BACKUP_SET_DIRECTORY_INVALID', 'Backup directory is required.')
  try {
    const resolved = fs.realpathSync.native(path.resolve(value))
    if (!fs.statSync(resolved).isDirectory()) fail('BACKUP_SET_DIRECTORY_INVALID', 'Backup path must be a directory.')
    return resolved
  } catch (error) {
    if (error instanceof BackupSetError) throw error
    fail('BACKUP_SET_DIRECTORY_INVALID', 'Backup directory could not be resolved.', error)
  }
}

function component(backupPath, file) {
  return { file, sha256: sha256File(path.join(backupPath, file)) }
}

export function createBackupSetManifest(options = {}) {
  const directory = backupDirectory(options.backupDirectory)
  const target = path.join(directory, BACKUP_SET_MANIFEST_FILE)
  if (fs.existsSync(target)) fail('BACKUP_SET_TARGET_EXISTS', 'Backup set manifest already exists.')
  try {
    verifyDatabaseBackup({ backupDirectory: directory })
    verifyResourceBackup({ backupDirectory: directory })
    const manifest = {
      formatVersion: BACKUP_SET_FORMAT_VERSION,
      kind: 'backup-set',
      components: {
        database: component(directory, DATABASE_BACKUP_MANIFEST_FILE),
        resources: component(directory, RESOURCE_BACKUP_MANIFEST_FILE)
      }
    }
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return Object.freeze({ manifestPath: target, manifest })
  } catch (error) {
    fs.rmSync(target, { force: true })
    if (error instanceof BackupSetError) throw error
    fail('BACKUP_SET_CREATE_FAILED', 'Backup set could not be finalized.', error)
  }
}

export function verifyBackupSet(options = {}) {
  const directory = backupDirectory(options.backupDirectory)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, BACKUP_SET_MANIFEST_FILE), 'utf8')) } catch (error) {
    fail('BACKUP_SET_MANIFEST_INVALID', 'Backup set manifest is missing or invalid.', error)
  }
  const database = manifest?.components?.database
  const resources = manifest?.components?.resources
  if (manifest?.formatVersion !== BACKUP_SET_FORMAT_VERSION || manifest?.kind !== 'backup-set' ||
    database?.file !== DATABASE_BACKUP_MANIFEST_FILE || resources?.file !== RESOURCE_BACKUP_MANIFEST_FILE ||
    !/^[a-f0-9]{64}$/.test(database?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(resources?.sha256 ?? '')) {
    fail('BACKUP_SET_MANIFEST_INVALID', 'Backup set manifest format is invalid.')
  }
  if (sha256File(path.join(directory, database.file)) !== database.sha256 ||
    sha256File(path.join(directory, resources.file)) !== resources.sha256) {
    fail('BACKUP_SET_COMPONENT_MISMATCH', 'Backup set component manifest does not match.')
  }
  verifyDatabaseBackup({ backupDirectory: directory })
  verifyResourceBackup({ backupDirectory: directory })
  return Object.freeze({ manifest })
}
