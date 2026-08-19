import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { RESTORE_MARKER_FILE } from '../../src/config/databaseBackup.js'
import { createStorageKey } from '../../src/services/storageService.js'

export const CONSISTENCY_FIXTURE_MARKER = '.prm-storage-consistency-fixture.json'
export const CONSISTENCY_FAULT_CODES = Object.freeze([
  'DUPLICATE_BUSINESS_REFERENCE',
  'EXPIRED_STAGING',
  'INVALID_STORAGE_KEY',
  'MISSING_OBJECT',
  'OBJECT_HASH_MISMATCH',
  'OBJECT_METADATA_MISMATCH',
  'ORPHAN_OBJECT'
])

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function realDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') fail('CONSISTENCY_FIXTURE_ROOT_INVALID', 'Fixture root is required.')
  let real
  let stat
  try {
    real = fs.realpathSync.native(path.resolve(value))
    stat = fs.lstatSync(real)
  } catch {
    fail('CONSISTENCY_FIXTURE_ROOT_INVALID', 'Fixture root is unavailable.')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONSISTENCY_FIXTURE_ROOT_INVALID', 'Fixture root must be a real directory.')
  return real
}

function assertWithin(root, candidate) {
  const real = realDirectory(candidate)
  const relative = path.relative(root, real)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CONSISTENCY_FIXTURE_PATH_OUTSIDE_ROOT', 'Fixture path escaped the isolated root.')
  }
  return real
}

function readJson(filePath, code) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { fail(code, 'Fixture marker is missing or invalid.') }
}

export function prepareConsistencyFaultRoot({ rootPath, token } = {}) {
  const root = realDirectory(rootPath)
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) fail('CONSISTENCY_FIXTURE_TOKEN_INVALID', 'Fixture token is invalid.')
  if (fs.readdirSync(root).length !== 0) fail('CONSISTENCY_FIXTURE_ROOT_NOT_EMPTY', 'Fixture root must be empty.')
  fs.writeFileSync(path.join(root, CONSISTENCY_FIXTURE_MARKER), `${JSON.stringify({
    formatVersion: 1,
    kind: 'storage-consistency-fixture',
    token
  })}\n`, { encoding: 'utf8', flag: 'wx' })
  return Object.freeze({ rootPath: root, token })
}

export function injectConsistencyFaultMatrix({
  rootPath,
  token,
  databaseRoot,
  restoreToken,
  database,
  storageService,
  now
} = {}) {
  const root = realDirectory(rootPath)
  const marker = readJson(path.join(root, CONSISTENCY_FIXTURE_MARKER), 'CONSISTENCY_FIXTURE_MARKER_INVALID')
  if (marker?.formatVersion !== 1 || marker.kind !== 'storage-consistency-fixture' || marker.token !== token) {
    fail('CONSISTENCY_FIXTURE_MARKER_INVALID', 'Fixture marker does not match.')
  }
  const restoredDatabaseRoot = assertWithin(root, databaseRoot)
  const restoredStorageRoot = assertWithin(root, storageService?.rootPath)
  const restoreMarker = readJson(path.join(restoredDatabaseRoot, RESTORE_MARKER_FILE), 'CONSISTENCY_RESTORE_MARKER_INVALID')
  if (restoreMarker?.formatVersion !== 1 || restoreMarker.token !== restoreToken) {
    fail('CONSISTENCY_RESTORE_MARKER_INVALID', 'Database restore marker does not match.')
  }
  if (!database || typeof database.prepare !== 'function') fail('CONSISTENCY_FIXTURE_DATABASE_INVALID', 'Fixture database is required.')
  const currentTime = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(currentTime.getTime())) fail('CONSISTENCY_FIXTURE_TIME_INVALID', 'Fixture time is invalid.')

  const hash = value => createHash('sha256').update(Buffer.from(value)).digest('hex')
  const writeObject = (content) => {
    const sha256 = hash(content)
    const storageKey = createStorageKey('documents', sha256)
    fs.writeFileSync(storageService.objectFile(storageKey, { createParents: true }), content)
    return { storageKey, sha256, bytes: Buffer.byteLength(content) }
  }

  const healthy = database.prepare('SELECT storage_key, content_sha256, content_bytes FROM documents WHERE id = 1').get()
  const corrupt = database.prepare('SELECT storage_key FROM document_versions WHERE id = 2').get()
  if (!healthy?.storage_key || !corrupt?.storage_key) fail('CONSISTENCY_FIXTURE_BASELINE_INVALID', 'Fixture baseline is incomplete.')

  const orphan = writeObject('orphan after isolated restore')
  fs.writeFileSync(storageService.objectFile(corrupt.storage_key), 'tampered after isolated restore')

  const missingHash = hash('missing after isolated restore')
  const missingKey = createStorageKey('documents', missingHash)
  database.prepare(`
    INSERT INTO documents (id, title, file_path, storage_key, content_sha256, content_bytes)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(3, 'missing fixture', missingKey, missingHash, Buffer.byteLength('missing after isolated restore'))
  database.prepare(`
    INSERT INTO documents (id, title, file_path, storage_key, content_sha256, content_bytes)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(4, 'invalid key fixture', 'documents/not-a-key', 'c'.repeat(64), 1)
  database.prepare(`
    INSERT INTO documents (id, title, file_path, storage_key, content_sha256, content_bytes)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(5, 'duplicate fixture', healthy.storage_key, healthy.content_sha256, healthy.content_bytes)

  const expiredToken = 'a'.repeat(32)
  const activeToken = 'b'.repeat(32)
  for (const [stagingToken, content] of [[expiredToken, 'expired'], [activeToken, 'active']]) {
    const target = storageService.stagingFile(stagingToken)
    fs.writeFileSync(target, content)
    const old = new Date(currentTime.getTime() - 48 * 60 * 60 * 1000)
    fs.utimesSync(target, old, old)
  }
  database.prepare(`
    INSERT INTO storage_commit_operations (staging_token, state) VALUES (?, 'staged')
  `).run(activeToken)

  return Object.freeze({
    rootPath: root,
    databaseRoot: restoredDatabaseRoot,
    storageRoot: restoredStorageRoot,
    orphanStorageKey: orphan.storageKey,
    expectedCodes: CONSISTENCY_FAULT_CODES
  })
}
