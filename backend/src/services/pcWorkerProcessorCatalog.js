import crypto from 'node:crypto'

import { normalizeContentInspectionResult } from './pcWorkerContract.js'

export const PC_WORKER_PROCESSOR_CATALOG_VERSION = 'v1'

const PC_WORKER_TASK_TYPE = 'content.inspect'
const PC_WORKER_PROCESSOR_VERSION = 'v1'
const PC_WORKER_EXECUTION_CLASS = 'gpu'
const PC_WORKER_OUTPUT_SCHEMA_VERSION = 1

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u
const SOURCE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER
const MAX_QUERY_BYTES = 64 * 1024
const MAX_REASON_BYTES = 128
const MAX_CITATION_ID_BYTES = 128

const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const FORMATS = new Set(['markdown', 'html', 'txt', 'ebook', 'repository_document'])
const DISTANCES = new Set(['cosine', 'dot', 'euclid'])
const NORMALIZATIONS = new Set(['none', 'l2'])

const LIMITS = Object.freeze({
  contentInspect: Object.freeze({ inputMaxBytes: 64 * 1024 * 1024, outputMaxBytes: 64 * 1024, maxBatchItems: 1 }),
  contentExtract: Object.freeze({ inputMaxBytes: 64 * 1024 * 1024, outputMaxBytes: 16 * 1024 * 1024, maxBatchItems: 1 }),
  embeddingGenerate: Object.freeze({ inputMaxBytes: 8 * 1024 * 1024, outputMaxBytes: 16 * 1024 * 1024, maxBatchItems: 256 }),
  queryEmbed: Object.freeze({ inputMaxBytes: MAX_QUERY_BYTES, outputMaxBytes: 512 * 1024, maxBatchItems: 1 }),
  rerank: Object.freeze({ inputMaxBytes: 2 * 1024 * 1024, outputMaxBytes: 512 * 1024, maxBatchItems: 256 }),
  answer: Object.freeze({ inputMaxBytes: 2 * 1024 * 1024, outputMaxBytes: 256 * 1024, maxBatchItems: 1 })
})

export class PcWorkerProcessorCatalogError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PcWorkerProcessorCatalogError'
    this.code = code
  }
}

function fail(code, message = code) {
  throw new PcWorkerProcessorCatalogError(code, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, allowed, fieldName) {
  if (!isPlainObject(value)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} must be an object.`)
  const keySet = new Set(allowed)
  if (Object.keys(value).some((key) => !keySet.has(key))) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} contains unsupported fields.`)
  }
}

function requiredText(value, fieldName, maxBytes = 512) {
  if (typeof value !== 'string') fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function token(value, fieldName, maxBytes = 512) {
  const normalized = requiredText(value, fieldName, maxBytes)
  if (!TOKEN_PATTERN.test(normalized)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function hash(value, fieldName) {
  const normalized = requiredText(value, fieldName, 64).toLowerCase()
  if (!HASH_PATTERN.test(normalized)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function normalizeHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value.toLowerCase()) ? value.toLowerCase() : null
}

function sourceVersion(value, fieldName) {
  const normalized = requiredText(value, fieldName, 128)
  if (!SOURCE_VERSION_PATTERN.test(normalized)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function positiveInteger(value, fieldName, max = MAX_SAFE_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return value
}

function nonNegativeInteger(value, fieldName, max = MAX_SAFE_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return value
}

function finiteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('PC_WORKER_PROCESSOR_RESULT_INVALID', `${fieldName} must be finite.`)
  }
  return value
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function boundedText(value, fieldName, maxBytes) {
  const normalized = requiredText(value, fieldName, maxBytes)
  if (byteLength(normalized) > maxBytes) fail('PC_WORKER_PROCESSOR_INPUT_TOO_LARGE', `${fieldName} exceeds its limit.`)
  return normalized
}

function boundedContentText(value, fieldName, maxBytes) {
  if (typeof value !== 'string') fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  if (byteLength(normalized) > maxBytes) fail('PC_WORKER_PROCESSOR_INPUT_TOO_LARGE', `${fieldName} exceeds its limit.`)
  return normalized
}

function vectorSha256(vectors) {
  return crypto.createHash('sha256').update(JSON.stringify(vectors.map((vector) => vector.embedding))).digest('hex')
}

function boundedOutputText(value, fieldName, maxBytes) {
  if (typeof value !== 'string' || byteLength(value) > maxBytes || /[\u0000]/u.test(value)) {
    fail('PC_WORKER_PROCESSOR_RESULT_INVALID', `${fieldName} exceeds its limit.`)
  }
  return value.normalize('NFKC')
}

function assertSerializedBytes(value, maxBytes, code) {
  let serialized
  try { serialized = JSON.stringify(value) } catch { fail(code, 'value cannot be serialized.') }
  if (typeof serialized !== 'string' || byteLength(serialized) > maxBytes) fail(code, 'value exceeds its byte limit.')
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze))
  if (isPlainObject(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])))
  return value
}

