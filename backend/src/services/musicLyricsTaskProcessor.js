import { getDatabase } from '../config/database.js'
import { TaskProcessorError } from './taskProcessorError.js'

export const MUSIC_LYRICS_TASK_TYPE = 'music.lyrics.batch'
export const MUSIC_LYRICS_PROCESSOR_VERSION = 'v1'
export const MUSIC_LYRICS_EXECUTION_CLASS = 'network'
export const MUSIC_LYRICS_SUBJECT_TYPE = 'music-library'
export const MUSIC_LYRICS_SUBJECT_ID = 'owner'
export const MUSIC_LYRICS_TASK_TYPES = Object.freeze([MUSIC_LYRICS_TASK_TYPE])

const MAX_MUSIC_IDS = 500
const TASK_ID_PATTERN = /^[1-9]\d*$/u
const INPUT_KEYS = new Set(['musicIds', 'force'])
const MUSIC_COLUMNS = new Set([
  'id',
  'title',
  'artist',
  'lyrics',
  'lyrics_source',
  'has_lyrics',
  'lyrics_updated_at'
])
const REQUIRED_MUSIC_COLUMNS = Object.freeze(['id', 'title', 'artist', 'lyrics'])
const SELECTABLE_MUSIC_COLUMNS = Object.freeze([
  'id',
  'title',
  'artist',
  'lyrics',
  'lyrics_source',
  'has_lyrics'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted) ||
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError'
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw taskError('TASK_CANCELLED', '歌词任务已取消。', false)
  }
}

function normalizeMusicIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MUSIC_IDS) {
    throw taskError('TASK_INPUT_INVALID', '歌词任务的音乐 ID 列表无效。', false)
  }

  const ids = new Set()
  for (const musicId of value) {
    if (!Number.isSafeInteger(musicId) || musicId <= 0) {
      throw taskError('TASK_INPUT_INVALID', '歌词任务的音乐 ID 无效。', false)
    }
    ids.add(musicId)
  }

  const normalized = [...ids].sort((first, second) => first - second)
  if (normalized.length < 1 || normalized.length > MAX_MUSIC_IDS) {
    throw taskError('TASK_INPUT_INVALID', '歌词任务的音乐 ID 列表无效。', false)
  }
  return normalized
}

export function normalizeMusicLyricsTaskInput(task) {
  const input = task?.input
  if (!isPlainObject(input)) {
    throw taskError('TASK_INPUT_INVALID', '歌词任务输入无效。', false)
  }
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) {
    throw taskError('TASK_INPUT_INVALID', '歌词任务输入包含不支持的字段。', false)
  }

  const musicIds = normalizeMusicIds(input.musicIds)
  const force = input.force === undefined ? false : input.force
  if (typeof force !== 'boolean') {
    throw taskError('TASK_INPUT_INVALID', '歌词任务的 force 参数无效。', false)
  }

  const taskId = task?.id
  if (taskId !== undefined && taskId !== null &&
    !TASK_ID_PATTERN.test(String(taskId))) {
    throw taskError('TASK_INPUT_INVALID', '歌词任务标识无效。', false)
  }

  return Object.freeze({ musicIds, force })
}

function normalizeSource(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized ? normalized.slice(0, 64) : null
}

function resultSuccess(musicId, source) {
  const normalizedSource = normalizeSource(source)
  return normalizedSource
    ? { musicId, success: true, source: normalizedSource }
    : { musicId, success: true }
}

function resultSkipped(musicId, source) {
  const result = resultSuccess(musicId, source)
  return { ...result, skipped: true, reason: '已有歌词' }
}

function resultFailure(musicId, error) {
  return { musicId, success: false, error }
}

function mapDatabaseError(error, fallbackCode = 'MUSIC_DATABASE_UNAVAILABLE') {
  if (error instanceof TaskProcessorError) return error
  return taskError(fallbackCode, '音乐数据库暂时不可用。', true)
}

