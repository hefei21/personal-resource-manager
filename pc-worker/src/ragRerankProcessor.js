import crypto from 'node:crypto'

export const RAG_RERANK_PROCESSOR_VERSION = 'v1'
export const RAG_RERANK_EXECUTION_CLASS = 'gpu'
export const RAG_RERANK_OUTPUT_SCHEMA_VERSION = 1
export const RAG_RERANK_TASK_TYPE = 'rag.rerank'
export const RAG_RERANK_PROVIDER = 'hugging-face-tei'
export const RAG_RERANK_MODEL_ID = 'BAAI/bge-reranker-v2-m3'
export const RAG_RERANK_MODEL_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
export const RAG_RERANK_DIMENSIONS = 1
export const RAG_RERANK_INPUT_LIMIT = 512
export const RAG_RERANK_CONFIG_HASH = '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'

const MAX_QUERY_BYTES = 64 * 1024
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024
const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_BATCH_ITEMS = 10
const MAX_LENGTH = 512
const SCORE_TYPE = 'raw_logit'
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~%!'()*=-]{0,127}$/u
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const LOCAL_MODEL = Object.freeze({
  provider: RAG_RERANK_PROVIDER,
  modelId: RAG_RERANK_MODEL_ID,
  modelRevision: RAG_RERANK_MODEL_REVISION,
  dimensions: RAG_RERANK_DIMENSIONS,
  inputLimit: RAG_RERANK_INPUT_LIMIT,
  configHash: RAG_RERANK_CONFIG_HASH
})

export class RagRerankProcessorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RagRerankProcessorError'
    this.code = code
  }
}

function fail(code, message = code) {
  throw new RagRerankProcessorError(code, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed, fieldName, code = 'WORKER_RERANK_INPUT_INVALID') {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(code, `${fieldName} is invalid.`)
  }
}

function requiredText(value, fieldName, maxBytes) {
  if (typeof value !== 'string') fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || CONTROL_PATTERN.test(normalized)) {
    fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function contentText(value, fieldName, maxBytes) {
  if (typeof value !== 'string') fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || CONTROL_PATTERN.test(normalized)) fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) fail('WORKER_RERANK_INPUT_TOO_LARGE', `${fieldName} exceeds its limit.`)
  return normalized
}

function opaqueId(value, fieldName) {
  const normalized = requiredText(value, fieldName, 128)
  if (!OPAQUE_ID_PATTERN.test(normalized)) fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function hash(value, fieldName) {
  const normalized = requiredText(value, fieldName, 64).toLowerCase()
  if (!HASH_PATTERN.test(normalized)) fail('WORKER_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function candidateSetHashFor(candidates) {
  return sha256(JSON.stringify(candidates.map((candidate, index) => ({
    index,
    candidateId: candidate.candidateId,
    textSha256: sha256(candidate.text),
    ...(Object.hasOwn(candidate, 'score') ? { score: candidate.score } : {})
  }))))
}

function finite(value, fieldName, code = 'WORKER_RERANK_RESULT_INVALID') {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, `${fieldName} is not finite.`)
  return value
}

function positiveInteger(value, fieldName, max = Number.MAX_SAFE_INTEGER, code = 'WORKER_RERANK_INPUT_INVALID') {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code, `${fieldName} is invalid.`)
  return value
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze))
  if (isPlainObject(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])))
  return value
}

function localModelIdentity(config) {
  return freeze({
    provider: config.provider,
    modelId: config.modelId,
    modelRevision: config.modelRevision,
    dimensions: config.dimensions,
    inputLimit: config.inputLimit,
    configHash: config.configHash
  })
}

