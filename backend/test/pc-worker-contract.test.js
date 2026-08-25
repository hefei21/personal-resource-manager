import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeContentInspectionResult,
  normalizeWorkerProfile,
  PC_WORKER_IMPLEMENTATION,
  PC_WORKER_OUTPUT_SCHEMA_VERSION,
  projectWorkerTask,
  supportedRemoteProcessors
} from '../src/services/pcWorkerContract.js'

function profile() {
  return {
    displayName: 'RTX 5080 Worker',
    protocolVersion: 1,
    agentVersion: '0.1.0',
    platform: 'win32',
    architecture: 'x64',
    capabilities: {
      processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }],
      resources: {
        cpuLogicalCores: 16,
        systemMemoryBytes: 64 * 1024 ** 3,
        gpus: [{ vendor: 'NVIDIA', name: 'GeForce RTX 5080', totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 5 * 1024 ** 3 }],
        loadedModels: [{ id: 'qwen3.5-9b-q6', backend: 'lm-studio', memoryBytes: 11 * 1024 ** 3 }]
      }
    }
  }
}

test('Worker capability contract is bounded and only schedules known remote processors', () => {
  const normalized = normalizeWorkerProfile(profile())
  assert.deepEqual(supportedRemoteProcessors(normalized.capabilities), [{
    taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu'
  }])
  const unsupported = profile()
  unsupported.capabilities.processors[0].processorVersion = 'v2'
  assert.deepEqual(supportedRemoteProcessors(normalizeWorkerProfile(unsupported).capabilities), [])
  const unknown = profile()
  unknown.capabilities.processors.push({ taskType: 'rag.unknown', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 })
  assert.deepEqual(supportedRemoteProcessors(normalizeWorkerProfile(unknown).capabilities), [{
    taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu'
  }])
  const leaked = profile()
  leaked.capabilities.resources.path = 'C:\\private'
  assert.throws(() => normalizeWorkerProfile(leaked), (error) => error.code === 'PC_WORKER_INPUT_INVALID')
})

test('claimed task projection exposes lease-scoped identifiers but no NAS path', () => {
  const task = projectWorkerTask({
    id: 12,
    taskType: 'content.inspect',
    processorVersion: 'v1',
    executionClass: 'gpu',
    subjectContentHash: 'a'.repeat(64),
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2026-08-23T00:01:00.000Z',
    attemptCount: 1,
    maxAttempts: 3,
    input: { schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9, path: 'C:\\secret' }
  })
  assert.equal(task, null)
  const valid = projectWorkerTask({
    id: 12,
    taskType: 'content.inspect',
    processorVersion: 'v1',
    executionClass: 'gpu',
    subjectContentHash: 'a'.repeat(64),
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2026-08-23T00:01:00.000Z',
    attemptCount: 1,
    maxAttempts: 3,
    input: { schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9 }
  })
  assert.equal(valid.input.sha256, 'a'.repeat(64))
  assert.doesNotMatch(JSON.stringify(valid), /path|storageKey/u)
  assert.equal(projectWorkerTask({
    ...valid,
    taskType: 'rag.unknown'
  }), null)
})

