import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import express from 'express'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import {
  KNOWN_TASK_TYPES,
  projectTask,
  TASK_TYPE_CATALOG
} from '../src/services/taskTypeCatalog.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))

const { createTasksRouter } = await import('../src/routes/tasks.js')
const { countTasks, listTasks } = await import('../src/services/taskStore.js')

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

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

const indexSource = fs.readFileSync(path.join(testDirectory, '..', 'src', 'index.js'), 'utf8')

function taskFixture(overrides = {}) {
  return {
    id: 1,
    taskType: 'games.steam.sync',
    processorVersion: 'v1',
    subjectType: 'game-library',
    subjectId: 'owner',
    subjectVersionId: 'secret-version-id',
    subjectContentHash: 'secret-content-hash',
    status: 'succeeded',
    executionClass: 'network',
    progress: 100,
    attemptCount: 1,
    maxAttempts: 3,
    input: {},
    result: { total: 3, inserted: 2, updated: 1 },
    idempotencyKey: 'secret-idempotency-key',
    inputFingerprint: 'secret-input-fingerprint',
    leaseToken: 'secret-lease-token',
    leaseOwner: 'secret-lease-owner',
    leaseExpiresAt: '2026-08-20T01:00:00.000Z',
    heartbeatAt: '2026-08-20T00:30:00.000Z',
    errorCode: null,
    errorSummary: 'https://secret.example/path?token=secret-token',
    availableAt: '2026-08-20T00:00:00.000Z',
    startedAt: '2026-08-20T00:00:01.000Z',
    finishedAt: '2026-08-20T00:00:02.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:02.000Z',
    ...overrides
  }
}

function ownerAuthentication(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  next()
}

function ownerOnly(req, res, next) {
  if (req.user?.principal !== 'owner') return res.status(403).json({ code: 'OWNER_REQUIRED' })
  next()
}

async function withServer({ listTasks: list, countTasks: count, getTaskById } = {}, callback) {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/tasks',
    ownerAuthentication,
    ownerOnly,
    createTasksRouter({
      databaseProvider: () => ({ taskDatabase: true }),
      ...(list ? { listTasks: list } : {}),
      ...(count ? { countTasks: count } : {}),
      ...(getTaskById ? { getTaskById } : {})
    })
  )
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function ownerHeaders() {
  return { 'x-test-role': 'owner' }
}

test('tasks route is mounted behind the shared ownerOnly boundary', () => {
  assert.match(indexSource, /import tasksRoutes from '\.\/routes\/tasks\.js'/u)
  assert.match(indexSource, /app\.use\('\/api\/tasks', \.\.\.ownerOnly, tasksRoutes\)/u)
  assert.doesNotMatch(indexSource, /app\.use\('\/api\/tasks', tasksRoutes\)/u)
})

test('tasks endpoint rejects anonymous and demo callers before reading tasks', async () => {
  let reads = 0
  await withServer({
    listTasks: () => { reads += 1; return [] },
    countTasks: () => { reads += 1; return 0 }
  }, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/tasks`)
    const demo = await fetch(`${baseUrl}/api/tasks`, { headers: { 'x-test-role': 'demo' } })
    assert.equal(anonymous.status, 401)
    assert.equal(demo.status, 403)
  })
  assert.equal(reads, 0)
})

test('tasks endpoint applies strict filters, DESC pagination, and matching total', async () => {
  const fixtures = [
    taskFixture({ id: 1, status: 'failed' }),
    taskFixture({ id: 2, status: 'failed' }),
    taskFixture({ id: 3, status: 'succeeded' })
  ]
  const calls = []
  const optionsFor = (options) => {
    calls.push(options)
    return options.status?.includes('failed')
      ? fixtures.filter((task) => task.status === 'failed')
      : fixtures
  }

  await withServer({
    listTasks: (_database, options) => {
      const rows = optionsFor(options)
      const ordered = options.order === 'desc' ? [...rows].reverse() : rows
      return ordered.slice(options.offset, options.offset + options.limit)
    },
    countTasks: (_database, options) => optionsFor(options).length
  }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/tasks?status=failed&taskType=games.steam.sync&limit=1&offset=1`,
      { headers: ownerHeaders() }
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.data.map(({ id }) => id), [1])
    assert.equal(body.total, 2)
    assert.deepEqual(body.pagination, {
      page: 2,
      pageSize: 1,
      limit: 1,
      offset: 1,
      order: 'desc',
      total: 2,
      totalPages: 2
    })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].taskTypes, ['games.steam.sync'])
    assert.deepEqual(calls[0].status, ['failed'])
    assert.equal(calls[0].order, 'desc')
  })
})

