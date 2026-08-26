import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { PcWorker } from '../src/worker.js'
import { RERANKER_MANIFEST_SHA256, RERANKER_REQUIRED_FILES } from '../src/modelReadiness.js'

const config = {
  statePath: 'C:\\worker-test\\reranker-state.json',
  enrollmentToken: 'enroll',
  displayName: 'Worker',
  heartbeatIntervalMs: 20_000,
  pollIntervalMs: 1_000,
  modelReadinessIntervalMs: 1_000,
  modelReadinessMaxBackoffMs: 4_000,
  reranker: {
    baseUrl: 'http://127.0.0.1:19090',
    endpoint: 'http://127.0.0.1:19090/rerank',
    infoEndpoint: 'http://127.0.0.1:19090/info',
    healthEndpoint: 'http://127.0.0.1:19090/health',
    provider: 'hugging-face-tei',
    modelId: 'BAAI/bge-reranker-v2-m3',
    modelRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
    dimensions: 1,
    inputLimit: 512,
    configHash: '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a',
    maxLength: 512,
    scoreType: 'raw_logit',
    maxBatchItems: 10,
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 512 * 1024,
    timeoutMs: 2_000,
    apiKey: null
  }
}

const model = {
  provider: config.reranker.provider,
  modelId: config.reranker.modelId,
  modelRevision: config.reranker.modelRevision,
  dimensions: 1,
  inputLimit: 512,
  configHash: config.reranker.configHash
}

const pinnedManifest = {
  modelId: config.reranker.modelId,
  revision: config.reranker.modelRevision,
  manifestSha256: RERANKER_MANIFEST_SHA256,
  files: RERANKER_REQUIRED_FILES
}

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function candidateSetSha256(candidates) {
  return hash(JSON.stringify(candidates.map((candidate, index) => ({
    index,
    candidateId: candidate.candidateId,
    textSha256: hash(candidate.text.normalize('NFKC').trim()),
    ...(candidate.score === undefined ? {} : { score: candidate.score })
  }))))
}

function profile() {
  return {
    displayName: 'Worker',
    protocolVersion: 1,
    agentVersion: 'test',
    platform: 'win32',
    architecture: 'x64',
    capabilities: { processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }] }
  }
}

test('Worker executes rerank only after independent TEI readiness and keeps LMS untouched', async () => {
  const query = '恢复索引'
  const candidates = [{ candidateId: 'C1', text: '先检查索引。' }, { candidateId: 'C2', text: '再恢复任务。' }]
  const task = {
    id: 7,
    leaseToken: 'lease',
    taskType: 'rag.rerank',
    processorVersion: 'v1',
    executionClass: 'gpu',
    input: {
      schemaVersion: 1,
      querySha256: hash(query.normalize('NFKC').trim()),
      candidateSetSha256: candidateSetSha256(candidates),
      query,
      model,
      candidates
    }
  }
  const profiles = []
  const completed = []
  const failures = []
  let claims = 0
  let loadedCalls = 0
  const api = {
    enroll: async (_token, value) => {
      profiles.push(value)
      return { worker: { id: 'pcw-rerank' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z', refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z' }
    },
    updateProfile: async (_token, value) => profiles.push(value),
    claim: async () => (claims++ === 0 ? task : null),
    start: async () => {},
    complete: async (_token, _task, value) => completed.push(value),
    fail: async (_token, _task, code) => failures.push(code)
  }
  const worker = new PcWorker({
    config,
    api,
    profileProvider: async () => profile(),
    logger: { info() {}, warn() {} },
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    rerankerManifestProvider: async () => pinnedManifest,
    loadedModelsProvider: async () => { loadedCalls += 1; throw new Error('LMS must not be consulted for reranker') },
    fetchImpl: async (url) => {
      if (url === config.reranker.infoEndpoint) return { ok: true, json: async () => ({ model_type: { reranker: {} }, model_id: config.reranker.modelId, revision: config.reranker.modelRevision }) }
      if (url === config.reranker.endpoint) return {
        ok: true,
        headers: new Headers({ 'content-length': '80' }),
        json: async () => [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]
      }
      throw new Error(`unexpected endpoint ${url}`)
    }
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(loadedCalls, 0)
  assert.equal(failures.length, 0)
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0].output.candidates, [{ candidateId: 'C2', score: 0.9 }, { candidateId: 'C1', score: 0.1 }])
  assert.equal(profiles[0].capabilities.processors.some((item) => item.taskType === 'rag.rerank'), true)
})
