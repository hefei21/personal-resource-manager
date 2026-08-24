import crypto from 'node:crypto'

export const RAG_VECTOR_STORE_VERSION = 'rag-vector-store.v1'
export const RAG_VECTOR_MAX_BATCH_ITEMS = 256
export const RAG_VECTOR_MAX_SEARCH_LIMIT = 100
export const RAG_VECTOR_MAX_OVERFETCH = 10

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const COLLECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SOURCE_VERSION_MAX_LENGTH = 256
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 60_000
const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const RAG_VECTOR_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_VECTOR_INPUT_INVALID',
  COLLECTION_INVALID: 'RAG_VECTOR_COLLECTION_INVALID',
  CONFIG_INVALID: 'RAG_VECTOR_CONFIG_INVALID',
  VECTOR_INVALID: 'RAG_VECTOR_INVALID',
  VECTOR_DIMENSIONS_INVALID: 'RAG_VECTOR_DIMENSIONS_INVALID',
  BATCH_INVALID: 'RAG_VECTOR_BATCH_INVALID',
  ID_INVALID: 'RAG_VECTOR_ID_INVALID',
  SOURCE_INVALID: 'RAG_VECTOR_SOURCE_INVALID',
  FILTER_FORBIDDEN: 'RAG_VECTOR_FILTER_FORBIDDEN',
  RESPONSE_INVALID: 'RAG_VECTOR_RESPONSE_INVALID',
  RESPONSE_FILTER_VIOLATION: 'RAG_VECTOR_RESPONSE_FILTER_VIOLATION',
  REQUEST_REJECTED: 'RAG_VECTOR_REQUEST_REJECTED',
  COLLECTION_MISSING: 'RAG_VECTOR_COLLECTION_MISSING',
  SCHEMA_MISMATCH: 'RAG_VECTOR_SCHEMA_MISMATCH',
  UNAVAILABLE: 'RAG_VECTOR_UNAVAILABLE',
  TIMEOUT: 'RAG_VECTOR_TIMEOUT',
  CANCELLED: 'RAG_VECTOR_CANCELLED'
})

export { RAG_VECTOR_ERROR_CODES }

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

const QWEN3_EMBEDDING_06B_CANDIDATE_BASE = Object.freeze({
  provider: 'local-openai-compatible',
  modelId: 'Qwen/Qwen3-Embedding-0.6B',
  modelRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3',
  dimensions: 1024,
  inputLimit: 32768,
  distance: 'cosine',
  normalization: 'l2'
})

export const QWEN3_EMBEDDING_06B_CANDIDATE_CONFIG = Object.freeze({
  ...QWEN3_EMBEDDING_06B_CANDIDATE_BASE,
  configHash: sha256(JSON.stringify(QWEN3_EMBEDDING_06B_CANDIDATE_BASE))
})

const MODEL_CONFIG_REQUIRED_KEYS = Object.freeze([
  'provider',
  'modelId',
  'modelRevision',
  'dimensions',
  'distance',
  'normalization',
  'inputLimit',
  'configHash'
])

const MODEL_DISTANCES = Object.freeze({ cosine: 'Cosine', dot: 'Dot', euclid: 'Euclid' })
const MODEL_DISTANCE_VALUES = new Set(Object.keys(MODEL_DISTANCES))
const MODEL_NORMALIZATION_VALUES = new Set(['none', 'l2'])

function normalizeModelText(value, fieldName, maxLength) {
  if (typeof value !== 'string') fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: fieldName })
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: fieldName })
  }
  return normalized
}

