import crypto from 'node:crypto'
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

const RERANKER_MODEL_ID = 'BAAI/bge-reranker-v2-m3'
const RERANKER_MODEL_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
const RERANKER_PROVIDER = 'hugging-face-tei'
const RERANKER_DIMENSIONS = 1
const RERANKER_INPUT_LIMIT = 512
const RERANKER_CONFIG_HASH = '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'
const RERANKER_MAX_LENGTH = 512
const RERANKER_SCORE_TYPE = 'raw_logit'

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

function optionalAnswerConfig(env, requestTimeoutMs) {
  const endpoint = env.PC_WORKER_ANSWER_BASE_URL || env.PC_WORKER_LLM_BASE_URL
  const modelId = env.PC_WORKER_ANSWER_MODEL_ID || env.PC_WORKER_LLM_MODEL_ID
  const modelRevision = env.PC_WORKER_ANSWER_MODEL_REVISION || env.PC_WORKER_LLM_MODEL_REVISION
  const contextLimitRaw = env.PC_WORKER_ANSWER_CONTEXT_LIMIT || env.PC_WORKER_ANSWER_CONTEXT_BYTES || env.PC_WORKER_ANSWER_MAX_CONTEXT_BYTES
  const maxOutputBytesRaw = env.PC_WORKER_ANSWER_MAX_OUTPUT_BYTES || env.PC_WORKER_ANSWER_OUTPUT_LIMIT_BYTES
  const fields = [endpoint, modelId, modelRevision, contextLimitRaw, maxOutputBytesRaw]
  if (fields.every((value) => value === undefined || value === '')) return null
  if (typeof endpoint !== 'string' || endpoint.trim() === '' || typeof modelId !== 'string' || modelId.trim() === '' ||
      typeof modelRevision !== 'string' || modelRevision.trim() === '' || contextLimitRaw === undefined || contextLimitRaw === '' ||
      maxOutputBytesRaw === undefined || maxOutputBytesRaw === '') {
    fail('WORKER_CONFIG_INVALID', 'Answer processor configuration is incomplete.')
  }
  let baseUrl
  try { baseUrl = new URL(endpoint) } catch { fail('WORKER_CONFIG_INVALID', 'Answer endpoint is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback) &&
      !(baseUrl.protocol === 'http:' && env.PC_WORKER_ALLOW_INSECURE_HTTP === 'true')) {
    fail('WORKER_HTTPS_REQUIRED', 'Answer endpoint must use HTTPS outside loopback testing.')
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail('WORKER_CONFIG_INVALID', 'Answer endpoint must not contain credentials, query, or fragment.')
  }
  const provider = (env.PC_WORKER_ANSWER_PROVIDER || 'openai-compatible').trim()
  const normalizedModelId = modelId.trim()
  const normalizedRevision = modelRevision.trim()
  if (!TOKEN_PATTERN.test(provider) || !TOKEN_PATTERN.test(normalizedModelId) || !TOKEN_PATTERN.test(normalizedRevision)) {
    fail('WORKER_CONFIG_INVALID', 'Answer model identity is invalid.')
  }
  const contextLimit = integer(contextLimitRaw, 0, 1, 8 * 1024 * 1024, 'PC_WORKER_ANSWER_CONTEXT_LIMIT')
  const maxOutputBytes = integer(maxOutputBytesRaw, 0, 1, 256 * 1024, 'PC_WORKER_ANSWER_MAX_OUTPUT_BYTES')
  const maxEvidenceItems = integer(env.PC_WORKER_ANSWER_MAX_EVIDENCE, 64, 1, 64, 'PC_WORKER_ANSWER_MAX_EVIDENCE')
  const timeoutMs = integer(env.PC_WORKER_ANSWER_TIMEOUT_MS, requestTimeoutMs, 1_000, 5 * 60_000, 'PC_WORKER_ANSWER_TIMEOUT_MS')
  const configHash = typeof env.PC_WORKER_ANSWER_CONFIG_HASH === 'string' && env.PC_WORKER_ANSWER_CONFIG_HASH !== ''
    ? env.PC_WORKER_ANSWER_CONFIG_HASH.toLowerCase()
    : crypto.createHash('sha256').update(JSON.stringify({ provider, modelId: normalizedModelId, modelRevision: normalizedRevision, contextLimit, maxOutputBytes, maxEvidenceItems })).digest('hex')
  if (!HASH_PATTERN.test(configHash)) fail('WORKER_CONFIG_INVALID', 'Answer configuration hash is invalid.')
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    provider,
    modelId: normalizedModelId,
    modelRevision: normalizedRevision,
    contextLimit,
    maxOutputBytes,
    maxEvidenceItems,
    timeoutMs,
    configHash,
    apiKey: typeof env.PC_WORKER_ANSWER_API_KEY === 'string' && env.PC_WORKER_ANSWER_API_KEY !== ''
      ? env.PC_WORKER_ANSWER_API_KEY
      : null
  })
}

