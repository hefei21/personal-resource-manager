import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const STAGING_TOKEN_PATTERN = /^[a-f0-9]{32}$/
const STORAGE_KEY_PATTERN = /^([a-z][a-z0-9_-]{0,31})\/([a-f0-9]{2})\/([a-f0-9]{64})$/

export class StorageServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'StorageServiceError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new StorageServiceError(code, message, cause ? { cause } : undefined)
}

function validateKind(kind) {
  if (!KIND_PATTERN.test(kind ?? '')) fail('STORAGE_KIND_INVALID', 'Storage kind is invalid.')
  return kind
}

export function createStorageKey(kind, sha256) {
  validateKind(kind)
  if (!HASH_PATTERN.test(sha256 ?? '')) fail('STORAGE_HASH_INVALID', 'Storage hash is invalid.')
  return `${kind}/${sha256.slice(0, 2)}/${sha256}`
}

export function parseStorageKey(storageKey) {
  if (typeof storageKey !== 'string') fail('STORAGE_KEY_INVALID', 'Storage key is invalid.')
  const match = STORAGE_KEY_PATTERN.exec(storageKey)
  if (!match || match[2] !== match[3].slice(0, 2)) {
    fail('STORAGE_KEY_INVALID', 'Storage key is invalid.')
  }
  return Object.freeze({ kind: match[1], prefix: match[2], sha256: match[3] })
}

function ensureRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    fail('STORAGE_ROOT_INVALID', 'Storage root is invalid.')
  }
  const requested = path.resolve(rootPath)
  try {
    fs.mkdirSync(requested, { recursive: true })
    const stat = fs.lstatSync(requested)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORAGE_ROOT_INVALID', 'Storage root must be a directory.')
    return fs.realpathSync.native(requested)
  } catch (error) {
    if (error instanceof StorageServiceError) throw error
    fail('STORAGE_ROOT_INVALID', 'Storage root could not be prepared.', error)
  }
}

function ensureManagedDirectory(rootPath, name) {
  const requested = path.join(rootPath, name)
  try {
    fs.mkdirSync(requested)
    return fs.realpathSync.native(requested)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      fail('STORAGE_DIRECTORY_INVALID', 'Managed storage directory could not be created.', error)
    }
    let stat
    try { stat = fs.lstatSync(requested) } catch (inspectError) {
      fail('STORAGE_DIRECTORY_INVALID', 'Managed storage directory could not be inspected.', inspectError)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('STORAGE_DIRECTORY_INVALID', 'Managed storage path must be a real directory.')
    }
    const real = fs.realpathSync.native(requested)
    if (!isWithin(rootPath, real)) {
      fail('STORAGE_DIRECTORY_INVALID', 'Managed storage directory escaped the storage root.')
    }
    return real
  }
}

function ensureChildDirectory(parentPath, name, create) {
  const requested = path.join(parentPath, name)
  if (create) {
    try { fs.mkdirSync(requested) } catch (error) {
      if (error?.code !== 'EEXIST') {
        fail('STORAGE_DIRECTORY_INVALID', 'Storage object directory could not be created.', error)
      }
    }
  }
  let stat
  try { stat = fs.lstatSync(requested) } catch (error) {
    if (!create && error?.code === 'ENOENT') fail('STORAGE_OBJECT_MISSING', 'Storage object does not exist.', error)
    fail('STORAGE_DIRECTORY_INVALID', 'Storage object directory could not be inspected.', error)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('STORAGE_DIRECTORY_INVALID', 'Storage object path must contain only real directories.')
  }
  const real = fs.realpathSync.native(requested)
  if (!isWithin(parentPath, real)) {
    fail('STORAGE_DIRECTORY_INVALID', 'Storage object directory escaped its parent.')
  }
  return real
}

function randomToken(provider = randomBytes) {
  let value
  try { value = provider(16) } catch (error) {
    fail('STORAGE_RANDOM_INVALID', 'Secure random bytes could not be generated.', error)
  }
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    fail('STORAGE_RANDOM_INVALID', 'Secure random bytes must return 16 bytes.')
  }
  return value.toString('hex')
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

