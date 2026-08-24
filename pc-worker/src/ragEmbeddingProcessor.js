import crypto from 'node:crypto'

export const RAG_EMBEDDING_PROCESSOR_VERSION = 'v1'
export const RAG_EMBEDDING_EXECUTION_CLASS = 'gpu'
export const RAG_EMBEDDING_OUTPUT_SCHEMA_VERSION = 1
export const RAG_EMBEDDING_TASK_TYPE = 'rag.embedding.generate'
export const RAG_QUERY_EMBED_TASK_TYPE = 'rag.query.embed'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u
const MAX_QUERY_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export class RagEmbeddingProcessorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RagEmbeddingProcessorError'
    this.code = code
  }
}

function fail(code, message = code) {
  throw new RagEmbeddingProcessorError(code, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed, fieldName, errorCode = 'WORKER_EMBEDDING_INPUT_INVALID') {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(errorCode, `${fieldName} is invalid.`)
  }
}

function requiredText(value, fieldName, maxBytes = 512) {
  if (typeof value !== 'string') fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function token(value, fieldName, maxBytes = 512) {
  const normalized = requiredText(value, fieldName, maxBytes)
  if (!TOKEN_PATTERN.test(normalized)) fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function hash(value, fieldName) {
  const normalized = requiredText(value, fieldName, 64).toLowerCase()
  if (!HASH_PATTERN.test(normalized)) fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function embeddingText(value, fieldName, maxBytes) {
  if (typeof value !== 'string') fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function finite(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('WORKER_EMBEDDING_RESULT_INVALID', `${fieldName} is not finite.`)
  return value
}

function positiveInteger(value, fieldName, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  return value
}

function nonNegativeInteger(value, fieldName, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('WORKER_EMBEDDING_INPUT_INVALID', `${fieldName} is invalid.`)
  return value
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze))
  if (isPlainObject(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])))
  return value
}

function modelIdentity(value, fieldName) {
  exactKeys(value, ['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit', 'distance', 'normalization', 'instruction', 'configHash'], fieldName)
  const provider = token(value.provider, `${fieldName}.provider`)
  const modelId = requiredText(value.modelId, `${fieldName}.modelId`)
  const modelRevision = requiredText(value.modelRevision, `${fieldName}.modelRevision`)
  const dimensions = positiveInteger(value.dimensions, `${fieldName}.dimensions`, 65_536)
  const configHash = hash(value.configHash, `${fieldName}.configHash`)
  return freeze({
    provider,
    modelId,
    modelRevision,
    dimensions,
    ...(value.inputLimit === undefined ? {} : { inputLimit: positiveInteger(value.inputLimit, `${fieldName}.inputLimit`, 1_048_576) }),
    ...(value.distance === undefined ? {} : { distance: token(value.distance, `${fieldName}.distance`, 32) }),
    ...(value.normalization === undefined ? {} : { normalization: token(value.normalization, `${fieldName}.normalization`, 32) }),
    ...(value.instruction === undefined ? {} : { instruction: requiredText(value.instruction, `${fieldName}.instruction`, 4096) }),
    configHash
  })
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

function assertLocalModel(value, config) {
  const model = modelIdentity(value, 'task.input.model')
  for (const field of ['distance', 'normalization', 'instruction']) {
    if (Object.hasOwn(model, field)) fail('WORKER_EMBEDDING_MODEL_MISMATCH', 'Task model identity does not match local configuration.')
  }
  if (model.provider !== config.provider || model.modelId !== config.modelId ||
      model.modelRevision !== config.modelRevision || model.dimensions !== config.dimensions ||
      model.configHash !== config.configHash ||
      (model.inputLimit !== undefined && model.inputLimit !== config.inputLimit)) {
    fail('WORKER_EMBEDDING_MODEL_MISMATCH', 'Task model identity does not match local configuration.')
  }
  return model
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) fail('WORKER_EMBEDDING_NOT_CONFIGURED', 'Embedding processor is not configured.')
  const baseUrl = requiredText(raw.baseUrl, 'embedding.baseUrl', 2048)
  let parsed
  try { parsed = new URL(baseUrl) } catch { fail('WORKER_EMBEDDING_NOT_CONFIGURED', 'Embedding endpoint is invalid.') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) {
    fail('WORKER_EMBEDDING_NOT_CONFIGURED', 'Embedding endpoint is not safe.')
  }
  const provider = token(raw.provider, 'embedding.provider')
  const modelId = requiredText(raw.modelId, 'embedding.modelId')
  const modelRevision = requiredText(raw.modelRevision, 'embedding.modelRevision')
  const dimensions = positiveInteger(raw.dimensions, 'embedding.dimensions', 65_536)
  const inputLimit = positiveInteger(raw.inputLimit, 'embedding.inputLimit', 1_048_576)
  const maxBatchItems = positiveInteger(raw.maxBatchItems, 'embedding.maxBatchItems', 256)
  const maxInputBytes = positiveInteger(raw.maxInputBytes, 'embedding.maxInputBytes', 8 * 1024 * 1024)
  const timeoutMs = positiveInteger(raw.timeoutMs, 'embedding.timeoutMs', 5 * 60_000)
  const configHash = hash(raw.configHash, 'embedding.configHash')
  return freeze({
    baseUrl: parsed.toString().replace(/\/$/u, ''),
    provider, modelId, modelRevision, dimensions, inputLimit,
    maxBatchItems, maxInputBytes, timeoutMs, configHash,
    apiKey: raw.apiKey === null || raw.apiKey === undefined ? null : requiredText(raw.apiKey, 'embedding.apiKey', 4096)
  })
}

