import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const RESOURCE_BACKUP_FORMAT_VERSION = 1
export const RESOURCE_BACKUP_MANIFEST_FILE = 'resources.json'
export const RESOURCE_BACKUP_OBJECTS_DIRECTORY = 'objects'

const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class ResourceBackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ResourceBackupError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new ResourceBackupError(code, message, cause ? { cause } : undefined)
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  const handle = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let count
    do {
      count = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (count > 0) hash.update(buffer.subarray(0, count))
    } while (count > 0)
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

function realDirectory(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, 'Directory path is required.')
  try {
    const resolved = fs.realpathSync.native(path.resolve(value))
    if (!fs.statSync(resolved).isDirectory()) fail(code, 'Path must be a directory.')
    return resolved
  } catch (error) {
    if (error instanceof ResourceBackupError) throw error
    fail(code, 'Directory could not be resolved.', error)
  }
}

function managedFile(rootPath, sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    fail('RESOURCE_BACKUP_SOURCE_INVALID', 'Resource source path is required.')
  }
  const requested = path.resolve(sourcePath)
  let source
  let stat
  try {
    stat = fs.lstatSync(requested)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('RESOURCE_BACKUP_SOURCE_INVALID', 'Resource source must be a regular file.')
    }
    source = fs.realpathSync.native(requested)
  } catch (error) {
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_BACKUP_SOURCE_INVALID', 'Resource source could not be resolved.', error)
  }
  const relative = path.relative(rootPath, source)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('RESOURCE_BACKUP_SOURCE_OUTSIDE_ROOT', 'Resource source is outside its managed root.')
  }
  return { source, relative: relative.split(path.sep).join('/') , stat }
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) fail('RESOURCE_BACKUP_ENTRIES_INVALID', 'Resource entries must be an array.')
  const targets = new Set()
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !KIND_PATTERN.test(entry.kind ?? '')) {
      fail('RESOURCE_BACKUP_ENTRY_INVALID', 'Resource entry is invalid.')
    }
    const rootPath = realDirectory(entry.rootPath, 'RESOURCE_BACKUP_ROOT_INVALID')
    const file = managedFile(rootPath, entry.sourcePath)
    const archivePath = `${entry.kind}/${file.relative}`
    if (targets.has(archivePath)) fail('RESOURCE_BACKUP_TARGET_DUPLICATE', 'Resource archive path is duplicated.')
    targets.add(archivePath)
    return { kind: entry.kind, archivePath, source: file.source, bytes: file.stat.size }
  })
  normalized.sort((left, right) => left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0)
  return normalized
}

export function createResourceBackup(options = {}) {
  const backupDirectory = realDirectory(options.backupDirectory, 'RESOURCE_BACKUP_DIRECTORY_INVALID')
  const manifestPath = path.join(backupDirectory, RESOURCE_BACKUP_MANIFEST_FILE)
  const objectsDirectory = path.join(backupDirectory, RESOURCE_BACKUP_OBJECTS_DIRECTORY)
  if (fs.existsSync(manifestPath) || fs.existsSync(objectsDirectory)) {
    fail('RESOURCE_BACKUP_TARGET_EXISTS', 'Resource backup target already exists.')
  }
  const entries = normalizeEntries(options.entries)
  try {
    const stats = (options.statfs ?? fs.statfsSync)(backupDirectory)
    const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize)
    const requiredBytes = entries.reduce((total, entry) => total + BigInt(entry.bytes), 0n)
    if (availableBytes < requiredBytes) {
      fail('RESOURCE_BACKUP_SPACE_INSUFFICIENT', 'Backup destination does not have enough free space.')
    }
  } catch (error) {
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_BACKUP_SPACE_CHECK_FAILED', 'Backup free space could not be verified.', error)
  }
  const copied = []
  try {
    fs.mkdirSync(objectsDirectory)
    for (const entry of entries) {
      const target = path.join(objectsDirectory, ...entry.archivePath.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(entry.source, target, fs.constants.COPYFILE_EXCL)
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) {
        fail('RESOURCE_BACKUP_COPY_FAILED', 'Copied resource did not match its source.')
      }
      copied.push({ kind: entry.kind, path: entry.archivePath, bytes: stat.size, sha256: sha256File(target) })
    }
    const manifest = {
      formatVersion: RESOURCE_BACKUP_FORMAT_VERSION,
      kind: 'resources',
      entries: copied
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return Object.freeze({ manifestPath, manifest })
  } catch (error) {
    fs.rmSync(manifestPath, { force: true })
    fs.rmSync(objectsDirectory, { recursive: true, force: true })
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_BACKUP_CREATE_FAILED', 'Resource backup could not be created.', error)
  }
}

function readManifest(backupDirectory) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, RESOURCE_BACKUP_MANIFEST_FILE), 'utf8'))
  } catch (error) {
    fail('RESOURCE_BACKUP_MANIFEST_INVALID', 'Resource manifest is missing or invalid.', error)
  }
  if (!manifest || manifest.formatVersion !== RESOURCE_BACKUP_FORMAT_VERSION || manifest.kind !== 'resources' || !Array.isArray(manifest.entries)) {
    fail('RESOURCE_BACKUP_MANIFEST_INVALID', 'Resource manifest format is invalid.')
  }
  const seen = new Set()
  for (const entry of manifest.entries) {
    const segments = typeof entry?.path === 'string' ? entry.path.split('/') : []
    if (!entry || !KIND_PATTERN.test(entry.kind ?? '') || typeof entry.path !== 'string' ||
      entry.path.includes('\\') || entry.path.includes('\0') || segments[0] !== entry.kind ||
      segments.length < 2 || segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256_PATTERN.test(entry.sha256 ?? '') || seen.has(entry.path)) {
      fail('RESOURCE_BACKUP_MANIFEST_INVALID', 'Resource manifest entry is invalid.')
    }
    seen.add(entry.path)
  }
  return manifest
}

