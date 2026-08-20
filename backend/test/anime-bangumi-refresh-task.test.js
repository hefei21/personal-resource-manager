import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'anime-bangumi-refresh-task-test-data')

const processorModule = await import('../src/services/bangumiRefreshTaskProcessor.js')
const routeModule = await import('../src/routes/anime.js')
const { getTaskRuntime } = await import('../src/services/taskRuntime.js')

const require = createRequire(import.meta.url)
let NativeDatabase = null
try {
  const candidate = require('better-sqlite3')
  const probe = new candidate(':memory:')
  probe.close()
  NativeDatabase = candidate
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
}

const DATABASE_TEST_OPTIONS = NativeDatabase
  ? {}
  : { skip: 'better-sqlite3 native bindings are unavailable locally; Node 22 CI must run this test' }

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const ANIME_ROUTE_SOURCE = readFileSync(
  path.join(TEST_DIRECTORY, '..', 'src', 'routes', 'anime.js'),
  'utf8'
)
const BANGUMI_PROCESSOR_SOURCE = readFileSync(
  path.join(TEST_DIRECTORY, '..', 'src', 'services', 'bangumiRefreshTaskProcessor.js'),
  'utf8'
)
const ANIME_API_SOURCE = readFileSync(
  path.join(TEST_DIRECTORY, '..', '..', 'frontend', 'src', 'api', 'index.js'),
  'utf8'
)
const ANIME_DIALOG_SOURCE = readFileSync(
  path.join(TEST_DIRECTORY, '..', '..', 'frontend', 'src', 'components', 'AnimeDetailDialog.vue'),
  'utf8'
)

const {
  BANGUMI_REFRESH_EXECUTION_CLASS,
  BANGUMI_REFRESH_PROCESSOR_VERSION,
  BANGUMI_REFRESH_SUBJECT_TYPE,
  BANGUMI_REFRESH_TASK_TYPE,
  createBangumiRefreshTaskProcessor
} = processorModule