function normalizeModelConfig(value) {
  const allowedKeys = new Set([...MODEL_CONFIG_REQUIRED_KEYS, 'instruction'])
  if (!isPlainObject(value) || MODEL_CONFIG_REQUIRED_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some((key) => !allowedKeys.has(key))) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: 'modelConfig' })
  }
  const normalized = {
    provider: normalizeModelText(value.provider, 'modelConfig.provider', 128),
    modelId: normalizeModelText(value.modelId, 'modelConfig.modelId', 512),
    modelRevision: normalizeModelText(value.modelRevision, 'modelConfig.modelRevision', 256),
    dimensions: value.dimensions,
    distance: value.distance,
    normalization: value.normalization,
    inputLimit: value.inputLimit,
    configHash: value.configHash
  }
  if (value.instruction !== undefined) {
    normalized.instruction = normalizeModelText(value.instruction, 'modelConfig.instruction', 4096)
  }
  if (!Number.isSafeInteger(normalized.dimensions) || normalized.dimensions < 32 || normalized.dimensions > 65_536 ||
      !Number.isSafeInteger(normalized.inputLimit) || normalized.inputLimit < 128 || normalized.inputLimit > 1_048_576) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: 'modelConfig.limits' })
  }
  if (!MODEL_DISTANCE_VALUES.has(normalized.distance) || !MODEL_NORMALIZATION_VALUES.has(normalized.normalization)) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: 'modelConfig.distance' })
  }
  if (typeof normalized.configHash !== 'string' || !HASH_PATTERN.test(normalized.configHash)) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: 'modelConfig.configHash' })
  }
  const hashInput = {
    provider: normalized.provider,
    modelId: normalized.modelId,
    modelRevision: normalized.modelRevision,
    dimensions: normalized.dimensions,
    inputLimit: normalized.inputLimit,
    distance: normalized.distance,
    normalization: normalized.normalization,
    ...(normalized.instruction === undefined ? {} : { instruction: normalized.instruction })
  }
  const expectedHash = sha256(JSON.stringify(hashInput))
  if (normalized.configHash !== expectedHash) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: 'modelConfig.configHash' })
  }
  return Object.freeze(normalized)
}

function collectionSchema(modelConfig) {
  return Object.freeze({
    size: modelConfig.dimensions,
    distance: MODEL_DISTANCES[modelConfig.distance],
    onDiskPayload: true,
    modelId: modelConfig.modelId,
    modelRevision: modelConfig.modelRevision,
    modelConfigHash: modelConfig.configHash
  })
}

const DEGRADED_ERROR_CODES = new Set([
  RAG_VECTOR_ERROR_CODES.COLLECTION_MISSING,
  RAG_VECTOR_ERROR_CODES.SCHEMA_MISMATCH,
  RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID,
  RAG_VECTOR_ERROR_CODES.RESPONSE_FILTER_VIOLATION,
  RAG_VECTOR_ERROR_CODES.REQUEST_REJECTED,
  RAG_VECTOR_ERROR_CODES.UNAVAILABLE,
  RAG_VECTOR_ERROR_CODES.TIMEOUT,
  RAG_VECTOR_ERROR_CODES.CANCELLED
])

const TIMEOUT_SENTINEL = Symbol('rag-vector-timeout')
const CANCEL_SENTINEL = Symbol('rag-vector-cancel')

export class RagVectorStoreError extends Error {
  constructor(code, { operation = null, retryable = false, degraded = DEGRADED_ERROR_CODES.has(code), status = null } = {}) {
    super(code)
    this.name = 'RagVectorStoreError'
    this.code = code
    this.operation = operation
    this.retryable = retryable
    this.degraded = degraded
    this.status = status
    Object.freeze(this)
  }
}

function fail(code, options = {}) {
  throw new RagVectorStoreError(code, options)
}

function positiveInteger(value, code = RAG_VECTOR_ERROR_CODES.ID_INVALID) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code)
  return value
}

function nonNegativeInteger(value, code = RAG_VECTOR_ERROR_CODES.INPUT_INVALID) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code)
  return value
}

function requiredHash(value, fieldName = 'hash') {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: fieldName })
  }
  return value
}

function requiredText(value, fieldName, maxLength = SOURCE_VERSION_MAX_LENGTH) {
  if (typeof value !== 'string') fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: fieldName })
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: fieldName })
  }
  return normalized
}

function validateSignal(signal) {
  if (signal === undefined) return
  if (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'signal' })
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'baseUrl' })
  }
  let parsed
  try { parsed = new URL(value.trim()) } catch { fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'baseUrl' }) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'baseUrl' })
  }
  return parsed.toString().replace(/\/+$/u, '')
}

