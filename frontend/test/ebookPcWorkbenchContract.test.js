import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const page = fs.readFileSync(new URL('../src/pc/pages/BooksPC.vue', import.meta.url), 'utf8')
const reader = fs.readFileSync(new URL('../src/pc/components/books/EbookReaderDialog.vue', import.meta.url), 'utf8')
const workbench = fs.readFileSync(new URL('../src/pc/components/books/EbookWorkbench.vue', import.meta.url), 'utf8')
const mobileReader = fs.readFileSync(new URL('../src/mobile/components/BookReader.vue', import.meta.url), 'utf8')
const api = fs.readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')

test('PC ebook page is a thin orchestrator rather than a second monolith', () => {
  assert.ok(page.split(/\r?\n/u).length < 400)
  assert.match(page, /EbookWorkbench/u)
  assert.match(page, /EbookDetailDrawer/u)
  assert.match(page, /EbookUploadDialog/u)
  assert.match(page, /EbookReaderDialog/u)
  assert.doesNotMatch(page, /BookSearchDialog|v-if="false"/u)
})

test('ebook workbench keeps server paging, smart reading views, stable category IDs, and detail-on-demand', () => {
  assert.match(page, /pageSize:\s*24/u)
  assert.match(page, /api\.books\.getDetail/u)
  assert.match(workbench, /readingStatus/u)
  assert.match(workbench, /uncategorized/u)
  assert.match(workbench, /String\(category\.id\)/u)
})

test('reader streams PDFs, loads EPUB chapters lazily, and uses the shared progress protocol', () => {
  assert.match(api, /getManifest:[^\n]+\/chapters/u)
  assert.match(reader, /api\.books\.getManifest/u)
  assert.match(reader, /api\.books\.getChapters/u)
  assert.match(reader, /openAuthenticatedPdfDocument/u)
  assert.match(reader, /\/api\/ebooks\/\$\{props\.book\.id\}\/preview/u)
  assert.match(reader, /createEbookReadingProgressSync/u)
  assert.match(reader, /resolveConflict\('remote'\)/u)
  assert.match(reader, /resolveConflict\('local'\)/u)
  assert.match(reader, /canMarkFinished/u)
  assert.match(reader, /v-if="tocOpen"/u)
})

test('reading position is shared across PC and mobile while appearance remains device-local', () => {
  assert.match(mobileReader, /createEbookReadingProgressSync/u)
  assert.match(mobileReader, /pr-manager:ebook-reader-preferences:v1/u)
  assert.match(mobileReader, /persistDeviceFontSize/u)
  assert.doesNotMatch(mobileReader, /fontSize\.value\s*=\s*progress\.fontSize/u)
})
