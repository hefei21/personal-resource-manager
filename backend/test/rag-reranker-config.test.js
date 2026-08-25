import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadRagRerankerModel,
  RAG_RERANKER_MODEL
} from '../src/config/ragReranker.js'

function enabledEnvironment(overrides = {}) {
  return {
    RAG_RERANKER_ENABLED: 'true',
    RAG_RERANKER_PROVIDER: RAG_RERANKER_MODEL.provider,
    RAG_RERANKER_MODEL_ID: RAG_RERANKER_MODEL.modelId,
    RAG_RERANKER_MODEL_REVISION: RAG_RERANKER_MODEL.modelRevision,
    RAG_RERANKER_DIMENSIONS: String(RAG_RERANKER_MODEL.dimensions),
    RAG_RERANKER_INPUT_LIMIT: String(RAG_RERANKER_MODEL.inputLimit),
    RAG_RERANKER_CONFIG_HASH: RAG_RERANKER_MODEL.configHash,
    ...overrides
  }
}

test('reranker config enables only the complete fixed BGE identity', () => {
  assert.deepEqual(loadRagRerankerModel(enabledEnvironment()), RAG_RERANKER_MODEL)
  assert.equal(loadRagRerankerModel(enabledEnvironment({ RAG_RERANKER_ENABLED: 'false' })), null)
  assert.equal(loadRagRerankerModel(enabledEnvironment({ RAG_RERANKER_MODEL_REVISION: 'main' })), null)
  assert.equal(loadRagRerankerModel(enabledEnvironment({ RAG_RERANKER_CONFIG_HASH: 'a'.repeat(64) })), null)
  assert.equal(loadRagRerankerModel({ RAG_RERANKER_ENABLED: 'true' }), null)
})
