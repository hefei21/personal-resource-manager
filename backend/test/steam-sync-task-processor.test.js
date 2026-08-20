import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'steam-sync-task-test-data')

const {
  createSteamSyncTaskProcessor,
  STEAM_SYNC_EXECUTION_CLASS,
  STEAM_SYNC_PROCESSOR_VERSION,
  STEAM_SYNC_SUBJECT_ID,
  STEAM_SYNC_SUBJECT_TYPE,
  STEAM_SYNC_TASK_TYPE
} = await import('../src/services/steamSyncTaskProcessor.js')
const { getTaskRuntime } = await import('../src/services/taskRuntime.js')
const {
  enqueueSteamSyncTask,
  normalizeSteamSyncIdempotencyKey,
  publicSteamSyncTaskStatus
} = await import('../src/routes/games.js')

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
const GAMES_ROUTE_SOURCE = readFileSync(
  path.join(TEST_DIRECTORY, '..', 'src', 'routes', 'games.js'),
  'utf8'
)

function createFakeDatabase({ config = { steam_id: 'steam-id', api_key: 'api-key' }, games = [] } = {}) {
  const state = {
    config,
    games: new Map(games.map((game, index) => [game.steam_appid, { id: index + 1, ...game }])),
    transactionCalls: 0,
    lastSync: null
  }

  return {
    state,
    prepare(sql) {
      const normalized = sql.replace(/\s+/gu, ' ').trim()
      if (normalized.startsWith('SELECT steam_id, api_key FROM steam_config')) {
        return { get: () => state.config }
      }
      if (normalized.startsWith('SELECT id, cover_image, cover_image_data FROM games')) {
        return { get: (steamAppId) => state.games.get(steamAppId) ?? undefined }
      }
      if (normalized.startsWith('INSERT INTO games')) {
        return {
          run: (steamAppId, title, coverImage, playtimeForever, playtime2Weeks, lastPlayed) => {
            if (state.games.has(steamAppId)) throw new Error('duplicate game')
            state.games.set(steamAppId, {
              id: state.games.size + 1,
              steam_appid: steamAppId,
              title,
              cover_image: coverImage,
              cover_image_data: null,
              playtime_forever: playtimeForever,
              playtime_2weeks: playtime2Weeks,
              last_played: lastPlayed
            })
            return { changes: 1 }
          }
        }
      }
      if (normalized.startsWith('UPDATE games SET')) {
        return {
          run: (playtimeForever, playtime2Weeks, lastPlayed, coverImage, steamAppId) => {
            const game = state.games.get(steamAppId)
            if (!game) return { changes: 0 }
            Object.assign(game, {
              playtime_forever: playtimeForever,
              playtime_2weeks: playtime2Weeks,
              last_played: lastPlayed,
              cover_image: coverImage
            })
            return { changes: 1 }
          }
        }
      }
      if (normalized.startsWith('UPDATE steam_config SET last_sync')) {
        return {
          run: () => {
            state.lastSync = 'updated'
            return { changes: state.config ? 1 : 0 }
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
    taskType: STEAM_SYNC_TASK_TYPE,
    processorVersion: STEAM_SYNC_PROCESSOR_VERSION,
    executionClass: STEAM_SYNC_EXECUTION_CLASS,
    subjectType: STEAM_SYNC_SUBJECT_TYPE,
    subjectId: STEAM_SYNC_SUBJECT_ID,
    input: {},
    ...overrides
  }
}

function successfulResponse(games = []) {
  return {
    status: 200,
    data: { response: { games } }
  }
}

test('Steam sync module registers one processor without starting the runtime', () => {
  const status = getTaskRuntime().status()
  assert.equal(status.state, 'idle')
  assert.equal(status.acceptingRegistrations, true)
  assert.equal(status.registeredProcessorCount, 1)
  assert.equal(status.executorState, null)
  assert.match(GAMES_ROUTE_SOURCE, /enqueueExclusiveRun/u)
  assert.doesNotMatch(GAMES_ROUTE_SOURCE, /\bsyncTasks\b/u)
  assert.doesNotMatch(GAMES_ROUTE_SOURCE, /\bsetInterval\s*\(/u)
  assert.doesNotMatch(GAMES_ROUTE_SOURCE, /executeSyncTask/u)
})

test('Steam Idempotency-Key is normalized and rejects empty, long, or control values', () => {
  assert.equal(normalizeSteamSyncIdempotencyKey('  sync-key  '), 'sync-key')
  assert.equal(normalizeSteamSyncIdempotencyKey(undefined).length, 36)
  assert.throws(() => normalizeSteamSyncIdempotencyKey(''), (error) => {
    return error.code === 'TASK_IDEMPOTENCY_KEY_INVALID'
  })
  assert.throws(() => normalizeSteamSyncIdempotencyKey('x'.repeat(129)), (error) => {
    return error.code === 'TASK_IDEMPOTENCY_KEY_INVALID'
  })
  assert.throws(() => normalizeSteamSyncIdempotencyKey('safe\nunsafe'), (error) => {
    return error.code === 'TASK_IDEMPOTENCY_KEY_INVALID'
  })
})

test('Steam processor reads credentials at execution time and passes params plus AbortSignal', async () => {
  const database = createFakeDatabase({ config: null })
  const requests = []
  const progress = []
  const processor = createSteamSyncTaskProcessor({
    databaseProvider: () => database,
    axiosClient: {
      get: async (url, options) => {
        requests.push({ url, options })
        return successfulResponse()
      }
    }
  })
  database.state.config = { steam_id: ' steam-id ', api_key: ' api-key ' }
  const controller = new AbortController()

  const result = await processor({
    task: task(),
    signal: controller.signal,
    progress: async (value) => progress.push(value)
  })

  assert.deepEqual(result, { total: 0, inserted: 0, updated: 0 })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.includes('?'), false)
  assert.deepEqual(requests[0].options.params, {
    key: 'api-key',
    steamid: 'steam-id',
    include_appinfo: 1,
    include_played_free_games: 1
  })
  assert.equal(requests[0].options.signal, controller.signal)
  assert.deepEqual(progress, [10, 50, 100])
  assert.equal(database.state.transactionCalls, 1)
})

test('Steam processor classifies 403 as stable and network failures as retryable without leaking request data', async () => {
  const database = createFakeDatabase()
  const stableProcessor = createSteamSyncTaskProcessor({
    database,
    axiosClient: {
      get: async () => ({
        status: 403,
        data: { key: 'secret', steamid: 'private' }
      })
    }
  })
  await assert.rejects(
    () => stableProcessor({ task: task(), signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, 'STEAM_API_KEY_INVALID')
      assert.equal(error.retryable, false)
      assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /secret|private|api\.steampowered\.com|key=/iu)
      return true
    }
  )

  const networkProcessor = createSteamSyncTaskProcessor({
    database,
    axiosClient: {
      get: async () => {
        const error = new Error('request details must not escape')
        error.code = 'ETIMEDOUT'
        error.config = { url: 'https://api.steampowered.com/?key=secret&steamid=private' }
        throw error
      }
    }
  })
  await assert.rejects(
    () => networkProcessor({ task: task(), signal: new AbortController().signal }),
    (error) => {
      assert.equal(error.code, 'STEAM_NETWORK_ERROR')
      assert.equal(error.retryable, true)
      assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /secret|private|api\.steampowered\.com|key=/iu)
      return true
    }
  )
})

test('Steam processor passes cancellation through, performs one request per attempt, and keeps upserts idempotent', async () => {
  const database = createFakeDatabase({
    games: [{
      steam_appid: 10,
      title: 'Existing',
      cover_image: 'https://example.test/cover.jpg',
      cover_image_data: 'base64-cover',
      playtime_forever: 1,
      playtime_2weeks: 0,
      last_played: null
    }]
  })
  const requests = []
  const processor = createSteamSyncTaskProcessor({
    database,
    axiosClient: {
      get: async (url, options) => {
        requests.push({ url, options })
        return successfulResponse([
          { appid: 10, name: 'Existing', playtime_forever: 20, playtime_2weeks: 2, rtime_last_played: 100 },
          { appid: 20, name: 'New', playtime_forever: 3, playtime_2weeks: 1, rtime_last_played: 200 }
        ])
      }
    }
  })

  const first = await processor({ task: task({ id: 11 }), signal: new AbortController().signal })
  const second = await processor({ task: task({ id: 11 }), signal: new AbortController().signal })

  assert.deepEqual(first, { total: 2, inserted: 1, updated: 1 })
  assert.deepEqual(second, { total: 2, inserted: 0, updated: 2 })
  assert.equal(requests.length, 2)
  assert.equal(database.state.games.size, 2)
  assert.equal(database.state.games.get(10).cover_image, 'https://example.test/cover.jpg')
  assert.equal(database.state.lastSync, 'updated')

  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    () => processor({ task: task({ id: 12 }), signal: cancelled.signal }),
    (error) => error.code === 'TASK_CANCELLED' && error.retryable === false
  )
  assert.equal(requests.length, 2)
})

test('Steam enqueue uses persistent mutex, idempotency, empty input, and three attempts', DATABASE_TEST_OPTIONS, () => {
  const database = new NativeDatabase(':memory:')
  try {
    database.exec(CREATE_TASK_SCHEMA_SQL)
    const first = enqueueSteamSyncTask(database, 'sync-key')
    const repeated = enqueueSteamSyncTask(database, 'sync-key')
    const conflict = enqueueSteamSyncTask(database, 'different-key')
    const row = database.prepare('SELECT * FROM tasks WHERE id = ?').get(first.task.id)

    assert.equal(first.created, true)
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, first.task.id)
    assert.equal(conflict.activeConflict, true)
    assert.equal(conflict.task.id, first.task.id)
    assert.equal(row.task_type, STEAM_SYNC_TASK_TYPE)
    assert.equal(row.processor_version, STEAM_SYNC_PROCESSOR_VERSION)
    assert.equal(row.execution_class, STEAM_SYNC_EXECUTION_CLASS)
    assert.equal(row.subject_type, STEAM_SYNC_SUBJECT_TYPE)
    assert.equal(row.subject_id, STEAM_SYNC_SUBJECT_ID)
    assert.equal(row.input_json, '{}')
    assert.equal(row.max_attempts, 3)
    assert.doesNotMatch(JSON.stringify({ input: first.task.input, result: first.task.result, error: first.task.errorSummary }), /steam_id|api_key|steamid|api\.steampowered\.com|cookie|token/iu)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
  } finally {
    database.close()
  }
})