function normalizeEndpoint(raw, fieldName) {
  if (typeof raw !== 'string' || raw.trim() === '') fail('WORKER_RERANK_NOT_CONFIGURED', `${fieldName} is invalid.`)
  let parsed
  try { parsed = new URL(raw) } catch { fail('WORKER_RERANK_NOT_CONFIGURED', `${fieldName} is invalid.`) }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    fail('WORKER_RERANK_NOT_CONFIGURED', `${fieldName} must use HTTPS outside loopback testing.`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('WORKER_RERANK_NOT_CONFIGURED', `${fieldName} must not contain credentials, query, or fragment.`)
  }
  return parsed.toString().replace(/\/$/u, '')
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) fail('WORKER_RERANK_NOT_CONFIGURED', 'Reranker processor is not configured.')
  const endpoint = normalizeEndpoint(raw.endpoint ?? raw.baseUrl, 'reranker.endpoint')
  const provider = raw.provider ?? RAG_RERANK_PROVIDER
  const modelId = raw.modelId ?? RAG_RERANK_MODEL_ID
  const modelRevision = raw.modelRevision ?? RAG_RERANK_MODEL_REVISION
  const dimensions = raw.dimensions ?? RAG_RERANK_DIMENSIONS
  const inputLimit = raw.inputLimit ?? RAG_RERANK_INPUT_LIMIT
  const configHash = raw.configHash ?? RAG_RERANK_CONFIG_HASH
  if (provider !== RAG_RERANK_PROVIDER || modelId !== RAG_RERANK_MODEL_ID || modelRevision !== RAG_RERANK_MODEL_REVISION ||
      dimensions !== RAG_RERANK_DIMENSIONS || inputLimit !== RAG_RERANK_INPUT_LIMIT || configHash !== RAG_RERANK_CONFIG_HASH) {
    fail('WORKER_RERANK_MODEL_MISMATCH', 'Reranker model identity is not the pinned BGE model.')
  }
  const timeoutMs = raw.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000) {
    fail('WORKER_RERANK_NOT_CONFIGURED', 'Reranker timeout is invalid.')
  }
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl !== ''
    ? normalizeEndpoint(raw.baseUrl, 'reranker.baseUrl')
    : endpoint.endsWith('/rerank') ? endpoint.slice(0, -'/rerank'.length) : endpoint
  const apiKey = raw.apiKey === null || raw.apiKey === undefined ? null : requiredText(raw.apiKey, 'reranker.apiKey', 4096)
  return freeze({
    baseUrl,
    endpoint: endpoint.endsWith('/rerank') ? endpoint : `${endpoint}/rerank`,
    provider: RAG_RERANK_PROVIDER,
    modelId: RAG_RERANK_MODEL_ID,
    modelRevision: RAG_RERANK_MODEL_REVISION,
    dimensions: RAG_RERANK_DIMENSIONS,
    inputLimit: RAG_RERANK_INPUT_LIMIT,
    configHash: RAG_RERANK_CONFIG_HASH,
    maxLength: MAX_LENGTH,
    scoreType: SCORE_TYPE,
    maxBatchItems: MAX_BATCH_ITEMS,
    maxInputBytes: MAX_INPUT_BYTES,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    timeoutMs,
    apiKey
  })
}

