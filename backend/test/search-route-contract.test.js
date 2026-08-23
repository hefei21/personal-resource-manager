import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'search-route-contract-data')

const { createSearchRouter, normalizeSearchRefreshBody } = await import('../src/routes/search.js')

async function withSearchServer(callback) {
  const queryCalls = []
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const principal = req.get('x-test-principal')
    if (principal) req.user = { principal }
    next()
  })
  app.use('/api/search', createSearchRouter({
    databaseProvider: () => ({ database: true }),
    serviceFactory: () => ({
      getStatus: () => ({ status: 'ready', entryCount: 1 }),
      query: (input) => {
        queryCalls.push(input)
        return { data: [], total: 0, summary: {}, index: { status: 'ready' } }
      }
    })
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`, queryCalls)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('normalizes bounded refresh options', () => {
  assert.deepEqual(normalizeSearchRefreshBody({}), { rebuild: false, includeCodeFiles: true })
  assert.deepEqual(normalizeSearchRefreshBody({ rebuild: true, includeCodeFiles: false }), {
    rebuild: true,
    includeCodeFiles: false
  })
  assert.throws(() => normalizeSearchRefreshBody({ rebuild: 'yes' }))
  assert.throws(() => normalizeSearchRefreshBody({ externalUrl: 'https://example.test' }))
})

test('retires the cross-table LIKE search implementation', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../src/routes/search.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /\bLIKE\b/iu)
  assert.match(source, /SEARCH_INDEX_MISSING/u)
  assert.match(source, /requireOwner/u)
  assert.match(source, /requireWritePermission/u)
})

test('requires an Owner principal before exposing status, query, or refresh routes', async () => {
  await withSearchServer(async (baseUrl, queryCalls) => {
    const anonymous = await fetch(`${baseUrl}/api/search?q=unified`)
    assert.equal(anonymous.status, 401)

    const demo = await fetch(`${baseUrl}/api/search/status`, {
      headers: { 'x-test-principal': 'demo' }
    })
    assert.equal(demo.status, 403)
    assert.deepEqual(await demo.json(), { message: '仅资源所有者可执行此操作', code: 'OWNER_REQUIRED' })

    const demoRefresh = await fetch(`${baseUrl}/api/search/index/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-principal': 'demo' },
      body: '{}'
    })
    assert.equal(demoRefresh.status, 403)

    const owner = await fetch(`${baseUrl}/api/search?keyword=unified`, {
      headers: { 'x-test-principal': 'owner' }
    })
    assert.equal(owner.status, 200)
    assert.equal(queryCalls.length, 1)
    assert.equal(queryCalls[0].q, 'unified')
  })
})