function endpointFor(config) {
  const endpoint = new URL(config.baseUrl)
  const pathname = endpoint.pathname.replace(/\/$/u, '')
  if (!pathname.endsWith('/embeddings')) endpoint.pathname = pathname.endsWith('/v1') ? `${pathname}/embeddings` : `${pathname}/v1/embeddings`
  return endpoint.toString()
}

function vectorHash(vectors) {
  return crypto.createHash('sha256').update(JSON.stringify(vectors.map((vector) => vector.embedding))).digest('hex')
}

function assertText(value, fieldName, maxBytes) {
  const text = embeddingText(value, fieldName, maxBytes)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('WORKER_EMBEDDING_INPUT_TOO_LARGE', `${fieldName} exceeds the configured limit.`)
  return text
}

function normalizeTask(task, config) {
  if (!isPlainObject(task) || !['v1', RAG_EMBEDDING_PROCESSOR_VERSION].includes(task.processorVersion) ||
      task.executionClass !== RAG_EMBEDDING_EXECUTION_CLASS ||
      ![RAG_EMBEDDING_TASK_TYPE, RAG_QUERY_EMBED_TASK_TYPE].includes(task.taskType)) {
    fail('WORKER_EMBEDDING_TASK_INVALID', 'Task processor identity is invalid.')
  }
  const input = task.input
  if (task.taskType === RAG_QUERY_EMBED_TASK_TYPE) {
    exactKeys(input, ['schemaVersion', 'querySha256', 'query', 'model'], 'task.input')
    if (input.schemaVersion !== 1) fail('WORKER_EMBEDDING_INPUT_INVALID', 'task.input.schemaVersion is invalid.')
    const query = assertText(input.query, 'task.input.query', Math.min(MAX_QUERY_BYTES, config.maxInputBytes))
    return freeze({ taskType: task.taskType, querySha256: hash(input.querySha256, 'task.input.querySha256'), query, model: assertLocalModel(input.model, config) })
  }
  exactKeys(input, [
    'schemaVersion', 'snapshotId', 'sourceType', 'sourceId', 'sourceVersionId',
    'sourceContentSha256', 'contentBytes', 'model', 'chunks'
  ], 'task.input')
  if (input.schemaVersion !== 1) fail('WORKER_EMBEDDING_INPUT_INVALID', 'task.input.schemaVersion is invalid.')
  const snapshotId = positiveInteger(input.snapshotId, 'task.input.snapshotId')
  const model = assertLocalModel(input.model, config)
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > config.maxBatchItems) {
    fail('WORKER_EMBEDDING_BATCH_INVALID', 'task.input.chunks exceeds the configured batch limit.')
  }
  const chunks = input.chunks.map((chunk, index) => {
    exactKeys(chunk, ['chunkId', 'ordinal', 'chunkSha256', 'body'], `task.input.chunks[${index}]`)
    return freeze({
      chunkId: positiveInteger(chunk.chunkId, `task.input.chunks[${index}].chunkId`),
      ordinal: nonNegativeInteger(chunk.ordinal, `task.input.chunks[${index}].ordinal`),
      chunkSha256: hash(chunk.chunkSha256, `task.input.chunks[${index}].chunkSha256`),
      body: assertText(chunk.body, `task.input.chunks[${index}].body`, config.maxInputBytes)
    })
  })
  if (new Set(chunks.map((chunk) => chunk.chunkId)).size !== chunks.length) fail('WORKER_EMBEDDING_BATCH_INVALID', 'Task chunks contain duplicate IDs.')
  const normalized = { taskType: task.taskType, snapshotId, model, chunks }
  const sourceFields = ['sourceType', 'sourceId', 'sourceVersionId', 'sourceContentSha256', 'contentBytes']
  if (input.sourceType === undefined && sourceFields.some((field) => input[field] !== undefined)) {
    fail('WORKER_EMBEDDING_INPUT_INVALID', 'Task source identity is incomplete.')
  }
  for (const field of ['sourceType', 'sourceId', 'sourceVersionId', 'sourceContentSha256', 'contentBytes']) {
    if (input[field] !== undefined) normalized[field] = input[field]
  }
  if (normalized.sourceType !== undefined) {
    if (!['document', 'ebook', 'code_repository'].includes(normalized.sourceType)) fail('WORKER_EMBEDDING_INPUT_INVALID', 'task.input.sourceType is invalid.')
    normalized.sourceId = positiveInteger(normalized.sourceId, 'task.input.sourceId')
    normalized.sourceVersionId = token(normalized.sourceVersionId, 'task.input.sourceVersionId', 128)
    normalized.sourceContentSha256 = hash(normalized.sourceContentSha256, 'task.input.sourceContentSha256')
    normalized.contentBytes = nonNegativeInteger(normalized.contentBytes, 'task.input.contentBytes')
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
  if (serializedBytes > config.maxInputBytes) fail('WORKER_EMBEDDING_INPUT_TOO_LARGE', 'Task batch exceeds the configured byte limit.')
  return freeze(normalized)
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController()
  let timer
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else if (signal) signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => controller.abort(new RagEmbeddingProcessorError('WORKER_EMBEDDING_TIMEOUT', 'Embedding request timed out.')), timeoutMs)
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
    const finish = (callback, result) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(result)
    }
    const onAbort = () => finish(reject, signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error)
    )
  })
}

