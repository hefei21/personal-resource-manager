import { steamSourceSnapshot } from './collectionSyncProposal.js'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { getDatabase } from '../config/database.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'
import { taskNetworkError } from './networkTaskError.js'

export const STEAM_SYNC_TASK_TYPE = 'games.steam.sync'
export const STEAM_SYNC_PROCESSOR_VERSION = 'v1'
export const STEAM_SYNC_EXECUTION_CLASS = 'network'
export const STEAM_SYNC_SUBJECT_TYPE = 'game-library'
export const STEAM_SYNC_SUBJECT_ID = 'owner'
export const STEAM_SYNC_MAX_ATTEMPTS = 3

const STEAM_SYNC_API_URL = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
const STEAM_SYNC_REQUEST_TIMEOUT_MS = 60_000
const STEAM_PROXY_AGENT = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined
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

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw taskError('TASK_CANCELLED', 'Steam 同步任务已取消。')
  }
}

function mapSteamRequestError(error, signal) {
  if (signal?.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
    return taskError('TASK_CANCELLED', 'Steam 同步任务已取消。')
  }

  const status = Number(error?.response?.status)
  if (status === 401 || status === 403) {
    return taskError('STEAM_API_KEY_INVALID', 'Steam API 密钥无效或权限不足。')
  }
  if (status === 429) {
    return taskError('STEAM_API_RATE_LIMITED', 'Steam API 请求过于频繁。', true)
  }
  if (status >= 500 && status <= 599) {
    return taskError('STEAM_API_UNAVAILABLE', 'Steam API 暂时不可用。', true)
  }
  if (status >= 400 && status <= 499) {
    return taskError('STEAM_API_REQUEST_REJECTED', 'Steam API 请求被拒绝。')
  }
  if (NETWORK_ERROR_CODES.has(error?.code) || error?.request) {
    return taskNetworkError(error, {
      code: 'STEAM_NETWORK_ERROR',
      summary: 'Steam API 网络请求失败。',
      retryable: true
    })
  }
  return taskError('STEAM_API_REQUEST_FAILED', 'Steam API 请求失败。')
}

function readSteamConfig(database) {
  let config
  try {
    config = database.prepare(
      'SELECT steam_id, api_key FROM steam_config WHERE id = 1'
    ).get()
  } catch {
    throw taskError('STEAM_CONFIG_READ_FAILED', 'Steam 配置读取失败。', true)
  }

  const steamId = typeof config?.steam_id === 'string' ? config.steam_id.trim() : ''
  const apiKey = typeof config?.api_key === 'string' ? config.api_key.trim() : ''
  if (!steamId || !apiKey) {
    throw taskError('STEAM_CONFIG_MISSING', 'Steam 配置缺失。')
  }
  return { steamId, apiKey }
}

function normalizeGame(game) {
  if (!isPlainObject(game)) return null
  const steamAppId = Number(game.appid)
  if (!Number.isSafeInteger(steamAppId) || steamAppId < 1 || typeof game.name !== 'string' || !game.name.trim() || game.name.length > 1000) {
    return null
  }

  let lastPlayed = null
  if (game.rtime_last_played) {
    const timestamp = Number(game.rtime_last_played)
    if (!Number.isFinite(timestamp)) return null
    const date = new Date(timestamp * 1000)
    if (Number.isNaN(date.getTime())) return null
    lastPlayed = date.toISOString()
  }

  return {
    appid: steamAppId,
    name: game.name,
    playtime_forever: Number.isFinite(Number(game.playtime_forever))
      ? Math.max(0, Number(game.playtime_forever))
      : 0,
    playtime_2weeks: Number.isFinite(Number(game.playtime_2weeks))
      ? Math.max(0, Number(game.playtime_2weeks))
      : 0,
    last_played: lastPlayed
  }
}