function normalizeCollection(value) {
  if (typeof value !== 'string' || !COLLECTION_PATTERN.test(value)) {
    fail(RAG_VECTOR_ERROR_CODES.COLLECTION_INVALID, { operation: 'collection' })
  }
  return value
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'timeoutMs' })
  }
  return value
}

function normalizeVector(vector, dimensions, fieldName = 'vector') {
  if (!Array.isArray(vector)) fail(RAG_VECTOR_ERROR_CODES.VECTOR_INVALID, { operation: fieldName })
  if (vector.length !== dimensions) {
    fail(RAG_VECTOR_ERROR_CODES.VECTOR_DIMENSIONS_INVALID, { operation: fieldName })
  }
  if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    fail(RAG_VECTOR_ERROR_CODES.VECTOR_INVALID, { operation: fieldName })
  }
  return Object.freeze([...vector])
}

export function ragVectorSha256(vector) {
  return sha256(JSON.stringify(vector))
}

export const vectorHash = ragVectorSha256

function normalizeSourceType(value) {
  if (typeof value !== 'string' || !SOURCE_TYPES.has(value)) {
    fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: 'sourceType' })
  }
  return value
}

function normalizeSourceVersionId(value) {
  return requiredText(value, 'sourceVersionId')
}

function normalizePointInput(point, index, modelConfig) {
  if (!isPlainObject(point)) fail(RAG_VECTOR_ERROR_CODES.BATCH_INVALID, { operation: `points[${index}]` })
  const chunkId = positiveInteger(point.chunkId)
  const snapshotId = positiveInteger(point.snapshotId)
  const sourceType = normalizeSourceType(point.sourceType)
  const sourceId = positiveInteger(point.sourceId)
  const sourceVersionId = normalizeSourceVersionId(point.sourceVersionId)
  const vector = normalizeVector(point.vector, modelConfig.dimensions, `points[${index}].vector`)
  const computedHash = ragVectorSha256(vector)
  if (point.vectorSha256 !== undefined && point.vectorSha256 !== computedHash) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: `points[${index}].vectorSha256` })
  }
  if (point.modelId !== undefined && point.modelId !== modelConfig.modelId) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: `points[${index}].modelId` })
  }
  if (point.modelRevision !== undefined && point.modelRevision !== modelConfig.modelRevision) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: `points[${index}].modelRevision` })
  }
  if (point.modelConfigHash !== undefined && point.modelConfigHash !== modelConfig.configHash) {
    fail(RAG_VECTOR_ERROR_CODES.CONFIG_INVALID, { operation: `points[${index}].modelConfigHash` })
  }
  return Object.freeze({ chunkId, snapshotId, sourceType, sourceId, sourceVersionId, vector, vectorSha256: computedHash })
}

function normalizePointBatch(points, modelConfig) {
  if (!Array.isArray(points) || points.length < 1 || points.length > RAG_VECTOR_MAX_BATCH_ITEMS) {
    fail(RAG_VECTOR_ERROR_CODES.BATCH_INVALID, { operation: 'points' })
  }
  const normalized = points.map((point, index) => normalizePointInput(point, index, modelConfig))
  const ids = new Set(normalized.map((point) => point.chunkId))
  if (ids.size !== normalized.length) fail(RAG_VECTOR_ERROR_CODES.BATCH_INVALID, { operation: 'points' })
  return Object.freeze(normalized)
}

function normalizeSourceAllowlist(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: 'sourceAllowlist' })
  }
  const seen = new Set()
  const normalized = value.map((source, index) => {
    if (!isPlainObject(source)) fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: `sourceAllowlist[${index}]` })
    const sourceType = normalizeSourceType(source.sourceType)
    const sourceId = positiveInteger(source.sourceId)
    const sourceVersionId = source.sourceVersionId === undefined
      ? null
      : normalizeSourceVersionId(source.sourceVersionId)
    const identity = `${sourceType}\u0000${sourceId}\u0000${sourceVersionId ?? ''}`
    if (seen.has(identity)) fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: `sourceAllowlist[${index}]` })
    seen.add(identity)
    return Object.freeze({ sourceType, sourceId, sourceVersionId })
  })
  return Object.freeze(normalized)
}