export function verifyResourceBackup(options = {}) {
  const backupDirectory = realDirectory(options.backupDirectory, 'RESOURCE_BACKUP_DIRECTORY_INVALID')
  const manifest = readManifest(backupDirectory)
  const objectsDirectory = path.join(backupDirectory, RESOURCE_BACKUP_OBJECTS_DIRECTORY)
  const actualFiles = []
  const visit = (directory) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const childPath = path.join(directory, child.name)
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        fail('RESOURCE_BACKUP_FILE_INVALID', 'Resource package contains an unsupported entry.')
      }
      if (child.isDirectory()) visit(childPath)
      else actualFiles.push(path.relative(objectsDirectory, childPath).split(path.sep).join('/'))
    }
  }
  try { visit(objectsDirectory) } catch (error) {
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_BACKUP_FILE_MISSING', 'Resource objects directory is missing.', error)
  }
  const expectedFiles = manifest.entries.map((entry) => entry.path).sort()
  actualFiles.sort()
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((value, index) => value !== expectedFiles[index])) {
    fail('RESOURCE_BACKUP_UNLISTED_FILE', 'Resource package contains an unlisted or missing file.')
  }
  for (const entry of manifest.entries) {
    const filePath = path.join(objectsDirectory, ...entry.path.split('/'))
    let stat
    try { stat = fs.lstatSync(filePath) } catch (error) {
      fail('RESOURCE_BACKUP_FILE_MISSING', 'Resource backup file is missing.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || sha256File(filePath) !== entry.sha256) {
      fail('RESOURCE_BACKUP_HASH_MISMATCH', 'Resource backup file does not match its manifest.')
    }
  }
  return Object.freeze({ manifest })
}

export function restoreResourceBackup(options = {}) {
  const backupDirectory = realDirectory(options.backupDirectory, 'RESOURCE_BACKUP_DIRECTORY_INVALID')
  if (typeof options.targetDirectory !== 'string' || options.targetDirectory.trim() === '') {
    fail('RESOURCE_RESTORE_TARGET_INVALID', 'Restore target path is required.')
  }
  const targetDirectory = path.resolve(options.targetDirectory)
  if (fs.existsSync(targetDirectory)) {
    fail('RESOURCE_RESTORE_TARGET_EXISTS', 'Restore target must not already exist.')
  }
  const parent = realDirectory(path.dirname(targetDirectory), 'RESOURCE_RESTORE_TARGET_INVALID')
  const canonicalTarget = path.join(parent, path.basename(targetDirectory))
  const relativeToBackup = path.relative(backupDirectory, canonicalTarget)
  const relativeToTarget = path.relative(canonicalTarget, backupDirectory)
  if (relativeToBackup === '' || (!relativeToBackup.startsWith(`..${path.sep}`) && relativeToBackup !== '..' && !path.isAbsolute(relativeToBackup)) ||
    relativeToTarget === '' || (!relativeToTarget.startsWith(`..${path.sep}`) && relativeToTarget !== '..' && !path.isAbsolute(relativeToTarget))) {
    fail('RESOURCE_BACKUP_PATH_OVERLAP', 'Backup and restore paths must not overlap.')
  }

  const { manifest } = verifyResourceBackup({ backupDirectory })
  try {
    const stats = (options.statfs ?? fs.statfsSync)(parent)
    const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize)
    const requiredBytes = manifest.entries.reduce((total, entry) => total + BigInt(entry.bytes), 0n)
    if (availableBytes < requiredBytes) {
      fail('RESOURCE_RESTORE_SPACE_INSUFFICIENT', 'Restore destination does not have enough free space.')
    }
  } catch (error) {
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_RESTORE_SPACE_CHECK_FAILED', 'Restore free space could not be verified.', error)
  }
  const temporaryDirectory = path.join(parent, `.${path.basename(canonicalTarget)}.${randomBytes(8).toString('hex')}.tmp`)
  let temporaryCreated = false
  try {
    fs.mkdirSync(temporaryDirectory)
    temporaryCreated = true
    for (const entry of manifest.entries) {
      const source = path.join(backupDirectory, RESOURCE_BACKUP_OBJECTS_DIRECTORY, ...entry.path.split('/'))
      const target = path.join(temporaryDirectory, ...entry.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || sha256File(target) !== entry.sha256) {
        fail('RESOURCE_RESTORE_HASH_MISMATCH', 'Restored resource does not match the backup.')
      }
    }
    fs.renameSync(temporaryDirectory, canonicalTarget)
    temporaryCreated = false
    return Object.freeze({ targetDirectory: canonicalTarget, manifest })
  } catch (error) {
    if (temporaryCreated) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    if (error instanceof ResourceBackupError) throw error
    fail('RESOURCE_RESTORE_FAILED', 'Resources could not be restored.', error)
  }
}
