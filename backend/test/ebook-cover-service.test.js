import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import sharp from 'sharp'
import {
  encodeEbookCoverJpeg,
  ensureEbookCover,
  resolveExistingEbookCover
} from '../src/services/ebookCoverService.js'

const jpeg = (...bytes) => Buffer.from([0xFF, 0xD8, 0xFF, ...bytes])

test('encodes PNG cover input as a bounded real JPEG', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#336699' }
  }).png().toBuffer()
  const encoded = await encodeEbookCoverJpeg(png)
  const metadata = await sharp(encoded).metadata()
  assert.deepEqual([...encoded.subarray(0, 3)], [0xFF, 0xD8, 0xFF])
  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.width, 2)
  assert.equal(metadata.height, 2)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-ebook-cover-'))
  const booksRoot = path.join(root, 'books')
  fs.mkdirSync(booksRoot)
  return { root, booksRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('returns an existing regular cover inside the covers root', async () => {
  const value = fixture()
  try {
    const coversRoot = path.join(value.booksRoot, 'covers')
    fs.mkdirSync(coversRoot)
    const coverPath = path.join(coversRoot, 'existing.jpg')
    fs.writeFileSync(coverPath, 'cover')
    let resolved = false
    const result = await ensureEbookCover({
      book: { id: 1, cover_image: coverPath, file_type: 'epub' },
      booksRoot: value.booksRoot,
      resolveBookPath: async () => { resolved = true },
      extractCover: async () => null,
      compressCover: async () => jpeg(0),
      updateCoverPath: async () => {}
    })
    assert.equal(result.filePath, fs.realpathSync.native(coverPath))
    assert.equal(result.rebuilt, false)
    assert.equal(resolved, false)
  } finally { value.cleanup() }
})

test('resolves only an existing controlled cover without touching EPUB dependencies', () => {
  const value = fixture()
  try {
    const coversRoot = path.join(value.booksRoot, 'covers')
    fs.mkdirSync(coversRoot)
    const coverPath = path.join(coversRoot, 'existing.jpg')
    fs.writeFileSync(coverPath, 'cover')
    const result = resolveExistingEbookCover({
      booksRoot: value.booksRoot,
      storedPath: coverPath
    })
    assert.equal(result.filePath, fs.realpathSync.native(coverPath))
    assert.equal(result.rebuilt, false)
    assert.equal(resolveExistingEbookCover({
      booksRoot: value.booksRoot,
      storedPath: path.join(coversRoot, 'missing.jpg')
    }), null)
  } finally { value.cleanup() }
})

test('rebases an old absolute cover path by filename without reading outside the cover root', async () => {
  const value = fixture()
  try {
    const coversRoot = path.join(value.booksRoot, 'covers')
    fs.mkdirSync(coversRoot)
    const current = path.join(coversRoot, 'legacy.jpg')
    fs.writeFileSync(current, 'cover')
    const result = await ensureEbookCover({
      book: { id: 2, cover_image: 'C:\\old-machine\\covers\\legacy.jpg', file_type: 'epub' },
      booksRoot: value.booksRoot,
      resolveBookPath: async () => assert.fail('must not rebuild an existing rebased cover'),
      extractCover: async () => null,
      compressCover: async () => jpeg(0),
      updateCoverPath: async () => {}
    })
    assert.equal(result.filePath, fs.realpathSync.native(current))
    assert.equal(result.rebuilt, false)
  } finally { value.cleanup() }
})

test('rebuilds a missing EPUB cover atomically and persists only the derived path', async () => {
  const value = fixture()
  try {
    const sourcePath = path.join(value.booksRoot, 'book.epub')
    fs.writeFileSync(sourcePath, 'epub')
    let persisted
    const result = await ensureEbookCover({
      book: { id: 23, cover_image: '/app/data/books/covers/missing.jpg', file_type: 'epub' },
      booksRoot: value.booksRoot,
      resolveBookPath: async () => sourcePath,
      extractCover: async (actual) => {
        assert.equal(actual, sourcePath)
        return { data: Buffer.from('raw-cover'), ext: '.png' }
      },
      compressCover: async (data) => {
        assert.equal(data.toString(), 'raw-cover')
        return jpeg(1, 2, 3)
      },
      updateCoverPath: async (coverPath) => { persisted = coverPath },
      uuid: () => 'fixed'
    })
    assert.equal(result.rebuilt, true)
    assert.equal(result.filePath, fs.realpathSync.native(path.join(value.booksRoot, 'covers', 'book-23-fixed.jpg')))
    assert.equal(persisted, result.filePath)
    assert.deepEqual(fs.readFileSync(result.filePath), jpeg(1, 2, 3))
    assert.equal(fs.existsSync(path.join(value.booksRoot, 'covers', '.book-23-fixed.tmp')), false)
  } finally { value.cleanup() }
})

test('cleans rebuilt files when the database update fails', async () => {
  const value = fixture()
  try {
    let observedPrevious
    await assert.rejects(ensureEbookCover({
      book: { id: 7, cover_image: '/old/cover.jpg', file_type: 'epub' },
      booksRoot: value.booksRoot,
      resolveBookPath: async () => path.join(value.booksRoot, 'book.epub'),
      extractCover: async () => ({ data: Buffer.from('raw') }),
      compressCover: async () => jpeg(1),
      updateCoverPath: async (_coverPath, previousCoverPath) => {
        observedPrevious = previousCoverPath
        throw new Error('database failed')
      },
      uuid: () => 'fixed'
    }), { code: 'EBOOK_COVER_REBUILD_FAILED' })
    assert.equal(observedPrevious, '/old/cover.jpg')
    assert.deepEqual(fs.readdirSync(path.join(value.booksRoot, 'covers')), [])
  } finally { value.cleanup() }
})

test('rejects non-JPEG converter output before writing files or database state', async () => {
  const value = fixture()
  try {
    let updated = false
    await assert.rejects(ensureEbookCover({
      book: { id: 8, cover_image: null, file_type: 'epub' },
      booksRoot: value.booksRoot,
      resolveBookPath: async () => path.join(value.booksRoot, 'book.epub'),
      extractCover: async () => ({ data: Buffer.from('raw') }),
      compressCover: async () => Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      updateCoverPath: async () => { updated = true }
    }), { code: 'EBOOK_COVER_REBUILD_FAILED' })
    assert.equal(updated, false)
    assert.deepEqual(fs.readdirSync(path.join(value.booksRoot, 'covers')), [])
  } finally { value.cleanup() }
})

test('rejects non-EPUB rebuilds and symlinked cover roots', async (context) => {
  const value = fixture()
  try {
    const dependencies = {
      booksRoot: value.booksRoot,
      resolveBookPath: async () => '',
      extractCover: async () => null,
      compressCover: async () => jpeg(1),
      updateCoverPath: async () => {}
    }
    await assert.rejects(ensureEbookCover({
      ...dependencies,
      book: { id: 1, cover_image: null, file_type: 'pdf' }
    }), { code: 'EBOOK_COVER_NOT_FOUND' })

    if (process.platform === 'win32') {
      context.diagnostic('cover-root symlink rejection is covered by Linux CI')
      return
    }
    fs.rmSync(path.join(value.booksRoot, 'covers'), { recursive: true, force: true })
    const outside = path.join(value.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(value.booksRoot, 'covers'), 'dir')
    await assert.rejects(ensureEbookCover({
      ...dependencies,
      book: { id: 2, cover_image: null, file_type: 'epub' }
    }), { code: 'EBOOK_COVER_ROOT_INVALID' })
  } finally { value.cleanup() }
})
