import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { StorageConsistencyService } from '../src/services/storageConsistencyService.js'
import { createStorageKey, StorageService } from '../src/services/storageService.js'

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-storage-consistency-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }
function sha256(value) { return createHash('sha256').update(Buffer.from(value)).digest('hex') }

function databaseFixture({ documents = [], versions = [], ebooks = [], music = [], operations = [] } = {}) {
  const state = structuredClone({ documents, versions, ebooks, music, operations })
  return {
    state,
    prepare(sql) {
      if (sql.includes('FROM document_versions')) return { all: () => structuredClone(state.versions) }
      if (sql.includes('FROM documents')) return { all: () => structuredClone(state.documents) }
      if (sql.includes('FROM books')) return { all: () => structuredClone(state.ebooks) }
      if (sql.includes('FROM music')) return { all: () => structuredClone(state.music) }
      if (sql.includes('FROM storage_commit_operations')) return { all: () => structuredClone(state.operations) }
      throw new Error(`Unexpected read: ${sql}`)
    }
  }
}

function writeObject(service, kind, content, storedContent = content) {
  const hash = sha256(content)
  const key = createStorageKey(kind, hash)
  const filePath = service.objectFile(key, { createParents: true })
  fs.writeFileSync(filePath, storedContent)
  return { key, hash, bytes: Buffer.byteLength(content), filePath }
}

function treeSnapshot(directory) {
  const walk = current => fs.readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const full = path.join(current, entry.name)
      const relative = path.relative(directory, full)
      const stat = fs.lstatSync(full)
      if (entry.isDirectory()) return [{ relative, type: 'directory', mtimeMs: stat.mtimeMs }, ...walk(full)]
      return [{
        relative,
        type: entry.isSymbolicLink() ? 'symlink' : 'file',
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: entry.isSymbolicLink() ? null : sha256(fs.readFileSync(full))
      }]
    })
  return walk(directory)
}

test('detects all six consistency fault classes without changing database or storage', async () => {
  const directory = root()
  try {
    const storageService = new StorageService({ rootPath: directory })
    const healthy = writeObject(storageService, 'documents', 'healthy')
    const orphan = writeObject(storageService, 'documents', 'orphan')
    const corrupt = writeObject(storageService, 'documents', 'expected', 'corrupted')
    const duplicate = writeObject(storageService, 'documents', 'duplicate')
    const missingHash = sha256('missing')
    const missingKey = createStorageKey('documents', missingHash)
    const invalidDirectory = path.join(storageService.objectsPath, 'bad kind')
    fs.mkdirSync(invalidDirectory)
    fs.writeFileSync(path.join(invalidDirectory, 'entry'), 'invalid')

    const expiredToken = 'a'.repeat(32)
    const activeToken = 'b'.repeat(32)
    const expiredPath = path.join(storageService.stagingPath, expiredToken)
    const activePath = path.join(storageService.stagingPath, activeToken)
    fs.writeFileSync(expiredPath, 'expired')
    fs.writeFileSync(activePath, 'active')
    const old = new Date('2026-08-10T00:00:00.000Z')
    fs.utimesSync(expiredPath, old, old)
    fs.utimesSync(activePath, old, old)

    const documents = [
      { id: 1, storage_key: healthy.key, content_sha256: healthy.hash, content_bytes: healthy.bytes, file_path: null },
      { id: 2, storage_key: missingKey, content_sha256: missingHash, content_bytes: 7, file_path: null },
      { id: 3, storage_key: corrupt.key, content_sha256: corrupt.hash, content_bytes: corrupt.bytes, file_path: null },
      { id: 4, storage_key: 'documents/not-a-key', content_sha256: 'c'.repeat(64), content_bytes: 1, file_path: null },
      { id: 5, storage_key: duplicate.key, content_sha256: duplicate.hash, content_bytes: duplicate.bytes, file_path: null },
      { id: 6, storage_key: duplicate.key, content_sha256: duplicate.hash, content_bytes: duplicate.bytes, file_path: null },
      { id: 7, storage_key: null, content_sha256: null, content_bytes: null, file_path: '/legacy/private-name.txt' }
    ]
    const versions = [
      { id: 10, document_id: 1, storage_key: healthy.key, content_sha256: healthy.hash, content_bytes: healthy.bytes, file_path: null },
      { id: 11, document_id: 1, storage_key: healthy.key, content_sha256: healthy.hash, content_bytes: healthy.bytes, file_path: null }
    ]
    const database = databaseFixture({ documents, versions, operations: [{ staging_token: activeToken, state: 'staged' }] })
    const beforeTree = treeSnapshot(directory)
    const beforeDatabase = structuredClone(database.state)

    const result = await new StorageConsistencyService({
      database,
      storageService,
      now: new Date('2026-08-14T00:00:00.000Z'),
      stagingMaxAgeMs: 24 * 60 * 60 * 1000
    }).inspect()

    const codes = new Set(result.issues.map(value => value.code))
    for (const code of [
      'ORPHAN_OBJECT', 'MISSING_OBJECT', 'OBJECT_HASH_MISMATCH', 'OBJECT_METADATA_MISMATCH',
      'INVALID_STORAGE_KEY', 'EXPIRED_STAGING', 'DUPLICATE_BUSINESS_REFERENCE'
    ]) assert.equal(codes.has(code), true, code)
    assert.equal(result.issues.some(value => value.objectId.includes(directory)), false)
    assert.equal(JSON.stringify(result).includes('private-name.txt'), false)
    assert.deepEqual(database.state, beforeDatabase)
    assert.deepEqual(treeSnapshot(directory), beforeTree)
    assert.equal(result.issues.filter(value => value.code === 'EXPIRED_STAGING').length, 1)
    assert.equal(result.issues.some(value => value.code === 'DUPLICATE_BUSINESS_REFERENCE' &&
      value.evidence.currentDocumentCount === 1), false)
    assert.equal(result.issues.some(value => value.objectId === healthy.key), false)
    assert.equal(orphan.bytes > 0, true)
  } finally { cleanup(directory) }
})