function sourceMatchesAllowlist(payload, sourceAllowlist) {
  return sourceAllowlist.some((source) => source.sourceType === payload.sourceType &&
    source.sourceId === payload.sourceId &&
    (source.sourceVersionId === null || source.sourceVersionId === payload.sourceVersionId))
}

function normalizeActiveSnapshotSources(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: 'activeSnapshotSources' })
  }
  const seen = new Set()
  const normalized = value.map((source, index) => {
    if (!isPlainObject(source)) fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: `activeSnapshotSources[${index}]` })
    const snapshotId = positiveInteger(source.snapshotId)
    const sourceType = normalizeSourceType(source.sourceType)
    const sourceId = positiveInteger(source.sourceId)
    const sourceVersionId = source.sourceVersionId === undefined
      ? null
      : normalizeSourceVersionId(source.sourceVersionId)
    const identity = `${snapshotId}\u0000${sourceType}\u0000${sourceId}\u0000${sourceVersionId ?? ''}`
    if (seen.has(identity)) fail(RAG_VECTOR_ERROR_CODES.SOURCE_INVALID, { operation: `activeSnapshotSources[${index}]` })
    seen.add(identity)
    return Object.freeze({ snapshotId, sourceType, sourceId, sourceVersionId })
  })
  return Object.freeze(normalized)
}

function normalizeSearchOptions(options = {}) {
  if (!isPlainObject(options)) fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'search.options' })
  if (Object.prototype.hasOwnProperty.call(options, 'filter')) {
    fail(RAG_VECTOR_ERROR_CODES.FILTER_FORBIDDEN, { operation: 'search.filter' })
  }
  validateSignal(options.signal)
  const activeSnapshotSources = options.activeSnapshotSources === undefined
    ? null
    : normalizeActiveSnapshotSources(options.activeSnapshotSources)
  if (activeSnapshotSources && options.sourceAllowlist !== undefined) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'search.sourceScope' })
  }
  const activeSnapshotId = activeSnapshotSources
    ? null
    : positiveInteger(options.activeSnapshotId)
  const sourceAllowlist = activeSnapshotSources
    ? null
    : normalizeSourceAllowlist(options.sourceAllowlist)
  const limitValue = options.limit === undefined ? options.topK : options.limit
  if (options.limit !== undefined && options.topK !== undefined && options.limit !== options.topK) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'search.limit' })
  }
  const limit = limitValue === undefined ? 10 : positiveInteger(limitValue, RAG_VECTOR_ERROR_CODES.INPUT_INVALID)
  if (limit > RAG_VECTOR_MAX_SEARCH_LIMIT) fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'search.limit' })
  const overfetch = options.overfetch === undefined
    ? 3
    : positiveInteger(options.overfetch, RAG_VECTOR_ERROR_CODES.INPUT_INVALID)
  if (overfetch > RAG_VECTOR_MAX_OVERFETCH || limit * overfetch > RAG_VECTOR_MAX_BATCH_ITEMS * 4) {
    fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'search.overfetch' })
  }
  const activeSources = activeSnapshotSources ?? sourceAllowlist.map((source) => ({
    snapshotId: activeSnapshotId,
    ...source
  }))
  return Object.freeze({ activeSnapshotId, sourceAllowlist, activeSources, limit, overfetch, signal: options.signal })
}

function sourceFilter(source) {
  const must = [
    { key: 'sourceType', match: { value: source.sourceType } },
    { key: 'sourceId', match: { value: source.sourceId } }
  ]
  if (source.sourceVersionId !== null) {
    must.push({ key: 'sourceVersionId', match: { value: source.sourceVersionId } })
  }
  return { must }
}