test('tasks endpoint returns stable 400 for illegal filters and pagination', async () => {
  await withServer({ listTasks: () => [], countTasks: () => 0 }, async (baseUrl) => {
    for (const query of [
      '?status=failed,unknown',
      '?taskType=unknown.type',
      '?limit=101',
      '?page=0',
      '?order=random',
      '?unexpected=value',
      '?page=2&offset=1'
    ]) {
      const first = await fetch(`${baseUrl}/api/tasks${query}`, { headers: ownerHeaders() })
      const second = await fetch(`${baseUrl}/api/tasks${query}`, { headers: ownerHeaders() })
      assert.equal(first.status, 400, query)
      assert.equal(second.status, 400, query)
      assert.deepEqual(await first.json(), { code: 'TASK_QUERY_INVALID' })
      assert.deepEqual(await second.json(), { code: 'TASK_QUERY_INVALID' })
    }
  })
})

test('task detail hides nonexistent and unknown task types', async () => {
  await withServer({
    getTaskById: (_database, id) => id === 1
      ? taskFixture({ id: 1 })
      : id === 2
        ? taskFixture({ id: 2, taskType: 'future.internal.task' })
        : null
  }, async (baseUrl) => {
    const known = await fetch(`${baseUrl}/api/tasks/1`, { headers: ownerHeaders() })
    const unknown = await fetch(`${baseUrl}/api/tasks/2`, { headers: ownerHeaders() })
    const missing = await fetch(`${baseUrl}/api/tasks/999`, { headers: ownerHeaders() })
    assert.equal(known.status, 200)
    assert.equal(unknown.status, 404)
    assert.equal(missing.status, 404)
    assert.deepEqual(await unknown.json(), { code: 'TASK_NOT_FOUND' })
    assert.deepEqual(await missing.json(), { code: 'TASK_NOT_FOUND' })
  })
})

test('catalog exposes explicit safe projections for every Stage 3 task type', () => {
  const fixtures = [
    taskFixture({
      taskType: 'code.repository.clone',
      subjectType: 'code-repository',
      subjectId: '7',
      input: { repoId: '7', path: 'C:\\secret', token: 'secret-token' },
      result: { message: '克隆完成', path: '/secret/repository', token: 'secret-token' }
    }),
    taskFixture({
      taskType: 'music.lyrics.batch',
      subjectType: 'music-library',
      subjectId: 'owner',
      input: { musicIds: [7, 8], force: true, path: '/secret' },
      result: { total: 2, success: 1, failed: 1, skipped: 0, lyrics: 'secret lyrics', token: 'secret-token' }
    }),
    taskFixture({
      taskType: 'games.steam.sync',
      subjectType: 'game-library',
      subjectId: 'owner',
      input: {},
      result: { total: 2, inserted: 1, updated: 1, response: { apiKey: 'secret-api-key' } }
    }),
    taskFixture({
      taskType: 'anime.bangumi.refresh',
      subjectType: 'anime',
      subjectId: '9',
      input: { animeId: 9, token: 'secret-token' },
      result: { animeId: 9, bangumiId: 99, characters: [{ name: 'secret' }], base64: 'secret-base64' }
    }),
    taskFixture({
      taskType: 'ebook.cover.generate',
      executionClass: 'cpu',
      subjectType: 'ebook',
      subjectId: '11',
      input: { bookId: 11, filePath: '/secret/book.epub' },
      result: { bookId: 11, generated: true, path: '/secret/cover.jpg' }
    }),
    taskFixture({
      taskType: 'code.repository.reclone',
      subjectType: 'code-repository',
      subjectId: '12',
      input: { repoId: '12' },
      result: { backupRepositoryId: 13, path: '/secret/backup' }
    })
  ]

  assert.deepEqual(Object.keys(TASK_TYPE_CATALOG).sort(), [...KNOWN_TASK_TYPES].sort())
  for (const fixture of fixtures) {
    const projected = projectTask(fixture)
    assert.ok(projected)
    assert.deepEqual(Object.keys(projected).sort(), [
      'attemptCount',
      'errorCode',
      'executionClass',
      'id',
      'input',
      'maxAttempts',
      'progress',
      'result',
      'status',
      'subject',
      'taskType',
      'timestamps'
    ])
  }
})

