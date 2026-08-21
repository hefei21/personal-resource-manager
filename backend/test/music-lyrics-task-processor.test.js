import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { enqueueExclusiveRun, TaskStoreError } from '../src/services/taskStore.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
process.env.DATA_PATH ??= path.join(testDirectory, '.music-lyrics-task-test-data')

const {
  createMusicLyricsTaskProcessor,
  normalizeMusicLyricsTaskInput,
  MUSIC_LYRICS_EXECUTION_CLASS,
  MUSIC_LYRICS_PROCESSOR_VERSION,
  MUSIC_LYRICS_SUBJECT_ID,
  MUSIC_LYRICS_SUBJECT_TYPE,
  MUSIC_LYRICS_TASK_TYPE
} = await import('../src/services/musicLyricsTaskProcessor.js')

const routeSource = fs.readFileSync(
  path.join(testDirectory, '..', 'src', 'routes', 'music.js'),
  'utf8'
)

let Database = null
try {
  const databaseModule = await import('better-sqlite3')
  const probe = new databaseModule.default(':memory:')
  probe.close()
  Database = databaseModule.default
} catch {
  // Native SQLite is authoritative in Linux CI; pure processor tests still run locally.
}

const nativeDatabaseOptions = Database
  ? {}
  : { skip: 'better-sqlite3 native bindings are unavailable locally' }

