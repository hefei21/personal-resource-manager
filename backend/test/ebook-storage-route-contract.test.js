import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const routeSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'routes', 'books.js'), 'utf8')
const storageSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'services', 'ebookStorageService.js'), 'utf8')

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
  assert.doesNotMatch(routeSource, /文件不存在:\s*['"]?\s*\+\s*book\.file_path/u)
})