test('catalog never returns internal task fields or malicious payload values', () => {
  const projected = projectTask(taskFixture({
    taskType: 'code.repository.clone',
    subjectType: 'code-repository',
    subjectId: '7',
    input: { repoId: '7', path: '/secret/path', token: 'secret-token' },
    result: {
      message: '克隆完成',
      path: '/secret/result',
      token: 'secret-result-token',
      base64: 'secret-base64',
      apiResponse: { authorization: 'secret-auth' }
    }
  }))
  assert.ok(projected)
  const serialized = JSON.stringify(projected)
  for (const secret of [
    'secret-idempotency-key',
    'secret-input-fingerprint',
    'secret-version-id',
    'secret-content-hash',
    'secret-lease-token',
    'secret-lease-owner',
    'secret-token',
    'secret-result-token',
    '/secret/path',
    '/secret/result',
    'secret-base64',
    'secret-auth',
    'https://secret.example'
  ]) assert.equal(serialized.includes(secret), false, secret)
  for (const field of [
    'idempotencyKey',
    'inputFingerprint',
    'subjectVersionId',
    'subjectContentHash',
    'leaseToken',
    'leaseOwner',
    'leaseExpiresAt',
    'heartbeatAt',
    'errorSummary'
  ]) assert.equal(Object.hasOwn(projected, field), false, field)
  assert.equal(projected.input, null)
  assert.deepEqual(projected.result, { message: '克隆完成' })
})

test('catalog returns null for unknown task types and malformed payloads do not echo input', () => {
  for (const taskType of ['unknown.task', '__proto__', 'constructor']) {
    assert.equal(projectTask(taskFixture({ taskType })), null, taskType)
  }
  const projected = projectTask(taskFixture({
    input: { repoId: '7', token: 'secret-token' },
    result: 'malformed-result'
  }))
  assert.ok(projected)
  assert.equal(projected.input, null)
  assert.equal(projected.result, null)
  assert.doesNotMatch(JSON.stringify(projected), /secret-token|malformed-result/u)

  assert.equal(projectTask(taskFixture({ processorVersion: 'v0' })), null)
  assert.equal(projectTask(taskFixture({ executionClass: 'gpu' })), null)
  assert.equal(projectTask(taskFixture({ subjectId: 'someone-else' })), null)
})

test('catalog reserves retry metadata for the next task-center node', () => {
  for (const taskType of KNOWN_TASK_TYPES) {
    const metadata = TASK_TYPE_CATALOG[taskType]
    assert.equal(metadata.processorVersion, 'v1')
    assert.equal(typeof metadata.executionClass, 'string')
    assert.ok(metadata.mutexTaskTypes.includes(taskType))
    assert.deepEqual(metadata.retryableFrom, ['failed'])
  }
})

test('TaskStore supports controlled DESC ordering, task-type filtering, pagination, and count', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(CREATE_TASK_SCHEMA_SQL)
    const insert = database.prepare(`
      INSERT INTO tasks (
        idempotency_key, input_fingerprint, task_type, processor_version,
        subject_type, subject_id, input_json, status, execution_class,
        available_at, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'v1', ?, ?, ?, ?, ?, ?, 3, ?, ?)
    `)
    const timestamp = '2026-08-20T00:00:00.000Z'
    insert.run('task:' + 'a'.repeat(64), 'b'.repeat(64), 'games.steam.sync', 'game-library', 'owner', '{}', 'succeeded', 'network', timestamp, timestamp, timestamp)
    insert.run('task:' + 'c'.repeat(64), 'd'.repeat(64), 'games.steam.sync', 'game-library', 'owner', '{}', 'failed', 'network', timestamp, timestamp, timestamp)
    insert.run('task:' + 'e'.repeat(64), 'f'.repeat(64), 'anime.bangumi.refresh', 'anime', '7', '{"animeId":7}', 'failed', 'network', timestamp, timestamp, timestamp)
    insert.run('task:' + '1'.repeat(64), '2'.repeat(64), 'future.internal.task', 'v1', 'future', '9', '{}', 'failed', 'network', timestamp, timestamp, timestamp)

    const options = {
      status: ['failed'],
      taskTypes: ['games.steam.sync', 'anime.bangumi.refresh'],
      order: 'desc',
      limit: 2,
      offset: 0
    }
    assert.deepEqual(listTasks(database, options).map(({ id }) => id), [3, 2])
    assert.equal(countTasks(database, options), 2)
    assert.deepEqual(listTasks(database, { ...options, limit: 1, offset: 1 }).map(({ id }) => id), [2])
    assert.deepEqual(listTasks(database, {
      taskTypes: KNOWN_TASK_TYPES,
      order: 'asc',
      limit: 10,
      offset: 0
    }).map(({ taskType }) => taskType), [
      'games.steam.sync',
      'games.steam.sync',
      'anime.bangumi.refresh'
    ])
    assert.equal(countTasks(database, { taskTypes: KNOWN_TASK_TYPES, limit: 100, offset: 0 }), 3)
  } finally {
    database.close()
  }
})
