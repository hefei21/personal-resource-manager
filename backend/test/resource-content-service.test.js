import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createResourceStorageRuntime } from '../src/services/resourceStorageRuntime.js'
import {
  ResourceContentService,
  resolveResourceContentReference
} from '../src/services/resourceContentService.js'

const hash = 'a'.repeat(64)
const storageKey = `ebooks/aa/${hash}`

async function readText(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-resource-content-'))
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

test('validates kind-specific storage metadata and only uses legacy when storage_key is absent', () => {
  assert.deepEqual(resolveResourceContentReference({ storage_key: storageKey, content_sha256: hash, content_bytes: 7 }, 'ebooks'), {
    source: 'storage', kind: 'ebooks', storageKey, sha256: hash, bytes: 7
  })
  assert.deepEqual(resolveResourceContentReference({ file_path: '/legacy/book.epub' }, 'ebooks'), {
    source: 'legacy', kind: 'ebooks', filePath: '/legacy/book.epub'
  })
  assert.throws(() => resolveResourceContentReference({
    storage_key: storageKey, content_sha256: null, content_bytes: null, file_path: '/legacy/book.epub'
  }, 'ebooks'), { code: 'RESOURCE_STORAGE_METADATA_INCOMPLETE' })
  assert.throws(() => resolveResourceContentReference({
    storage_key: `music/aa/${hash}`, content_sha256: hash, content_bytes: 7, file_path: '/legacy/book.epub'
  }, 'ebooks'), { code: 'RESOURCE_STORAGE_KIND_INVALID' })
  assert.throws(() => resolveResourceContentReference({
    storage_key: storageKey, content_sha256: 'b'.repeat(64), content_bytes: 7, file_path: '/legacy/book.epub'
  }, 'ebooks'), { code: 'RESOURCE_STORAGE_METADATA_MISMATCH' })
})
test('prefers managed storage, never falls back after a managed failure, and hides paths from stat/stream results', async () => {
  const calls = []
  const service = new ResourceContentService({
    kind: 'ebooks',
    storageService: {
      async stat(key) {
        calls.push(['storage-stat', key])
        return { sha256: hash, bytes: 7, modifiedAt: 'managed' }
      },
      async createReadStream(key, range) {
        calls.push(['storage-read', key, range])
        return Readable.from(['managed'])
      },
      objectFile(key) {
        calls.push(['storage-path', key])
        return path.join(os.tmpdir(), 'managed-object')
      }
    },
    legacyStorageAdapters: {
      ebooks: {
        stat(filePath) { calls.push(['legacy-stat', filePath]); return { bytes: 6, modifiedAt: 'legacy' } },
        createReadStream(filePath) { calls.push(['legacy-read', filePath]); return Readable.from(['legacy']) },
        resolveFile(filePath) { return { filePath } }
      }
    }
  })
  assert.deepEqual(await service.stat({ storage_key: storageKey, content_sha256: hash, content_bytes: 7, file_path: '/legacy/ignored' }), {
    source: 'storage', storageKey, sha256: hash, bytes: 7, modifiedAt: 'managed'
  })
  const streamed = await service.createReadStream(
    { storage_key: storageKey, content_sha256: hash, content_bytes: 7, file_path: '/legacy/ignored' },
    { start: 1, end: 3 }
  )
  assert.equal(await readText(streamed.stream), 'managed')
  assert.equal(Object.hasOwn(streamed, 'filePath'), false)
  const internal = await service.resolveVerifiedFilePath({ storage_key: storageKey, content_sha256: hash, content_bytes: 7 })
  assert.equal(path.isAbsolute(internal.filePath), true)
  assert.deepEqual(calls, [
    ['storage-stat', storageKey],
    ['storage-read', storageKey, { start: 1, end: 3 }],
    ['storage-stat', storageKey],
    ['storage-path', storageKey]
  ])

  const failing = new ResourceContentService({
    kind: 'ebooks',
    storageService: {
      async stat() { throw Object.assign(new Error('missing'), { code: 'STORAGE_OBJECT_MISSING' }) },
      async createReadStream() { throw Object.assign(new Error('missing'), { code: 'STORAGE_OBJECT_MISSING' }) }
    },
    legacyStorageAdapters: {
      ebooks: {
        stat() { throw new Error('legacy must not be called') },
        createReadStream() { throw new Error('legacy must not be called') }
      }
    }
  })
  await assert.rejects(failing.stat({ storage_key: storageKey, content_sha256: hash, content_bytes: 7, file_path: '/legacy/fallback' }), {
    code: 'RESOURCE_CONTENT_MISSING'
  })
})

test('supports controlled legacy stat, range streams, and verified internal paths', async () => {
  const directory = temporaryDirectory()
  try {
    const storageRoot = path.join(directory, 'storage')
    const legacyRoot = path.join(directory, 'books')
    const musicLegacyRoot = path.join(directory, 'music')
    fs.mkdirSync(legacyRoot)
    fs.mkdirSync(musicLegacyRoot)
    const legacyFile = path.join(legacyRoot, 'book.epub')
    fs.writeFileSync(legacyFile, 'legacy-content')
    const runtime = createResourceStorageRuntime({ storageRoot, ebooksLegacyRoot: legacyRoot, musicLegacyRoot })
    const resource = { file_path: legacyFile }
    assert.deepEqual(await runtime.contentService.stat(resource), {
      source: 'legacy', bytes: 14, modifiedAt: fs.statSync(legacyFile).mtime.toISOString()
    })
    const streamed = await runtime.contentService.createReadStream(resource, { start: 1, end: 6 })
    assert.equal(await readText(streamed.stream), 'egacy-')
    const verified = await runtime.contentService.resolveInternalFilePath(resource)
    assert.equal(verified.filePath, fs.realpathSync.native(legacyFile))
    assert.equal(runtime.storageService.rootPath, fs.realpathSync.native(storageRoot))
    assert.equal(runtime.contentServiceFor('music').defaultKind, 'music')
  } finally {
    cleanup(directory)
  }
})
