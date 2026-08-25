import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'

const base = {
  PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
  PC_WORKER_RERANKER_BASE_URL: 'http://127.0.0.1:19090/rerank',
  LOCALAPPDATA: 'C:\\worker-test'
}

test('Worker accepts only the explicit loopback/HTTPS pinned TEI reranker', () => {
  const config = loadConfig(base)
  assert.equal(config.reranker.baseUrl, 'http://127.0.0.1:19090')
  assert.equal(config.reranker.endpoint, 'http://127.0.0.1:19090/rerank')
  assert.equal(config.reranker.infoEndpoint, 'http://127.0.0.1:19090/info')
  assert.equal(config.reranker.healthEndpoint, 'http://127.0.0.1:19090/health')
  assert.equal(config.reranker.modelId, 'BAAI/bge-reranker-v2-m3')
  assert.equal(config.reranker.inputLimit, 512)
  assert.equal(config.reranker.maxBatchItems, 10)
  assert.equal(Object.isFrozen(config.reranker), true)

  assert.throws(() => loadConfig({ ...base, PC_WORKER_RERANKER_BASE_URL: 'http://worker.example.test' }), (error) => error.code === 'WORKER_HTTPS_REQUIRED')
  assert.throws(() => loadConfig({ ...base, PC_WORKER_RERANKER_MODEL_ID: 'BAAI/other' }), (error) => error.code === 'WORKER_CONFIG_INVALID')
})
