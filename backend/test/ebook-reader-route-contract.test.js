import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../src/routes/books.js', import.meta.url), 'utf8')

test('ebook PDF preview is authenticated, Range-capable, and reads through the managed content service', () => {
  assert.match(source, /router\.get\('\/:id\/preview', authenticateToken/u)
  assert.match(source, /parseDocumentByteRange\(req\.headers\.range, totalBytes\)/u)
  assert.match(source, /contentService\.createReadStream\(book, range \|\| \{\}\)/u)
  assert.match(source, /Accept-Ranges', 'bytes'/u)
  assert.match(source, /Content-Range/u)
  assert.match(source, /Content-Type', 'application\/pdf'/u)
})

test('EPUB manifest requests do not return chapter bodies and chapter reads are bounded', () => {
  assert.match(source, /const manifestOnly = req\.query\.manifest === '1'/u)
  assert.match(source, /const count = manifestOnly \? 0 : Math\.min\(20/u)
  assert.match(source, /chapters: manifestOnly \? ebookChapterManifest\(allChapters\) : chaptersToLoad/u)
})

test('ebook detail preserves legacy file sizes and cache invalidation stays owner-only', () => {
  assert.match(source, /fileSize: Number\(row\.content_bytes\) > 0 \? Number\(row\.content_bytes\) : \(Number\(row\.file_size\) \|\| 0\)/u)
  assert.match(source, /router\.delete\('\/:id\/cache', authenticateToken, requireWritePermission/u)
})
