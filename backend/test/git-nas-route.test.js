import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'git-nas-route-test-data')

const { createGitNasRepositoriesRouter } = await import('../src/routes/gitNasRepositories.js')

function ownerBoundary(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  return next()
}

function taskFixture(input) {
  return {
    id: 7,
    taskType: input.taskType,
    processorVersion: 'v1',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectVersionId: input.subjectVersionId,
    executionClass: 'disk',
    input: input.input,
    status: 'pending',
    progress: 0,
    attemptCount: 0,
    maxAttempts: 3,
    result: null
  }
}

async function withServer(callback) {
  const calls = []
  const root = { id: 3, enabled: true, rulesVersion: 5, lastSuccessfulGeneration: 8 }
  const app = express()
  app.use(express.json())
  app.use('/api/git-nas', ownerBoundary, createGitNasRepositoriesRouter({
    databaseProvider: () => ({ fake: true }),
    rootService: { status: () => root },
    candidateList: () => [{ candidateId: 9, name: 'repo', state: 'active' }],
    taskRuntimeProvider: () => ({
      getStore: () => ({
        enqueueExclusiveRun(input, options) {
          calls.push({ input, options })
          return { created: true, task: taskFixture(input) }
        }
      })
    }),
    runIdentityFactory: () => 'run'
  }))
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`, calls)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('Git NAS Owner API only accepts IDs, uses root mutex, and redacts paths', async () => {
  await withServer(async (baseUrl, calls) => {
    assert.equal((await fetch(`${baseUrl}/api/git-nas`)).status, 401)
    const list = await fetch(`${baseUrl}/api/git-nas`, { headers: { 'x-test-role': 'owner' } })
    assert.equal(list.status, 200)
    assert.deepEqual((await list.json()).data, [{ candidateId: 9, name: 'repo', state: 'active' }])

    const discover = await fetch(`${baseUrl}/api/git-nas/discover`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ scanRootId: 3, rulesVersion: 5, generation: 9 })
    })
    assert.equal(discover.status, 202)
    const discoverBody = await discover.json()
    assert.deepEqual(discoverBody.data.input, { scanRootId: 3, rulesVersion: 5, generation: 9 })
    assert.deepEqual(calls[0].options, { mutexTaskTypes: ['nas.resource.scan', 'nas.resource.repair', 'code.repository.git_nas.discover'] })

    const imported = await fetch(`${baseUrl}/api/git-nas/import`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: 9, relativePath: 'secret' })
    })
    assert.equal(imported.status, 400)

    const importResponse = await fetch(`${baseUrl}/api/git-nas/candidates/9/import`, {
      method: 'POST', headers: { 'x-test-role': 'owner' }
    })
    assert.equal(importResponse.status, 202)
    assert.deepEqual(calls[1].input.input, { candidateId: 9 })
    assert.deepEqual(calls[1].options, { mutexTaskTypes: ['code.repository.git_nas.import'] })
    const importBody = await importResponse.json()
    assert.doesNotMatch(JSON.stringify(importBody), /root_path|relative_path|local_path|C:\\|D:\\/u)
    assert.equal(Object.hasOwn(importBody.data, 'subjectVersionId'), false)
  })
})

test('Git NAS API does not allow a stale root generation', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/git-nas/discover`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ scanRootId: 3, rulesVersion: 5, generation: 8 })
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { code: 'GIT_NAS_TASK_CONFLICT' })
  })
})
