import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { getDatabase } from '../config/database.js'
import { TaskProcessorError } from './taskProcessorError.js'
import { enqueueExclusiveRun } from './taskStore.js'
import { projectTask } from './taskTypeCatalog.js'

export const MUSIC_METADATA_TASK_TYPE = 'music.metadata.reparse'
export const MUSIC_METADATA_PROCESSOR_VERSION = 'v1'
export const MUSIC_METADATA_PARSER_VERSION = 'music-parser-v1'
export const MUSIC_METADATA_EXECUTION_CLASS = 'cpu'
export const MUSIC_METADATA_SUBJECT_TYPE = 'music'
export const MUSIC_METADATA_TASK_TYPES = Object.freeze([MUSIC_METADATA_TASK_TYPE])

export const MUSIC_METADATA_FIELDS = Object.freeze([
  'title',
  'artist',
  'album',
  'duration',
  'coverImage'
])

const TASK_ID_PATTERN = /^[1-9]\d*$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const METADATA_VALUE_MAX_LENGTH = 100_000
const COVER_VALUE_MAX_LENGTH = 20 * 1024 * 1024
const PARSE_TIMEOUT_MS = 30_000
const STABLE_ERROR_CODES = new Set([
  'MUSIC_METADATA_MUSIC_NOT_FOUND',
  'MUSIC_METADATA_SOURCE_MISSING',
  'MUSIC_METADATA_SOURCE_INVALID',
  'MUSIC_METADATA_CONTENT_HASH_MISSING',
  'MUSIC_METADATA_CONTENT_CHANGED',
  'MUSIC_METADATA_NO_FIELDS',
  'MUSIC_METADATA_PARSE_FAILED',
  'MUSIC_METADATA_PARSE_TIMEOUT',
  'MUSIC_METADATA_INPUT_INVALID',
  'MUSIC_METADATA_DATABASE_UNAVAILABLE',
  'MUSIC_METADATA_CANCELLED'
])

function metadataRunVersionId(runIdentity = randomUUID()) {
  const normalized = String(runIdentity || '').normalize('NFKC').trim()
  if (!normalized || normalized.length > 96 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw metadataError('MUSIC_METADATA_INPUT_INVALID', 'Music metadata task run identity is invalid.')
  }
  return `${MUSIC_METADATA_PARSER_VERSION}:${normalized}`
}

export function enqueueMusicMetadataTask(database, musicId, contentSha256, runIdentity) {
  const normalizedMusicId = Number(musicId)
  const normalizedHash = String(contentSha256 || '').toLowerCase()
  if (!Number.isSafeInteger(normalizedMusicId) || normalizedMusicId <= 0 || !HASH_PATTERN.test(normalizedHash)) {
    throw metadataError('MUSIC_METADATA_INPUT_INVALID', 'Music metadata task identity is invalid.')
  }
  return enqueueExclusiveRun(database, {
    taskType: MUSIC_METADATA_TASK_TYPE,
    processorVersion: MUSIC_METADATA_PROCESSOR_VERSION,
    subjectType: MUSIC_METADATA_SUBJECT_TYPE,
    subjectId: String(normalizedMusicId),
    subjectVersionId: metadataRunVersionId(runIdentity),
    subjectContentSha256: normalizedHash,
    input: { musicId: normalizedMusicId },
    executionClass: MUSIC_METADATA_EXECUTION_CLASS
  }, { taskTypes: MUSIC_METADATA_TASK_TYPES })
}

export function projectMusicMetadataTask(task) {
  const projected = projectTask(task)
  return projected?.taskType === MUSIC_METADATA_TASK_TYPE ? projected : null
}

export class MusicMetadataError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'MusicMetadataError'
    this.code = code
  }
}

function metadataError(code, message, cause) {
  return new MusicMetadataError(code, message, cause ? { cause } : undefined)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

function normalizeText(value, maxLength = METADATA_VALUE_MAX_LENGTH) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength) return null
  return normalized
}

function normalizeDuration(value) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > Number.MAX_SAFE_INTEGER) return null
  return Math.round(number)
}

function normalizeCover(value) {
  return normalizeText(value, COVER_VALUE_MAX_LENGTH)
}

function fallbackTitle(music) {
  const originalName = String(music?.original_name || '').trim()
  if (!originalName) return null
  const fileName = path.basename(originalName.replace(/\\/gu, '/'))
  const value = path.basename(fileName, path.extname(fileName)).normalize('NFKC').trim()
  return value || null
}