async function requestEmbeddings({ config, texts, fetchImpl, signal }) {
  const timeout = timeoutSignal(signal, config.timeoutMs)
  try {
    if (timeout.signal.aborted) {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Embedding request was cancelled.')
      fail('WORKER_EMBEDDING_TIMEOUT', 'Embedding request timed out.')
    }
    const headers = { accept: 'application/json', 'content-type': 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    let response
    try {
      response = await awaitAbortable(Promise.resolve().then(() => fetchImpl(endpointFor(config), {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.modelId, input: texts.length === 1 ? texts[0] : texts, encoding_format: 'float' }),
        signal: timeout.signal
      })), timeout.signal)
    } catch (error) {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Embedding request was cancelled.')
      if (timeout.signal.aborted) fail('WORKER_EMBEDDING_TIMEOUT', 'Embedding request timed out.')
      fail('WORKER_EMBEDDING_UNAVAILABLE', 'Embedding endpoint is unavailable.')
    }
    if (!response || !response.ok) fail('WORKER_EMBEDDING_HTTP_FAILED', 'Embedding endpoint rejected the request.')
    const contentLength = Number(response.headers?.get?.('content-length'))
    if (Number.isSafeInteger(contentLength) && contentLength > MAX_OUTPUT_BYTES) {
      fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response exceeds its byte limit.')
    }
    let payload
    try { payload = await awaitAbortable(response.json(), timeout.signal) } catch (error) {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED', 'Embedding request was cancelled.')
      if (timeout.signal.aborted) fail('WORKER_EMBEDDING_TIMEOUT', 'Embedding request timed out.')
      fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response is invalid.')
    }
    let serialized
    try { serialized = JSON.stringify(payload) } catch { fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response is invalid.') }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_BYTES) {
      fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response exceeds its byte limit.')
    }
    return payload
  } finally {
    timeout.dispose()
  }
}