function modelIdentity(value, fieldName = 'model') {
  exactKeys(value, [
    'provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit',
    'distance', 'normalization', 'instruction', 'configHash'
  ], fieldName)
  const dimensions = positiveInteger(value.dimensions, `${fieldName}.dimensions`, 65_536)
  const inputLimit = value.inputLimit === undefined
    ? undefined
    : positiveInteger(value.inputLimit, `${fieldName}.inputLimit`, 1_048_576)
  const distance = value.distance === undefined ? undefined : token(value.distance, `${fieldName}.distance`, 32)
  const normalization = value.normalization === undefined
    ? undefined
    : token(value.normalization, `${fieldName}.normalization`, 32)
  if (distance !== undefined && !DISTANCES.has(distance)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName}.distance is invalid.`)
  if (normalization !== undefined && !NORMALIZATIONS.has(normalization)) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName}.normalization is invalid.`)
  }
  const normalized = {
    provider: token(value.provider, `${fieldName}.provider`),
    modelId: requiredText(value.modelId, `${fieldName}.modelId`, 512),
    modelRevision: requiredText(value.modelRevision, `${fieldName}.modelRevision`, 256),
    dimensions,
    ...(inputLimit === undefined ? {} : { inputLimit }),
    ...(distance === undefined ? {} : { distance }),
    ...(normalization === undefined ? {} : { normalization }),
    ...(value.instruction === undefined ? {} : { instruction: boundedText(value.instruction, `${fieldName}.instruction`, 4096) }),
    configHash: hash(value.configHash, `${fieldName}.configHash`)
  }
  return freeze(normalized)
}

function modelMatches(actual, expected) {
  if (!isPlainObject(actual) || !isPlainObject(expected)) return false
  try {
    const left = modelIdentity(actual, 'actualModel')
    const right = modelIdentity(expected, 'expectedModel')
    const keys = new Set(['provider', 'modelId', 'modelRevision', 'dimensions', 'configHash'])
    for (const key of ['inputLimit', 'distance', 'normalization', 'instruction']) {
      if (Object.hasOwn(right, key)) keys.add(key)
    }
    return [...keys].every((key) => left[key] === right[key])
  } catch {
    return false
  }
}

