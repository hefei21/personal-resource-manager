import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModelReadiness,
  RERANKER_MANIFEST_SHA256,
  RERANKER_REQUIRED_FILES
} from '../src/modelReadiness.js'

const config = {
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
  timeoutMs: 2_000
}

function jsonResponse(payload, ok = true) {
  return { ok, json: async () => payload }
}

const pinnedManifest = {
  modelId: config.modelId,
  revision: config.modelRevision,
  manifestSha256: RERANKER_MANIFEST_SHA256,
  files: RERANKER_REQUIRED_FILES
}

test('reranker readiness uses TEI info without LMS loaded-model probing or rerank requests', async () => {
  const calls = []
  let loadedCalls = 0
  const readiness = createModelReadiness({
    reranker: config,
    rerankerManifestProvider: async () => pinnedManifest,
    loadedModelsProvider: async () => { loadedCalls += 1; return [] },
    fetchImpl: async (url) => {
      calls.push(url)
      assert.equal(url, config.infoEndpoint)
      return jsonResponse({ model_type: { reranker: {} }, served_model_name: config.modelId })
    },
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  assert.equal(await readiness.refresh({ force: true }), true)
  assert.equal(readiness.isReady('reranker'), true)
  assert.equal(loadedCalls, 0)
  assert.deepEqual(calls, [config.infoEndpoint])
})

test('reranker readiness never falls back to health-only identity', async () => {
  const calls = []
  const readiness = createModelReadiness({
    reranker: config,
    rerankerManifestProvider: async () => pinnedManifest,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url === config.infoEndpoint) return jsonResponse({}, false)
      return jsonResponse({ status: 'ok', model_type: 'reranker' })
    },
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  assert.equal(await readiness.refresh({ force: true }), false)
  assert.equal(readiness.isReady('reranker'), false)
  assert.equal(readiness.snapshot().reranker.reason, 'info_unavailable')
  assert.deepEqual(calls, [config.infoEndpoint, config.healthEndpoint])

  const wrongIdentity = createModelReadiness({
    reranker: config,
    rerankerManifestProvider: async () => pinnedManifest,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', model_id: 'BAAI/other' }),
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  assert.equal(await wrongIdentity.refresh({ force: true }), false)
  assert.equal(wrongIdentity.isReady('reranker'), false)
  assert.equal(wrongIdentity.snapshot().reranker.reason, 'model_identity_mismatch')
})

test('served model name takes precedence and explicit mismatches remain rejected', async () => {
  const wrongServed = createModelReadiness({
    reranker: config,
    rerankerManifestProvider: async () => pinnedManifest,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', servedModelName: 'BAAI/other', model_id: config.modelId }),
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  assert.equal(await wrongServed.refresh({ force: true }), false)
  assert.equal(wrongServed.snapshot().reranker.reason, 'model_identity_mismatch')

  const wrongRevision = createModelReadiness({
    reranker: config,
    rerankerManifestProvider: async () => pinnedManifest,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', servedModelName: config.modelId, revision: 'wrong-revision' }),
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  assert.equal(await wrongRevision.refresh({ force: true }), false)
  assert.equal(wrongRevision.snapshot().reranker.reason, 'model_identity_mismatch')
})

test('revision alone cannot establish reranker model identity', async () => {
  const readiness = createModelReadiness({
    reranker: config,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', revision: config.modelRevision }),
    rerankerManifestProvider: async () => manifest,
    now: () => 0,
    random: () => 0.5
  })
  await readiness.refresh({ force: true })
  assert.equal(readiness.isReady('reranker'), false)
  assert.equal(readiness.snapshot().reranker.reason, 'model_identity_unverified')
})

test('local TEI model path requires the pinned manifest and reranker model type', async () => {
  const missingManifest = createModelReadiness({
    reranker: config,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', model_id: '/models/reranker' }),
    rerankerManifestProvider: async () => null,
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  await missingManifest.refresh({ force: true })
  assert.equal(missingManifest.isReady('reranker'), false)
  assert.equal(missingManifest.snapshot().reranker.reason, 'manifest_invalid')

  const acceptedManifest = createModelReadiness({
    reranker: config,
    fetchImpl: async () => jsonResponse({ model_type: 'reranker', model_id: '/models/reranker' }),
    rerankerManifestProvider: async () => pinnedManifest,
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  await acceptedManifest.refresh({ force: true })
  assert.equal(acceptedManifest.isReady('reranker'), true)

  const wrongType = createModelReadiness({
    reranker: config,
    fetchImpl: async () => jsonResponse({ model_type: 'embedding', model_id: config.modelId }),
    rerankerManifestProvider: async () => pinnedManifest,
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  await wrongType.refresh({ force: true })
  assert.equal(wrongType.isReady('reranker'), false)
  assert.equal(wrongType.snapshot().reranker.reason, 'model_type_mismatch')
})

test('TEI server build sha is not treated as the local model revision', async () => {
  const readiness = createModelReadiness({
    reranker: config,
    fetchImpl: async () => jsonResponse({
      model_id: '/models/reranker',
      model_sha: null,
      served_model_name: config.modelId,
      model_type: { reranker: { id2label: { 0: 'LABEL_0' } } },
      version: '1.9.3',
      sha: '06670157fb6c1523482219bdb2d1660277d38088'
    }),
    rerankerManifestProvider: async () => pinnedManifest,
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => 0,
    random: () => 0.5
  })
  await readiness.refresh({ force: true })
  assert.equal(readiness.isReady('reranker'), true)
  assert.equal(readiness.snapshot().reranker.reason, null)
})

for (const revisionField of ['model_revision', 'modelRevision', 'model_sha']) {
  test(`explicit ${revisionField} mismatch remains rejected`, async () => {
    const readiness = createModelReadiness({
      reranker: config,
      fetchImpl: async () => jsonResponse({
        model_type: { reranker: {} },
        served_model_name: config.modelId,
        [revisionField]: 'wrong-model-revision',
        sha: 'tei-server-build-sha'
      }),
      rerankerManifestProvider: async () => pinnedManifest,
      now: () => 0,
      random: () => 0.5
    })
    await readiness.refresh({ force: true })
    assert.equal(readiness.isReady('reranker'), false)
    assert.equal(readiness.snapshot().reranker.reason, 'model_identity_mismatch')
  })
}
