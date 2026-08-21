import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import express from 'express'
import test from 'node:test'

import { normalizeNasScanRules } from '../src/config/nasScan.js'
import { RESOURCE_MODEL_MIGRATIONS } from '../src/config/resourceModelSchema.js'
import { createNasScanRootService } from '../src/services/nasScanRootService.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'nas-scan-roots-route-test-data')
const { createNasScanRootsRouter } = await import('../src/routes/nasScanRoots.js')

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const databaseOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run SQLite cases' }

function ownerBoundary(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  next()
}

function safeRoot(overrides = {}) {
  return {
    id: 1,
    name: 'Documents',
    enabled: true,
    rulesVersion: 1,
    lastSuccessfulGeneration: 0,
    rules: {
      version: 1,
      useGitignore: true,
      maxFileBytes: 2 * 1024 * 1024 * 1024,
      maxDepth: 64,
      allowedExtensionCount: 0,
      excludedGlobCount: 0,
      credentialGlobCount: 0
    },
    counts: { active: 0, missing: 0, excluded: 0, errors: 0, conflicts: 0 },
    ...overrides
  }
}

function taskFixture(input) {
  return {
    id: 9,
    taskType: input.taskType,
    processorVersion: 'v1',
    subjectType: 'nas-scan-root',
    subjectId: '1',
    subjectVersionId: '1-1',
    status: 'pending',
    executionClass: 'disk',
    input: input.input,
    result: null,
    progress: 0,
    attemptCount: 0,
    maxAttempts: 3,
    availableAt: '2026-08-21T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    errorCode: null
  }
}