test('healthy, legitimate version deduplication, active staging and legacy-only rows do not report issues', async () => {
  const directory = root()
  try {
    const storageService = new StorageService({ rootPath: directory })
    const content = writeObject(storageService, 'documents', 'shared-version-content')
    const ebookContent = writeObject(storageService, 'ebooks', 'shared-ebook-content')
    const musicContent = writeObject(storageService, 'music', 'shared-music-content')
    const activeToken = 'd'.repeat(32)
    fs.writeFileSync(path.join(storageService.stagingPath, activeToken), 'active')
    const old = new Date('2026-08-01T00:00:00.000Z')
    fs.utimesSync(path.join(storageService.stagingPath, activeToken), old, old)
    const database = databaseFixture({
      documents: [
        { id: 1, storage_key: content.key, content_sha256: content.hash, content_bytes: content.bytes, file_path: null },
        { id: 2, storage_key: null, content_sha256: null, content_bytes: null, file_path: '/legacy/file.txt' }
      ],
      versions: [
        { id: 3, document_id: 1, storage_key: content.key, content_sha256: content.hash, content_bytes: content.bytes, file_path: null },
        { id: 4, document_id: 1, storage_key: content.key, content_sha256: content.hash, content_bytes: content.bytes, file_path: null }
      ],
      ebooks: [
        { id: 5, storage_key: ebookContent.key, content_sha256: ebookContent.hash, content_bytes: ebookContent.bytes },
        { id: 6, storage_key: ebookContent.key, content_sha256: ebookContent.hash, content_bytes: ebookContent.bytes },
        { id: 7, storage_key: null, content_sha256: null, content_bytes: null }
      ],
      music: [
        { id: 8, storage_key: musicContent.key, content_sha256: musicContent.hash, content_bytes: musicContent.bytes },
        { id: 9, storage_key: musicContent.key, content_sha256: musicContent.hash, content_bytes: musicContent.bytes },
        { id: 10, storage_key: null, content_sha256: null, content_bytes: null }
      ],
      operations: [{ staging_token: activeToken, state: 'staged' }]
    })
    const result = await new StorageConsistencyService({
      database, storageService, now: new Date('2026-08-14T00:00:00.000Z'), stagingMaxAgeMs: 1
    }).inspect()
    assert.deepEqual(result.issues, [])
  } finally { cleanup(directory) }
})

test('reports a business reference whose storage kind does not match its table', async () => {
  const directory = root()
  try {
    const storageService = new StorageService({ rootPath: directory })
    const musicContent = writeObject(storageService, 'music', 'wrong-kind-reference')
    const database = databaseFixture({
      ebooks: [{
        id: 1,
        storage_key: musicContent.key,
        content_sha256: musicContent.hash,
        content_bytes: musicContent.bytes
      }]
    })
    const result = await new StorageConsistencyService({
      database, storageService, now: new Date('2026-08-14T00:00:00.000Z')
    }).inspect()
    assert.equal(result.issues.some(value => value.code === 'STORAGE_METADATA_MISMATCH' &&
      value.evidence.source === 'ebook'), true)
    assert.equal(result.issues.some(value => value.code === 'ORPHAN_OBJECT'), false)
  } finally { cleanup(directory) }
})

test('fails closed on symbolic links in managed object and staging trees', async () => {
  const directory = root()
  try {
    const storageService = new StorageService({ rootPath: directory })
    const outside = path.join(directory, 'outside.txt')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, path.join(storageService.stagingPath, 'e'.repeat(32)))
    const service = new StorageConsistencyService({
      database: databaseFixture(), storageService, now: new Date('2026-08-14T00:00:00.000Z')
    })
    await assert.rejects(service.inspect(), { code: 'CONSISTENCY_STORAGE_LAYOUT_INVALID' })
    fs.rmSync(path.join(storageService.stagingPath, 'e'.repeat(32)))

    const outsideDirectory = path.join(directory, 'outside-directory')
    fs.mkdirSync(outsideDirectory)
    fs.symlinkSync(outsideDirectory, path.join(storageService.objectsPath, 'documents'), 'dir')
    await assert.rejects(service.inspect(), { code: 'CONSISTENCY_STORAGE_LAYOUT_INVALID' })
  } finally { cleanup(directory) }
})
