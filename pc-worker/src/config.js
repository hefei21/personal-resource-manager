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

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u

function optionalEmbeddingConfig(env, requestTimeoutMs) {
  const endpoint = env.PC_WORKER_EMBEDDINGS_BASE_URL || env.PC_WORKER_EMBEDDINGS_URL
  const fields = [
    endpoint,
    env.PC_WORKER_EMBEDDINGS_PROVIDER,
    env.PC_WORKER_EMBEDDINGS_MODEL_ID,
    env.PC_WORKER_EMBEDDINGS_MODEL_REVISION,
    env.PC_WORKER_EMBEDDINGS_DIMENSIONS,
    env.PC_WORKER_EMBEDDINGS_CONFIG_HASH
  ]
  if (fields.every((value) => value === undefined || value === '')) return null
  if (typeof endpoint !== 'string' || endpoint.trim() === '' ||
      typeof env.PC_WORKER_EMBEDDINGS_PROVIDER !== 'string' || env.PC_WORKER_EMBEDDINGS_PROVIDER.trim() === '' ||
      typeof env.PC_WORKER_EMBEDDINGS_MODEL_ID !== 'string' || env.PC_WORKER_EMBEDDINGS_MODEL_ID.trim() === '' ||
      typeof env.PC_WORKER_EMBEDDINGS_MODEL_REVISION !== 'string' || env.PC_WORKER_EMBEDDINGS_MODEL_REVISION.trim() === '' ||
      typeof env.PC_WORKER_EMBEDDINGS_CONFIG_HASH !== 'string' || !HASH_PATTERN.test(env.PC_WORKER_EMBEDDINGS_CONFIG_HASH.toLowerCase())) {
    fail('WORKER_CONFIG_INVALID', 'Embedding processor configuration is incomplete.')
  }
  let baseUrl
  try { baseUrl = new URL(endpoint) } catch { fail('WORKER_CONFIG_INVALID', 'Embedding endpoint is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback) &&
      !(baseUrl.protocol === 'http:' && env.PC_WORKER_ALLOW_INSECURE_HTTP === 'true')) {
    fail('WORKER_HTTPS_REQUIRED', 'Embedding endpoint must use HTTPS outside loopback testing.')
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail('WORKER_CONFIG_INVALID', 'Embedding endpoint must not contain credentials, query, or fragment.')
  }
  const provider = env.PC_WORKER_EMBEDDINGS_PROVIDER.trim()
  const modelId = env.PC_WORKER_EMBEDDINGS_MODEL_ID.trim()
  const modelRevision = env.PC_WORKER_EMBEDDINGS_MODEL_REVISION.trim()
  if (!TOKEN_PATTERN.test(provider) || !TOKEN_PATTERN.test(modelId) || !TOKEN_PATTERN.test(modelRevision)) {
    fail('WORKER_CONFIG_INVALID', 'Embedding model identity is invalid.')
  }
  const dimensions = integer(env.PC_WORKER_EMBEDDINGS_DIMENSIONS, 0, 1, 65_536, 'PC_WORKER_EMBEDDINGS_DIMENSIONS')
  if (dimensions < 1) fail('WORKER_CONFIG_INVALID', 'PC_WORKER_EMBEDDINGS_DIMENSIONS is invalid.')
  const inputLimit = integer(env.PC_WORKER_EMBEDDINGS_INPUT_LIMIT, 8192, 1, 1_048_576, 'PC_WORKER_EMBEDDINGS_INPUT_LIMIT')
  const maxBatchItems = integer(env.PC_WORKER_EMBEDDINGS_MAX_BATCH, 256, 1, 256, 'PC_WORKER_EMBEDDINGS_MAX_BATCH')
  const maxInputBytes = integer(env.PC_WORKER_EMBEDDINGS_MAX_INPUT_BYTES, 1024 * 1024, 1024, 8 * 1024 * 1024, 'PC_WORKER_EMBEDDINGS_MAX_INPUT_BYTES')
  const timeoutMs = integer(env.PC_WORKER_EMBEDDINGS_TIMEOUT_MS, requestTimeoutMs, 1_000, 5 * 60_000, 'PC_WORKER_EMBEDDINGS_TIMEOUT_MS')
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    provider,
    modelId,
    modelRevision,
    dimensions,
    configHash: env.PC_WORKER_EMBEDDINGS_CONFIG_HASH.toLowerCase(),
    inputLimit,
    maxBatchItems,
    maxInputBytes,
    timeoutMs,
    apiKey: typeof env.PC_WORKER_EMBEDDINGS_API_KEY === 'string' && env.PC_WORKER_EMBEDDINGS_API_KEY !== ''
      ? env.PC_WORKER_EMBEDDINGS_API_KEY
      : null
  })
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

export function parentProcessIdFromCommandLine(argv = process.argv.slice(2), currentParentProcessId = process.ppid) {
  if (argv.includes('--watch-parent')) {
    if (!Number.isSafeInteger(currentParentProcessId) || currentParentProcessId <= 0) {
      fail('WORKER_CONFIG_INVALID', 'Worker parent process is invalid.')
    }
    return currentParentProcessId
  }
  const index = argv.indexOf('--parent-pid')
  if (index === -1) return null
  const value = Number(argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('WORKER_CONFIG_INVALID', '--parent-pid requires a positive integer.')
  }
  return value
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
  const requestTimeoutMs = integer(env.PC_WORKER_REQUEST_TIMEOUT_MS, 30_000, 5_000, 5 * 60_000, 'PC_WORKER_REQUEST_TIMEOUT_MS')
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    statePath,
    enrollmentToken: env.PC_WORKER_ENROLLMENT_TOKEN || null,
    displayName: (env.PC_WORKER_DISPLAY_NAME || os.hostname()).slice(0, 80),
    pollIntervalMs: integer(env.PC_WORKER_POLL_INTERVAL_MS, 5_000, 1_000, 60_000, 'PC_WORKER_POLL_INTERVAL_MS'),
    heartbeatIntervalMs: integer(env.PC_WORKER_HEARTBEAT_INTERVAL_MS, 20_000, 5_000, 45_000, 'PC_WORKER_HEARTBEAT_INTERVAL_MS'),
    requestTimeoutMs,
    embedding: optionalEmbeddingConfig(env, requestTimeoutMs)
  })
}
