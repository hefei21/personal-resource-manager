import fs from 'node:fs'
import path from 'node:path'

export class LegacyStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'LegacyStorageError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new LegacyStorageError(code, message, cause ? { cause } : undefined)
}

function canonicalRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('LEGACY_STORAGE_ROOT_INVALID', 'Legacy storage root is invalid.')
  }
  const requested = path.resolve(value)
  let stat
  try { stat = fs.lstatSync(requested) } catch (error) {
    fail('LEGACY_STORAGE_ROOT_INVALID', 'Legacy storage root does not exist.', error)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('LEGACY_STORAGE_ROOT_INVALID', 'Legacy storage root must be a real directory.')
  }
  return fs.realpathSync.native(requested)
}

function within(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertNoSymlinkChain(rootPath, requestedPath) {
  const relative = path.relative(rootPath, requestedPath)
  const segments = relative.split(path.sep)
  let current = rootPath
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) {
      fail('LEGACY_STORAGE_FILE_MISSING', 'Legacy file does not exist.', error)
    }
    if (stat.isSymbolicLink()) {
      fail('LEGACY_STORAGE_SYMLINK_REJECTED', 'Legacy storage path must not contain symbolic links.')
    }
  }
}

export class LegacyStorageAdapter {
  constructor(options = {}) {
    if (!Array.isArray(options.roots) || options.roots.length === 0) {
      fail('LEGACY_STORAGE_ROOTS_INVALID', 'At least one legacy storage root is required.')
    }
    this.roots = Object.freeze([...new Set(options.roots.map(canonicalRoot))])
  }

  resolveFile(storedPath) {
    if (typeof storedPath !== 'string' || storedPath.trim() === '' || storedPath.includes('\0') || !path.isAbsolute(storedPath)) {
      fail('LEGACY_STORAGE_PATH_INVALID', 'Legacy file path is invalid.')
    }
    const requested = path.resolve(storedPath)
    const rootPath = this.roots.find((root) => within(root, requested))
    if (!rootPath) fail('LEGACY_STORAGE_OUTSIDE_ROOT', 'Legacy file is outside managed roots.')
    assertNoSymlinkChain(rootPath, requested)
    let stat
    let real
    try {
      stat = fs.lstatSync(requested)
      real = fs.realpathSync.native(requested)
    } catch (error) {
      fail('LEGACY_STORAGE_FILE_MISSING', 'Legacy file does not exist.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !within(rootPath, real)) {
      fail('LEGACY_STORAGE_FILE_INVALID', 'Legacy path must resolve to a managed regular file.')
    }
    return Object.freeze({ rootPath, filePath: real, bytes: stat.size, modifiedAt: stat.mtime.toISOString() })
  }

  stat(storedPath) {
    return this.resolveFile(storedPath)
  }

  createReadStream(storedPath, range = {}) {
    const resolved = this.resolveFile(storedPath)
    const options = {}
    if (range.start !== undefined || range.end !== undefined) {
      const start = range.start ?? 0
      const end = range.end ?? resolved.bytes - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= resolved.bytes) {
        fail('LEGACY_STORAGE_RANGE_INVALID', 'Legacy byte range is invalid.')
      }
      options.start = start
      options.end = end
    }
    return fs.createReadStream(resolved.filePath, options)
  }
}
