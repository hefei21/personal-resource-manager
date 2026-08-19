import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LegacyStorageAdapter } from '../src/services/legacyStorageAdapter.js'

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-legacy-storage-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }
async function text(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8') }

test('reads regular legacy files only from explicitly declared roots', async () => {
  const directory = tempRoot()
  try {
    const documents = path.join(directory, 'documents')
    const books = path.join(directory, 'books')
    fs.mkdirSync(documents)
    fs.mkdirSync(books)
    const document = path.join(documents, 'doc.txt')
    const book = path.join(books, 'book.txt')
    fs.writeFileSync(document, 'document')
    fs.writeFileSync(book, 'book')
    const adapter = new LegacyStorageAdapter({ roots: [documents, books, documents] })
    assert.equal(adapter.roots.length, 2)
    assert.equal(adapter.stat(document).bytes, 8)
    assert.equal(await text(adapter.createReadStream(book)), 'book')
    assert.equal(await text(adapter.createReadStream(document, { start: 1, end: 3 })), 'ocu')
  } finally { cleanup(directory) }
})

test('rejects traversal, sibling-prefix, missing, directory and relative paths outside roots', () => {
  const directory = tempRoot()
  try {
    const root = path.join(directory, 'docs')
    const sibling = path.join(directory, 'docs-private')
    fs.mkdirSync(root)
    fs.mkdirSync(sibling)
    const adapter = new LegacyStorageAdapter({ roots: [root] })
    const outside = path.join(sibling, 'secret.txt')
    fs.writeFileSync(outside, 'secret')
    assert.throws(() => adapter.stat(outside), { code: 'LEGACY_STORAGE_OUTSIDE_ROOT' })
    assert.throws(() => adapter.stat(path.join(root, '..', 'docs-private', 'secret.txt')), { code: 'LEGACY_STORAGE_OUTSIDE_ROOT' })
    assert.throws(() => adapter.stat(path.join(root, 'missing.txt')), { code: 'LEGACY_STORAGE_FILE_MISSING' })
    assert.throws(() => adapter.stat(root), { code: 'LEGACY_STORAGE_OUTSIDE_ROOT' })
    assert.throws(() => adapter.stat(path.join('docs', 'relative.txt')), { code: 'LEGACY_STORAGE_PATH_INVALID' })
  } finally { cleanup(directory) }
})

test('rejects file and intermediate directory symlinks', (context) => {
  if (process.platform === 'win32') {
    context.skip('legacy symlink chains are covered by Linux CI')
    return
  }
  const directory = tempRoot()
  try {
    const root = path.join(directory, 'root')
    const outside = path.join(directory, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    const target = path.join(outside, 'secret.txt')
    fs.writeFileSync(target, 'secret')
    fs.symlinkSync(target, path.join(root, 'file-link.txt'))
    fs.symlinkSync(outside, path.join(root, 'dir-link'), 'dir')
    const adapter = new LegacyStorageAdapter({ roots: [root] })
    assert.throws(() => adapter.stat(path.join(root, 'file-link.txt')), { code: 'LEGACY_STORAGE_SYMLINK_REJECTED' })
    assert.throws(() => adapter.stat(path.join(root, 'dir-link', 'secret.txt')), { code: 'LEGACY_STORAGE_SYMLINK_REJECTED' })
  } finally { cleanup(directory) }
})

test('rejects invalid ranges and never exposes write or delete methods', () => {
  const directory = tempRoot()
  try {
    const root = path.join(directory, 'root')
    fs.mkdirSync(root)
    const file = path.join(root, 'file.txt')
    fs.writeFileSync(file, 'content')
    const adapter = new LegacyStorageAdapter({ roots: [root] })
    assert.throws(() => adapter.createReadStream(file, { start: 2, end: 99 }), { code: 'LEGACY_STORAGE_RANGE_INVALID' })
    assert.equal(adapter.write, undefined)
    assert.equal(adapter.delete, undefined)
  } finally { cleanup(directory) }
})