function createFakeDatabase({ columns, rows }) {
  const music = new Map(rows.map((row) => [row.id, { ...row }]))
  const calls = {
    searches: [],
    reads: [],
    updates: [],
    prepared: []
  }
  return {
    calls,
    music,
    prepare(sql) {
      calls.prepared.push(sql)
      if (sql.includes('PRAGMA table_info(music)')) {
        return { all: () => columns.map((name) => ({ name })) }
      }
      if (sql.includes('SELECT') && sql.includes('FROM music')) {
        return {
          get(id) {
            calls.reads.push(id)
            return music.get(id) ?? null
          }
        }
      }
      if (sql.includes('UPDATE music')) {
        return {
          run(...parameters) {
            const id = parameters.at(-1)
            const row = music.get(id)
            calls.updates.push({ id, parameters })
            if (!row) return { changes: 0 }
            row.lyrics = parameters[0]
            if (columns.includes('lyrics_source')) row.lyrics_source = parameters[1]
            if (columns.includes('has_lyrics')) row.has_lyrics = 1
            return { changes: 1 }
          }
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }
}

function musicColumns() {
  return ['id', 'title', 'artist', 'lyrics', 'lyrics_source', 'has_lyrics', 'lyrics_updated_at']
}

function task(input, id = 1) {
  return {
    id,
    taskType: MUSIC_LYRICS_TASK_TYPE,
    processorVersion: MUSIC_LYRICS_PROCESSOR_VERSION,
    subjectType: MUSIC_LYRICS_SUBJECT_TYPE,
    subjectId: MUSIC_LYRICS_SUBJECT_ID,
    executionClass: MUSIC_LYRICS_EXECUTION_CLASS,
    input
  }
}

test('lyrics route retires the process-local Map and registers the persistent processor', () => {
  assert.doesNotMatch(routeSource, /\blyricTasks\s*=\s*new Map/u)
  assert.doesNotMatch(routeSource, /executeLyricDownloadTask/u)
  assert.match(routeSource, /enqueueExclusiveRun\(/u)
  assert.match(routeSource, /getTaskById\(/u)
  assert.match(routeSource, /registerTaskProcessor\(/u)
  assert.match(routeSource, /music\.lyrics\.batch/u)

  const batchRoute = routeSource.slice(
    routeSource.indexOf("router.post('/lyrics/batch-download'"),
    routeSource.indexOf("router.get('/lyrics/task/:taskId'")
  )
  assert.doesNotMatch(batchRoute, /HTTP_PROXY|Cookie|Authorization|file_path|storagePath/u)

  const statusRoute = routeSource.slice(
    routeSource.indexOf("router.get('/lyrics/task/:taskId'"),
    routeSource.indexOf("router.get('/:id/lyrics'", routeSource.indexOf("router.get('/lyrics/task/:taskId'"))
  )
  assert.doesNotMatch(statusRoute, /leaseToken|leaseOwner|stack|file_path|storagePath/u)
  assert.match(routeSource, /succeeded:\s*'completed'/u)
  assert.match(routeSource, /cancelled:\s*'cancelled'/u)
})

test('lyrics task input rejects sensitive or unsupported fields and normalizes IDs', () => {
  assert.deepEqual(
    normalizeMusicLyricsTaskInput({ input: { musicIds: [9, 3, 9, 1] } }),
    { musicIds: [1, 3, 9], force: false }
  )

  for (const field of ['HTTP_PROXY', 'Cookie', 'token', 'path']) {
    assert.throws(
      () => normalizeMusicLyricsTaskInput({ input: { musicIds: [1], [field]: 'secret' } }),
      (error) => error.code === 'TASK_INPUT_INVALID'
    )
  }
  assert.throws(
    () => normalizeMusicLyricsTaskInput({ input: { musicIds: [1], force: 'true' } }),
    (error) => error.code === 'TASK_INPUT_INVALID'
  )
  assert.throws(
    () => normalizeMusicLyricsTaskInput({ input: { musicIds: [0] } }),
    (error) => error.code === 'TASK_INPUT_INVALID'
  )
})

test('lyrics processor reports partial success, skips existing lyrics, and writes percentage progress', async () => {
  const database = createFakeDatabase({
    columns: musicColumns(),
    rows: [
      { id: 1, title: 'Existing', artist: 'Artist', lyrics: '[00:01.000]old', lyrics_source: 'manual', has_lyrics: 1 },
      { id: 2, title: 'Missing', artist: 'Artist', lyrics: null, lyrics_source: null, has_lyrics: 0 },
      { id: 3, title: 'Found', artist: 'Artist', lyrics: null, lyrics_source: null, has_lyrics: 0 }
    ]
  })
  const searchCalls = []
  const progress = []
  const processor = createMusicLyricsTaskProcessor({
    database,
    searchLyricsFromSources: async (title, artist, options) => {
      searchCalls.push({ title, artist, signal: options.signal })
      if (title === 'Found') return { source: 'QQ音乐', lrc: '[00:01.000]new' }
      return null
    }
  })

  const result = await processor({
    task: task({ musicIds: [3, 1, 2, 2], force: false }),
    signal: new AbortController().signal,
    progress: async (value) => progress.push(value)
  })

  assert.deepEqual(progress, [0, 33, 67, 100])
  assert.deepEqual(database.calls.reads, [1, 2, 3])
  assert.deepEqual(searchCalls.map(({ title }) => title), ['Missing', 'Found'])
  assert.equal(searchCalls[0].signal instanceof AbortSignal, true)
  assert.deepEqual(result, {
    total: 3,
    success: 1,
    failed: 1,
    skipped: 1,
    results: [
      { musicId: 1, success: true, source: 'manual', skipped: true, reason: '已有歌词' },
      { musicId: 2, success: false, error: '未找到歌词' },
      { musicId: 3, success: true, source: 'QQ音乐' }
    ]
  })
  for (const item of result.results) {
    assert.deepEqual(Object.keys(item).sort(), Object.keys(item).filter((key) => [
      'musicId', 'success', 'source', 'error', 'skipped', 'reason'
    ].includes(key)).sort())
  }
})

test('lyrics processor converts external exceptions to stable per-song errors and honors force', async () => {
  const database = createFakeDatabase({
    columns: musicColumns(),
    rows: [
      { id: 1, title: 'Existing', artist: 'Artist', lyrics: 'old', lyrics_source: 'manual', has_lyrics: 1 }
    ]
  })
  let calls = 0
  const searchLyricsFromSources = async () => {
    calls += 1
    throw new Error('raw upstream response /secret/path')
  }
  const processor = createMusicLyricsTaskProcessor({ database, searchLyricsFromSources })

  const skipped = await processor({ task: task({ musicIds: [1], force: false }) })
  assert.equal(calls, 0)
  assert.deepEqual(skipped, {
    total: 1,
    success: 0,
    failed: 0,
    skipped: 1,
    results: [{ musicId: 1, success: true, source: 'manual', skipped: true, reason: '已有歌词' }]
  })

  const forced = await processor({ task: task({ musicIds: [1], force: true }) })
  assert.equal(calls, 1)
  assert.deepEqual(forced, {
    total: 1,
    success: 0,
    failed: 1,
    skipped: 0,
    results: [{ musicId: 1, success: false, error: '歌词源请求失败' }]
  })
})

test('lyrics processor fails schema errors without retry and propagates cancellation', async () => {
  const missingSchema = createFakeDatabase({
    columns: ['id', 'title', 'artist'],
    rows: []
  })
  const missingSchemaProcessor = createMusicLyricsTaskProcessor({ database: missingSchema })
  await assert.rejects(
    () => missingSchemaProcessor({ task: task({ musicIds: [1] }) }),
    (error) => error.code === 'MUSIC_SCHEMA_MISSING' && error.retryable === false
  )

  const database = createFakeDatabase({
    columns: musicColumns(),
    rows: [{ id: 1, title: 'Held', artist: 'Artist', lyrics: null, lyrics_source: null, has_lyrics: 0 }]
  })
  const controller = new AbortController()
  const processor = createMusicLyricsTaskProcessor({
    database,
    searchLyricsFromSources: async (title, artist, { signal }) => {
      assert.equal(title, 'Held')
      assert.equal(artist, 'Artist')
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          error.code = 'ABORT_ERR'
          reject(error)
        }, { once: true })
      })
    }
  })
  const running = processor({ task: task({ musicIds: [1] }), signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(running, (error) => error.code === 'TASK_CANCELLED' && error.retryable === false)
})

test('lyrics task uses one persistent mutex domain with idempotent retries', nativeDatabaseOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(CREATE_TASK_SCHEMA_SQL)
    const input = {
      musicIds: [1, 2],
      force: false
    }
    const identity = (subjectVersionId, taskInput = input) => ({
      taskType: MUSIC_LYRICS_TASK_TYPE,
      processorVersion: MUSIC_LYRICS_PROCESSOR_VERSION,
      subjectType: MUSIC_LYRICS_SUBJECT_TYPE,
      subjectId: MUSIC_LYRICS_SUBJECT_ID,
      subjectVersionId,
      executionClass: MUSIC_LYRICS_EXECUTION_CLASS,
      input: taskInput
    })

    const first = enqueueExclusiveRun(database, identity('run-1'), {
      taskTypes: [MUSIC_LYRICS_TASK_TYPE]
    })
    const repeated = enqueueExclusiveRun(database, identity('run-1'), {
      taskTypes: [MUSIC_LYRICS_TASK_TYPE]
    })
    const conflict = enqueueExclusiveRun(database, identity('run-2'), {
      taskTypes: [MUSIC_LYRICS_TASK_TYPE]
    })

    assert.equal(first.created, true)
    assert.equal(repeated.outcome, 'idempotent')
    assert.equal(repeated.task.id, first.task.id)
    assert.equal(conflict.activeConflict, true)
    assert.equal(conflict.task.id, first.task.id)
    assert.equal(first.task.input.HTTP_PROXY, undefined)
    assert.throws(
      () => enqueueExclusiveRun(database, identity('run-1', { musicIds: [1], force: true }), {
        taskTypes: [MUSIC_LYRICS_TASK_TYPE]
      }),
      (error) => error instanceof TaskStoreError && error.code === 'TASK_IDEMPOTENCY_CONFLICT'
    )
  } finally {
    database.close()
  }
})