function createDatabase() {
  const database = new NativeDatabase(':memory:')
  database.exec(CREATE_TASK_SCHEMA_SQL)
  database.exec(`
    CREATE TABLE anime (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bangumi_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      name_cn TEXT,
      name_original TEXT,
      summary TEXT,
      cover_image TEXT,
      rating REAL DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      tags TEXT,
      air_date TEXT,
      eps INTEGER DEFAULT 0,
      eps_total INTEGER DEFAULT 0,
      author TEXT,
      director TEXT,
      studio TEXT,
      infobox TEXT,
      characters TEXT,
      staff TEXT,
      cover_image_data TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
  return database
}

function insertAnime(database, { id = 1, bangumiId = 123 } = {}) {
  database.prepare(
    'INSERT INTO anime (id, bangumi_id, title) VALUES (?, ?, ?)'
  ).run(id, bangumiId, '旧标题')
}

function createFakeDatabase(bangumiId = 123) {
  const state = {
    anime: bangumiId === undefined ? null : { bangumi_id: bangumiId },
    updates: [],
    transactionCalls: 0
  }
  return {
    state,
    prepare(sql) {
      const normalized = sql.replace(/\s+/gu, ' ').trim()
      if (normalized.startsWith('SELECT bangumi_id FROM anime')) {
        return { get: () => state.anime }
      }
      if (normalized.startsWith('UPDATE anime SET')) {
        return {
          run: (...args) => {
            state.updates.push(args)
            return { changes: state.anime ? 1 : 0 }
          }
        }
      }
      throw new Error(`Unexpected fake SQL: ${normalized}`)
    },
    transaction(callback) {
      state.transactionCalls += 1
      return (...args) => callback(...args)
    }
  }
}

function task(overrides = {}) {
  return {
    id: 1,
    taskType: BANGUMI_REFRESH_TASK_TYPE,
    processorVersion: BANGUMI_REFRESH_PROCESSOR_VERSION,
    executionClass: BANGUMI_REFRESH_EXECUTION_CLASS,
    subjectType: BANGUMI_REFRESH_SUBJECT_TYPE,
    subjectId: '1',
    input: { animeId: 1 },
    ...overrides
  }
}

function detailFixture() {
  return {
    subject: {
      id: 123,
      name: '新标题',
      name_cn: '新中文标题',
      summary: '新简介',
      images: { large: 'https://img.example/cover.jpg' },
      rating: { score: 8.5, total: 100 },
      tags: [{ name: '动作' }, { name: '奇幻' }],
      date: '2026-08-20',
      eps: 12,
      eps_count: 12,
      infobox: [
        { key: '作者', value: '作者甲' },
        { key: '动画制作', value: '制作社' }
      ]
    },
    characters: [{ id: 1, name: '角色甲' }],
    persons: [{ id: 2, name: '人员乙' }]
  }
}

function createProcessor(database, hooks = {}) {
  return createBangumiRefreshTaskProcessor({
    database,
    fetchDetail: hooks.fetchDetail || (async () => detailFixture()),
    downloadImage: hooks.downloadImage || (async () => 'data:image/jpeg;base64,cover'),
    extractInfobox: hooks.extractInfobox || ((infobox, key) => {
      const item = infobox.find((entry) => entry.key === key)
      return item?.value || null
    })
  })
}

test('anime route registers the Bangumi processor before the runtime starts', () => {
  const status = getTaskRuntime().status()
  assert.equal(status.state, 'idle')
  assert.equal(status.acceptingRegistrations, true)
  assert.equal(status.registeredProcessorCount, 1)
  assert.match(ANIME_ROUTE_SOURCE, /registerTaskProcessor\(/u)
  assert.ok(ANIME_ROUTE_SOURCE.indexOf('registerTaskProcessor(') < ANIME_ROUTE_SOURCE.indexOf('export default router'))
})

test('refresh enqueue uses one per-anime persistent mutex and idempotency', DATABASE_TEST_OPTIONS, () => {
  const database = createDatabase()
  try {
    insertAnime(database)
    const first = routeModule.enqueueBangumiRefreshTask(database, 1, '  refresh-key  ')
    const repeated = routeModule.enqueueBangumiRefreshTask(database, 1, 'refresh-key')
    const conflict = routeModule.enqueueBangumiRefreshTask(database, 1, 'another-key')
    const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(first.task.id)

    assert.equal(first.created, true)
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, first.task.id)
    assert.equal(conflict.activeConflict, true)
    assert.equal(conflict.task.id, first.task.id)
    assert.equal(row.task_type, BANGUMI_REFRESH_TASK_TYPE)
    assert.equal(row.processor_version, BANGUMI_REFRESH_PROCESSOR_VERSION)
    assert.equal(row.execution_class, BANGUMI_REFRESH_EXECUTION_CLASS)
    assert.equal(row.subject_type, BANGUMI_REFRESH_SUBJECT_TYPE)
    assert.equal(row.subject_id, '1')
    assert.deepEqual(JSON.parse(row.input_json), { animeId: 1 })
    assert.doesNotMatch(row.input_json, /token|authorization|header|proxy|cover|response/iu)
  } finally {
    database.close()
  }
})

test('processor passes bypassCache and AbortSignal, performs one atomic update, and returns bounded result', async () => {
  const database = createFakeDatabase()
  const requests = []
  const imageRequests = []
  const progress = []
  const controller = new AbortController()
  const processor = createProcessor(database, {
    fetchDetail: async (bangumiId, options) => {
      requests.push({ bangumiId, options })
      return detailFixture()
    },
    downloadImage: async (url, options) => {
      imageRequests.push({ url, options })
      return 'data:image/jpeg;base64,cover'
    }
  })

  const result = await processor({
    task: task(),
    signal: controller.signal,
    progress: async (value) => progress.push(value)
  })

  assert.deepEqual(result, { animeId: 1, bangumiId: 123, message: '动漫刷新成功。' })
  assert.deepEqual(requests, [{ bangumiId: 123, options: { bypassCache: true, signal: controller.signal } }])
  assert.deepEqual(imageRequests, [{
    url: 'https://img.example/cover.jpg',
    options: { signal: controller.signal }
  }])
  assert.deepEqual(progress, [0, 70, 100])
  assert.equal(database.state.transactionCalls, 1)
  assert.equal(database.state.updates.length, 1)
  assert.equal(database.state.updates[0][0], '新标题')
  assert.equal(database.state.updates[0][1], '新中文标题')
  assert.equal(database.state.updates[0][8], '动作,奇幻')
  assert.equal(database.state.updates[0][15], JSON.stringify(detailFixture().subject.infobox))
  assert.equal(database.state.updates[0][16], JSON.stringify(detailFixture().characters))
  assert.equal(database.state.updates[0][17], JSON.stringify(detailFixture().persons))
  assert.deepEqual(Object.keys(result).sort(), ['animeId', 'bangumiId', 'message'])
  assert.doesNotMatch(JSON.stringify(result), /characters|staff|infobox|base64|cover/iu)
})

test('processor rejects credential-bearing input without persisting it', async () => {
  const database = createFakeDatabase()
  const processor = createProcessor(database)
  await assert.rejects(
    () => processor({
      task: task({ input: { animeId: 1, token: 'secret-token' } }),
      signal: new AbortController().signal
    }),
    (error) => {
      assert.equal(error.code, 'TASK_INPUT_INVALID')
      assert.equal(error.retryable, false)
      assert.doesNotMatch(JSON.stringify(error), /secret-token|authorization|proxy/iu)
      return true
    }
  )
  assert.equal(database.state.updates.length, 0)
})

test('cover download propagates cancellation instead of returning null', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => routeModule.downloadImageAsBase64('https://img.example/cover.jpg', { signal: controller.signal }),
    (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
  )
})

test('processor classifies stable, retryable, and cancellation failures without request details', async () => {
  const cases = [
    [{ response: { status: 404 } }, 'BANGUMI_NOT_FOUND', false],
    [{ response: { status: 401 } }, 'BANGUMI_CREDENTIALS_INVALID', false],
    [{ response: { status: 403 } }, 'BANGUMI_CREDENTIALS_INVALID', false],
    [{ response: { status: 429 } }, 'BANGUMI_RATE_LIMITED', true],
    [{ response: { status: 503 } }, 'BANGUMI_UNAVAILABLE', true],
    [Object.assign(new Error('timeout at https://api.example/?token=secret'), { code: 'ETIMEDOUT' }), 'BANGUMI_NETWORK_ERROR', true]
  ]

  for (const [failure, code, retryable] of cases) {
    const processor = createProcessor(createFakeDatabase(), {
      fetchDetail: async () => { throw failure }
    })
    await assert.rejects(
      () => processor({ task: task(), signal: new AbortController().signal }),
      (error) => {
        assert.equal(error.code, code)
        assert.equal(error.retryable, retryable)
        assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /secret|api\.example|token=/iu)
        return true
      }
    )
  }

  const invalidProcessor = createProcessor(createFakeDatabase(), {
    fetchDetail: async () => ({ subject: {}, characters: [], persons: [] })
  })
  await assert.rejects(
    () => invalidProcessor({ task: task(), signal: new AbortController().signal }),
    (error) => error.code === 'BANGUMI_RESPONSE_INVALID' && error.retryable === false
  )

  const missingIdProcessor = createProcessor(createFakeDatabase(null))
  await assert.rejects(
    () => missingIdProcessor({ task: task(), signal: new AbortController().signal }),
    (error) => error.code === 'ANIME_BANGUMI_ID_MISSING' && error.retryable === false
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => createProcessor(createFakeDatabase())({ task: task(), signal: controller.signal }),
    (error) => error.code === 'TASK_CANCELLED' && error.retryable === false
  )
})

test('refresh task status filters identity and internal task fields', () => {
  const view = routeModule.publicBangumiRefreshTaskStatus({
    id: 9,
    taskType: BANGUMI_REFRESH_TASK_TYPE,
    processorVersion: BANGUMI_REFRESH_PROCESSOR_VERSION,
    executionClass: BANGUMI_REFRESH_EXECUTION_CLASS,
    subjectType: BANGUMI_REFRESH_SUBJECT_TYPE,
    subjectId: '1',
    status: 'failed',
    progress: 55,
    input: { animeId: 1, token: 'secret-token' },
    leaseToken: 'secret-lease',
    leaseOwner: 'secret-owner',
    stack: 'secret-stack',
    result: { animeId: 1, characters: [{ name: 'private' }], base64: 'secret-cover' },
    errorSummary: 'https://api.example/?token=secret',
    errorCode: 'BANGUMI_UNAVAILABLE'
  }, 1)

  assert.deepEqual(Object.keys(view).sort(), ['errorCode', 'message', 'progress', 'status', 'taskId'])
  assert.equal(view.status, 'failed')
  assert.equal(view.progress, 55)
  assert.equal(view.errorCode, 'BANGUMI_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(view), /secret|characters|stack|lease|result|api\.example/iu)
  assert.equal(routeModule.publicBangumiRefreshTaskStatus({
    taskType: BANGUMI_REFRESH_TASK_TYPE,
    processorVersion: BANGUMI_REFRESH_PROCESSOR_VERSION,
    executionClass: BANGUMI_REFRESH_EXECUTION_CLASS,
    subjectType: BANGUMI_REFRESH_SUBJECT_TYPE,
    subjectId: '2',
    status: 'running',
    progress: 1
  }, 1), null)
})

test('route and frontend source keep cache, signal, status polling, and compatibility contracts', () => {
  const detailSource = ANIME_ROUTE_SOURCE.slice(
    ANIME_ROUTE_SOURCE.indexOf('export async function getAnimeDetail'),
    ANIME_ROUTE_SOURCE.indexOf('// 从 infobox 提取特定字段')
  )
  const axiosLines = detailSource.split('\n').filter((line) => line.includes('axios.get('))
  assert.equal(axiosLines.length, 3)
  assert.equal(axiosLines.every((line) => line.includes('signal')), true)
  assert.match(detailSource, /if \(!bypassCache\)/u)
  assert.match(BANGUMI_PROCESSOR_SOURCE, /fetchDetail\(bangumiId, \{ bypassCache: true, signal \}\)/u)
  assert.match(ANIME_ROUTE_SOURCE, /fetchDetail: getAnimeDetail/u)
  assert.match(ANIME_ROUTE_SOURCE, /safeAxiosGet\(imageUrl, \{[\s\S]*signal/u)
  assert.match(ANIME_ROUTE_SOURCE, /if \(isAbortError\(error, signal\)\) throw error/u)
  assert.match(ANIME_API_SOURCE, /getRefreshStatus: \(id, taskId\) => api\.get\(`/u)
  assert.match(ANIME_DIALOG_SOURCE, /api\.anime\.getRefreshStatus\(animeId, taskId\)/u)
  assert.match(ANIME_DIALOG_SOURCE, /REFRESH_POLL_INTERVAL_MS = 1000/u)
  assert.match(ANIME_DIALOG_SOURCE, /REFRESH_POLL_TIMEOUT_MS/u)
  assert.match(ANIME_DIALOG_SOURCE, /onUnmounted\(/u)
  assert.match(ANIME_DIALOG_SOURCE, /clearTimeout\(refreshPollTimer\)/u)
  assert.match(ANIME_DIALOG_SOURCE, /const detailResponse = await api\.anime\.get\(animeId\)/u)
  assert.match(ANIME_DIALOG_SOURCE, /if \(!localAnime\.value \|\| refreshing\.value\) return/u)
})
