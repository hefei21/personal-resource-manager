import crypto from 'node:crypto'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const COLLECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_TIMEOUT_MS = 60_000
const MIN_DIMENSIONS = 32
const MAX_DIMENSIONS = 65_536
const MIN_INPUT_LIMIT = 128
const MAX_INPUT_LIMIT = 1_048_576

const VECTOR_ENV_KEYS = Object.freeze({
  enabled: 'RAG_VECTOR_ENABLED',
  baseUrl: 'RAG_VECTOR_BASE_URL',
  collection: 'RAG_VECTOR_COLLECTION',
  timeoutMs: 'RAG_VECTOR_TIMEOUT_MS',
  provider: 'RAG_VECTOR_EMBEDDING_PROVIDER',
  modelId: 'RAG_VECTOR_EMBEDDING_MODEL_ID',
  modelRevision: 'RAG_VECTOR_EMBEDDING_MODEL_REVISION',
  dimensions: 'RAG_VECTOR_EMBEDDING_DIMENSIONS',
  inputLimit: 'RAG_VECTOR_EMBEDDING_INPUT_LIMIT',
  distance: 'RAG_VECTOR_EMBEDDING_DISTANCE',
  normalization: 'RAG_VECTOR_EMBEDDING_NORMALIZATION',
  configHash: 'RAG_VECTOR_EMBEDDING_CONFIG_HASH'
})

export { VECTOR_ENV_KEYS as RAG_VECTOR_ENV_KEYS }

export class RagVectorConfigError extends Error {
  constructor(field, message) {
    super(message)
    this.name = 'RagVectorConfigError'
    this.code = 'RAG_VECTOR_CONFIG_INVALID'
    this.field = field
  }
}

function fail(field, message) {
  throw new RagVectorConfigError(field, message)
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requiredText(env, key, { maxLength = 512 } = {}) {
  const value = optionalText(env[key])
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(key, `${key} is required and must be a valid text value.`)
  }
  return value.normalize('NFKC')
}

function parseEnabled(value) {
  const normalized = optionalText(value).toLowerCase()
  if (normalized === '') return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  fail(VECTOR_ENV_KEYS.enabled, `${VECTOR_ENV_KEYS.enabled} must be a boolean.`)
}

function parseInteger(env, key, { min, max }) {
  const value = optionalText(env[key])
  const parsed = Number(value)
  if (!value || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(key, `${key} must be an integer between ${min} and ${max}.`)
  }
  return parsed
}

function parseBaseUrl(env, key) {
  const value = requiredText(env, key, { maxLength: 2_048 })
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(key, `${key} must be an absolute HTTP(S) URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash) {
    fail(key, `${key} must not contain credentials, a query, or a fragment.`)
  }
  return parsed.toString().replace(/\/+$/u, '')
}

function parseCollection(env, key) {
  const value = requiredText(env, key, { maxLength: 128 })
  if (!COLLECTION_PATTERN.test(value)) fail(key, `${key} contains invalid collection characters.`)
  return value
}

function parseChoice(env, key, values) {
  const value = requiredText(env, key, { maxLength: 32 }).toLowerCase()
  if (!values.includes(value)) fail(key, `${key} must be one of: ${values.join(', ')}.`)
  return value
}

function canonicalModelConfig(modelConfig) {
  return {
    provider: modelConfig.provider,
    modelId: modelConfig.modelId,
    modelRevision: modelConfig.modelRevision,
    dimensions: modelConfig.dimensions,
    inputLimit: modelConfig.inputLimit,
    distance: modelConfig.distance,
    normalization: modelConfig.normalization
  }
}

export function computeRagVectorConfigHash(modelConfig) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalModelConfig(modelConfig), null, 0), 'utf8')
    .digest('hex')
}

function parseModelConfig(env) {
  const modelConfig = {
    provider: requiredText(env, VECTOR_ENV_KEYS.provider, { maxLength: 128 }),
    modelId: requiredText(env, VECTOR_ENV_KEYS.modelId, { maxLength: 512 }),
    modelRevision: requiredText(env, VECTOR_ENV_KEYS.modelRevision, { maxLength: 256 }),
    dimensions: parseInteger(env, VECTOR_ENV_KEYS.dimensions, { min: MIN_DIMENSIONS, max: MAX_DIMENSIONS }),
    inputLimit: parseInteger(env, VECTOR_ENV_KEYS.inputLimit, { min: MIN_INPUT_LIMIT, max: MAX_INPUT_LIMIT }),
    distance: parseChoice(env, VECTOR_ENV_KEYS.distance, ['cosine', 'dot', 'euclid']),
    normalization: parseChoice(env, VECTOR_ENV_KEYS.normalization, ['none', 'l2'])
  }
  const configHash = requiredText(env, VECTOR_ENV_KEYS.configHash, { maxLength: 64 }).toLowerCase()
  if (!HASH_PATTERN.test(configHash)) fail(VECTOR_ENV_KEYS.configHash, `${VECTOR_ENV_KEYS.configHash} is invalid.`)
  const expectedHash = computeRagVectorConfigHash(modelConfig)
  if (configHash !== expectedHash) {
    fail(VECTOR_ENV_KEYS.configHash, `${VECTOR_ENV_KEYS.configHash} does not match the embedding identity.`)
  }
  return Object.freeze({ ...modelConfig, configHash })
}

/**
 * Read the optional Qdrant/vector configuration without ever selecting a model implicitly.
 * A disabled configuration intentionally discards all endpoint/model values so stale Qwen1024
 * environment variables cannot activate a vector path by accident.
 */
export function loadRagVectorConfig(env = process.env) {
  const enabled = parseEnabled(env[VECTOR_ENV_KEYS.enabled])
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      baseUrl: null,
      collection: null,
      timeoutMs: null,
      modelConfig: null,
      embedding: null
    })
  }

  const baseUrl = parseBaseUrl(env, VECTOR_ENV_KEYS.baseUrl)
  const collection = parseCollection(env, VECTOR_ENV_KEYS.collection)
  const timeoutMs = parseInteger(env, VECTOR_ENV_KEYS.timeoutMs, { min: 1, max: MAX_TIMEOUT_MS })
  const modelConfig = parseModelConfig(env)
  return Object.freeze({
    enabled: true,
    baseUrl,
    collection,
    timeoutMs,
    modelConfig,
    embedding: modelConfig
  })
}

export const parseRagVectorConfig = loadRagVectorConfig