function errorSummary(code) {
  switch (code) {
    case 'MUSIC_METADATA_MUSIC_NOT_FOUND': return '音乐不存在或已回收。'
    case 'MUSIC_METADATA_SOURCE_MISSING': return '音乐源文件不存在。'
    case 'MUSIC_METADATA_SOURCE_INVALID': return '音乐源文件暂时不可读。'
    case 'MUSIC_METADATA_CONTENT_HASH_MISSING': return '音乐内容身份缺失。'
    case 'MUSIC_METADATA_CONTENT_CHANGED': return '音乐内容已变化，请重新解析。'
    case 'MUSIC_METADATA_NO_FIELDS': return '音乐未包含可用元数据。'
    case 'MUSIC_METADATA_PARSE_TIMEOUT': return '音乐元数据解析超时。'
    case 'MUSIC_METADATA_PARSE_FAILED': return '音乐元数据解析失败。'
    case 'MUSIC_METADATA_INPUT_INVALID': return '音乐元数据任务输入无效。'
    case 'MUSIC_METADATA_DATABASE_UNAVAILABLE': return '音乐元数据数据库暂时不可用。'
    case 'MUSIC_METADATA_CANCELLED': return '音乐元数据解析已取消。'
    case 'TASK_CANCELLED': return '音乐元数据任务已取消。'
    default: return '音乐元数据解析暂时失败。'
  }
}

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function mapProcessorError(error) {
  if (error instanceof TaskProcessorError) return error
  if (error instanceof MusicMetadataError) {
    const code = STABLE_ERROR_CODES.has(error.code) ? error.code : 'MUSIC_METADATA_PARSE_FAILED'
    const retryable = code === 'MUSIC_METADATA_PARSE_TIMEOUT' ||
      code === 'MUSIC_METADATA_SOURCE_INVALID' || code === 'MUSIC_METADATA_PARSE_FAILED'
    return taskError(code, errorSummary(code), retryable)
  }
  return taskError('MUSIC_METADATA_PARSE_FAILED', errorSummary('MUSIC_METADATA_PARSE_FAILED'), true)
}

function databaseError() {
  return taskError(
    'MUSIC_METADATA_DATABASE_UNAVAILABLE',
    errorSummary('MUSIC_METADATA_DATABASE_UNAVAILABLE'),
    true
  )
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw taskError('TASK_CANCELLED', errorSummary('TASK_CANCELLED'), false)
}

function normalizeTaskId(task) {
  const value = String(task?.id ?? '')
  if (!TASK_ID_PATTERN.test(value)) {
    throw taskError('MUSIC_METADATA_INPUT_INVALID', errorSummary('MUSIC_METADATA_INPUT_INVALID'), false)
  }
  return value
}

export function normalizeMusicMetadataTaskInput(task) {
  if (task?.taskType !== undefined && task.taskType !== MUSIC_METADATA_TASK_TYPE) {
    throw taskError('TASK_TYPE_UNSUPPORTED', '音乐元数据任务类型不受支持。', false)
  }
  const input = task?.input
  if (!isPlainObject(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'musicId') ||
    !Number.isSafeInteger(input.musicId) || input.musicId <= 0) {
    throw taskError('MUSIC_METADATA_INPUT_INVALID', errorSummary('MUSIC_METADATA_INPUT_INVALID'), false)
  }
  return input.musicId
}

function readActiveMusic(database, musicId) {
  return database.prepare(`
    SELECT m.* FROM music m WHERE m.id = ? AND NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'music' AND t.resource_id = m.id
    )
  `).get(musicId)
}

function currentContentHash(music) {
  const value = String(music?.content_sha256 || '').toLowerCase()
  return HASH_PATTERN.test(value) ? value : null
}

function taskContentHash(task) {
  const value = task?.subjectContentHash ?? task?.subjectContentSha256
  const normalized = String(value || '').toLowerCase()
  return HASH_PATTERN.test(normalized) ? normalized : null
}

function taskIdentityIsCompatible(task, musicId, contentHash) {
  if (task?.taskType !== undefined && task.taskType !== MUSIC_METADATA_TASK_TYPE) return false
  if (task?.processorVersion !== undefined && task.processorVersion !== MUSIC_METADATA_PROCESSOR_VERSION) return false
  if (task?.executionClass !== undefined && task.executionClass !== MUSIC_METADATA_EXECUTION_CLASS) return false
  if (task?.subjectType !== undefined && task.subjectType !== MUSIC_METADATA_SUBJECT_TYPE) return false
  if (task?.subjectId !== undefined && String(task.subjectId) !== String(musicId)) return false
  return taskContentHash(task) === contentHash
}

