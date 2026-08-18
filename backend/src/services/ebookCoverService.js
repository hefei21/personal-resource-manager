import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

export class EbookCoverError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'EbookCoverError'
    this.code = code
  }
}

export async function encodeEbookCoverJpeg(data) {
  return sharp(data, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(500, 500, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
}

function fail(code, message, cause) {
  throw new EbookCoverError(code, message, cause)
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function regularFileWithin(rootPath, candidatePath, fileSystem) {
  const resolved = path.resolve(candidatePath)
  if (!isWithin(rootPath, resolved)) return null
  try {
    const stat = fileSystem.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const real = fileSystem.realpathSync.native(resolved)
    return isWithin(rootPath, real) ? real : null
  } catch {
    return null
  }
}

function prepareCoversRoot(booksRoot, fileSystem) {
  const requestedBooksRoot = path.resolve(booksRoot)
  let booksStat
  try { booksStat = fileSystem.lstatSync(requestedBooksRoot) } catch (error) {
    fail('EBOOK_COVER_ROOT_INVALID', 'Ebook root is unavailable.', error)
  }
  if (!booksStat.isDirectory() || booksStat.isSymbolicLink()) {
    fail('EBOOK_COVER_ROOT_INVALID', 'Ebook root must be a real directory.')
  }
  const realBooksRoot = fileSystem.realpathSync.native(requestedBooksRoot)
  const requestedCoversRoot = path.join(realBooksRoot, 'covers')
  try { fileSystem.mkdirSync(requestedCoversRoot, { recursive: true }) } catch (error) {
    fail('EBOOK_COVER_ROOT_INVALID', 'Ebook cover directory is unavailable.', error)
  }
  const coversStat = fileSystem.lstatSync(requestedCoversRoot)
  if (!coversStat.isDirectory() || coversStat.isSymbolicLink()) {
    fail('EBOOK_COVER_ROOT_INVALID', 'Ebook cover directory must be a real directory.')
  }
  const realCoversRoot = fileSystem.realpathSync.native(requestedCoversRoot)
  if (!isWithin(realBooksRoot, realCoversRoot)) {
    fail('EBOOK_COVER_ROOT_INVALID', 'Ebook cover directory escaped its root.')
  }
  return realCoversRoot
}

function existingCoverPath(coversRoot, storedPath, fileSystem) {
  if (!storedPath) return null
  const direct = regularFileWithin(coversRoot, storedPath, fileSystem)
  if (direct) return direct
  const fileName = path.posix.basename(String(storedPath).replace(/\\/g, '/'))
  if (!fileName || fileName === '.' || fileName === '..') return null
  return regularFileWithin(coversRoot, path.join(coversRoot, fileName), fileSystem)
}

function coverResult(coversRoot, filePath, rebuilt) {
  return Object.freeze({
    root: coversRoot,
    fileName: path.basename(filePath),
    filePath,
    rebuilt
  })
}

export async function ensureEbookCover({
  book,
  booksRoot,
  resolveBookPath,
  extractCover,
  compressCover,
  updateCoverPath,
  fileSystem = fs,
  uuid = randomUUID
} = {}) {
  if (!book || !Number.isSafeInteger(Number(book.id)) || Number(book.id) <= 0) {
    fail('EBOOK_COVER_INPUT_INVALID', 'A valid ebook is required.')
  }
  if (typeof resolveBookPath !== 'function' || typeof extractCover !== 'function' ||
      typeof compressCover !== 'function' || typeof updateCoverPath !== 'function') {
    fail('EBOOK_COVER_INPUT_INVALID', 'Ebook cover dependencies are invalid.')
  }

  const coversRoot = prepareCoversRoot(booksRoot, fileSystem)
  const existing = existingCoverPath(coversRoot, book.cover_image, fileSystem)
  if (existing) return coverResult(coversRoot, existing, false)

  const extension = path.extname(String(book.original_name || book.file_path || '')).toLowerCase()
  if (extension !== '.epub' && String(book.file_type || '').toLowerCase() !== 'epub') {
    fail('EBOOK_COVER_NOT_FOUND', 'Ebook cover cannot be rebuilt for this file type.')
  }

  let sourcePath
  let extracted
  try {
    sourcePath = await resolveBookPath(book)
    extracted = await extractCover(sourcePath)
  } catch (error) {
    if (error instanceof EbookCoverError) throw error
    if (error?.code === 'RESOURCE_CONTENT_MISSING' || error?.code === 'RESOURCE_CONTENT_REFERENCE_MISSING') {
      fail('EBOOK_COVER_SOURCE_MISSING', 'Ebook source does not exist.', error)
    }
    fail('EBOOK_COVER_SOURCE_INVALID', 'Ebook cover source could not be read.', error)
  }
  if (!extracted?.data || !Buffer.isBuffer(extracted.data)) {
    fail('EBOOK_COVER_NOT_FOUND', 'Ebook does not contain a rebuildable cover.')
  }
  if (extracted.data.length === 0 || extracted.data.length > 25 * 1024 * 1024) {
    fail('EBOOK_COVER_TOO_LARGE', 'Ebook cover exceeds the rebuild limit.')
  }

  let compressed
  try {
    compressed = await compressCover(extracted.data)
  } catch (error) {
    fail('EBOOK_COVER_REBUILD_FAILED', 'Ebook cover could not be rebuilt.', error)
  }
  if (!Buffer.isBuffer(compressed) || compressed.length < 3 || compressed.length > 10 * 1024 * 1024 ||
      compressed[0] !== 0xFF || compressed[1] !== 0xD8 || compressed[2] !== 0xFF) {
    fail('EBOOK_COVER_REBUILD_FAILED', 'Rebuilt ebook cover is invalid.')
  }

  const token = uuid()
  const finalPath = path.join(coversRoot, `book-${Number(book.id)}-${token}.jpg`)
  const temporaryPath = path.join(coversRoot, `.book-${Number(book.id)}-${token}.tmp`)
  try {
    fileSystem.writeFileSync(temporaryPath, compressed, { flag: 'wx' })
    if (!regularFileWithin(coversRoot, temporaryPath, fileSystem)) {
      fail('EBOOK_COVER_REBUILD_FAILED', 'Temporary ebook cover failed verification.')
    }
    fileSystem.renameSync(temporaryPath, finalPath)
    const real = regularFileWithin(coversRoot, finalPath, fileSystem)
    if (!real) fail('EBOOK_COVER_REBUILD_FAILED', 'Rebuilt ebook cover failed verification.')
    await updateCoverPath(real, book.cover_image ?? null)
    return coverResult(coversRoot, real, true)
  } catch (error) {
    try { fileSystem.rmSync(temporaryPath, { force: true }) } catch {}
    try { fileSystem.rmSync(finalPath, { force: true }) } catch {}
    if (error instanceof EbookCoverError) throw error
    fail('EBOOK_COVER_REBUILD_FAILED', 'Ebook cover could not be committed.', error)
  }
}