export class StorageService {
  constructor(options = {}) {
    this.rootPath = ensureRoot(options.rootPath)
    this.objectsPath = ensureManagedDirectory(this.rootPath, 'objects')
    this.stagingPath = ensureManagedDirectory(this.rootPath, 'staging')
    this.trashPath = ensureManagedDirectory(this.rootPath, 'trash')
    this.randomBytes = options.randomBytes ?? randomBytes
  }

  createStagingWriteStream() {
    const token = randomToken(this.randomBytes)
    const filePath = path.join(this.stagingPath, token)
    const stream = fs.createWriteStream(filePath, { flags: 'wx' })
    return Object.freeze({ token, stream })
  }

  async stageFromStream(readable) {
    if (!readable || typeof readable.pipe !== 'function') {
      fail('STORAGE_INPUT_INVALID', 'A readable stream is required.')
    }
    const staged = this.createStagingWriteStream()
    try {
      await pipeline(readable, staged.stream)
      const handle = await fs.promises.open(this.stagingFile(staged.token), 'r+')
      try { await handle.sync() } finally { await handle.close() }
      const metadata = await hashFile(this.stagingFile(staged.token))
      return Object.freeze({ token: staged.token, ...metadata })
    } catch (error) {
      fs.rmSync(this.stagingFile(staged.token), { force: true })
      if (error instanceof StorageServiceError) throw error
      fail('STORAGE_STAGE_FAILED', 'Input could not be staged.', error)
    }
  }

  stagingFile(token) {
    if (!STAGING_TOKEN_PATTERN.test(token ?? '')) fail('STORAGE_STAGING_TOKEN_INVALID', 'Staging token is invalid.')
    return path.join(this.stagingPath, token)
  }

  objectFile(storageKey, options = {}) {
    const parsed = parseStorageKey(storageKey)
    const kindPath = ensureChildDirectory(this.objectsPath, parsed.kind, options.createParents === true)
    const prefixPath = ensureChildDirectory(kindPath, parsed.prefix, options.createParents === true)
    const candidate = path.resolve(prefixPath, parsed.sha256)
    if (!isWithin(this.objectsPath, candidate)) fail('STORAGE_KEY_INVALID', 'Storage key escaped the object root.')
    return candidate
  }

  async commitStaged({ token, kind, expectedSha256, expectedBytes } = {}) {
    validateKind(kind)
    const stagedPath = this.stagingFile(token)
    let stat
    try { stat = fs.lstatSync(stagedPath) } catch (error) {
      fail('STORAGE_STAGING_MISSING', 'Staged object does not exist.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STORAGE_STAGING_INVALID', 'Staged object must be a regular file.')
    const actual = await hashFile(stagedPath)
    if ((expectedSha256 !== undefined && actual.sha256 !== expectedSha256) ||
      (expectedBytes !== undefined && actual.bytes !== expectedBytes)) {
      fail('STORAGE_STAGING_MISMATCH', 'Staged object does not match expected metadata.')
    }
    const storageKey = createStorageKey(kind, actual.sha256)
    const objectPath = this.objectFile(storageKey, { createParents: true })
    const reuseExisting = async () => {
      const existingStat = fs.lstatSync(objectPath)
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        fail('STORAGE_OBJECT_INVALID', 'Existing storage object is invalid.')
      }
      const existing = await hashFile(objectPath)
      if (existing.bytes !== actual.bytes || existing.sha256 !== actual.sha256) {
        fail('STORAGE_OBJECT_COLLISION', 'Existing storage object does not match its key.')
      }
      fs.rmSync(stagedPath)
      return Object.freeze({ storageKey, sha256: actual.sha256, bytes: actual.bytes, reused: true })
    }
    if (fs.existsSync(objectPath)) return reuseExisting()
    try {
      fs.linkSync(stagedPath, objectPath)
      fs.rmSync(stagedPath)
    } catch (error) {
      if (error?.code === 'EEXIST') return reuseExisting()
      fail('STORAGE_COMMIT_FAILED', 'Staged object could not be committed.', error)
    }
    return Object.freeze({ storageKey, sha256: actual.sha256, bytes: actual.bytes, reused: false })
  }