test('Steam task status keeps compatibility fields while filtering input, lease, stack, and unsafe result fields', () => {
  const view = publicSteamSyncTaskStatus({
    id: 9,
    taskType: STEAM_SYNC_TASK_TYPE,
    processorVersion: STEAM_SYNC_PROCESSOR_VERSION,
    executionClass: STEAM_SYNC_EXECUTION_CLASS,
    subjectType: STEAM_SYNC_SUBJECT_TYPE,
    subjectId: STEAM_SYNC_SUBJECT_ID,
    status: 'succeeded',
    progress: 100,
    input: { api_key: 'must-not-show' },
    leaseToken: 'must-not-show',
    leaseOwner: 'must-not-show',
    stack: 'must-not-show',
    result: { total: 4, inserted: 2, updated: 2, response: 'must-not-show' },
    createdAt: '2026-08-20T01:00:00.000Z',
    startedAt: '2026-08-20T01:00:01.000Z',
    finishedAt: '2026-08-20T01:00:02.000Z',
    errorSummary: null,
    errorCode: null
  })

  assert.deepEqual(Object.keys(view).sort(), [
    'endTime',
    'error',
    'id',
    'message',
    'progress',
    'result',
    'startTime',
    'status',
    'taskId'
  ])
  assert.equal(view.status, 'completed')
  assert.deepEqual(view.result, {
    total: 4,
    inserted: 2,
    updated: 2,
    newCount: 2,
    updateCount: 2
  })
  assert.doesNotMatch(JSON.stringify(view), /api_key|must-not-show|response/iu)
})