function buildServerFilter({ activeSnapshotId, sourceAllowlist, activeSources }, modelConfig) {
  if (activeSnapshotId === null) {
    return {
      must: [
        { key: 'lifecycle', match: { value: 'active' } },
        { key: 'modelId', match: { value: modelConfig.modelId } },
        { key: 'modelConfigHash', match: { value: modelConfig.configHash } },
        { should: activeSources.map((source) => ({
          must: [
            { key: 'snapshotId', match: { value: source.snapshotId } },
            ...sourceFilter(source).must
          ]
        })) }
      ]
    }
  }
  return {
    must: [
      { key: 'snapshotId', match: { value: activeSnapshotId } },
      { key: 'lifecycle', match: { value: 'active' } },
      { key: 'modelId', match: { value: modelConfig.modelId } },
      { key: 'modelConfigHash', match: { value: modelConfig.configHash } },
      { should: sourceAllowlist.map(sourceFilter) }
    ]
  }
}

function validateCollectionPayload(payload, schema) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) ||
      !isPlainObject(payload.result.config) || !isPlainObject(payload.result.config.params) ||
      !isPlainObject(payload.result.config.params.vectors)) {
    fail(RAG_VECTOR_ERROR_CODES.SCHEMA_MISMATCH, { operation: 'collection' })
  }
  const vectors = payload.result.config.params.vectors
  if (vectors.size !== schema.size || vectors.distance !== schema.distance) {
    fail(RAG_VECTOR_ERROR_CODES.SCHEMA_MISMATCH, { operation: 'collection' })
  }
  const pointsCount = payload.result.points_count === undefined
    ? null
    : nonNegativeInteger(payload.result.points_count, RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID)
  return Object.freeze({
    pointsCount,
    status: typeof payload.result.status === 'string' ? payload.result.status : null,
    schema
  })
}

function validateMutationResponse(payload, operation) {
  if (!isPlainObject(payload) || !Object.prototype.hasOwnProperty.call(payload, 'result')) {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation })
  }
  if (payload.status !== undefined && payload.status !== 'ok') {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation })
  }
  if (!isPlainObject(payload.result) && typeof payload.result !== 'boolean') {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation })
  }
  return payload.result
}

function normalizePayload(payload, modelConfig, fieldName = 'payload') {
  if (!isPlainObject(payload)) fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: fieldName })
  const chunkId = positiveInteger(payload.chunkId)
  const snapshotId = positiveInteger(payload.snapshotId)
  const sourceType = normalizeSourceType(payload.sourceType)
  const sourceId = positiveInteger(payload.sourceId)
  const sourceVersionId = normalizeSourceVersionId(payload.sourceVersionId)
  if (payload.lifecycle !== 'active' || payload.modelId !== modelConfig.modelId ||
      payload.modelRevision !== modelConfig.modelRevision ||
      payload.modelConfigHash !== modelConfig.configHash) {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_FILTER_VIOLATION, { operation: fieldName })
  }
  const vectorSha256 = requiredHash(payload.vectorSha256, `${fieldName}.vectorSha256`)
  return Object.freeze({
    chunkId,
    snapshotId,
    sourceType,
    sourceId,
    sourceVersionId,
    modelId: payload.modelId,
    modelRevision: payload.modelRevision,
    modelConfigHash: payload.modelConfigHash,
    vectorSha256,
    lifecycle: 'active'
  })
}

function normalizeSearchResponse(payload, options, modelConfig) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.points)) {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'search' })
  }
  const ids = new Set()
  const points = payload.result.points.map((point, index) => {
    if (!isPlainObject(point) || !Number.isSafeInteger(point.id) || point.id <= 0 ||
        typeof point.score !== 'number' || !Number.isFinite(point.score)) {
      fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: `search.points[${index}]` })
    }
    if (ids.has(point.id)) fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'search.points' })
    ids.add(point.id)
    const normalizedPayload = normalizePayload(point.payload, modelConfig, `search.points[${index}].payload`)
    if (normalizedPayload.chunkId !== point.id ||
        !options.activeSources.some((source) => source.snapshotId === normalizedPayload.snapshotId &&
          sourceMatchesAllowlist(normalizedPayload, [source]))) {
      fail(RAG_VECTOR_ERROR_CODES.RESPONSE_FILTER_VIOLATION, { operation: `search.points[${index}]` })
    }
    return Object.freeze({
      chunkId: normalizedPayload.chunkId,
      score: point.score,
      payload: normalizedPayload
    })
  })
  return Object.freeze(points)
}