function sourceIdentity(value, fieldName = 'input') {
  exactKeys(value, [
    'sourceType', 'sourceId', 'sourceVersionId', 'sourceContentSha256', 'contentBytes', 'format'
  ], fieldName)
  if (!SOURCE_TYPES.has(value.sourceType)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName}.sourceType is invalid.`)
  const normalized = {
    sourceType: value.sourceType,
    sourceId: positiveInteger(value.sourceId, `${fieldName}.sourceId`),
    sourceVersionId: sourceVersion(value.sourceVersionId, `${fieldName}.sourceVersionId`),
    sourceContentSha256: hash(value.sourceContentSha256, `${fieldName}.sourceContentSha256`),
    contentBytes: nonNegativeInteger(value.contentBytes, `${fieldName}.contentBytes`)
  }
  if (value.format !== undefined) {
    const format = token(value.format, `${fieldName}.format`, 64).toLowerCase()
    if (!FORMATS.has(format)) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', `${fieldName}.format is invalid.`)
    normalized.format = format
  }
  return freeze(normalized)
}

function projectContentInspectInput(input) {
  exactKeys(input, ['schemaVersion', 'resourceVersionId', 'contentObjectId'], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  return freeze({
    schemaVersion: 1,
    resourceVersionId: positiveInteger(input.resourceVersionId, 'task.input.resourceVersionId'),
    contentObjectId: positiveInteger(input.contentObjectId, 'task.input.contentObjectId')
  })
}

function projectContentExtractInput(input) {
  exactKeys(input, [
    'schemaVersion', 'sourceType', 'sourceId', 'sourceVersionId', 'sourceContentSha256', 'contentBytes', 'format'
  ], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  const projected = freeze({ schemaVersion: 1, ...sourceIdentity(input, 'task.input') })
  assertSerializedBytes(projected, LIMITS.contentExtract.inputMaxBytes, 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE')
  return projected
}

function projectEmbeddingInput(input) {
  exactKeys(input, [
    'schemaVersion', 'snapshotId', 'sourceType', 'sourceId', 'sourceVersionId',
    'sourceContentSha256', 'contentBytes', 'model', 'chunks'
  ], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  const snapshotId = positiveInteger(input.snapshotId, 'task.input.snapshotId')
  const model = modelIdentity(input.model, 'task.input.model')
  if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > LIMITS.embeddingGenerate.maxBatchItems) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.chunks exceeds its batch limit.')
  }
  const chunks = input.chunks.map((chunk, index) => {
    exactKeys(chunk, ['chunkId', 'ordinal', 'chunkSha256', 'body'], `task.input.chunks[${index}]`)
    return freeze({
      chunkId: positiveInteger(chunk.chunkId, `task.input.chunks[${index}].chunkId`),
      ordinal: nonNegativeInteger(chunk.ordinal, `task.input.chunks[${index}].ordinal`),
      chunkSha256: hash(chunk.chunkSha256, `task.input.chunks[${index}].chunkSha256`),
      body: boundedContentText(chunk.body, `task.input.chunks[${index}].body`, LIMITS.embeddingGenerate.inputMaxBytes)
    })
  })
  const ids = new Set(chunks.map((chunk) => chunk.chunkId))
  if (ids.size !== chunks.length) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.chunks contains duplicate IDs.')
  const identity = input.sourceType === undefined
    ? {}
    : sourceIdentity({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      sourceContentSha256: input.sourceContentSha256,
      contentBytes: Number.isSafeInteger(input.contentBytes) ? input.contentBytes : 0
    }, 'task.input')
  const projected = freeze({ schemaVersion: 1, snapshotId, ...identity, model, chunks })
  assertSerializedBytes(projected, LIMITS.embeddingGenerate.inputMaxBytes, 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE')
  return projected
}

function projectQueryEmbedInput(input) {
  exactKeys(input, ['schemaVersion', 'querySha256', 'query', 'model'], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  const query = boundedContentText(input.query, 'task.input.query', MAX_QUERY_BYTES)
  const projected = freeze({ schemaVersion: 1, querySha256: hash(input.querySha256, 'task.input.querySha256'), query, model: modelIdentity(input.model, 'task.input.model') })
  assertSerializedBytes(projected, LIMITS.queryEmbed.inputMaxBytes, 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE')
  return projected
}

function projectRerankInput(input) {
  exactKeys(input, ['schemaVersion', 'querySha256', 'query', 'model', 'candidates'], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  const query = boundedText(input.query, 'task.input.query', MAX_QUERY_BYTES)
  const model = modelIdentity(input.model, 'task.input.model')
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > LIMITS.rerank.maxBatchItems) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.candidates exceeds its batch limit.')
  }
  const candidates = input.candidates.map((candidate, index) => {
    exactKeys(candidate, ['candidateId', 'text', 'score'], `task.input.candidates[${index}]`)
    const normalized = {
      candidateId: token(candidate.candidateId, `task.input.candidates[${index}].candidateId`, 128),
      text: boundedText(candidate.text, `task.input.candidates[${index}].text`, LIMITS.rerank.inputMaxBytes)
    }
    if (candidate.score !== undefined) normalized.score = finiteNumber(candidate.score, `task.input.candidates[${index}].score`)
    return freeze(normalized)
  })
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.candidates contains duplicate IDs.')
  }
  const projected = freeze({ schemaVersion: 1, querySha256: hash(input.querySha256, 'task.input.querySha256'), query, model, candidates })
  assertSerializedBytes(projected, LIMITS.rerank.inputMaxBytes, 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE')
  return projected
}

function projectAnswerInput(input) {
  exactKeys(input, ['schemaVersion', 'querySha256', 'query', 'model', 'evidence'], 'task.input')
  if (input.schemaVersion !== 1) fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.schemaVersion is unsupported.')
  const query = boundedText(input.query, 'task.input.query', MAX_QUERY_BYTES)
  const model = modelIdentity(input.model, 'task.input.model')
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 64) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.evidence exceeds its batch limit.')
  }
  const evidence = input.evidence.map((item, index) => {
    exactKeys(item, ['citationId', 'text'], `task.input.evidence[${index}]`)
    return freeze({
      citationId: token(item.citationId, `task.input.evidence[${index}].citationId`, MAX_CITATION_ID_BYTES),
      text: boundedText(item.text, `task.input.evidence[${index}].text`, LIMITS.answer.inputMaxBytes)
    })
  })
  if (new Set(evidence.map((item) => item.citationId)).size !== evidence.length) {
    fail('PC_WORKER_PROCESSOR_INPUT_INVALID', 'task.input.evidence contains duplicate citation IDs.')
  }
  const projected = freeze({ schemaVersion: 1, querySha256: hash(input.querySha256, 'task.input.querySha256'), query, model, evidence })
  assertSerializedBytes(projected, LIMITS.answer.inputMaxBytes, 'PC_WORKER_PROCESSOR_INPUT_TOO_LARGE')
  return projected
}

function unwrapExpected(expected) {
  if (isPlainObject(expected) && isPlainObject(expected.input)) return expected.input
  return expected
}

function normalizeEnvelope(value, normalizeOutput, expected, maxOutputBytes) {
  exactKeys(value, ['schemaVersion', 'processorVersion', 'output'], 'result')
  if (value.schemaVersion !== 1 || value.processorVersion !== PC_WORKER_PROCESSOR_VERSION) {
    fail('PC_WORKER_PROCESSOR_RESULT_SCHEMA_INVALID', 'result schema or processor version is invalid.')
  }
  const output = normalizeOutput(value.output, expected)
  assertSerializedBytes(output, maxOutputBytes, 'PC_WORKER_PROCESSOR_RESULT_TOO_LARGE')
  return freeze({ schemaVersion: 1, processorVersion: PC_WORKER_PROCESSOR_VERSION, output })
}

function normalizeContentInspectResult(value, expected) {
  const normalized = normalizeContentInspectionResult(value, expected)
  assertSerializedBytes(normalized, LIMITS.contentInspect.outputMaxBytes, 'PC_WORKER_PROCESSOR_RESULT_TOO_LARGE')
  return normalized
}

function normalizeModelOutput(output, expectedModel, fieldName = 'result.output.model') {
  const model = modelIdentity(output, fieldName)
  if (expectedModel && !modelMatches(model, expectedModel)) fail('PC_WORKER_PROCESSOR_RESULT_MODEL_MISMATCH', `${fieldName} is stale.`)
  return model
}

function normalizeContentExtractResult(value, expected) {
  exactKeys(value, [
    'sourceVersionId', 'sourceContentSha256', 'extractorVersion', 'artifactSha256',
    'artifactBytes', 'sectionCount', 'manifest'
  ], 'result.output')
  const input = unwrapExpected(expected)
  const sourceVersionId = sourceVersion(value.sourceVersionId, 'result.output.sourceVersionId')
  const sourceContentSha256 = hash(value.sourceContentSha256, 'result.output.sourceContentSha256')
  if (input && (sourceVersionId !== input.sourceVersionId || sourceContentSha256 !== input.sourceContentSha256)) {
    fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result source identity is stale.')
  }
  const normalized = {
    sourceVersionId,
    sourceContentSha256,
    extractorVersion: token(value.extractorVersion, 'result.output.extractorVersion'),
    artifactSha256: hash(value.artifactSha256, 'result.output.artifactSha256'),
    artifactBytes: nonNegativeInteger(value.artifactBytes, 'result.output.artifactBytes', LIMITS.contentExtract.outputMaxBytes),
    sectionCount: positiveInteger(value.sectionCount, 'result.output.sectionCount', 100_000)
  }
  if (value.manifest !== undefined) {
    exactKeys(value.manifest, ['artifactSha256', 'artifactBytes', 'sectionCount'], 'result.output.manifest')
    if (hash(value.manifest.artifactSha256, 'result.output.manifest.artifactSha256') !== normalized.artifactSha256 ||
        value.manifest.artifactBytes !== normalized.artifactBytes || value.manifest.sectionCount !== normalized.sectionCount) {
      fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'result manifest does not match output.')
    }
    normalized.manifest = freeze({
      artifactSha256: normalized.artifactSha256,
      artifactBytes: normalized.artifactBytes,
      sectionCount: normalized.sectionCount
    })
  }
  return freeze(normalized)
}

function expectedModelFrom(expected) {
  const input = unwrapExpected(expected)
  return input?.model
}

function normalizeEmbeddingResult(value, expected) {
  exactKeys(value, ['model', 'snapshotId', 'sourceVersionId', 'sourceContentSha256', 'vectors', 'vectorSha256'], 'result.output')
  const input = unwrapExpected(expected)
  const model = normalizeModelOutput(value.model, expectedModelFrom(expected))
  const vectors = value.vectors
  if (!Array.isArray(vectors) || vectors.length !== input?.chunks?.length || vectors.length > LIMITS.embeddingGenerate.maxBatchItems) {
    fail('PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID', 'result vectors count does not match the input batch.')
  }
  const inputById = new Map(input.chunks.map((chunk) => [chunk.chunkId, chunk]))
  const seen = new Set()
  const normalizedVectors = vectors.map((vector, index) => {
    exactKeys(vector, ['chunkId', 'chunkSha256', 'embedding'], `result.output.vectors[${index}]`)
    const chunkId = positiveInteger(vector.chunkId, `result.output.vectors[${index}].chunkId`)
    if (seen.has(chunkId) || !inputById.has(chunkId)) fail('PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH', 'result vector identity is invalid.')
    seen.add(chunkId)
    const chunkSha256 = hash(vector.chunkSha256, `result.output.vectors[${index}].chunkSha256`)
    const expectedChunk = inputById.get(chunkId)
    if (chunkSha256 !== expectedChunk.chunkSha256 || !Array.isArray(vector.embedding) ||
        vector.embedding.length !== model.dimensions) {
      fail('PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH', 'result vector identity or dimensions are invalid.')
    }
    const embedding = vector.embedding.map((item, itemIndex) => finiteNumber(item, `result.output.vectors[${index}].embedding[${itemIndex}]`))
    return freeze({ chunkId, chunkSha256, embedding })
  })
  if (seen.size !== input.chunks.length) fail('PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID', 'result vectors are incomplete.')
  const vectorHash = hash(value.vectorSha256, 'result.output.vectorSha256')
  if (vectorHash !== vectorSha256(normalizedVectors)) {
    fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'result vector hash does not match the ordered vectors.')
  }
  const normalized = { model, vectors: normalizedVectors, vectorSha256: vectorHash }
  if (value.snapshotId !== undefined) normalized.snapshotId = positiveInteger(value.snapshotId, 'result.output.snapshotId')
  if (value.sourceVersionId !== undefined) normalized.sourceVersionId = sourceVersion(value.sourceVersionId, 'result.output.sourceVersionId')
  if (value.sourceContentSha256 !== undefined) normalized.sourceContentSha256 = hash(value.sourceContentSha256, 'result.output.sourceContentSha256')
  if (input) {
    if (normalized.snapshotId !== undefined && normalized.snapshotId !== input.snapshotId) fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result snapshot is stale.')
    if (normalized.sourceVersionId !== undefined && normalized.sourceVersionId !== input.sourceVersionId) fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result source version is stale.')
    if (normalized.sourceContentSha256 !== undefined && normalized.sourceContentSha256 !== input.sourceContentSha256) fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result source hash is stale.')
  }
  return freeze(normalized)
}

function normalizeQueryEmbeddingResult(value, expected) {
  exactKeys(value, ['model', 'querySha256', 'embedding', 'vectorSha256'], 'result.output')
  const input = unwrapExpected(expected)
  const model = normalizeModelOutput(value.model, expectedModelFrom(expected))
  const querySha256 = hash(value.querySha256, 'result.output.querySha256')
  if (input && querySha256 !== input.querySha256) fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result query is stale.')
  if (!Array.isArray(value.embedding) || value.embedding.length !== model.dimensions) {
    fail('PC_WORKER_PROCESSOR_RESULT_DIMENSIONS_INVALID', 'result embedding dimensions are invalid.')
  }
  const embedding = value.embedding.map((item, index) => finiteNumber(item, `result.output.embedding[${index}]`))
  const vectorHash = hash(value.vectorSha256, 'result.output.vectorSha256')
  if (vectorHash !== vectorSha256([{ embedding }])) {
    fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'result vector hash does not match the embedding.')
  }
  return freeze({ model, querySha256, embedding, vectorSha256: vectorHash })
}

function normalizeRerankResult(value, expected) {
  exactKeys(value, ['querySha256', 'candidates'], 'result.output')
  const input = unwrapExpected(expected)
  const querySha256 = hash(value.querySha256, 'result.output.querySha256')
  if (input && querySha256 !== input.querySha256) fail('PC_WORKER_PROCESSOR_RESULT_STALE', 'result query is stale.')
  if (!Array.isArray(value.candidates) || value.candidates.length > LIMITS.rerank.maxBatchItems) {
    fail('PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID', 'result candidates exceed the batch limit.')
  }
  const allowedIds = new Set(input?.candidates?.map((candidate) => candidate.candidateId) ?? [])
  const seen = new Set()
  const candidates = value.candidates.map((candidate, index) => {
    exactKeys(candidate, ['candidateId', 'score'], `result.output.candidates[${index}]`)
    const candidateId = token(candidate.candidateId, `result.output.candidates[${index}].candidateId`, 128)
    if (seen.has(candidateId) || (input && !allowedIds.has(candidateId))) {
      fail('PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH', 'result candidate identity is invalid.')
    }
    seen.add(candidateId)
    return freeze({ candidateId, score: finiteNumber(candidate.score, `result.output.candidates[${index}].score`) })
  })
  return freeze({ querySha256, candidates })
}

function normalizeAnswerResult(value, expected) {
  exactKeys(value, ['answer', 'abstained', 'reasonCode', 'citations'], 'result.output')
  if (typeof value.abstained !== 'boolean') fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'result.output.abstained is invalid.')
  const input = unwrapExpected(expected)
  if (!Array.isArray(value.citations) || value.citations.length > 64) {
    fail('PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID', 'result.output.citations exceeds its limit.')
  }
  const allowedCitations = new Set(input?.evidence?.map((item) => item.citationId) ?? [])
  const citations = value.citations.map((citation, index) => {
    const id = token(citation, `result.output.citations[${index}]`, MAX_CITATION_ID_BYTES)
    if (input && !allowedCitations.has(id)) fail('PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH', 'result citation is not in evidence.')
    return id
  })
  if (new Set(citations).size !== citations.length) fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'result citations contain duplicates.')
  const normalized = {
    abstained: value.abstained,
    citations
  }
  if (value.answer !== undefined) normalized.answer = boundedOutputText(value.answer, 'result.output.answer', LIMITS.answer.outputMaxBytes)
  if (value.reasonCode !== undefined) normalized.reasonCode = token(value.reasonCode, 'result.output.reasonCode', MAX_REASON_BYTES)
  if (!value.abstained && (!Object.hasOwn(normalized, 'answer') || !normalized.answer.trim())) {
    fail('PC_WORKER_PROCESSOR_RESULT_INVALID', 'non-abstained answers require answer text.')
  }
  return freeze(normalized)
}

function resolveProjectedInput(input, project) {
  if (isPlainObject(input) && Object.hasOwn(input, 'input')) {
    exactKeys(input, ['input', 'subjectContentHash', 'subjectBytes'], 'resolveInput context')
    const projected = project(input.input)
    if (input.subjectContentHash !== undefined && Object.hasOwn(projected, 'sourceContentSha256') &&
        hash(input.subjectContentHash, 'subjectContentHash') !== projected.sourceContentSha256) {
      fail('PC_WORKER_PROCESSOR_INPUT_MISMATCH', 'leased content identity does not match input.')
    }
    if (input.subjectBytes !== undefined && Object.hasOwn(projected, 'contentBytes') &&
        nonNegativeInteger(input.subjectBytes, 'subjectBytes') !== projected.contentBytes) {
      fail('PC_WORKER_PROCESSOR_INPUT_MISMATCH', 'leased content byte count does not match input.')
    }
    return projected
  }
  return project(input)
}

function inspectStaleGuard(current, expected) {
  try {
    const left = isPlainObject(current) && isPlainObject(current.input) ? current.input : current
    const right = isPlainObject(expected) && isPlainObject(expected.input) ? expected.input : expected
    const input = projectContentInspectInput({
      schemaVersion: left.schemaVersion ?? 1,
      resourceVersionId: left.resourceVersionId,
      contentObjectId: left.contentObjectId
    })
    const authorized = projectContentInspectInput({
      schemaVersion: right.schemaVersion ?? 1,
      resourceVersionId: right.resourceVersionId,
      contentObjectId: right.contentObjectId
    })
    const leftHash = normalizeHash(current?.sha256 ?? current?.subjectContentHash ?? current?.input?.sha256)
    const rightHash = normalizeHash(expected?.sha256 ?? expected?.subjectContentHash ?? expected?.input?.sha256)
    const leftBytes = current?.bytes ?? current?.input?.bytes
    const rightBytes = expected?.bytes ?? expected?.input?.bytes
    return input.resourceVersionId === authorized.resourceVersionId && input.contentObjectId === authorized.contentObjectId &&
      leftHash !== null && leftHash === rightHash &&
      (leftBytes === undefined || rightBytes === undefined || leftBytes === rightBytes)
  } catch {
    return false
  }
}

function sourceStaleGuard(current, expected) {
  try {
    const left = isPlainObject(current) && isPlainObject(current.input) ? current.input : current
    const right = isPlainObject(expected) && isPlainObject(expected.input) ? expected.input : expected
    if (left.sourceVersionId !== right.sourceVersionId || left.sourceContentSha256 !== right.sourceContentSha256) return false
    if (left.model || right.model) return modelMatches(left.model, right.model)
    return true
  } catch {
    return false
  }
}

function embeddingStaleGuard(current, expected) {
  try {
    const left = isPlainObject(current) && isPlainObject(current.input) ? current.input : current
    const right = isPlainObject(expected) && isPlainObject(expected.input) ? expected.input : expected
    if (left.snapshotId !== right.snapshotId || left.sourceVersionId !== right.sourceVersionId ||
        left.sourceContentSha256 !== right.sourceContentSha256) return false
    return modelMatches(left.model, right.model)
  } catch {
    return false
  }
}

function queryStaleGuard(current, expected) {
  try {
    const left = isPlainObject(current) && isPlainObject(current.input) ? current.input : current
    const right = isPlainObject(expected) && isPlainObject(expected.input) ? expected.input : expected
    return left.querySha256 === right.querySha256 && modelMatches(left.model, right.model)
  } catch {
    return false
  }
}

function rerankStaleGuard(current, expected) {
  return queryStaleGuard(current, expected)
}

function answerStaleGuard(current, expected) {
  return queryStaleGuard(current, expected)
}

function contentInputResolver(context) {
  const projected = resolveProjectedInput(context, projectContentInspectInput)
  if (isPlainObject(context) && Object.hasOwn(context, 'subjectContentHash')) {
    return freeze({ ...projected, sha256: hash(context.subjectContentHash, 'subjectContentHash') })
  }
  return projected
}

function ragInputResolver(project) {
  return (context) => resolveProjectedInput(context, project)
}

function descriptor(definition) {
  return freeze({
    taskType: definition.taskType,
    processorVersion: definition.processorVersion,
    executionClass: definition.executionClass,
    outputSchemaVersion: definition.outputSchemaVersion,
    inputMode: definition.inputMode
  })
}

function definition({ taskType, executionClass, inputMode, limits, projectInput, normalizeResult, resolveInput, staleGuard }) {
  const value = {
    taskType,
    processorVersion: PC_WORKER_PROCESSOR_VERSION,
    executionClass,
    outputSchemaVersion: PC_WORKER_OUTPUT_SCHEMA_VERSION,
    inputMode,
    limits,
    inputMaxBytes: limits.inputMaxBytes,
    outputMaxBytes: limits.outputMaxBytes,
    maxBatchItems: limits.maxBatchItems,
    projectInput,
    normalizeResult,
    resolveInput,
    staleGuard
  }
  return freeze(value)
}

const CONTENT_INSPECT = definition({
  taskType: PC_WORKER_TASK_TYPE,
  executionClass: PC_WORKER_EXECUTION_CLASS,
  inputMode: 'leased-content-stream',
  limits: LIMITS.contentInspect,
  projectInput: projectContentInspectInput,
  normalizeResult: normalizeContentInspectResult,
  resolveInput: contentInputResolver,
  staleGuard: inspectStaleGuard
})

const CONTENT_EXTRACT = definition({
  taskType: 'rag.content.extract',
  executionClass: 'cpu',
  inputMode: 'leased-content-stream',
  limits: LIMITS.contentExtract,
  projectInput: projectContentExtractInput,
  normalizeResult: (value, expected) => normalizeEnvelope(value, normalizeContentExtractResult, expected, LIMITS.contentExtract.outputMaxBytes),
  resolveInput: ragInputResolver(projectContentExtractInput),
  staleGuard: sourceStaleGuard
})

const EMBEDDING_GENERATE = definition({
  taskType: 'rag.embedding.generate',
  executionClass: 'gpu',
  inputMode: 'leased-chunk-batch',
  limits: LIMITS.embeddingGenerate,
  projectInput: projectEmbeddingInput,
  normalizeResult: (value, expected) => normalizeEnvelope(value, normalizeEmbeddingResult, expected, LIMITS.embeddingGenerate.outputMaxBytes),
  resolveInput: ragInputResolver(projectEmbeddingInput),
  staleGuard: embeddingStaleGuard
})

const QUERY_EMBED = definition({
  taskType: 'rag.query.embed',
  executionClass: 'gpu',
  inputMode: 'bounded-query',
  limits: LIMITS.queryEmbed,
  projectInput: projectQueryEmbedInput,
  normalizeResult: (value, expected) => normalizeEnvelope(value, normalizeQueryEmbeddingResult, expected, LIMITS.queryEmbed.outputMaxBytes),
  resolveInput: ragInputResolver(projectQueryEmbedInput),
  staleGuard: queryStaleGuard
})

const RERANK = definition({
  taskType: 'rag.rerank',
  executionClass: 'gpu',
  inputMode: 'bounded-candidates',
  limits: LIMITS.rerank,
  projectInput: projectRerankInput,
  normalizeResult: (value, expected) => normalizeEnvelope(value, normalizeRerankResult, expected, LIMITS.rerank.outputMaxBytes),
  resolveInput: ragInputResolver(projectRerankInput),
  staleGuard: rerankStaleGuard
})

const ANSWER = definition({
  taskType: 'rag.answer.generate',
  executionClass: 'gpu',
  inputMode: 'bounded-evidence',
  limits: LIMITS.answer,
  projectInput: projectAnswerInput,
  normalizeResult: (value, expected) => normalizeEnvelope(value, normalizeAnswerResult, expected, LIMITS.answer.outputMaxBytes),
  resolveInput: ragInputResolver(projectAnswerInput),
  staleGuard: answerStaleGuard
})

export const PC_WORKER_PROCESSOR_CATALOG = Object.freeze({
  [CONTENT_INSPECT.taskType]: CONTENT_INSPECT,
  [CONTENT_EXTRACT.taskType]: CONTENT_EXTRACT,
  [EMBEDDING_GENERATE.taskType]: EMBEDDING_GENERATE,
  [QUERY_EMBED.taskType]: QUERY_EMBED,
  [RERANK.taskType]: RERANK,
  [ANSWER.taskType]: ANSWER
})

export const PC_WORKER_PROCESSOR_DEFINITIONS = Object.freeze([
  CONTENT_INSPECT, CONTENT_EXTRACT, EMBEDDING_GENERATE, QUERY_EMBED, RERANK, ANSWER
])

export function lookupPcWorkerProcessor(taskType, processorVersion = PC_WORKER_PROCESSOR_VERSION) {
  if (typeof taskType !== 'string' || typeof processorVersion !== 'string') return null
  const definitionValue = PC_WORKER_PROCESSOR_CATALOG[taskType]
  return definitionValue?.processorVersion === processorVersion ? definitionValue : null
}

export const lookupProcessor = lookupPcWorkerProcessor

export const getProcessorDefinition = lookupPcWorkerProcessor

export function matchPcWorkerCapabilities(capabilities, requirements = {}) {
  if (!isPlainObject(capabilities) || !Array.isArray(capabilities.processors)) return Object.freeze([])
  if (!isPlainObject(requirements)) return Object.freeze([])
  const requirementKeys = new Set(['taskType', 'processorVersion', 'executionClass', 'outputSchemaVersion', 'inputMode'])
  if (Object.keys(requirements).some((key) => !requirementKeys.has(key))) return Object.freeze([])
  const matches = []
  for (const processor of capabilities.processors) {
    if (!isPlainObject(processor)) continue
    if (Object.keys(processor).some((key) => !['taskType', 'processorVersion', 'executionClass', 'outputSchemaVersion'].includes(key))) continue
    const definitionValue = lookupPcWorkerProcessor(processor.taskType, processor.processorVersion)
    if (!definitionValue || processor.executionClass !== definitionValue.executionClass ||
        processor.outputSchemaVersion !== definitionValue.outputSchemaVersion) continue
    if (Object.entries(requirements).some(([key, value]) => processor[key] !== value && definitionValue[key] !== value)) continue
    matches.push(descriptor(definitionValue))
  }
  const unique = new Map(matches.map((item) => [`${item.taskType}:${item.processorVersion}:${item.executionClass}:${item.outputSchemaVersion}`, item]))
  return Object.freeze([...unique.values()])
}

export const matchProcessorCapabilities = matchPcWorkerCapabilities

export const matchCapabilities = matchPcWorkerCapabilities

export function supportedPcWorkerProcessors(capabilities) {
  return matchPcWorkerCapabilities(capabilities)
}

export function isKnownPcWorkerProcessor(taskType, processorVersion = PC_WORKER_PROCESSOR_VERSION) {
  return lookupPcWorkerProcessor(taskType, processorVersion) !== null
}

export const PROCESSOR_CATALOG = PC_WORKER_PROCESSOR_CATALOG
export const PROCESSOR_DEFINITIONS = PC_WORKER_PROCESSOR_DEFINITIONS

export function createPcWorkerProcessorCatalog() {
  return Object.freeze({
    version: PC_WORKER_PROCESSOR_CATALOG_VERSION,
    definitions: PC_WORKER_PROCESSOR_DEFINITIONS,
    lookup: lookupPcWorkerProcessor,
    matchCapabilities: matchPcWorkerCapabilities,
    supported: supportedPcWorkerProcessors
  })
}

export default PC_WORKER_PROCESSOR_CATALOG
