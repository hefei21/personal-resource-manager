import assert from 'node:assert/strict'
import test from 'node:test'
import { findEbookChapterIndex, resolveEbookLink } from '../src/domain/ebookReaderNavigation.js'

test('resolves fragment and relative EPUB links without leaving the reader', () => {
  assert.deepEqual(resolveEbookLink('#note-2', 'Text/chapter-1.xhtml'), {
    external: false,
    url: '',
    path: 'Text/chapter-1.xhtml',
    fragment: 'note-2'
  })
  assert.deepEqual(resolveEbookLink('../Text/chapter-2.xhtml#target', 'Text/chapter-1.xhtml'), {
    external: false,
    url: '',
    path: 'Text/chapter-2.xhtml',
    fragment: 'target'
  })
})

test('matches EPUB chapters exactly and only uses unique basename fallback', () => {
  const chapters = [
    { href: 'OEBPS/Text/chapter-1.xhtml' },
    { href: 'OEBPS/Text/chapter-2.xhtml' }
  ]
  assert.equal(findEbookChapterIndex(chapters, 'OEBPS/Text/chapter-2.xhtml'), 1)
  assert.equal(findEbookChapterIndex(chapters, 'Text/chapter-1.xhtml'), 0)
  assert.equal(findEbookChapterIndex([...chapters, { href: 'Other/chapter-1.xhtml' }], 'Text/chapter-1.xhtml'), -1)
})

test('keeps external schemes external and rejects empty links', () => {
  assert.equal(resolveEbookLink('', 'chapter.xhtml'), null)
  assert.equal(resolveEbookLink('https://example.com/read', 'chapter.xhtml')?.external, true)
  assert.equal(resolveEbookLink('mailto:reader@example.com', 'chapter.xhtml')?.external, true)
})
