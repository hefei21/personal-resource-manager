import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-music-metadata-tests-'))
const previousDataPath = process.env.DATA_PATH
const previousMusicPath = process.env.MUSIC_PATH
process.env.DATA_PATH = path.join(testRoot, 'data')
process.env.MUSIC_PATH = path.join(testRoot, 'music')

const processorModule = await import('../src/services/musicMetadataTaskProcessor.js')
const migrationModule = await import('../src/config/databaseMigrations.js')
const {
  createMusicMetadataTaskProcessor,
  enqueueMusicMetadataTask,
  MUSIC_METADATA_EXECUTION_CLASS,
  MUSIC_METADATA_PARSER_VERSION,
  MUSIC_METADATA_PROCESSOR_VERSION,
  MUSIC_METADATA_SUBJECT_TYPE,
  MUSIC_METADATA_TASK_TYPE
} = processorModule
const { applicationMigrationRegistry } = migrationModule

const HASH = 'a'.repeat(64)
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
const taskMigration = applicationMigrationRegistry.migrations.find(({ id }) => id === '0054_persistent_tasks')

test.after(() => {
  if (previousDataPath === undefined) delete process.env.DATA_PATH
  else process.env.DATA_PATH = previousDataPath
  if (previousMusicPath === undefined) delete process.env.MUSIC_PATH
  else process.env.MUSIC_PATH = previousMusicPath
  fs.rmSync(testRoot, { recursive: true, force: true })
})

function makeMusic(overrides = {}) {
  return {
    id: 17,
    title: 'track',
    artist: '用户歌手',
    album: null,
    duration: 0,
    cover_image: null,
    original_name: 'track.mp3',
    file_type: 'mp3',
    content_sha256: HASH,
    metadata_status: 'pending',
    metadata_error_code: 'MUSIC_METADATA_PARSE_FAILED',
    ...overrides
  }
}

