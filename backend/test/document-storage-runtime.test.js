import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import {
  createDocumentStorageRuntime,
  documentOriginalName,
  resolveDocumentContentBytes
} from '../src/services/documentStorageRuntime.js'
import { DocumentUploadStorage } from '../src/services/documentUploadStorage.js'

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-document-runtime-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }

test('builds an isolated document runtime with explicit managed and legacy roots', async () => {
  const directory = root()
  try {
    const storageRoot = path.join(directory, 'storage')
    const legacyRoot = path.join(directory, 'legacy')
    fs.mkdirSync(legacyRoot)
    const legacyFile = path.join(legacyRoot, 'old.txt')
    fs.writeFileSync(legacyFile, 'old')
    const runtime = createDocumentStorageRuntime({ storageRoot, legacyRoots: [legacyRoot] })
    assert.equal((await runtime.contentService.stat({ file_path: legacyFile })).bytes, 3)
    assert.equal(runtime.storageService.rootPath, fs.realpathSync.native(storageRoot))
  } finally { cleanup(directory) }
})

test('streams Multer files into StorageService staging and removes abandoned staging', async () => {
  const calls = []
  const runtime = {
    storageService: {
      async stageFromStream(stream) {
        let value = ''
        for await (const chunk of stream) value += chunk.toString()
        calls.push(['stage', value])
        return { token: 'a'.repeat(32), sha256: 'b'.repeat(64), bytes: value.length }
      },
      discardStaged(token) { calls.push(['discard', token]); return true }
    }
  }
  const engine = new DocumentUploadStorage({ runtimeProvider: () => runtime })
  const file = { originalname: 'note.txt', stream: Readable.from(['content']) }
  const staged = await new Promise((resolve, reject) => engine._handleFile({}, file, (error, value) => error ? reject(error) : resolve(value)))
  assert.deepEqual(staged, {
    stagingToken: 'a'.repeat(32), contentSha256: 'b'.repeat(64), contentBytes: 7, originalName: 'note.txt'
  })
  await new Promise((resolve, reject) => engine._removeFile({}, staged, (error) => error ? reject(error) : resolve()))
  assert.deepEqual(calls, [['stage', 'content'], ['discard', 'a'.repeat(32)]])
})

test('propagates staging failures without fabricating file metadata', async () => {
  const engine = new DocumentUploadStorage({ runtimeProvider: () => ({
    storageService: { stageFromStream: async () => { throw Object.assign(new Error('failed'), { code: 'STORAGE_STAGE_FAILED' }) } }
  }) })
  const file = { originalname: 'note.txt', stream: new PassThrough() }
  file.stream.end('content')
  await assert.rejects(new Promise((resolve, reject) => engine._handleFile({}, file, (error, value) => error ? reject(error) : resolve(value))), {
    code: 'STORAGE_STAGE_FAILED'
  })
})

test('normalizes display-only original names without retaining client paths or controls', () => {
  assert.equal(documentOriginalName('C:\\fakepath\\report.txt'), 'report.txt')
  assert.equal(documentOriginalName('../report\u0000.txt'), 'report.txt')
  const mojibake = Buffer.from('北辰灯塔-运维说明.docx', 'utf8').toString('latin1')
  assert.equal(documentOriginalName(mojibake), '北辰灯塔-运维说明.docx')
  assert.equal(documentOriginalName('Ångström notes.txt'), 'Ångström notes.txt')
  assert.equal(documentOriginalName('  '), 'document')
})

test('resolves document bytes from metadata, current version, or legacy content without fabricating zero', async () => {
  let statCalls = 0
  const contentService = {
    async stat() {
      statCalls += 1
      return { bytes: 37 }
    }
  }

  assert.equal(await resolveDocumentContentBytes(contentService, { content_bytes: 12 }), 12)
  assert.equal(await resolveDocumentContentBytes(contentService, { content_bytes: null, current_version_content_bytes: 24 }), 24)
  assert.equal(await resolveDocumentContentBytes(contentService, { content_bytes: null }), 37)
  assert.equal(statCalls, 1)
  assert.equal(await resolveDocumentContentBytes({ stat: async () => { throw new Error('missing') } }, {}), null)
})