async function withServer({ rootService, taskRuntimeProvider, enqueue } = {}, callback) {
  const app = express()
  app.use(express.json())
  app.use('/api/nas-scan-roots', ownerBoundary, createNasScanRootsRouter({
    databaseProvider: () => ({ fakeDatabase: true }),
    ...(rootService ? { rootService } : {}),
    ...(taskRuntimeProvider ? { taskRuntimeProvider } : {}),
    ...(enqueue ? { enqueue } : {})
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

test('NAS root Owner API projects safe fields and protects every write', async () => {
  const calls = { create: [], update: [], disable: [], enqueue: [] }
  const root = safeRoot()
  const rootService = {
    list: () => [root],
    status: () => root,
    create: (_database, body) => {
      calls.create.push(body)
      return root
    },
    update: (_database, id, body) => {
      calls.update.push({ id, body })
      return safeRoot({ name: body.name ?? root.name })
    },
    disable: (_database, id) => {
      calls.disable.push(id)
      return safeRoot({ enabled: false })
    }
  }
  const taskRuntimeProvider = () => ({
    getStore() {
      return {
        enqueueExclusiveRun(input, options) {
          calls.enqueue.push({ input, options })
          return { created: true, outcome: 'created', task: taskFixture(input) }
        }
      }
    }
  })

  await withServer({ rootService, taskRuntimeProvider }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/nas-scan-roots`)
    assert.equal(anonymous.status, 401)
    const demo = await fetch(`${baseUrl}/api/nas-scan-roots`, { headers: { 'x-test-role': 'demo' } })
    assert.equal(demo.status, 403)

    const list = await fetch(`${baseUrl}/api/nas-scan-roots`, { headers: { 'x-test-role': 'owner' } })
    assert.equal(list.status, 200)
    const listBody = await list.json()
    assert.deepEqual(listBody.data[0], root)
    assert.doesNotMatch(JSON.stringify(listBody), /root_path|relative_path|sha256|hash|lease/u)

    const create = await fetch(`${baseUrl}/api/nas-scan-roots`, {
      method: 'POST',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New root', rootPath: 'C:\\private', rules: { useGitignore: true } })
    })
    assert.equal(create.status, 201)
    assert.equal(calls.create.length, 1)

    const scan = await fetch(`${baseUrl}/api/nas-scan-roots/1/scan`, {
      method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: '{}'
    })
    assert.equal(scan.status, 202)
    const scanBody = await scan.json()
    assert.equal(scanBody.data.taskType, 'nas.resource.scan')
    assert.deepEqual(scanBody.data.input, { scanRootId: 1, rulesVersion: 1, generation: 1 })
    assert.deepEqual(calls.enqueue[0].options, { mutexTaskTypes: ['nas.resource.scan', 'nas.resource.repair'] })
    assert.doesNotMatch(JSON.stringify(scanBody), /root_path|relative_path|sha256|hash|lease/u)

    const secondScan = await fetch(`${baseUrl}/api/nas-scan-roots/1/scan`, {
      method: 'POST', headers: { 'x-test-role': 'owner', 'content-type': 'application/json' }, body: '{}'
    })
    assert.equal(secondScan.status, 202)
    assert.notEqual(calls.enqueue[0].input.subjectVersionId, calls.enqueue[1].input.subjectVersionId)
    assert.match(calls.enqueue[0].input.subjectVersionId, /^1-1-/u)

    const update = await fetch(`${baseUrl}/api/nas-scan-roots/1`, {
      method: 'PATCH',
      headers: { 'x-test-role': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' })
    })
    assert.equal(update.status, 200)
    const remove = await fetch(`${baseUrl}/api/nas-scan-roots/1`, {
      method: 'DELETE', headers: { 'x-test-role': 'owner' }
    })
    assert.equal(remove.status, 200)
    assert.equal(calls.update.length, 1)
    assert.deepEqual(calls.disable, [1])
  })
})

test('NAS root API maps active scan conflicts to stable 409', async () => {
  const root = safeRoot()
  const rootService = { status: () => root }
  const taskRuntimeProvider = () => ({
    getStore: () => ({
      enqueueExclusiveRun: () => ({
        created: false,
        outcome: 'active-conflict',
        activeConflict: true,
        task: taskFixture({ taskType: 'nas.resource.scan', input: { scanRootId: 1, rulesVersion: 1, generation: 1 } })
      })
    })
  })
  await withServer({ rootService, taskRuntimeProvider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/nas-scan-roots/1/repair`, {
      method: 'POST', headers: { 'x-test-role': 'owner' }
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { code: 'NAS_SCAN_TASK_CONFLICT' })
  })
})

test('real NAS root service canonicalizes paths, normalizes rules, and never projects root_path', databaseOptions, () => {
  const database = new Database(':memory:')
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-root-service-'))
  try {
    for (const migration of RESOURCE_MODEL_MIGRATIONS) database.exec(migration.source)
    const service = createNasScanRootService()
    const created = service.create(database, {
      name: 'Fixture',
      rootPath: path.join(rootPath, '.'),
      rules: { allowedExtensions: ['TXT'], maxDepth: 4 }
    })
    assert.equal(created.id, 1)
    assert.equal(created.rules.version, 1)
    assert.equal(created.rules.maxDepth, 4)
    assert.equal('root_path' in created, false)
    assert.equal(JSON.stringify(created).includes(rootPath), false)
    const updated = service.update(database, 1, { rules: { maxDepth: 3 }, enabled: false })
    assert.equal(updated.enabled, false)
    assert.equal(updated.rulesVersion, 2)
    const secondRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-scan-root-service-moved-'))
    try {
      const moved = service.update(database, 1, { rootPath: secondRootPath })
      assert.equal(moved.rulesVersion, 3)
      assert.equal(JSON.stringify(moved).includes(secondRootPath), false)
    } finally {
      fs.rmSync(secondRootPath, { recursive: true, force: true })
    }
    assert.equal(service.status(database, 1).enabled, false)
    assert.equal(service.disable(database, 1).enabled, false)
  } finally {
    database.close()
    fs.rmSync(rootPath, { recursive: true, force: true })
  }
})