function validateHealthPayload(payload) {
  if (!isPlainObject(payload)) fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'health' })
  if (payload.title !== undefined && (typeof payload.title !== 'string' || !payload.title.trim())) {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'health' })
  }
  if (payload.version !== undefined && typeof payload.version !== 'string') {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'health' })
  }
  return Object.freeze({
    title: payload.title ?? null,
    version: payload.version ?? null
  })
}

function validateSnapshotPayload(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) ||
      typeof payload.result.name !== 'string' || !payload.result.name.trim() ||
      /[\u0000-\u001f\u007f/]/u.test(payload.result.name)) {
    fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'snapshot' })
  }
  const size = payload.result.size === undefined
    ? null
    : nonNegativeInteger(payload.result.size, RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID)
  const checksum = payload.result.checksum === undefined || payload.result.checksum === null
    ? null
    : requiredHash(payload.result.checksum, 'snapshot.checksum')
  return Object.freeze({ name: payload.result.name, size, checksum })
}

function urlPath(collection, suffix = '') {
  return `/collections/${encodeURIComponent(collection)}${suffix}`
}

export function isRagVectorDegradedError(error) {
  return error instanceof RagVectorStoreError && (error.degraded || DEGRADED_ERROR_CODES.has(error.code))
}

export class RagVectorStore {
  constructor({ fetch: fetchFn = globalThis.fetch, fetchFn: fetchAlias, baseUrl, collection, modelConfig, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const resolvedFetch = fetchAlias ?? fetchFn
    if (typeof resolvedFetch !== 'function') fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'fetch' })
    this.fetchFn = resolvedFetch
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.collection = normalizeCollection(collection)
    this.modelConfig = normalizeModelConfig(modelConfig)
    this.collectionSchema = collectionSchema(this.modelConfig)
    this.timeoutMs = normalizeTimeout(timeoutMs)
    Object.freeze(this)
  }

  async #request(path, { method = 'GET', body, expectedStatuses = [200], signal, operation } = {}) {
    validateSignal(signal)
    if (signal?.aborted) fail(RAG_VECTOR_ERROR_CODES.CANCELLED, { operation, retryable: false })
    const controller = new AbortController()
    let timeoutId = null
    let timedOut = false
    let abortListener = null
    const requestUrl = `${this.baseUrl}${path}`
    const init = {
      method,
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }),
      signal: controller.signal
    }

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(TIMEOUT_SENTINEL)
      }, this.timeoutMs)
    })
    const fetchPromise = Promise.resolve().then(() => this.fetchFn(requestUrl, init))
    const cancelPromise = signal
      ? new Promise((_, reject) => {
        abortListener = () => {
          controller.abort()
          reject(CANCEL_SENTINEL)
        }
        signal.addEventListener('abort', abortListener, { once: true })
      })
      : null

    try {
      const response = await Promise.race(cancelPromise ? [fetchPromise, timeoutPromise, cancelPromise] : [fetchPromise, timeoutPromise])
      if (!response || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
        fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation })
      }
      let payload = null
      if (response.status !== 204) {
        if (typeof response.json !== 'function') fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation })
        try { payload = await response.json() } catch { fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation }) }
      }
      if (signal?.aborted) fail(RAG_VECTOR_ERROR_CODES.CANCELLED, { operation, retryable: false })
      if (!expectedStatuses.includes(response.status)) {
        if (response.status === 404) {
          fail(RAG_VECTOR_ERROR_CODES.COLLECTION_MISSING, { operation, status: response.status, retryable: false })
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          fail(RAG_VECTOR_ERROR_CODES.UNAVAILABLE, { operation, status: response.status, retryable: true })
        }
        fail(RAG_VECTOR_ERROR_CODES.REQUEST_REJECTED, { operation, status: response.status, retryable: false })
      }
      return Object.freeze({ status: response.status, payload })
    } catch (error) {
      if (error === TIMEOUT_SENTINEL || timedOut) {
        fail(RAG_VECTOR_ERROR_CODES.TIMEOUT, { operation, retryable: true })
      }
      if (error === CANCEL_SENTINEL || signal?.aborted) {
        fail(RAG_VECTOR_ERROR_CODES.CANCELLED, { operation, retryable: false })
      }
      if (error instanceof RagVectorStoreError) throw error
      fail(RAG_VECTOR_ERROR_CODES.UNAVAILABLE, { operation, retryable: true })
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  async #getCollection(signal) {
    const response = await this.#request(urlPath(this.collection), {
      signal,
      operation: 'collection',
      expectedStatuses: [200]
    })
    return validateCollectionPayload(response.payload, this.collectionSchema)
  }

  async ensureCollection({ signal } = {}) {
    validateSignal(signal)
    const existing = await this.#request(urlPath(this.collection), {
      signal,
      operation: 'ensureCollection.read',
      expectedStatuses: [200, 404]
    })
    if (existing.status === 200) {
      return Object.freeze({ created: false, ...validateCollectionPayload(existing.payload, this.collectionSchema) })
    }

    const created = await this.#request(urlPath(this.collection), {
      method: 'PUT',
      body: {
        vectors: { size: this.collectionSchema.size, distance: this.collectionSchema.distance },
        on_disk_payload: this.collectionSchema.onDiskPayload
      },
      signal,
      operation: 'ensureCollection.create',
      expectedStatuses: [200, 201, 409]
    })
    const verified = await this.#getCollection(signal)
    return Object.freeze({ created: created.status !== 409, ...verified })
  }

  async health({ signal } = {}) {
    const healthResponse = await this.#request('/healthz', {
      signal,
      operation: 'health',
      expectedStatuses: [200]
    })
    const health = validateHealthPayload(healthResponse.payload)
    const collection = await this.#getCollection(signal)
    return Object.freeze({
      available: true,
      degraded: false,
      title: health.title,
      version: health.version,
      collection: this.collection,
      pointsCount: collection.pointsCount,
      schema: collection.schema
    })
  }

  async count({ signal } = {}) {
    const collection = await this.#getCollection(signal)
    if (collection.pointsCount === null) fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'count' })
    return Object.freeze({ collection: this.collection, pointsCount: collection.pointsCount })
  }

  async upsertBatch(points, { signal } = {}) {
    const normalized = normalizePointBatch(points, this.modelConfig)
    validateSignal(signal)
    const result = normalized.map((point) => ({
      id: point.chunkId,
      vector: point.vector,
      payload: {
        chunkId: point.chunkId,
        snapshotId: point.snapshotId,
        sourceType: point.sourceType,
        sourceId: point.sourceId,
        sourceVersionId: point.sourceVersionId,
        modelId: this.modelConfig.modelId,
        modelRevision: this.modelConfig.modelRevision,
        modelConfigHash: this.modelConfig.configHash,
        vectorSha256: point.vectorSha256,
        lifecycle: 'active'
      }
    }))
    const response = await this.#request(`${urlPath(this.collection)}/points?wait=true`, {
      method: 'PUT',
      body: { points: result },
      signal,
      operation: 'upsertBatch',
      expectedStatuses: [200]
    })
    validateMutationResponse(response.payload, 'upsertBatch')
    return Object.freeze({ collection: this.collection, upserted: normalized.length, degraded: false })
  }

  async search(vector, options = {}) {
    const queryVector = normalizeVector(vector, this.modelConfig.dimensions, 'query')
    const normalizedOptions = normalizeSearchOptions(options)
    const response = await this.#request(`${urlPath(this.collection)}/points/query`, {
      method: 'POST',
      body: {
        query: queryVector,
        limit: normalizedOptions.limit * normalizedOptions.overfetch,
        with_payload: true,
        with_vector: false,
        filter: buildServerFilter(normalizedOptions, this.modelConfig)
      },
      signal: normalizedOptions.signal,
      operation: 'search',
      expectedStatuses: [200]
    })
    const points = normalizeSearchResponse(response.payload, normalizedOptions, this.modelConfig)
    return Object.freeze({ collection: this.collection, points, degraded: false })
  }

  async query(vector, options = {}) {
    return this.search(vector, options)
  }

  async deleteBySnapshot(snapshotId, { signal } = {}) {
    const normalizedSnapshotId = positiveInteger(snapshotId)
    validateSignal(signal)
    const response = await this.#request(`${urlPath(this.collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: {
        filter: {
          must: [
            { key: 'snapshotId', match: { value: normalizedSnapshotId } },
            { key: 'modelId', match: { value: this.modelConfig.modelId } },
            { key: 'modelConfigHash', match: { value: this.modelConfig.configHash } }
          ]
        }
      },
      signal,
      operation: 'deleteBySnapshot',
      expectedStatuses: [200]
    })
    validateMutationResponse(response.payload, 'deleteBySnapshot')
    return Object.freeze({ collection: this.collection, snapshotId: normalizedSnapshotId, deleted: true, degraded: false })
  }

  async deleteSnapshot(snapshotId, options = {}) {
    return this.deleteBySnapshot(snapshotId, options)
  }

  async listBySnapshot(snapshotId, { limit = RAG_VECTOR_MAX_BATCH_ITEMS, offset = null, signal } = {}) {
    const normalizedSnapshotId = positiveInteger(snapshotId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'listBySnapshot.limit' })
    }
    if (offset !== null && offset !== undefined &&
        ((!Number.isSafeInteger(offset) && typeof offset !== 'string') ||
          (typeof offset === 'string' && !offset.trim()))) {
      fail(RAG_VECTOR_ERROR_CODES.INPUT_INVALID, { operation: 'listBySnapshot.offset' })
    }
    validateSignal(signal)
    const body = {
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: 'snapshotId', match: { value: normalizedSnapshotId } },
          { key: 'modelId', match: { value: this.modelConfig.modelId } },
          { key: 'modelConfigHash', match: { value: this.modelConfig.configHash } }
        ]
      }
    }
    if (offset !== null && offset !== undefined) body.offset = offset
    const response = await this.#request(`${urlPath(this.collection)}/points/scroll`, {
      method: 'POST',
      body,
      signal,
      operation: 'listBySnapshot',
      expectedStatuses: [200]
    })
    if (!isPlainObject(response.payload) || !isPlainObject(response.payload.result) ||
        !Array.isArray(response.payload.result.points)) {
      fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: 'listBySnapshot' })
    }
    const points = response.payload.result.points.map((point, index) => {
      if (!isPlainObject(point) || !Number.isSafeInteger(point.id) || point.id <= 0) {
        fail(RAG_VECTOR_ERROR_CODES.RESPONSE_INVALID, { operation: `listBySnapshot.points[${index}]` })
      }
      const payload = normalizePayload(point.payload, this.modelConfig, `listBySnapshot.points[${index}].payload`)
      if (payload.snapshotId !== normalizedSnapshotId || payload.chunkId !== point.id) {
        fail(RAG_VECTOR_ERROR_CODES.RESPONSE_FILTER_VIOLATION, { operation: `listBySnapshot.points[${index}]` })
      }
      return Object.freeze({ id: point.id, chunkId: payload.chunkId, vectorSha256: payload.vectorSha256, payload })
    })
    const nextPageOffset = response.payload.result.next_page_offset ?? null
    return Object.freeze({
      collection: this.collection,
      snapshotId: normalizedSnapshotId,
      points: Object.freeze(points),
      nextPageOffset,
      degraded: false
    })
  }

  async snapshot({ signal } = {}) {
    const response = await this.#request(`${urlPath(this.collection)}/snapshots?wait=true`, {
      method: 'POST',
      signal,
      operation: 'snapshot',
      expectedStatuses: [200]
    })
    return Object.freeze({ collection: this.collection, ...validateSnapshotPayload(response.payload), degraded: false })
  }

  async createSnapshot(options = {}) {
    return this.snapshot(options)
  }
}

export function createRagVectorStore(options) {
  return new RagVectorStore(options)
}

export default createRagVectorStore