function normalizeGames(response) {
  const payload = response?.data?.response
  if (!isPlainObject(payload)) {
    throw taskError('STEAM_RESPONSE_INVALID', 'Steam 游戏列表响应无效。', true)
  }
  const games = payload.games === undefined ? [] : payload.games
  if (!Array.isArray(games) || games.length > 20000) {
    throw taskError('STEAM_RESPONSE_INVALID', 'Steam 游戏列表响应无效。', true)
  }
  const normalized = games.map(normalizeGame)
  if (normalized.some((game) => game === null)) {
    throw taskError('STEAM_RESPONSE_INVALID', 'Steam 游戏列表响应无效。', true)
  }
  return [...new Map(normalized.map(game => [game.appid, game])).values()]
}

export function createSteamSyncTaskProcessor({
  database,
  databaseProvider = getDatabase,
  axiosClient = axios,
  httpsAgent = STEAM_PROXY_AGENT,
  requestTimeoutMs = STEAM_SYNC_REQUEST_TIMEOUT_MS
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') {
    throw new TypeError('databaseProvider must be a function')
  }
  if (!axiosClient || typeof axiosClient.get !== 'function') {
    throw new TypeError('axiosClient must expose get()')
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('requestTimeoutMs must be a positive integer')
  }

  return async function processSteamSyncTask(context = {}) {
    const task = context.task
    const signal = context.signal
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}

    if (task?.taskType !== STEAM_SYNC_TASK_TYPE) {
      throw taskError('TASK_TYPE_UNSUPPORTED', 'Steam 同步任务类型不受支持。')
    }
    if (!isPlainObject(task.input) || Object.keys(task.input).length !== 0) {
      throw taskError('TASK_INPUT_INVALID', 'Steam 同步任务输入必须为空对象。')
    }

    throwIfAborted(signal)

    let databaseConnection
    try {
      databaseConnection = getDatabaseForTask()
    } catch {
      throw taskError('STEAM_DATABASE_UNAVAILABLE', 'Steam 同步数据库不可用。', true)
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function' ||
      typeof databaseConnection.transaction !== 'function') {
      throw taskError('STEAM_DATABASE_UNAVAILABLE', 'Steam 同步数据库不可用。', true)
    }

    const { steamId, apiKey } = readSteamConfig(databaseConnection)
    const baseSnapshot = steamSourceSnapshot(databaseConnection)
    await progress(10)
    throwIfAborted(signal)

    let response
    try {
      response = await axiosClient.get(STEAM_SYNC_API_URL, {
        params: {
          key: apiKey,
          steamid: steamId,
          include_appinfo: 1,
          include_played_free_games: 1
        },
        httpsAgent,
        timeout: requestTimeoutMs,
        signal,
        validateStatus: () => true
      })
    } catch (error) {
      throw mapSteamRequestError(error, signal)
    }

    throwIfAborted(signal)

    const status = response?.status === undefined ? 200 : Number(response.status)
    if (!Number.isInteger(status)) {
      throw taskError('STEAM_RESPONSE_INVALID', 'Steam 游戏列表响应无效。', true)
    }
    if (status === 401 || status === 403) {
      throw taskError('STEAM_API_KEY_INVALID', 'Steam API 密钥无效或权限不足。')
    }
    if (status === 429) {
      throw taskError('STEAM_API_RATE_LIMITED', 'Steam API 请求过于频繁。', true)
    }
    if (status >= 500 && status <= 599) {
      throw taskError('STEAM_API_UNAVAILABLE', 'Steam API 暂时不可用。', true)
    }
    if (status >= 400 && status <= 499) {
      throw taskError('STEAM_API_REQUEST_REJECTED', 'Steam API 请求被拒绝。')
    }
    if (status < 200 || status > 299) {
      throw taskError('STEAM_RESPONSE_INVALID', 'Steam 游戏列表响应无效。', true)
    }

    const games = normalizeGames(response)
    await progress(50)
    throwIfAborted(signal)
    const result = { total: games.length, games, proposalVersion: 1, baseSnapshot }
    await progress(100)
    return result
  }
}

const registeredProcessor = createSteamSyncTaskProcessor()
registerTaskProcessor(
  STEAM_SYNC_TASK_TYPE,
  STEAM_SYNC_PROCESSOR_VERSION,
  STEAM_SYNC_EXECUTION_CLASS,
  registeredProcessor
)

export default registeredProcessor
