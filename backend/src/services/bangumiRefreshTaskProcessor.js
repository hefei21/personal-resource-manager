import { getDatabase } from '../config/database.js'
import { TaskProcessorError } from './taskProcessorError.js'
import { taskNetworkError } from './networkTaskError.js'

export const BANGUMI_REFRESH_TASK_TYPE = 'anime.bangumi.refresh'
export const BANGUMI_REFRESH_PROCESSOR_VERSION = 'v1'
export const BANGUMI_REFRESH_EXECUTION_CLASS = 'network'
export const BANGUMI_REFRESH_SUBJECT_TYPE = 'anime'
export const BANGUMI_REFRESH_TASK_TYPES = Object.freeze([BANGUMI_REFRESH_TASK_TYPE])

const INPUT_KEYS = new Set(['animeId'])
const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ERR_NETWORK'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function taskError(code, summary, retryable = false) {
  return new TaskProcessorError({ code, summary, retryable })
}

function normalizePositiveId(value, code, summary) {
  const candidate = typeof value === 'string' && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : value
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw taskError(code, summary)
  }
  return candidate
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
    throw taskError('TASK_CANCELLED', '动漫刷新任务已取消。')
  }
}

function normalizeBangumiId(value) {
  if (typeof value === 'number') {
    return normalizePositiveId(
      value,
      'ANIME_BANGUMI_ID_INVALID',
      '动漫的 Bangumi ID 无效。'
    )
  }
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC').trim()
    if (/^[1-9]\d*$/u.test(normalized) && Number.isSafeInteger(Number(normalized))) {
      return normalized
    }
  }
  throw taskError('ANIME_BANGUMI_ID_MISSING', '该动漫未配置 Bangumi ID。')
}

export function normalizeBangumiRefreshTaskInput(task) {
  if (task?.taskType !== BANGUMI_REFRESH_TASK_TYPE) {
    throw taskError('TASK_TYPE_UNSUPPORTED', '动漫刷新任务类型不受支持。')
  }

  const identityFields = [
    ['processorVersion', BANGUMI_REFRESH_PROCESSOR_VERSION],
    ['executionClass', BANGUMI_REFRESH_EXECUTION_CLASS],
    ['subjectType', BANGUMI_REFRESH_SUBJECT_TYPE]
  ]
  for (const [field, expected] of identityFields) {
    if (task[field] !== undefined && task[field] !== expected) {
      throw taskError('TASK_IDENTITY_INVALID', '动漫刷新任务身份无效。')
    }
  }

  if (!isPlainObject(task.input) || Object.keys(task.input).some((key) => !INPUT_KEYS.has(key)) ||
    Object.keys(task.input).length !== INPUT_KEYS.size) {
    throw taskError('TASK_INPUT_INVALID', '动漫刷新任务输入必须仅包含 animeId。')
  }

  const animeId = normalizePositiveId(
    task.input.animeId,
    'TASK_INPUT_INVALID',
    '动漫刷新任务的 animeId 无效。'
  )
  return Object.freeze({ animeId })
}

function isNetworkError(error) {
  if (NETWORK_ERROR_CODES.has(error?.code)) return true
  if (error?.request) return true
  return typeof error?.message === 'string' &&
    /(network|timeout|timed out|socket|connect|dns)/iu.test(error.message)
}

function mapBangumiRequestError(error, signal) {
  if (error instanceof TaskProcessorError) return error
  if (isAbortError(error, signal)) {
    return taskError('TASK_CANCELLED', '动漫刷新任务已取消。')
  }

  const status = Number(error?.response?.status ?? error?.status)
  if (status === 401 || status === 403) {
    return taskError('BANGUMI_CREDENTIALS_INVALID', 'Bangumi 凭据无效或权限不足。')
  }
  if (status === 404) {
    return taskError('BANGUMI_NOT_FOUND', 'Bangumi 条目不存在。')
  }
  if (status === 429) {
    return taskError('BANGUMI_RATE_LIMITED', 'Bangumi 请求过于频繁，请稍后重试。', true)
  }
  if (status >= 500 && status <= 599) {
    return taskError('BANGUMI_UNAVAILABLE', 'Bangumi 服务暂时不可用，请稍后重试。', true)
  }
  if (isNetworkError(error)) {
    return taskNetworkError(error, {
      code: 'BANGUMI_NETWORK_ERROR',
      summary: 'Bangumi 网络请求失败，请稍后重试。',
      retryable: true
    })
  }
  return taskError('BANGUMI_REQUEST_FAILED', 'Bangumi 请求失败。')
}

function normalizeDetail(detail) {
  if (!isPlainObject(detail) || !isPlainObject(detail.subject) ||
    !Array.isArray(detail.characters) || !Array.isArray(detail.persons)) {
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }
  if (typeof detail.subject.name !== 'string' || !detail.subject.name.trim()) {
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }
  const infobox = detail.subject.infobox === undefined || detail.subject.infobox === null
    ? []
    : detail.subject.infobox
  if (!Array.isArray(infobox)) {
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }
  return Object.freeze({
    subject: detail.subject,
    characters: detail.characters,
    persons: detail.persons,
    infobox
  })
}

function normalizeTags(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }
  return value.map((tag) => {
    if (typeof tag === 'string') return tag
    if (isPlainObject(tag) && typeof tag.name === 'string') return tag.name
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }).filter(Boolean).join(',')
}

function toJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
  }
}