function assertLocalModel(value, config) {
  exactKeys(value, ['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'configHash'], 'task.input.model')
  if (value.provider !== config.provider || value.modelId !== config.modelId || value.modelRevision !== config.modelRevision ||
      value.dimensions !== config.dimensions || value.inputLimit !== config.inputLimit || value.configHash !== config.configHash) {
    fail('WORKER_RERANK_MODEL_MISMATCH', 'Task model identity does not match the pinned reranker.')
  }
  return localModelIdentity(config)
}

function normalizeTask(task, config) {
  if (!isPlainObject(task) || task.processorVersion !== RAG_RERANK_PROCESSOR_VERSION ||
      task.executionClass !== RAG_RERANK_EXECUTION_CLASS || task.taskType !== RAG_RERANK_TASK_TYPE) {
    fail('WORKER_RERANK_TASK_INVALID', 'Task processor identity is invalid.')
  }
  exactKeys(task.input, ['schemaVersion', 'querySha256', 'candidateSetSha256', 'query', 'model', 'candidates'], 'task.input')
  const input = task.input
  if (input.schemaVersion !== 1) fail('WORKER_RERANK_INPUT_INVALID', 'task.input.schemaVersion is invalid.')
  const query = requiredText(input.query, 'task.input.query', MAX_QUERY_BYTES)
  const querySha256 = hash(input.querySha256, 'task.input.querySha256')
  if (querySha256 !== sha256(query)) fail('WORKER_RERANK_INPUT_INVALID', 'task query hash does not match query text.')
  const candidateSetSha256 = hash(input.candidateSetSha256, 'task.input.candidateSetSha256')
  const model = assertLocalModel(input.model, config)
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > config.maxBatchItems) {
    fail('WORKER_RERANK_INPUT_INVALID', 'task.input.candidates exceeds its batch limit.')
  }
  const ids = new Set()
  const candidates = input.candidates.map((candidate, index) => {
    exactKeys(candidate, ['candidateId', 'text', 'score'], `task.input.candidates[${index}]`)
    const candidateId = opaqueId(candidate.candidateId, `task.input.candidates[${index}].candidateId`)
    if (ids.has(candidateId)) fail('WORKER_RERANK_INPUT_INVALID', 'Task candidates contain duplicate IDs.')
    ids.add(candidateId)
    const text = contentText(candidate.text, `task.input.candidates[${index}].text`, MAX_CANDIDATE_BYTES)
    return freeze({ candidateId, text, ...(candidate.score === undefined ? {} : { score: finite(candidate.score, `task.input.candidates[${index}].score`, 'WORKER_RERANK_INPUT_INVALID') }) })
  })
  const projected = { schemaVersion: 1, querySha256, candidateSetSha256, query, model, candidates }
  let serialized
  try { serialized = JSON.stringify(projected) } catch { fail('WORKER_RERANK_INPUT_INVALID', 'Reranker input cannot be serialized.') }
  if (Buffer.byteLength(serialized, 'utf8') > config.maxInputBytes) fail('WORKER_RERANK_INPUT_TOO_LARGE', 'Reranker input exceeds its limit.')
  const expectedCandidateSetSha256 = candidateSetHashFor(candidates)
  if (candidateSetSha256 !== expectedCandidateSetSha256) {
    fail('WORKER_RERANK_INPUT_INVALID', 'Task candidate set hash does not match candidate IDs, text, or scores.')
  }
  return freeze({ querySha256, candidateSetSha256, query, model, candidates })
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController()
  let timer
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else if (signal) signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => controller.abort(new RagRerankProcessorError('WORKER_RERANK_TIMEOUT', 'Reranker request timed out.')), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function awaitAbortable(value, signal) {
  if (!signal) return value
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    let settled = false
    let onAbort
    const finish = (callback, result) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(result)
    }
    onAbort = () => finish(reject, signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then((result) => finish(resolve, result), (error) => finish(reject, error))
  })
}

function responseEntries(payload) {
  if (Array.isArray(payload)) return payload
  if (!isPlainObject(payload)) fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response is invalid.')
  exactKeys(payload, ['data', 'scores', 'results'], 'reranker.response', 'WORKER_RERANK_RESPONSE_INVALID')
  const entries = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.scores) ? payload.scores : payload.results)
  if (!Array.isArray(entries)) fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response scores are invalid.')
  return entries
}

function normalizeResponse(payload, input) {
  const entries = responseEntries(payload)
  if (entries.length !== input.candidates.length) fail('WORKER_RERANK_RESPONSE_COUNT_INVALID', 'Reranker response dropped or added candidates.')
  const seen = new Set()
  const candidates = entries.map((entry, entryIndex) => {
    if (!isPlainObject(entry)) fail('WORKER_RERANK_RESPONSE_INVALID', `reranker.response[${entryIndex}] is invalid.`)
    exactKeys(entry, ['index', 'score'], `reranker.response[${entryIndex}]`, 'WORKER_RERANK_RESPONSE_INVALID')
    const index = entry.index
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.candidates.length) {
      fail('WORKER_RERANK_RESPONSE_INPUT_MISMATCH', 'Reranker response candidate index is invalid.')
    }
    const score = entry.score
    if (seen.has(index)) fail('WORKER_RERANK_RESPONSE_INPUT_MISMATCH', 'Reranker response contains duplicate candidates.')
    seen.add(index)
    return { originalIndex: index, candidateId: input.candidates[index].candidateId, score: finite(score, `reranker.response[${entryIndex}].score`, 'WORKER_RERANK_RESPONSE_INVALID') }
  })
  if (seen.size !== input.candidates.length) fail('WORKER_RERANK_RESPONSE_COUNT_INVALID', 'Reranker response is incomplete.')
  candidates.sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
  return freeze(candidates.map(({ candidateId, score }) => ({ candidateId, score })))
}