  async stat(storageKey) {
    const objectPath = this.objectFile(storageKey)
    let stat
    try { stat = fs.lstatSync(objectPath) } catch (error) {
      fail('STORAGE_OBJECT_MISSING', 'Storage object does not exist.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STORAGE_OBJECT_INVALID', 'Storage object must be a regular file.')
    const actual = await hashFile(objectPath)
    const expected = parseStorageKey(storageKey).sha256
    if (actual.sha256 !== expected) fail('STORAGE_OBJECT_HASH_MISMATCH', 'Storage object does not match its key.')
    return Object.freeze({ storageKey, sha256: actual.sha256, bytes: actual.bytes, modifiedAt: stat.mtime.toISOString() })
  }

  async createReadStream(storageKey, range = {}) {
    const objectPath = this.objectFile(storageKey)
    let stat
    try { stat = fs.lstatSync(objectPath) } catch (error) {
      fail('STORAGE_OBJECT_MISSING', 'Storage object does not exist.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STORAGE_OBJECT_INVALID', 'Storage object must be a regular file.')
    const actual = await hashFile(objectPath)
    if (actual.sha256 !== parseStorageKey(storageKey).sha256) {
      fail('STORAGE_OBJECT_HASH_MISMATCH', 'Storage object does not match its key.')
    }
    const options = {}
    if (range.start !== undefined || range.end !== undefined) {
      const start = range.start ?? 0
      const end = range.end ?? stat.size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= stat.size) {
        fail('STORAGE_RANGE_INVALID', 'Storage byte range is invalid.')
      }
      options.start = start
      options.end = end
    }
    return fs.createReadStream(objectPath, options)
  }

  discardStaged(token) {
    const stagedPath = this.stagingFile(token)
    let stat
    try { stat = fs.lstatSync(stagedPath) } catch (error) {
      if (error?.code === 'ENOENT') return false
      fail('STORAGE_STAGING_INVALID', 'Staged object could not be inspected.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STORAGE_STAGING_INVALID', 'Staged object must be a regular file.')
    fs.rmSync(stagedPath)
    return true
  }

  async trashObject({ storageKey, activeReferenceCount } = {}) {
    if (!Number.isSafeInteger(activeReferenceCount) || activeReferenceCount < 0) {
      fail('STORAGE_REFERENCE_PROOF_INVALID', 'Active reference count must be a non-negative integer.')
    }
    if (activeReferenceCount !== 0) {
      fail('STORAGE_OBJECT_REFERENCED', 'Referenced storage objects cannot be moved to trash.')
    }
    const metadata = await this.stat(storageKey)
    const objectPath = this.objectFile(storageKey)
    const trashToken = randomToken(this.randomBytes)
    const temporaryPath = path.join(this.trashPath, `.${trashToken}.tmp`)
    const finalPath = path.join(this.trashPath, trashToken)
    try {
      fs.mkdirSync(temporaryPath)
      fs.linkSync(objectPath, path.join(temporaryPath, 'object'))
      fs.writeFileSync(path.join(temporaryPath, 'manifest.json'), `${JSON.stringify({
        formatVersion: 1,
        trashToken,
        storageKey,
        sha256: metadata.sha256,
        bytes: metadata.bytes,
        deletedAt: new Date().toISOString()
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      fs.renameSync(temporaryPath, finalPath)
      fs.rmSync(objectPath)
      return Object.freeze({ trashToken, storageKey, sha256: metadata.sha256, bytes: metadata.bytes })
    } catch (error) {
      fs.rmSync(temporaryPath, { recursive: true, force: true })
      if (error instanceof StorageServiceError) throw error
      fail('STORAGE_TRASH_FAILED', 'Storage object could not be moved to trash.', error)
    }
  }

  async restoreTrashed(trashToken) {
    if (!STAGING_TOKEN_PATTERN.test(trashToken ?? '')) {
      fail('STORAGE_TRASH_TOKEN_INVALID', 'Trash token is invalid.')
    }
    const trashDirectory = path.join(this.trashPath, trashToken)
    let directoryStat
    try { directoryStat = fs.lstatSync(trashDirectory) } catch (error) {
      fail('STORAGE_TRASH_MISSING', 'Trash entry does not exist.', error)
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      fail('STORAGE_TRASH_INVALID', 'Trash entry must be a real directory.')
    }
    const realTrashDirectory = fs.realpathSync.native(trashDirectory)
    if (!isWithin(this.trashPath, realTrashDirectory)) {
      fail('STORAGE_TRASH_INVALID', 'Trash entry escaped the trash root.')
    }
    const manifestPath = path.join(realTrashDirectory, 'manifest.json')
    let manifestStat
    try { manifestStat = fs.lstatSync(manifestPath) } catch (error) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest is missing.', error)
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest must be a regular file.')
    }
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch (error) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest is invalid.', error)
    }
    if (manifest?.formatVersion !== 1 || manifest.trashToken !== trashToken ||
      !HASH_PATTERN.test(manifest.sha256 ?? '') || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 ||
      createStorageKey(parseStorageKey(manifest.storageKey).kind, manifest.sha256) !== manifest.storageKey) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest is invalid.')
    }
    const trashedObject = path.join(realTrashDirectory, 'object')
    let trashedStat
    try { trashedStat = fs.lstatSync(trashedObject) } catch (error) {
      fail('STORAGE_TRASH_INVALID', 'Trashed object is missing.', error)
    }
    if (!trashedStat.isFile() || trashedStat.isSymbolicLink()) {
      fail('STORAGE_TRASH_INVALID', 'Trashed object must be a regular file.')
    }
    const actual = await hashFile(trashedObject)
    if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes) {
      fail('STORAGE_TRASH_HASH_MISMATCH', 'Trashed object does not match its manifest.')
    }
    const objectPath = this.objectFile(manifest.storageKey, { createParents: true })
    try {
      fs.linkSync(trashedObject, objectPath)
    } catch (error) {
      if (error?.code !== 'EEXIST') fail('STORAGE_RESTORE_FAILED', 'Trashed object could not be restored.', error)
      const existing = await hashFile(objectPath)
      if (existing.sha256 !== manifest.sha256 || existing.bytes !== manifest.bytes) {
        fail('STORAGE_OBJECT_COLLISION', 'Existing storage object does not match the trash entry.')
      }
    }
    fs.rmSync(realTrashDirectory, { recursive: true })
    return Object.freeze({ storageKey: manifest.storageKey, sha256: manifest.sha256, bytes: manifest.bytes })
  }

  async purgeTrashed(trashToken) {
    if (!STAGING_TOKEN_PATTERN.test(trashToken ?? '')) {
      fail('STORAGE_TRASH_TOKEN_INVALID', 'Trash token is invalid.')
    }
    const trashDirectory = path.join(this.trashPath, trashToken)
    let stat
    try { stat = fs.lstatSync(trashDirectory) } catch (error) {
      fail('STORAGE_TRASH_MISSING', 'Trash entry does not exist.', error)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('STORAGE_TRASH_INVALID', 'Trash entry must be a real directory.')
    }
    const real = fs.realpathSync.native(trashDirectory)
    if (!isWithin(this.trashPath, real)) fail('STORAGE_TRASH_INVALID', 'Trash entry escaped the trash root.')
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(path.join(real, 'manifest.json'), 'utf8')) } catch (error) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest is invalid.', error)
    }
    if (manifest?.formatVersion !== 1 || manifest.trashToken !== trashToken ||
      !HASH_PATTERN.test(manifest.sha256 ?? '') || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 ||
      createStorageKey(parseStorageKey(manifest.storageKey).kind, manifest.sha256) !== manifest.storageKey) {
      fail('STORAGE_TRASH_INVALID', 'Trash manifest is invalid.')
    }
    const objectPath = path.join(real, 'object')
    let objectStat
    try { objectStat = fs.lstatSync(objectPath) } catch (error) {
      fail('STORAGE_TRASH_INVALID', 'Trashed object is missing.', error)
    }
    if (!objectStat.isFile() || objectStat.isSymbolicLink()) {
      fail('STORAGE_TRASH_INVALID', 'Trashed object must be a regular file.')
    }
    const actual = await hashFile(objectPath)
    if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes) {
      fail('STORAGE_TRASH_HASH_MISMATCH', 'Trashed object does not match its manifest.')
    }
    fs.rmSync(real, { recursive: true })
    return Object.freeze({ storageKey: manifest.storageKey, sha256: manifest.sha256, bytes: manifest.bytes })
  }
}
