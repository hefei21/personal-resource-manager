import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'resource-domain-import-route-test-data')

const { createResourceDomainImportsRouter } = await import('../src/routes/resourceDomainImports.js')

function ownerBoundary(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  next()
}

function taskFixture(input) {
  return {
    id: 9,
    taskType: input.taskType,
    processorVersion: input.processorVersion,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectVersionId: input.subjectVersionId,
    status: 'pending',
    executionClass: 'disk',
    input: input.input,
    result: null,
    progress: 0,
    attemptCount: 0,
    maxAttempts: 3,
    availableAt: '2026-08-22T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    errorCode: null
  }
}

async function withServer({ enqueue, taskRuntimeProvider } = {}, callback) {
  const app = express()
  app.use(express.json())
  app.use('/api/resource-domain-imports', ownerBoundary, createResourceDomainImportsRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    ...(enqueue ? { enqueue } : {}),
    ...(taskRuntimeProvider ? { taskRuntimeProvider } : {})
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('Owner API starts a persistent import task and does not accept paths', async () => {
  const calls = []
  const enqueue = (database, input, options) => {
    calls.push({ database, input, options })
    return { created: true, outcome: 'created', task: taskFixture(input) }
  }
  await withServer({ enqueue }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/resource-domain-imports`, { method: 'POST' })
    assert.equal(anonymous.status, 401)
    const nonOwner = await fetch(`${baseUrl}/api/resource-domain-imports`, {
      method: 'POST', headers: { 'x-test-role': 'demo', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'documents' })
    })
    assert.equal(nonOwner.status, 403)
    const invalid = await fetch(`${baseUrl}/api/resource-domain-imports`, {
      method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'documents', rootPath: '/secret' })
    })
    assert.equal(invalid.status, 400)

    const response = await fetch(`${baseUrl}/api/resource-domain-imports`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'documents', cursor: 4, batchSize: 5 })
    })
    assert.equal(response.status, 202)
    const body = await response.json()
    assert.equal(body.data.taskType, 'resource.domain.adapt')
    assert.deepEqual(body.data.input, { scope: 'documents', cursor: 4, batchSize: 5 })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].options, { mutexTaskTypes: ['resource.domain.adapt'] })
    assert.equal(calls[0].input.subjectType, 'resource-domain-import')
    assert.equal(calls[0].input.subjectId, 'owner')
    assert.match(calls[0].input.subjectVersionId, /^documents-/u)
    assert.doesNotMatch(JSON.stringify(body), /rootPath|file_path|sha256|hash|lease/u)
    assert.equal(Object.hasOwn(body.data, 'subjectVersionId'), false)
  })
})

test('Owner API maps an active owner import to a stable conflict', async () => {
  const enqueue = () => ({
    created: false,
    outcome: 'active-conflict',
    activeConflict: true,
    task: taskFixture({
      taskType: 'resource.domain.adapt',
      processorVersion: 'v1',
      subjectType: 'resource-domain-import',
      subjectId: 'owner',
      subjectVersionId: 'documents-run',
      input: { scope: 'documents' }
    })
  })
  await withServer({ enqueue }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/resource-domain-imports`, {
      method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'documents' })
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { code: 'RESOURCE_DOMAIN_IMPORT_CONFLICT' })
  })
})
