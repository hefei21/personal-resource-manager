import os from 'node:os'
import path from 'node:path'

export class WorkerConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkerConfigError'
    this.code = code
  }
}

function fail(code, message) {
  throw new WorkerConfigError(code, message)
}

function integer(value, fallback, min, max, fieldName) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail('WORKER_CONFIG_INVALID', `${fieldName} is invalid.`)
  return parsed
}

function noProxyEntries(value) {
  return typeof value === 'string'
    ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
    : []
}

export function ensureNoProxyForUrl(env = process.env, rawUrl) {
  const hostname = new URL(rawUrl).hostname.toLowerCase()
  const entries = [...noProxyEntries(env.NO_PROXY), ...noProxyEntries(env.no_proxy)]
  const unique = []
  const seen = new Set()
  for (const entry of [...entries, hostname]) {
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  const value = unique.join(',')
  env.NO_PROXY = value
  env.no_proxy = value
  return value
}

export function applyCommandLineConfig(env = process.env, argv = process.argv.slice(2)) {
  const index = argv.indexOf('--nas-base-url')
  if (index === -1) return env
  const value = argv[index + 1]
  if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
    fail('WORKER_CONFIG_INVALID', '--nas-base-url requires a value.')
  }
  env.PC_WORKER_NAS_BASE_URL = value
  return env
}

export function loadConfig(env = process.env) {
  const rawUrl = env.PC_WORKER_NAS_BASE_URL
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') fail('WORKER_CONFIG_MISSING', 'PC_WORKER_NAS_BASE_URL is required.')
  let baseUrl
  try { baseUrl = new URL(rawUrl) } catch { fail('WORKER_CONFIG_INVALID', 'PC_WORKER_NAS_BASE_URL is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback) &&
    !(baseUrl.protocol === 'http:' && env.PC_WORKER_ALLOW_INSECURE_HTTP === 'true')) {
    fail('WORKER_HTTPS_REQUIRED', 'Worker NAS URL must use HTTPS outside loopback testing.')
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail('WORKER_CONFIG_INVALID', 'Worker NAS URL must not contain credentials, query, or fragment.')
  }
  const localData = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share')
  const statePath = path.resolve(env.PC_WORKER_STATE_PATH || path.join(localData, 'PRManagerWorker', 'state.json'))
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    statePath,
    enrollmentToken: env.PC_WORKER_ENROLLMENT_TOKEN || null,
    displayName: (env.PC_WORKER_DISPLAY_NAME || os.hostname()).slice(0, 80),
    pollIntervalMs: integer(env.PC_WORKER_POLL_INTERVAL_MS, 5_000, 1_000, 60_000, 'PC_WORKER_POLL_INTERVAL_MS'),
    heartbeatIntervalMs: integer(env.PC_WORKER_HEARTBEAT_INTERVAL_MS, 20_000, 5_000, 45_000, 'PC_WORKER_HEARTBEAT_INTERVAL_MS'),
    requestTimeoutMs: integer(env.PC_WORKER_REQUEST_TIMEOUT_MS, 30_000, 5_000, 5 * 60_000, 'PC_WORKER_REQUEST_TIMEOUT_MS')
  })
}
