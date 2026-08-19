import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'

import {
  PRIVATE_SPACE_RETIRED_CODE,
  createPrivateSpaceRetiredRouter
} from '../src/routes/privateSpaceRetired.js'

const LEGACY_REQUESTS = Object.freeze([
  ['POST', '/docs/special/verify'],
  ['GET', '/docs/special/inventory'],
  ['POST', '/docs/special/update-auth'],
  ['GET', '/docs/special/list'],
  ['DELETE', '/docs/special/list/7'],
  ['POST', '/docs/special/upload'],
  ['GET', '/docs/special/view/7'],
  ['POST', '/secure/upload'],
  ['GET', '/secure/download/7'],
  ['DELETE', '/secure/files/7']
])

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DOCUMENTS_ROUTE_SOURCE = fs.readFileSync(
  path.join(TEST_DIRECTORY, '../src/routes/documents.js'),
  'utf8'
)
const RETIRED_ROUTE_SOURCE = fs.readFileSync(
  path.join(TEST_DIRECTORY, '../src/routes/privateSpaceRetired.js'),
  'utf8'
)

async function withServer(callback) {
  const app = express()
  let downstreamCalls = 0
  app.use('/api/documents', createPrivateSpaceRetiredRouter())
  app.use('/api/documents', (req, res) => {
    downstreamCalls += 1
    res.status(418).json({ code: 'DOWNSTREAM_REACHED' })
  })
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`, () => downstreamCalls)
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

test('all known legacy private-space endpoints return one non-disclosing 410 contract', async () => {
  await withServer(async (baseUrl, downstreamCalls) => {
    for (const [method, path] of LEGACY_REQUESTS) {
      const response = await fetch(`${baseUrl}/api/documents${path}`, { method })
      assert.equal(response.status, 410, `${method} ${path}`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { code: PRIVATE_SPACE_RETIRED_CODE })
    }
    assert.equal(downstreamCalls(), 0)
  })
})

test('ordinary document routes continue to the active document router', async () => {
  await withServer(async (baseUrl, downstreamCalls) => {
    const response = await fetch(`${baseUrl}/api/documents/42/content`)
    assert.equal(response.status, 418)
    assert.deepEqual(await response.json(), { code: 'DOWNSTREAM_REACHED' })
    assert.equal(downstreamCalls(), 1)
  })
})

test('legacy private-space paths are behind the owner boundary', async () => {
  const app = express()
  app.use('/api/documents', (req, res, next) => {
    if (req.get('authorization') !== 'Bearer owner-token') {
      return res.status(401).json({ code: 'AUTH_REQUIRED' })
    }
    next()
  })
  app.use('/api/documents', createPrivateSpaceRetiredRouter())

  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const url = `http://127.0.0.1:${address.port}/api/documents/docs/special/verify`
    const anonymous = await fetch(url, { method: 'POST' })
    assert.equal(anonymous.status, 401)
    assert.deepEqual(await anonymous.json(), { code: 'AUTH_REQUIRED' })

    const owner = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token' }
    })
    assert.equal(owner.status, 410)
    assert.equal(owner.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await owner.json(), { code: PRIVATE_SPACE_RETIRED_CODE })
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
})

test('active documents router no longer contains private-space handlers or dependencies', () => {
  for (const retiredReference of [
    'private_documents',
    'private_settings',
    'bcrypt',
    'privateSpaceLimiter',
    'PRIVATE_SPACE_FROZEN',
    '/docs/special/',
    '/secure/'
  ]) {
    assert.equal(
      DOCUMENTS_ROUTE_SOURCE.includes(retiredReference),
      false,
      `documents.js still references ${retiredReference}`
    )
  }

  assert.match(DOCUMENTS_ROUTE_SOURCE, /router\.post\('\/:id\/versions\/:versionId\/restore'/)
})

test('retired handler has no database, filesystem, or password access', () => {
  for (const forbiddenReference of [
    'getDatabase',
    'private_documents',
    'private_settings',
    'fs',
    'bcrypt',
    'password'
  ]) {
    assert.equal(
      RETIRED_ROUTE_SOURCE.includes(forbiddenReference),
      false,
      `privateSpaceRetired.js still references ${forbiddenReference}`
    )
  }
})
