import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
  StorageService,
  createStorageKey,
  parseStorageKey
} from '../src/services/storageService.js'

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-storage-service-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }
function sha256(value) { return createHash('sha256').update(Buffer.from(value)).digest('hex') }
function deterministicRandomBytes() { return Buffer.alloc(16, 0xab) }

async function streamText(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('storage keys are canonical content addresses and reject traversal forms', () => {
  const hash = 'a'.repeat(64)
  assert.equal(createStorageKey('documents', hash), `documents/aa/${hash}`)
  assert.deepEqual(parseStorageKey(`documents/aa/${hash}`), {
    kind: 'documents', prefix: 'aa', sha256: hash
  })
  for (const value of [
    `documents/bb/${hash}`,
    `documents/aa/${hash}/extra`,
    `../documents/aa/${hash}`,
    `documents\\aa\\${hash}`,
    `Documents/aa/${hash}`
  ]) {
    assert.throws(() => parseStorageKey(value), { code: 'STORAGE_KEY_INVALID' })
  }
})

test('streams staging, hashes content, commits atomically, and reads ranges', async () => {
  const directory = root()
  try {
    const service = new StorageService({ rootPath: directory, randomBytes: deterministicRandomBytes })
    const content = 'streamed-content'
    const staged = await service.stageFromStream(Readable.from([content.slice(0, 7), content.slice(7)]))
    assert.equal(staged.token, 'abababababababababababababababab')
    assert.equal(staged.sha256, sha256(content))
    assert.equal(staged.bytes, Buffer.byteLength(content))
    const committed = await service.commitStaged({
      token: staged.token,
      kind: 'documents',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes
    })
    assert.equal(committed.reused, false)
    assert.equal(committed.storageKey, createStorageKey('documents', staged.sha256))
    assert.equal(await streamText(await service.createReadStream(committed.storageKey)), content)
    assert.equal(await streamText(await service.createReadStream(committed.storageKey, { start: 2, end: 7 })), 'reamed')
    const metadata = await service.stat(committed.storageKey)
    assert.equal(metadata.bytes, Buffer.byteLength(content))
    assert.equal(metadata.sha256, staged.sha256)
    assert.match(metadata.modifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally { cleanup(directory) }
})

test('deduplicates matching content without overwriting the existing object', async () => {
  const directory = root()
  try {
    let counter = 0
    const service = new StorageService({
      rootPath: directory,
      randomBytes: () => Buffer.alloc(16, ++counter)
    })
    const first = await service.stageFromStream(Readable.from(['same-content']))
    const firstCommit = await service.commitStaged({ token: first.token, kind: 'documents' })
    const objectPath = service.objectFile(firstCommit.storageKey)
    const firstMtime = fs.statSync(objectPath).mtimeMs
    const second = await service.stageFromStream(Readable.from(['same-content']))
    const secondCommit = await service.commitStaged({ token: second.token, kind: 'documents' })
    assert.equal(secondCommit.reused, true)
    assert.equal(secondCommit.storageKey, firstCommit.storageKey)
    assert.equal(fs.statSync(objectPath).mtimeMs, firstMtime)
    assert.equal(fs.existsSync(service.stagingFile(second.token)), false)
  } finally { cleanup(directory) }
})

test('keeps staged data for retry when metadata or commit validation fails', async () => {
  const directory = root()
  try {
    const service = new StorageService({ rootPath: directory, randomBytes: deterministicRandomBytes })
    const staged = await service.stageFromStream(Readable.from(['retry-me']))
    await assert.rejects(service.commitStaged({
      token: staged.token,
      kind: 'documents',
      expectedSha256: '0'.repeat(64)
    }), { code: 'STORAGE_STAGING_MISMATCH' })
    assert.equal(fs.existsSync(service.stagingFile(staged.token)), true)
    const committed = await service.commitStaged({ token: staged.token, kind: 'documents' })
    assert.equal(committed.reused, false)
  } finally { cleanup(directory) }
})

test('rejects tampered objects, invalid ranges, symlinks, and staging token reuse', async (context) => {
  const directory = root()
  try {
    const service = new StorageService({ rootPath: directory, randomBytes: deterministicRandomBytes })
    const staged = await service.stageFromStream(Readable.from(['original']))
    const committed = await service.commitStaged({ token: staged.token, kind: 'documents' })
    await assert.rejects(service.commitStaged({ token: staged.token, kind: 'documents' }), {
      code: 'STORAGE_STAGING_MISSING'
    })
    await assert.rejects(service.createReadStream(committed.storageKey, { start: 5, end: 100 }), {
      code: 'STORAGE_RANGE_INVALID'
    })
    fs.writeFileSync(service.objectFile(committed.storageKey), 'tampered')
    await assert.rejects(service.stat(committed.storageKey), { code: 'STORAGE_OBJECT_HASH_MISMATCH' })
    await assert.rejects(service.createReadStream(committed.storageKey), { code: 'STORAGE_OBJECT_HASH_MISMATCH' })

    if (process.platform === 'win32') {
      context.diagnostic('symlink branch is covered by Linux CI on Windows hosts without link privileges')
      return
    }
    const hash = sha256('link-target')
    const key = createStorageKey('documents', hash)
    const objectPath = service.objectFile(key)
    fs.mkdirSync(path.dirname(objectPath), { recursive: true })
    const target = path.join(directory, 'outside.txt')
    fs.writeFileSync(target, 'link-target')
    fs.symlinkSync(target, objectPath)
    await assert.rejects(service.createReadStream(key), { code: 'STORAGE_OBJECT_INVALID' })
  } finally { cleanup(directory) }
})

test('rejects managed directory symlinks before any storage operation', (context) => {
  if (process.platform === 'win32') {
    context.skip('directory symlink branch is covered by Linux CI')
    return
  }
  const directory = root()
  try {
    const outside = path.join(directory, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(directory, 'objects'), 'dir')
    assert.throws(() => new StorageService({ rootPath: directory }), {
      code: 'STORAGE_DIRECTORY_INVALID'
    })
  } finally { cleanup(directory) }
})

test('rejects symlinks in kind and hash-prefix directories', async (context) => {
  if (process.platform === 'win32') {
    context.skip('nested directory symlink branch is covered by Linux CI')
    return
  }
  const directory = root()
  try {
    const service = new StorageService({ rootPath: directory, randomBytes: deterministicRandomBytes })
    const staged = await service.stageFromStream(Readable.from(['escape']))
    const key = createStorageKey('documents', staged.sha256)
    const outside = path.join(directory, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(service.objectsPath, 'documents'), 'dir')
    await assert.rejects(service.commitStaged({ token: staged.token, kind: 'documents' }), {
      code: 'STORAGE_DIRECTORY_INVALID'
    })
    assert.equal(fs.readdirSync(outside).length, 0)
    assert.equal(fs.existsSync(service.stagingFile(staged.token)), true)
    assert.throws(() => service.objectFile(key), { code: 'STORAGE_DIRECTORY_INVALID' })
  } finally { cleanup(directory) }
})

test('discard is idempotent and never accepts a non-file staging entry', async () => {
  const directory = root()
  try {
    const service = new StorageService({ rootPath: directory, randomBytes: deterministicRandomBytes })
    const staged = await service.stageFromStream(Readable.from(['discard']))
    assert.equal(service.discardStaged(staged.token), true)
    assert.equal(service.discardStaged(staged.token), false)
    fs.mkdirSync(service.stagingFile(staged.token))
    assert.throws(() => service.discardStaged(staged.token), { code: 'STORAGE_STAGING_INVALID' })
  } finally { cleanup(directory) }
})