function updateMetadataStatus(database, musicId, contentHash, status, errorCode) {
  const result = database.prepare(`
    UPDATE music
       SET metadata_status = ?,
           metadata_error_code = ?,
           metadata_parser_version = ?,
           metadata_updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND content_sha256 = ?
  `).run(status, errorCode ?? null, MUSIC_METADATA_PARSER_VERSION, musicId, contentHash)
  if (result.changes !== 1) {
    throw taskError('MUSIC_METADATA_CONTENT_CHANGED', errorSummary('MUSIC_METADATA_CONTENT_CHANGED'), false)
  }
}

function normalizeParsedMetadata(metadata) {
  const source = isPlainObject(metadata?.metadata) ? metadata.metadata : metadata
  if (!isPlainObject(source)) {
    throw metadataError('MUSIC_METADATA_PARSE_FAILED', errorSummary('MUSIC_METADATA_PARSE_FAILED'))
  }
  const normalized = {
    title: normalizeText(source.title),
    artist: normalizeText(source.artist),
    album: normalizeText(source.album),
    duration: normalizeDuration(source.duration),
    coverImage: normalizeCover(source.coverImage ?? source.cover_image)
  }
  if (MUSIC_METADATA_FIELDS.every(field => normalized[field] === null)) {
    throw metadataError('MUSIC_METADATA_NO_FIELDS', errorSummary('MUSIC_METADATA_NO_FIELDS'))
  }
  return Object.freeze(normalized)
}

function metadataStatusFor(music, updates) {
  const value = (field) => Object.hasOwn(updates, field) ? updates[field] : music[field]
  return !isBlank(value('title')) && !isBlank(value('artist')) && !isBlank(value('album')) &&
    Number(value('duration')) > 0
    ? 'ready'
    : 'partial'
}

function computeMetadataUpdates(music, metadata) {
  const updates = {}
  const fallback = fallbackTitle(music)
  if (!isBlank(metadata.title) &&
    (isBlank(music.title) || (fallback !== null && String(music.title).normalize('NFKC').trim() === fallback))) {
    updates.title = metadata.title
  }
  if (isBlank(music.artist) && !isBlank(metadata.artist)) updates.artist = metadata.artist
  if (isBlank(music.album) && !isBlank(metadata.album)) updates.album = metadata.album
  if ((music.duration === null || music.duration === undefined || Number(music.duration) === 0) &&
    metadata.duration !== null) {
    updates.duration = metadata.duration
  }
  if (isBlank(music.cover_image) && !isBlank(metadata.coverImage)) updates.cover_image = metadata.coverImage
  return updates
}

function applyParsedMetadata(database, musicId, contentHash, metadata) {
  const run = () => {
    const music = readActiveMusic(database, musicId)
    if (!music) {
      throw taskError('MUSIC_METADATA_MUSIC_NOT_FOUND', errorSummary('MUSIC_METADATA_MUSIC_NOT_FOUND'), false)
    }
    if (currentContentHash(music) !== contentHash) {
      throw taskError('MUSIC_METADATA_CONTENT_CHANGED', errorSummary('MUSIC_METADATA_CONTENT_CHANGED'), false)
    }

    const updates = computeMetadataUpdates(music, metadata)
    const metadataStatus = metadataStatusFor(music, updates)
    const fields = Object.keys(updates)
    const assignments = fields.map(field => `${field} = ?`)
    const parameters = fields.map(field => updates[field])
    assignments.push(
      'metadata_status = ?',
      'metadata_error_code = NULL',
      'metadata_parser_version = ?',
      'metadata_updated_at = CURRENT_TIMESTAMP',
      'updated_at = CURRENT_TIMESTAMP'
    )
    parameters.push(metadataStatus, MUSIC_METADATA_PARSER_VERSION, musicId, contentHash)
    const result = database.prepare(`
      UPDATE music SET ${assignments.join(', ')}
       WHERE id = ? AND content_sha256 = ?
    `).run(...parameters)
    if (result.changes !== 1) {
      throw taskError('MUSIC_METADATA_CONTENT_CHANGED', errorSummary('MUSIC_METADATA_CONTENT_CHANGED'), false)
    }
    return { musicId, updatedFields: fields.length, metadataStatus }
  }
  return typeof database.transaction === 'function' ? database.transaction(run)() : run()
}

function parseTimeoutError() {
  return metadataError('MUSIC_METADATA_PARSE_TIMEOUT', errorSummary('MUSIC_METADATA_PARSE_TIMEOUT'))
}