function createMusicDatabasePlan(database) {
  let columnRows
  try {
    columnRows = database.prepare('PRAGMA table_info(music)').all()
  } catch (error) {
    throw mapDatabaseError(error)
  }

  if (!Array.isArray(columnRows)) {
    throw taskError('MUSIC_DATABASE_UNAVAILABLE', '音乐数据库暂时不可用。', true)
  }

  const availableColumns = new Set(
    columnRows
      .map((column) => column?.name)
      .filter((name) => MUSIC_COLUMNS.has(name))
  )
  if (REQUIRED_MUSIC_COLUMNS.some((column) => !availableColumns.has(column))) {
    throw taskError('MUSIC_SCHEMA_MISSING', '音乐数据库未升级到歌词结构。', false)
  }

  const selectColumns = SELECTABLE_MUSIC_COLUMNS.filter((column) => availableColumns.has(column))
  let readMusic
  let updateLyrics
  try {
    readMusic = database.prepare(`
      SELECT ${selectColumns.join(', ')}
        FROM music
       WHERE id = ?
    `)

    const updateFields = ['lyrics = ?']
    if (availableColumns.has('lyrics_source')) updateFields.push('lyrics_source = ?')
    if (availableColumns.has('has_lyrics')) updateFields.push('has_lyrics = 1')
    if (availableColumns.has('lyrics_updated_at')) updateFields.push('lyrics_updated_at = CURRENT_TIMESTAMP')
    updateLyrics = database.prepare(`
      UPDATE music
         SET ${updateFields.join(', ')}
       WHERE id = ?
    `)
  } catch (error) {
    throw mapDatabaseError(error)
  }

  return Object.freeze({
    availableColumns,
    readMusic,
    updateLyrics
  })
}

function updateMusicLyrics(plan, database, musicId, lyric, source) {
  const parameters = [lyric]
  if (plan.availableColumns.has('lyrics_source')) parameters.push(source ?? null)
  parameters.push(musicId)
  try {
    plan.updateLyrics.run(...parameters)
  } catch (error) {
    throw mapDatabaseError(error, 'MUSIC_DATABASE_WRITE_FAILED')
  }
}

function hasLyrics(music) {
  return Boolean(music?.has_lyrics) ||
    (typeof music?.lyrics === 'string' && music.lyrics.length > 0)
}

export function createMusicLyricsTaskProcessor({
  database,
  databaseProvider = getDatabase,
  searchLyricsFromSources = async () => null
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') {
    throw new TypeError('databaseProvider must be a function')
  }
  if (typeof searchLyricsFromSources !== 'function') {
    throw new TypeError('searchLyricsFromSources must be a function')
  }

  return async function processMusicLyricsTask(context = {}) {
    const task = context.task
    const signal = context.signal
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    const normalized = normalizeMusicLyricsTaskInput(task)

    let databaseConnection
    try {
      databaseConnection = getDatabaseForTask()
    } catch (error) {
      throw mapDatabaseError(error)
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function') {
      throw taskError('MUSIC_DATABASE_UNAVAILABLE', '音乐数据库暂时不可用。', true)
    }

    const plan = createMusicDatabasePlan(databaseConnection)
    const results = []
    let success = 0
    let failed = 0
    let skipped = 0

    throwIfAborted(signal)
    await progress(0)

    for (let index = 0; index < normalized.musicIds.length; index += 1) {
      const musicId = normalized.musicIds[index]
      throwIfAborted(signal)

      let music
      try {
        music = plan.readMusic.get(musicId)
      } catch (error) {
        throw mapDatabaseError(error)
      }

      let result
      if (!music) {
        result = resultFailure(musicId, '音乐不存在')
      } else if (!normalized.force && hasLyrics(music)) {
        result = resultSkipped(musicId, music.lyrics_source)
      } else {
        let searchResult
        try {
          searchResult = await searchLyricsFromSources(
            music.title,
            music.artist || '',
            { signal }
          )
          throwIfAborted(signal)
        } catch (error) {
          if (isAbortError(error, signal)) throw taskError('TASK_CANCELLED', '歌词任务已取消。', false)
          result = resultFailure(musicId, '歌词源请求失败')
        }

        if (!result) {
          if (!searchResult || typeof searchResult.lrc !== 'string' || !searchResult.lrc.trim()) {
            result = resultFailure(musicId, '未找到歌词')
          } else {
            throwIfAborted(signal)
            updateMusicLyrics(plan, databaseConnection, musicId, searchResult.lrc, searchResult.source)
            result = resultSuccess(musicId, searchResult.source)
          }
        }
      }

      results.push(result)
      if (result.skipped) skipped += 1
      else if (result.success) success += 1
      else failed += 1
      await progress(Math.round(((index + 1) / normalized.musicIds.length) * 100))
    }

    return {
      total: normalized.musicIds.length,
      success,
      failed,
      skipped,
      results
    }
  }
}

export default createMusicLyricsTaskProcessor