function optionalRerankerConfig(env, requestTimeoutMs) {
  const endpoint = env.PC_WORKER_RERANKER_BASE_URL || env.PC_WORKER_RERANKER_URL
  const identityValues = [
    env.PC_WORKER_RERANKER_PROVIDER,
    env.PC_WORKER_RERANKER_MODEL_ID,
    env.PC_WORKER_RERANKER_MODEL_REVISION,
    env.PC_WORKER_RERANKER_DIMENSIONS,
    env.PC_WORKER_RERANKER_INPUT_LIMIT,
    env.PC_WORKER_RERANKER_CONFIG_HASH
  ]
  if ((endpoint === undefined || endpoint === '') && identityValues.every((value) => value === undefined || value === '')) return null
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    fail('WORKER_CONFIG_INVALID', 'Reranker processor configuration is incomplete.')
  }
  let baseUrl
  try { baseUrl = new URL(endpoint) } catch { fail('WORKER_CONFIG_INVALID', 'Reranker endpoint is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback)) {
    fail('WORKER_HTTPS_REQUIRED', 'Reranker endpoint must use HTTPS outside loopback testing.')
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    fail('WORKER_CONFIG_INVALID', 'Reranker endpoint must not contain credentials, query, or fragment.')
  }
  const configuredIdentity = [
    ['PC_WORKER_RERANKER_PROVIDER', env.PC_WORKER_RERANKER_PROVIDER, RERANKER_PROVIDER],
    ['PC_WORKER_RERANKER_MODEL_ID', env.PC_WORKER_RERANKER_MODEL_ID, RERANKER_MODEL_ID],
    ['PC_WORKER_RERANKER_MODEL_REVISION', env.PC_WORKER_RERANKER_MODEL_REVISION, RERANKER_MODEL_REVISION],
    ['PC_WORKER_RERANKER_CONFIG_HASH', env.PC_WORKER_RERANKER_CONFIG_HASH, RERANKER_CONFIG_HASH]
  ]
  for (const [fieldName, value, expected] of configuredIdentity) {
    if (value !== undefined && value !== '' && value.trim() !== expected) {
      fail('WORKER_CONFIG_INVALID', `${fieldName} is fixed for the configured reranker.`)
    }
  }
  if (env.PC_WORKER_RERANKER_DIMENSIONS !== undefined && env.PC_WORKER_RERANKER_DIMENSIONS !== '' &&
      integer(env.PC_WORKER_RERANKER_DIMENSIONS, 0, 1, 65_536, 'PC_WORKER_RERANKER_DIMENSIONS') !== RERANKER_DIMENSIONS) {
    fail('WORKER_CONFIG_INVALID', 'PC_WORKER_RERANKER_DIMENSIONS is fixed for the configured reranker.')
  }
  if (env.PC_WORKER_RERANKER_INPUT_LIMIT !== undefined && env.PC_WORKER_RERANKER_INPUT_LIMIT !== '' &&
      integer(env.PC_WORKER_RERANKER_INPUT_LIMIT, 0, 1, 1_048_576, 'PC_WORKER_RERANKER_INPUT_LIMIT') !== RERANKER_INPUT_LIMIT) {
    fail('WORKER_CONFIG_INVALID', 'PC_WORKER_RERANKER_INPUT_LIMIT is fixed for the configured reranker.')
  }
  const timeoutMs = integer(env.PC_WORKER_RERANKER_TIMEOUT_MS, requestTimeoutMs, 1_000, 5 * 60_000, 'PC_WORKER_RERANKER_TIMEOUT_MS')
  const root = new URL(baseUrl.toString())
  const pathname = root.pathname.replace(/\/+$/u, '')
  const servicePath = pathname.endsWith('/rerank') ? pathname.slice(0, -'/rerank'.length) : pathname
  const serviceUrl = new URL(root.toString())
  serviceUrl.pathname = servicePath || '/'
  serviceUrl.search = ''
  serviceUrl.hash = ''
  const endpointUrl = new URL(serviceUrl.toString())
  endpointUrl.pathname = `${servicePath || ''}/rerank` || '/rerank'
  const infoUrl = new URL(serviceUrl.toString())
  infoUrl.pathname = `${servicePath || ''}/info` || '/info'
  const healthUrl = new URL(serviceUrl.toString())
  healthUrl.pathname = `${servicePath || ''}/health` || '/health'
  return Object.freeze({
    baseUrl: serviceUrl.toString().replace(/\/$/u, ''),
    endpoint: endpointUrl.toString().replace(/\/$/u, ''),
    infoEndpoint: infoUrl.toString().replace(/\/$/u, ''),
    healthEndpoint: healthUrl.toString().replace(/\/$/u, ''),
    provider: RERANKER_PROVIDER,
    modelId: RERANKER_MODEL_ID,
    modelRevision: RERANKER_MODEL_REVISION,
    dimensions: RERANKER_DIMENSIONS,
    inputLimit: RERANKER_INPUT_LIMIT,
    configHash: RERANKER_CONFIG_HASH,
    maxLength: RERANKER_MAX_LENGTH,
    scoreType: RERANKER_SCORE_TYPE,
    maxBatchItems: 10,
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 512 * 1024,
    timeoutMs,
    apiKey: typeof env.PC_WORKER_RERANKER_API_KEY === 'string' && env.PC_WORKER_RERANKER_API_KEY !== ''
      ? env.PC_WORKER_RERANKER_API_KEY
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
  const logPath = path.resolve(env.PC_WORKER_LOG_PATH || path.join(localData, 'PRManagerWorker', 'worker.log'))
  const requestTimeoutMs = integer(env.PC_WORKER_REQUEST_TIMEOUT_MS, 30_000, 5_000, 5 * 60_000, 'PC_WORKER_REQUEST_TIMEOUT_MS')
  const modelReadinessIntervalMs = integer(
    env.PC_WORKER_MODEL_READINESS_INTERVAL_MS,
    15_000,
    1_000,
    60_000,
    'PC_WORKER_MODEL_READINESS_INTERVAL_MS'
  )
  const modelReadinessMaxBackoffMs = integer(
    env.PC_WORKER_MODEL_READINESS_MAX_BACKOFF_MS,
    60_000,
    modelReadinessIntervalMs,
    5 * 60_000,
    'PC_WORKER_MODEL_READINESS_MAX_BACKOFF_MS'
  )
  return Object.freeze({
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    statePath,
    logPath,
    enrollmentToken: env.PC_WORKER_ENROLLMENT_TOKEN || null,
    displayName: (env.PC_WORKER_DISPLAY_NAME || os.hostname()).slice(0, 80),
    pollIntervalMs: integer(env.PC_WORKER_POLL_INTERVAL_MS, 1_000, 1_000, 60_000, 'PC_WORKER_POLL_INTERVAL_MS'),
    followUpPollIntervalMs: integer(env.PC_WORKER_FOLLOW_UP_POLL_INTERVAL_MS, 25, 10, 250, 'PC_WORKER_FOLLOW_UP_POLL_INTERVAL_MS'),
    followUpPollAttempts: integer(env.PC_WORKER_FOLLOW_UP_POLL_ATTEMPTS, 8, 1, 20, 'PC_WORKER_FOLLOW_UP_POLL_ATTEMPTS'),
    heartbeatIntervalMs: integer(env.PC_WORKER_HEARTBEAT_INTERVAL_MS, 20_000, 5_000, 45_000, 'PC_WORKER_HEARTBEAT_INTERVAL_MS'),
    requestTimeoutMs,
    modelReadinessIntervalMs,
    modelReadinessMaxBackoffMs,
    embedding: optionalEmbeddingConfig(env, requestTimeoutMs),
    answer: optionalAnswerConfig(env, requestTimeoutMs),
    reranker: optionalRerankerConfig(env, requestTimeoutMs)
  })
}
