import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bookmarkHref,
  bookmarkDomain,
  bookmarkHtmlExport,
} from '../src/utils/bookmarkPresentation.js'
test('bookmark links reject executable URLs and credentials, display only host', () => {
  assert.equal(bookmarkHref('javascript:alert(1)'), null)
  assert.equal(bookmarkHref('https://a:b@example.com'), null)
  assert.equal(
    bookmarkDomain('http://192.168.1.2:8080/private?q=secret'),
    '192.168.1.2:8080',
  )
})
test('HTML export escapes content and attributes, omits active links', () => {
  const html = bookmarkHtmlExport([
    {
      title: '<script>x</script>',
      url: 'https://example.com/?a=1&b=2',
      tags: ['开发'],
      category: 'A&B',
      description: '"hello"',
    },
    { title: 'bad', url: 'javascript:alert(1)', tags: [] },
  ])
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('a=1&amp;b=2'))
  assert.ok(!html.includes('javascript:'))
  assert.ok(html.includes('NETSCAPE-Bookmark-file-1'))
})
