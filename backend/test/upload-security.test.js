import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mergeChunkFiles, uploadPath, validateArchiveEntries, validateUploadDescriptor } from '../src/services/uploadSecurity.js'

const policy = { extensions: ['.epub'], maxChunks: 100 }

test('validates safe upload descriptors', () => {
  assert.deepEqual(validateUploadDescriptor({ fileId: '12345678-safe', fileName: 'book.epub', totalChunks: '2', index: '1' }, policy), {
    fileId: '12345678-safe', fileName: 'book.epub', extension: '.epub', totalChunks: 2, chunkIndex: 1
  })
})

test('rejects traversal identifiers and filenames', () => {
  assert.throws(() => validateUploadDescriptor({ fileId: '../escape', fileName: 'book.epub', totalChunks: 1 }, policy))
  assert.throws(() => validateUploadDescriptor({ fileId: '12345678-safe', fileName: '../book.epub', totalChunks: 1 }, policy))
  assert.throws(() => uploadPath('C:/safe/root', '..', 'escape'))
})

test('merges chunks without loading the whole upload into memory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-upload-'))
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  const output = path.join(root, 'output')
  fs.writeFileSync(first, 'hello ')
  fs.writeFileSync(second, 'world')
  await mergeChunkFiles([first, second], output)
  assert.equal(fs.readFileSync(output, 'utf8'), 'hello world')
  fs.rmSync(root, { recursive: true, force: true })
})

test('rejects archive traversal and decompression bombs', () => {
  assert.throws(() => validateArchiveEntries([{ entryName: '../escape', header: { size: 1, compressedSize: 1 } }]))
  assert.throws(() => validateArchiveEntries([{ entryName: 'huge.txt', header: { size: 20 * 1024 * 1024, compressedSize: 1024 } }]))
  assert.deepEqual(validateArchiveEntries([{ entryName: 'OPS/content.xhtml', header: { size: 10, compressedSize: 8 } }]), {
    entryCount: 1,
    expandedBytes: 10
  })
})
