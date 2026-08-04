import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const indexSource = fs.readFileSync(
  new URL('../src/index.js', import.meta.url),
  'utf8'
)

test('all production resource modules are owner-only at the mount boundary', () => {
  const ownerModules = [
    '/api/documents',
    '/api/music',
    '/api/ebooks',
    '/api/code',
    '/api/bookmarks',
    '/api/anime',
    '/api/games',
    '/api/search',
    '/api/book-search',
    '/api/todos',
    '/api/blog'
  ]

  for (const route of ownerModules) {
    assert.match(
      indexSource,
      new RegExp(
        `app\\.use\\('${route.replaceAll('/', '\\/')}', \\.\\.\\.ownerOnly,`
      ),
      `${route} must be mounted behind ownerOnly`
    )
  }
})
test('stored uploads and the network diagnostic are not public', () => {
  assert.match(
    indexSource,
    /app\.use\(\s*'\/uploads',\s*authenticateToken,\s*requireOwner,/s
  )
  assert.match(
    indexSource,
    /app\.get\(\s*'\/api\/proxy-test',\s*authenticateToken,\s*requireOwner,/s
  )
})