function readAnime(database, animeId) {
  try {
    const row = database.prepare('SELECT bangumi_id FROM anime WHERE id = ?').get(animeId)
    if (!row) {
      throw taskError('ANIME_NOT_FOUND', '动漫不存在。')
    }
    return row
  } catch (error) {
    if (error instanceof TaskProcessorError) throw error
    throw taskError('ANIME_DATABASE_READ_FAILED', '动漫数据库读取失败。', true)
  }
}

function updateAnime(database, animeId, values) {
  let result
  try {
    const update = database.prepare(`
      UPDATE anime SET
        title = ?,
        name_cn = ?,
        name_original = ?,
        summary = ?,
        cover_image = ?,
        cover_image_data = ?,
        rating = ?,
        rating_count = ?,
        tags = ?,
        air_date = ?,
        eps = ?,
        eps_total = ?,
        author = ?,
        director = ?,
        studio = ?,
        infobox = ?,
        characters = ?,
        staff = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    result = database.transaction(() => update.run(
      values.title,
      values.nameCn,
      values.nameOriginal,
      values.summary,
      values.coverImageUrl,
      values.coverImageData,
      values.rating,
      values.ratingCount,
      values.tags,
      values.airDate,
      values.eps,
      values.epsTotal,
      values.author,
      values.director,
      values.studio,
      values.infobox,
      values.characters,
      values.staff,
      animeId
    ))()
  } catch (error) {
    if (error instanceof TaskProcessorError) throw error
    throw taskError('ANIME_DATABASE_WRITE_FAILED', '动漫数据库写入失败。', true)
  }
  if (result && result.changes === 0) {
    throw taskError('ANIME_NOT_FOUND', '动漫不存在。')
  }
}

export function createBangumiRefreshTaskProcessor({
  database,
  databaseProvider = getDatabase,
  fetchDetail,
  downloadImage,
  extractInfobox
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') {
    throw new TypeError('databaseProvider must be a function')
  }
  if (typeof fetchDetail !== 'function') {
    throw new TypeError('fetchDetail must be a function')
  }
  if (typeof downloadImage !== 'function') {
    throw new TypeError('downloadImage must be a function')
  }
  if (typeof extractInfobox !== 'function') {
    throw new TypeError('extractInfobox must be a function')
  }

  return async function processBangumiRefreshTask(context = {}) {
    const task = context.task
    const signal = context.signal
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    const { animeId } = normalizeBangumiRefreshTaskInput(task)

    throwIfAborted(signal)
    await progress(0)

    let databaseConnection
    try {
      databaseConnection = getDatabaseForTask()
    } catch {
      throw taskError('ANIME_DATABASE_UNAVAILABLE', '动漫数据库暂时不可用。', true)
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function' ||
      typeof databaseConnection.transaction !== 'function') {
      throw taskError('ANIME_DATABASE_UNAVAILABLE', '动漫数据库暂时不可用。', true)
    }

    const row = readAnime(databaseConnection, animeId)
    const bangumiId = normalizeBangumiId(row.bangumi_id)

    let detail
    try {
      detail = await fetchDetail(bangumiId, { bypassCache: true, signal })
      throwIfAborted(signal)
    } catch (error) {
      throw mapBangumiRequestError(error, signal)
    }

    const normalizedDetail = normalizeDetail(detail)
    const animeInfo = normalizedDetail.subject
    const infobox = normalizedDetail.infobox
    let author
    let director
    let studio
    try {
      author = animeInfo.author || extractInfobox(infobox, '作者') || extractInfobox(infobox, '原作')
      director = animeInfo.director || extractInfobox(infobox, '导演') || extractInfobox(infobox, '监督')
      studio = animeInfo.studio || extractInfobox(infobox, '动画制作') || extractInfobox(infobox, '制作')
    } catch {
      throw taskError('BANGUMI_RESPONSE_INVALID', 'Bangumi 返回数据无效。')
    }

    const coverImageUrl = animeInfo.images?.large || animeInfo.images?.common || animeInfo.cover_image || null
    let coverImageData = null
    try {
      coverImageData = await downloadImage(coverImageUrl, { signal })
      throwIfAborted(signal)
    } catch (error) {
      throw mapBangumiRequestError(error, signal)
    }

    await progress(70)
    throwIfAborted(signal)

    const rating = isPlainObject(animeInfo.rating) ? animeInfo.rating : {}
    const values = {
      title: animeInfo.name,
      nameCn: animeInfo.name_cn ?? null,
      nameOriginal: animeInfo.name_original || animeInfo.name,
      summary: animeInfo.summary ?? null,
      coverImageUrl,
      coverImageData: coverImageData ?? null,
      rating: isPlainObject(animeInfo.rating) ? rating.score || 0 : Number(animeInfo.rating) || 0,
      ratingCount: rating.total || animeInfo.rating_count || 0,
      tags: normalizeTags(animeInfo.tags),
      airDate: animeInfo.date || animeInfo.air_date || null,
      eps: animeInfo.eps || 0,
      epsTotal: animeInfo.eps_total || animeInfo.eps_count || animeInfo.total_episodes || 0,
      author: author || null,
      director: director || null,
      studio: studio || null,
      infobox: toJson(infobox),
      characters: toJson(normalizedDetail.characters),
      staff: toJson(normalizedDetail.persons)
    }

    updateAnime(databaseConnection, animeId, values)
    await progress(100)

    return {
      animeId,
      bangumiId,
      message: '动漫刷新成功。'
    }
  }
}

export default createBangumiRefreshTaskProcessor