async function requestRerank(config, input, signal, fetchImpl) {
  const timeout = timeoutSignal(signal, config.timeoutMs)
  try {
    if (timeout.signal.aborted) {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Reranker request was cancelled.')
      fail('WORKER_RERANK_TIMEOUT', 'Reranker request timed out.')
    }
    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    const body = {
      query: input.query,
      texts: input.candidates.map((candidate) => candidate.text),
      raw_scores: config.scoreType === 'raw_logit'
    }
    let response
    try {
      response = await awaitAbortable(Promise.resolve().then(() => fetchImpl(config.endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), signal: timeout.signal
      })), timeout.signal)
    } catch {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Reranker request was cancelled.')
      if (timeout.signal.aborted) fail('WORKER_RERANK_TIMEOUT', 'Reranker request timed out.')
      fail('WORKER_RERANK_UNAVAILABLE', 'Reranker endpoint is unavailable.')
    }
    if (!response?.ok) fail('WORKER_RERANK_HTTP_FAILED', 'Reranker endpoint rejected the request.')
    const contentLength = Number(response.headers?.get?.('content-length'))
    if (Number.isSafeInteger(contentLength) && contentLength > config.maxOutputBytes) fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response is too large.')
    let payload
    try { payload = await awaitAbortable(response.json(), timeout.signal) } catch {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Reranker request was cancelled.')
      if (timeout.signal.aborted) fail('WORKER_RERANK_TIMEOUT', 'Reranker request timed out.')
      fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response is invalid.')
    }
    let serialized
    try { serialized = JSON.stringify(payload) } catch { fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response is invalid.') }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > config.maxOutputBytes) fail('WORKER_RERANK_RESPONSE_INVALID', 'Reranker response is too large.')
    return payload
  } finally {
    timeout.dispose()
  }
}

export function createRagRerankProcessor({ config, fetchImpl = fetch } = {}) {
  let normalizedConfig = null
  if (config !== null && config !== undefined) {
    try { normalizedConfig = normalizeConfig(config) } catch (error) {
      if (!(error instanceof RagRerankProcessorError)) throw error
    }
  }
  const processor = {
    configured: normalizedConfig !== null,
    supports(taskType) {
      return normalizedConfig !== null && taskType === RAG_RERANK_TASK_TYPE
    },
    async process(task, { signal } = {}) {
      if (!normalizedConfig) fail('WORKER_RERANK_NOT_CONFIGURED', 'Reranker processor is not configured.')
      const input = normalizeTask(task, normalizedConfig)
      const payload = await requestRerank(normalizedConfig, input, signal, fetchImpl)
      return freeze({
        schemaVersion: RAG_RERANK_OUTPUT_SCHEMA_VERSION,
        processorVersion: RAG_RERANK_PROCESSOR_VERSION,
        output: {
          model: input.model,
          querySha256: input.querySha256,
          candidateSetSha256: input.candidateSetSha256,
          candidates: normalizeResponse(payload, input)
        }
      })
    }
  }
  return Object.freeze(processor)
}

export function rerankProcessorsForConfig(config) {
  if (!config) return Object.freeze([])
  try {
    const normalizedConfig = normalizeConfig(config)
    return Object.freeze([Object.freeze({
      taskType: RAG_RERANK_TASK_TYPE,
      processorVersion: RAG_RERANK_PROCESSOR_VERSION,
      executionClass: RAG_RERANK_EXECUTION_CLASS,
      outputSchemaVersion: RAG_RERANK_OUTPUT_SCHEMA_VERSION,
      model: localModelIdentity(normalizedConfig)
    })])
  } catch {
    return Object.freeze([])
  }
}

export { LOCAL_MODEL as RAG_RERANK_MODEL }
export default createRagRerankProcessor
