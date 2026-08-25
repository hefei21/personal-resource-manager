import assert from 'node:assert/strict'
import test from 'node:test'

import { createModelReadiness, modelKindForTaskType } from '../src/modelReadiness.js'

const answer = {
  baseUrl: 'http://127.0.0.1:1234',
  modelId: 'answer-model',
  apiKey: null
}
const embedding = {
  baseUrl: 'http://127.0.0.1:1234',
  modelId: 'embedding-model',
  apiKey: null
}

function loadedModels(state) {
  return [
    ...(state.answerLoaded ? [{ modelKey: answer.modelId }] : []),
    ...(state.embeddingLoaded ? [{ identifier: embedding.modelId }] : [])
  ]
}

test('loaded snapshot gates answer and embedding independently', async () => {
  const state = { answerLoaded: true, embeddingLoaded: true }
  let now = 0
  let snapshotCalls = 0
  const readiness = createModelReadiness({
    answer,
    embedding,
    fetchImpl: () => { throw new Error('active endpoint probe must not run') },
    loadedModelsProvider: async () => {
      snapshotCalls += 1
      return loadedModels(state)
    },
    intervalMs: 1_000,
    maxBackoffMs: 8_000,
    now: () => now,
    random: () => 0.5
  })

  assert.equal(await readiness.refresh({ force: true }), true)
  assert.equal(snapshotCalls, 1)
  assert.equal(readiness.isReady('answer'), true)
  assert.equal(readiness.isReady('embedding'), true)

  state.answerLoaded = false
  now = 1_001
  assert.equal(await readiness.refresh(), true)
  assert.equal(snapshotCalls, 2)
  assert.equal(readiness.isReady('answer'), false)
  assert.equal(readiness.isReady('embedding'), true)
  assert.equal(readiness.snapshot().answer.reason, 'model_not_loaded')

  state.answerLoaded = true
  now = 2_002
  assert.equal(await readiness.refresh(), true)
  assert.equal(snapshotCalls, 3)
  assert.equal(readiness.isReady('answer'), true)
  assert.equal(readiness.isReady('embedding'), true)
})

test('downloaded models in /v1/models do not trigger a JIT active probe', async () => {
  let fetchCalls = 0
  const readiness = createModelReadiness({
    answer,
    embedding,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('the downloaded-model listing must never trigger JIT')
    },
    // This is the loaded-only snapshot: Nomic is loaded, Qwen answer and the
    // configured embedding model are not. The OpenAI model listing is not used.
    loadedModelsProvider: async () => [{ modelKey: 'nomic-embed-text-v1.5' }],
    intervalMs: 1_000,
    now: () => 0,
    random: () => 0.5
  })

  assert.equal(await readiness.refresh({ force: true }), false)
  assert.equal(fetchCalls, 0)
  assert.equal(readiness.isReady('answer'), false)
  assert.equal(readiness.isReady('embedding'), false)
  assert.equal(readiness.snapshot().answer.reason, 'model_not_loaded')
})

test('loaded snapshot failure backs off and the next successful snapshot restores readiness', async () => {
  let now = 0
  let snapshotAvailable = false
  const readiness = createModelReadiness({
    answer,
    loadedModelsProvider: async () => {
      if (!snapshotAvailable) throw new Error('lms unavailable')
      return [{ identifier: answer.modelId }]
    },
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => now,
    random: () => 0.5
  })

  assert.equal(await readiness.refresh({ force: true }), false)
  const nextProbeAt = readiness.snapshot().answer.nextProbeAt
  assert.equal(await readiness.refresh(), false)
  assert.equal(readiness.snapshot().answer.nextProbeAt, nextProbeAt)

  snapshotAvailable = true
  now = nextProbeAt
  assert.equal(await readiness.refresh(), true)
  assert.equal(readiness.isReady('answer'), true)
})

test('processor failure revokes readiness and retryable recovery can follow', async () => {
  let now = 0
  const readiness = createModelReadiness({
    answer,
    loadedModelsProvider: async () => [{ modelKey: answer.modelId }],
    intervalMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => now,
    random: () => 0.5
  })

  assert.equal(await readiness.refresh({ force: true }), true)
  assert.equal(readiness.markUnavailable('answer', 'processor_failed'), true)
  assert.equal(readiness.isReady('answer'), false)
  now = readiness.snapshot().answer.nextProbeAt
  assert.equal(await readiness.refresh(), true)
  assert.equal(readiness.isReady('answer'), true)
})

test('task types map to independent model readiness gates', () => {
  assert.equal(modelKindForTaskType('rag.answer.generate'), 'answer')
  assert.equal(modelKindForTaskType('rag.embedding.generate'), 'embedding')
  assert.equal(modelKindForTaskType('rag.query.embed'), 'embedding')
  assert.equal(modelKindForTaskType('rag.content.extract'), null)
})
