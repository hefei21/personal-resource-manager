import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeRagVectorConfigHash,
  loadRagVectorConfig,
  RagVectorConfigError
} from '../src/config/ragVector.js'

function validEnvironment(overrides = {}) {
  const model = {
    provider: 'lmstudio',
    modelId: 'text-embedding-nomic-embed-text-v1.5',
    modelRevision: 'nomic-v1.5-q4-k-m',
    dimensions: '768',
    inputLimit: '2048',
    distance: 'cosine',
    normalization: 'l2'
  }
  const hash = computeRagVectorConfigHash({
    ...model,
    dimensions: Number(model.dimensions),
    inputLimit: Number(model.inputLimit)
  })
  return {
    RAG_VECTOR_ENABLED: 'true',
    RAG_VECTOR_BASE_URL: 'http://qdrant:6333/',
    RAG_VECTOR_COLLECTION: 'rag_vectors',
    RAG_VECTOR_TIMEOUT_MS: '5000',
    RAG_VECTOR_EMBEDDING_PROVIDER: model.provider,
    RAG_VECTOR_EMBEDDING_MODEL_ID: model.modelId,
    RAG_VECTOR_EMBEDDING_MODEL_REVISION: model.modelRevision,
    RAG_VECTOR_EMBEDDING_DIMENSIONS: model.dimensions,
    RAG_VECTOR_EMBEDDING_INPUT_LIMIT: model.inputLimit,
    RAG_VECTOR_EMBEDDING_DISTANCE: model.distance,
    RAG_VECTOR_EMBEDDING_NORMALIZATION: model.normalization,
    RAG_VECTOR_EMBEDDING_CONFIG_HASH: hash,
    ...overrides
  }
}

function configError(action) {
  assert.throws(action, (error) => error instanceof RagVectorConfigError && error.code === 'RAG_VECTOR_CONFIG_INVALID')
}

test('vector configuration is disabled by default and drops stale model values', () => {
  const config = loadRagVectorConfig({
    RAG_VECTOR_ENABLED: '',
    RAG_VECTOR_BASE_URL: 'http://qdrant:6333',
    RAG_VECTOR_EMBEDDING_MODEL_ID: 'Qwen/Qwen3-Embedding-0.6B',
    RAG_VECTOR_EMBEDDING_DIMENSIONS: '1024'
  })
  assert.deepEqual(config, {
    enabled: false,
    baseUrl: null,
    collection: null,
    timeoutMs: null,
    modelConfig: null,
    embedding: null
  })
})

test('complete identity is required and normalizes the Qdrant endpoint', () => {
  const config = loadRagVectorConfig(validEnvironment())
  assert.equal(config.enabled, true)
  assert.equal(config.baseUrl, 'http://qdrant:6333')
  assert.equal(config.collection, 'rag_vectors')
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.modelConfig.dimensions, 768)
  assert.equal(config.modelConfig.inputLimit, 2048)
  assert.equal(config.modelConfig.configHash, validEnvironment().RAG_VECTOR_EMBEDDING_CONFIG_HASH)
  assert.equal(config.embedding, config.modelConfig)
})

test('enabled configuration fails closed when identity is incomplete or stale', () => {
  configError(() => loadRagVectorConfig({
    RAG_VECTOR_ENABLED: 'true',
    RAG_VECTOR_BASE_URL: 'http://qdrant:6333',
    RAG_VECTOR_COLLECTION: 'rag_vectors',
    RAG_VECTOR_TIMEOUT_MS: '5000',
    RAG_VECTOR_EMBEDDING_MODEL_ID: 'Qwen/Qwen3-Embedding-0.6B',
    RAG_VECTOR_EMBEDDING_DIMENSIONS: '1024'
  }))
  configError(() => loadRagVectorConfig(validEnvironment({
    RAG_VECTOR_EMBEDDING_CONFIG_HASH: '0'.repeat(64)
  })))
})

test('endpoint, collection, and boolean syntax are validated', () => {
  configError(() => loadRagVectorConfig(validEnvironment({ RAG_VECTOR_BASE_URL: 'http://user:pass@qdrant:6333' })))
  configError(() => loadRagVectorConfig(validEnvironment({ RAG_VECTOR_COLLECTION: '../unsafe' })))
  configError(() => loadRagVectorConfig(validEnvironment({ RAG_VECTOR_ENABLED: 'sometimes' })))
})