function createFakeDatabase(music) {
  const database = {
    music,
    updates: [],
    prepare(sql) {
      if (/^\s*SELECT\s+m\.\*/u.test(sql)) return { get: () => database.music }
      if (/^\s*UPDATE\s+music\s+SET/u.test(sql)) {
        return {
          run: (...parameters) => {
            database.updates.push({ sql, parameters })
            if (sql.includes('metadata_error_code = NULL')) {
              const fields = ['title', 'artist', 'album', 'duration', 'cover_image']
                .filter(field => new RegExp(`${field} = \\?`, 'u').test(sql))
              fields.forEach((field, index) => { database.music[field] = parameters[index] })
              database.music.metadata_status = parameters[fields.length]
              database.music.metadata_error_code = null
              return { changes: parameters.at(-2) === database.music.id && parameters.at(-1) === HASH ? 1 : 0 }
            }
            const [status, errorCode, parserVersion, musicId, contentHash] = parameters
            if (musicId === database.music.id && contentHash === HASH) {
              database.music.metadata_status = status
              database.music.metadata_error_code = errorCode
              database.music.metadata_parser_version = parserVersion
              return { changes: 1 }
            }
            return { changes: 0 }
          }
        }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    transaction(callback) { return (...args) => callback(...args) }
  }
  return database
}

function taskFixture(overrides = {}) {
  return {
    id: 1,
    taskType: MUSIC_METADATA_TASK_TYPE,
    processorVersion: MUSIC_METADATA_PROCESSOR_VERSION,
    executionClass: MUSIC_METADATA_EXECUTION_CLASS,
    subjectType: MUSIC_METADATA_SUBJECT_TYPE,
    subjectId: '17',
    subjectVersionId: `${MUSIC_METADATA_PARSER_VERSION}:run-1`,
    subjectContentHash: HASH,
    input: { musicId: 17 },
    ...overrides
  }
}

function createProcessor(database, overrides = {}) {
  return createMusicMetadataTaskProcessor({
    database,
    resolveMusicPath: async () => 'verified.mp3',
    parseMetadata: async () => ({
      title: '解析标题',
      artist: '解析歌手',
      album: '解析专辑',
      duration: 245,
      coverImage: 'data:image/jpeg;base64,Y292ZXI='
    }),
    ...overrides
  })
}

test('reparse fills only empty fields and may replace the strict filename fallback title', async () => {
  const music = makeMusic()
  const processor = createProcessor(createFakeDatabase(music))
  const result = await processor({ task: taskFixture(), signal: new AbortController().signal })

  assert.deepEqual(result, { musicId: 17, updatedFields: 4, metadataStatus: 'ready' })
  assert.equal(music.title, '解析标题')
  assert.equal(music.artist, '用户歌手')
  assert.equal(music.album, '解析专辑')
  assert.equal(music.duration, 245)
  assert.equal(music.cover_image, 'data:image/jpeg;base64,Y292ZXI=')
})

test('reparse never overwrites non-empty user metadata', async () => {
  const music = makeMusic({
    title: '用户标题',
    artist: '用户歌手',
    album: '用户专辑',
    duration: 99,
    cover_image: 'data:image/jpeg;base64,dXNlcg=='
  })
  const processor = createProcessor(createFakeDatabase(music))
  const result = await processor({ task: taskFixture(), signal: new AbortController().signal })

  assert.equal(result.updatedFields, 0)
  assert.equal(music.title, '用户标题')
  assert.equal(music.album, '用户专辑')
  assert.equal(music.duration, 99)
  assert.equal(music.cover_image, 'data:image/jpeg;base64,dXNlcg==')
})

test('parser failure stores only a stable retryable error', async () => {
  const music = makeMusic()
  const processor = createProcessor(createFakeDatabase(music), {
    parseMetadata: async () => { throw new Error('/private/music.mp3 parser stack') }
  })
  await assert.rejects(
    () => processor({ task: taskFixture(), signal: new AbortController().signal }),
    error => error.code === 'MUSIC_METADATA_PARSE_FAILED' && error.retryable === true &&
      !error.message.includes('/private') && !error.message.includes('stack')
  )
  assert.equal(music.metadata_status, 'failed')
  assert.equal(music.metadata_error_code, 'MUSIC_METADATA_PARSE_FAILED')
})

test('timeout and cancellation do not leave metadata pending', async () => {
  const timedOutMusic = makeMusic()
  const timeoutProcessor = createProcessor(createFakeDatabase(timedOutMusic), {
    parseTimeoutMs: 5,
    parseMetadata: () => new Promise(() => {})
  })
  await assert.rejects(
    () => timeoutProcessor({ task: taskFixture(), signal: new AbortController().signal }),
    error => error.code === 'MUSIC_METADATA_PARSE_TIMEOUT'
  )
  assert.equal(timedOutMusic.metadata_status, 'failed')
  assert.equal(timedOutMusic.metadata_error_code, 'MUSIC_METADATA_PARSE_TIMEOUT')

  const cancelledMusic = makeMusic()
  const controller = new AbortController()
  const cancelProcessor = createProcessor(createFakeDatabase(cancelledMusic), {
    parseMetadata: async () => {
      controller.abort()
      return { title: '不会写入' }
    }
  })
  await assert.rejects(
    () => cancelProcessor({ task: taskFixture(), signal: controller.signal }),
    error => error.code === 'TASK_CANCELLED' && error.retryable === false
  )
  assert.equal(cancelledMusic.metadata_status, 'failed')
  assert.equal(cancelledMusic.metadata_error_code, 'MUSIC_METADATA_CANCELLED')
})

test('content hash drift is rejected before mutation', async () => {
  const music = makeMusic()
  const database = createFakeDatabase(music)
  const processor = createProcessor(database)
  await assert.rejects(
    () => processor({
      task: taskFixture({ subjectContentHash: 'b'.repeat(64) }),
      signal: new AbortController().signal
    }),
    error => error.code === 'MUSIC_METADATA_INPUT_INVALID' && error.retryable === false
  )
  assert.equal(database.updates.length, 0)
})

test('real task schema binds content identity and enforces one active music reparse', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(taskMigration.source)
    const first = enqueueMusicMetadataTask(database, 17, HASH, 'run-a')
    const second = enqueueMusicMetadataTask(database, 17, HASH, 'run-b')
    assert.equal(first.created, true)
    assert.equal(second.activeConflict, true)
    assert.equal(second.task.id, first.task.id)
    assert.deepEqual(database.prepare(`
      SELECT task_type, subject_type, subject_id, subject_content_sha256, status
        FROM tasks
    `).all(), [{
      task_type: 'music.metadata.reparse',
      subject_type: 'music',
      subject_id: '17',
      subject_content_sha256: HASH,
      status: 'pending'
    }])
  } finally {
    database.close()
  }
})

test('missing optional MP3 tags produce a partial fallback without requesting recovery', async () => {
  const filePath = path.join(testRoot, 'untagged.mp3')
  fs.writeFileSync(filePath, Buffer.alloc(32, 0))
  const { parseMusicMetadata } = await import('../src/routes/music.js')
  const parsed = await parseMusicMetadata(filePath, 'untagged.mp3')
  assert.equal(parsed.title, 'untagged')
  assert.equal(parsed.artist, null)
  assert.equal(parsed.album, null)
  assert.equal(parsed.status, 'partial')
  assert.equal(parsed.needsReparse, false)
  assert.equal(parsed.errorCode, null)
})

test('music route retires synchronous overwrite and exposes safe persistent recovery', () => {
  const source = fs.readFileSync(new URL('../src/routes/music.js', import.meta.url), 'utf8')
  const route = source.slice(source.indexOf("router.post('/:id/reparse'"), source.indexOf('// 更新音乐信息'))
  assert.match(route, /enqueueMusicMetadataTask/u)
  assert.match(route, /projectMusicMetadataTask/u)
  assert.doesNotMatch(route, /resolveVerifiedFilePath|parseMusicMetadata|title\s*=\s*\?/u)
  assert.match(source, /runMusicMetadataTransaction[\s\S]*persistMusicMetadataState[\s\S]*enqueueMusicMetadataTask/u)
  assert.match(source, /MUSIC_METADATA_TASK_ENQUEUE_FAILED/u)
  assert.match(source, /fs\.readSync\(handle, prefix, 0, prefix\.length, 0\)/u)
})