test('embedding capability identity is required for remote scheduling and must match the active model', () => {
  const model = {
    provider: 'lmstudio', modelId: 'nomic-embed-text-v1.5', modelRevision: 'gguf-r1',
    dimensions: 768, inputLimit: 8192, configHash: 'a'.repeat(64)
  }
  const withEmbedding = profile()
  withEmbedding.capabilities.processors.push({
    taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu',
    outputSchemaVersion: 1, model
  })
  const normalized = normalizeWorkerProfile(withEmbedding)
  assert.deepEqual(supportedRemoteProcessors(normalized.capabilities, { model: { ...model, distance: 'cosine', normalization: 'l2' } }), [
    { taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu' },
    { taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu' }
  ])
  assert.deepEqual(supportedRemoteProcessors(normalized.capabilities, { model: { ...model, configHash: 'b'.repeat(64) } }), [
    { taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu' }
  ])

  const legacy = profile()
  legacy.capabilities.processors.push({
    taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1
  })
  assert.deepEqual(supportedRemoteProcessors(normalizeWorkerProfile(legacy).capabilities, { model }), [
    { taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu' }
  ])
})

test('reranker capability is model-bound and rejects an unversioned or mismatched BGE runtime', () => {
  const model = {
    provider: 'hugging-face-tei', modelId: 'BAAI/bge-reranker-v2-m3',
    modelRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e', dimensions: 1, inputLimit: 512,
    configHash: '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'
  }
  const capable = profile()
  capable.capabilities.processors.push({
    taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1, model
  })
  const normalized = normalizeWorkerProfile(capable)
  assert.deepEqual(supportedRemoteProcessors(normalized.capabilities, { taskType: 'rag.rerank', model }), [
    { taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu' }
  ])
  assert.deepEqual(supportedRemoteProcessors(normalized.capabilities, {
    taskType: 'rag.rerank', model: { ...model, configHash: 'b'.repeat(64) }
  }), [])

  const missingModel = profile()
  missingModel.capabilities.processors.push({
    taskType: 'rag.rerank', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1
  })
  assert.deepEqual(supportedRemoteProcessors(normalizeWorkerProfile(missingModel).capabilities, { taskType: 'rag.rerank', model }), [])
})

test('content result binds input hash, byte count, processor and schema', () => {
  const result = {
    schemaVersion: PC_WORKER_OUTPUT_SCHEMA_VERSION,
    processorVersion: 'v1',
    implementation: PC_WORKER_IMPLEMENTATION,
    input: { sha256: 'b'.repeat(64), bytes: 5 },
    output: {
      sha256: 'b'.repeat(64), bytes: 5, nulBytes: 0,
      lineFeedBytes: 1, carriageReturnBytes: 0, utf8Valid: true
    }
  }
  assert.deepEqual(normalizeContentInspectionResult(result, { sha256: 'b'.repeat(64), bytes: 5 }).output, result.output)
  assert.throws(
    () => normalizeContentInspectionResult({ ...result, output: { ...result.output, sha256: 'c'.repeat(64) } }, { sha256: 'b'.repeat(64), bytes: 5 }),
    (error) => error.code === 'PC_WORKER_RESULT_INPUT_MISMATCH'
  )
  assert.throws(
    () => normalizeContentInspectionResult({ ...result, implementation: { name: 'other', version: '1' } }, { sha256: 'b'.repeat(64), bytes: 5 }),
    (error) => error.code === 'PC_WORKER_RESULT_PROCESSOR_INVALID'
  )
})

test('RAG embedding tasks are projected through the catalog resolver and reject stale identities', () => {
  const sourceHash = 'a'.repeat(64)
  const input = {
    schemaVersion: 1,
    snapshotId: 17,
    sourceType: 'document',
    sourceId: 7,
    sourceVersionId: '11',
    sourceContentSha256: sourceHash,
    model: {
      provider: 'local-provider',
      modelId: 'embedding-model',
      modelRevision: 'rev-1',
      dimensions: 3,
      configHash: 'b'.repeat(64)
    },
    chunks: [{ chunkId: 101, ordinal: 0, chunkSha256: 'c'.repeat(64), body: '正文' }]
  }
  const projected = projectWorkerTask({
    id: 18,
    taskType: 'rag.embedding.generate',
    processorVersion: 'v1',
    executionClass: 'gpu',
    subjectContentSha256: sourceHash,
    input,
    leaseToken: 'lease-secret',
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
    attemptCount: 1,
    maxAttempts: 3
  })
  assert.equal(projected.input.snapshotId, 17)
  assert.equal(projected.input.sourceContentSha256, sourceHash)
  assert.doesNotMatch(JSON.stringify(projected), /storageKey|C:\\private/u)
})