function normalizeResponse(payload, count, config) {
  if (!isPlainObject(payload) || payload.model !== config.modelId || !Array.isArray(payload.data) || payload.data.length !== count) {
    fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response model or count is invalid.')
  }
  const ordered = [...payload.data].sort((left, right) => Number(left?.index) - Number(right?.index))
  const embeddings = ordered.map((item, index) => {
    exactKeys(item, ['index', 'embedding', 'object'], `embedding.data[${index}]`, 'WORKER_EMBEDDING_RESPONSE_INVALID')
    if (item.object !== undefined && item.object !== 'embedding') {
      fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response object is invalid.')
    }
    if (item.index !== index || !Array.isArray(item.embedding) || item.embedding.length !== config.dimensions) {
      fail('WORKER_EMBEDDING_RESPONSE_INVALID', 'Embedding response dimensions are invalid.')
    }
    return item.embedding.map((value, valueIndex) => finite(value, `embedding.data[${index}].embedding[${valueIndex}]`))
  })
  return Object.freeze({ embeddings: Object.freeze(embeddings), vectorSha256: vectorHash(embeddings.map((embedding) => ({ embedding }))) })
}

export function createRagEmbeddingProcessor({ config, fetchImpl = fetch } = {}) {
  let normalizedConfig = null
  if (config !== null && config !== undefined) {
    try { normalizedConfig = normalizeConfig(config) } catch (error) {
      if (!(error instanceof RagEmbeddingProcessorError)) throw error
    }
  }
  const processor = {
    configured: normalizedConfig !== null,
    supports(taskType) {
      return normalizedConfig !== null && [RAG_EMBEDDING_TASK_TYPE, RAG_QUERY_EMBED_TASK_TYPE].includes(taskType)
    },
    async process(task, { signal } = {}) {
      if (!normalizedConfig) fail('WORKER_EMBEDDING_NOT_CONFIGURED', 'Embedding processor is not configured.')
      const input = normalizeTask(task, normalizedConfig)
      const texts = input.taskType === RAG_QUERY_EMBED_TASK_TYPE ? [input.query] : input.chunks.map((chunk) => chunk.body)
      const payload = await requestEmbeddings({ config: normalizedConfig, texts, fetchImpl, signal })
      const response = normalizeResponse(payload, texts.length, normalizedConfig)
      const model = localModelIdentity(normalizedConfig)
      if (input.taskType === RAG_QUERY_EMBED_TASK_TYPE) {
        return freeze({
          schemaVersion: RAG_EMBEDDING_OUTPUT_SCHEMA_VERSION,
          processorVersion: RAG_EMBEDDING_PROCESSOR_VERSION,
          output: { model, querySha256: input.querySha256, embedding: response.embeddings[0], vectorSha256: response.vectorSha256 }
        })
      }
      const vectors = input.chunks.map((chunk, index) => ({ chunkId: chunk.chunkId, chunkSha256: chunk.chunkSha256, embedding: response.embeddings[index] }))
      return freeze({
        schemaVersion: RAG_EMBEDDING_OUTPUT_SCHEMA_VERSION,
        processorVersion: RAG_EMBEDDING_PROCESSOR_VERSION,
        output: {
          model,
          snapshotId: input.snapshotId,
          ...(input.sourceVersionId === undefined ? {} : {
            sourceVersionId: input.sourceVersionId,
            sourceContentSha256: input.sourceContentSha256
          }),
          vectors,
          vectorSha256: response.vectorSha256
        }
      })
    }
  }
  return Object.freeze(processor)
}

export function embeddingProcessorsForConfig(config) {
  if (!config) return Object.freeze([])
  try { normalizeConfig(config) } catch { return Object.freeze([]) }
  return Object.freeze([
    Object.freeze({ taskType: RAG_EMBEDDING_TASK_TYPE, processorVersion: RAG_EMBEDDING_PROCESSOR_VERSION, executionClass: RAG_EMBEDDING_EXECUTION_CLASS, outputSchemaVersion: RAG_EMBEDDING_OUTPUT_SCHEMA_VERSION }),
    Object.freeze({ taskType: RAG_QUERY_EMBED_TASK_TYPE, processorVersion: RAG_EMBEDDING_PROCESSOR_VERSION, executionClass: RAG_EMBEDDING_EXECUTION_CLASS, outputSchemaVersion: RAG_EMBEDDING_OUTPUT_SCHEMA_VERSION })
  ])
}

export default createRagEmbeddingProcessor