async function parseWithTimeout(parseMetadata, filePath, originalName, signal, timeoutMs) {
  throwIfAborted(signal)
  const parsing = Promise.resolve().then(() => parseMetadata(filePath, originalName, { signal }))
  if (timeoutMs === null) return parsing
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : PARSE_TIMEOUT_MS
  let timer
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(parseTimeoutError()), timeout)
  })
  try {
    return await Promise.race([parsing, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

function persistCancellation(database, musicId, contentHash) {
  try {
    updateMetadataStatus(database, musicId, contentHash, 'failed', 'MUSIC_METADATA_CANCELLED')
  } catch (error) {
    if (error instanceof TaskProcessorError) throw error
    throw databaseError()
  }
}

export function createMusicMetadataTaskProcessor({
  database,
  databaseProvider = getDatabase,
  resolveMusicPath,
  parseMetadata,
  parseTimeoutMs = PARSE_TIMEOUT_MS
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof resolveMusicPath !== 'function') throw new TypeError('resolveMusicPath must be a function')
  if (typeof parseMetadata !== 'function') throw new TypeError('parseMetadata must be a function')

  return async function processMusicMetadataTask(context = {}) {
    const signal = context.signal
    const task = context.task
    normalizeTaskId(task)
    const musicId = normalizeMusicMetadataTaskInput(task)

    let databaseConnection
    try {
      databaseConnection = await getDatabaseForTask()
    } catch {
      throw databaseError()
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function') throw databaseError()

    let music
    try {
      music = readActiveMusic(databaseConnection, musicId)
    } catch {
      throw databaseError()
    }
    if (!music) {
      throw taskError('MUSIC_METADATA_MUSIC_NOT_FOUND', errorSummary('MUSIC_METADATA_MUSIC_NOT_FOUND'), false)
    }

    const contentHash = currentContentHash(music)
    if (!contentHash) {
      throw taskError('MUSIC_METADATA_CONTENT_HASH_MISSING', errorSummary('MUSIC_METADATA_CONTENT_HASH_MISSING'), false)
    }
    if (!taskIdentityIsCompatible(task, musicId, contentHash)) {
      throw taskError('MUSIC_METADATA_INPUT_INVALID', errorSummary('MUSIC_METADATA_INPUT_INVALID'), false)
    }

    if (signal?.aborted) {
      persistCancellation(databaseConnection, musicId, contentHash)
      throw taskError('TASK_CANCELLED', errorSummary('TASK_CANCELLED'), false)
    }

    try {
      updateMetadataStatus(databaseConnection, musicId, contentHash, 'pending', null)
    } catch (error) {
      if (error instanceof TaskProcessorError) throw error
      throw databaseError()
    }

    let filePath
    try {
      const resolved = await resolveMusicPath(music)
      filePath = typeof resolved === 'string' ? resolved : resolved?.filePath
      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('Music source path is unavailable.')
      }
    } catch (error) {
      const code = error?.code === 'RESOURCE_CONTENT_MISSING' || error?.code === 'MUSIC_CONTENT_MISSING'
        ? 'MUSIC_METADATA_SOURCE_MISSING'
        : 'MUSIC_METADATA_SOURCE_INVALID'
      const mapped = taskError(code, errorSummary(code), code === 'MUSIC_METADATA_SOURCE_INVALID')
      try { updateMetadataStatus(databaseConnection, musicId, contentHash, 'failed', code) } catch (statusError) {
        if (statusError instanceof TaskProcessorError) throw statusError
        throw databaseError()
      }
      throw mapped
    }

    try {
      const originalName = String(music.original_name || '').trim() ||
        `${fallbackTitle(music) || 'music'}.${String(music.file_type || 'mp3').replace(/^\./u, '')}`
      const parsed = await parseWithTimeout(parseMetadata, filePath, originalName, signal, parseTimeoutMs)
      throwIfAborted(signal)
      const normalized = normalizeParsedMetadata(parsed)
      return applyParsedMetadata(databaseConnection, musicId, contentHash, normalized)
    } catch (error) {
      if (signal?.aborted || (error instanceof TaskProcessorError && error.code === 'TASK_CANCELLED')) {
        persistCancellation(databaseConnection, musicId, contentHash)
        throw taskError('TASK_CANCELLED', errorSummary('TASK_CANCELLED'), false)
      }
      const mapped = mapProcessorError(error)
      try {
        updateMetadataStatus(databaseConnection, musicId, contentHash, 'failed', mapped.code)
      } catch (statusError) {
        if (statusError instanceof TaskProcessorError) throw statusError
        throw databaseError()
      }
      throw mapped
    }
  }
}

export default createMusicMetadataTaskProcessor
