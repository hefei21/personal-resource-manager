import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const routeSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'routes', 'books.js'), 'utf8')
const storageSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'services', 'ebookStorageService.js'), 'utf8')
const coverSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'services', 'ebookCoverService.js'), 'utf8')

test('ebook routes use managed commit, controlled content resolution, and generic trash lifecycle', () => {
  assert.match(routeSource, /commitEbookUpload/u)
  assert.match(storageSource, /coordinateStorageCommit/u)
  assert.match(storageSource, /kind: 'ebooks'/u)
  assert.match(routeSource, /resolveVerifiedFilePath/u)
  assert.match(routeSource, /contentService\.createReadStream/u)
  assert.match(routeSource, /resource_type = 'ebook'/u)
  assert.match(routeSource, /router\.get\('\/trash'/u)
  assert.match(routeSource, /router\.post\('\/trash\/:id\/restore'/u)
  assert.match(routeSource, /router\.delete\('\/trash\/:id\/permanent'/u)
})

test('ebook routes do not expose or directly delete original content paths', () => {
  assert.doesNotMatch(routeSource, /filePath:\s*row\.file_path/u)
  assert.doesNotMatch(routeSource, /req\.body\.filePath/u)
  assert.doesNotMatch(routeSource, /fs\.unlinkSync\(book\.file_path\)/u)
  assert.doesNotMatch(routeSource, /res\.sendFile\(book\.file_path\)/u)
  assert.doesNotMatch(routeSource, /coverImage:\s*row\.cover_image/u)
  assert.doesNotMatch(routeSource, /fs\.existsSync\(book\.cover_image\)/u)
  assert.doesNotMatch(routeSource, /res\.sendFile\(book\.cover_image\)/u)
  assert.doesNotMatch(routeSource, /文件不存在:\s*['"]?\s*\+\s*book\.file_path/u)
})

test('ebook covers require owner authentication and rebuild through bounded managed paths', () => {
  assert.match(routeSource, /router\.get\('\/:id\/cover', authenticateToken, ebookResourceLimiter/u)
  assert.match(routeSource, /ensureEbookCover/u)
  assert.match(routeSource, /validateEpubArchive\(bookPath\)/u)
  assert.match(routeSource, /resolveBookPath:\s*verifiedBookPath/u)
  assert.match(routeSource, /compressCover:\s*encodeEbookCoverJpeg/u)
  assert.match(routeSource, /cover_image IS \?/u)
  assert.match(routeSource, /result\.changes !== 1/u)
  assert.match(routeSource, /res\.sendFile\(cover\.fileName, \{ root: cover\.root \}\)/u)
  assert.match(coverSource, /realpathSync\.native/u)
  assert.match(coverSource, /isSymbolicLink/u)
  assert.match(coverSource, /renameSync/u)
  assert.match(coverSource, /\.jpeg\(\{ quality: 85, mozjpeg: true \}\)/u)
  assert.doesNotMatch(routeSource, /entryName\.includes\(coverHref\)/u)
})
