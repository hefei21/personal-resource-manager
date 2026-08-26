import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { createRagContentExtractionService } from '../src/services/ragContentExtractionService.js'
import { projectTask } from '../src/services/taskTypeCatalog.js'

function fixture() {
  const input = {
    schemaVersion: 1,
    sourceType: 'document',
    sourceId: 33,
    sourceVersionId: '91',
    sourceContentSha256: 'a'.repeat(64),
    contentBytes: 3618,
    format: 'pdf'
  }
  const artifact = {
    schemaVersion: 1,
    format: 'pdf',
    sections: [{ ordinal: 0, title: 'Page 1', text: '设备运行正常。', locator: { page: 1 } }]
  }
  const serialized = JSON.stringify(artifact)
  const output = {
    sourceVersionId: input.sourceVersionId,
    sourceContentSha256: input.sourceContentSha256,
    extractorVersion: 'pc-worker-structured-text.v1',
    artifactSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    artifactBytes: Buffer.byteLength(serialized),
    sectionCount: artifact.sections.length,
    format: input.format
  }
  return { input, artifact, result: { schemaVersion: 1, processorVersion: 'v1', output } }
}

test('enqueues one model-free extraction and consumes its committed bound artifact', async () => {
  const { input, artifact, result } = fixture()
  let request
  let reads = 0
  const taskStore = {
    enqueueExclusiveRun(value, options) {
      request = value
      assert.deepEqual(options, { taskTypes: ['rag.content.extract'] })
      return { task: { id: 49, status: 'pending', input: value.input }, created: true }
    },
    getById(id) {
      reads += 1
      assert.equal(id, 49)
      return { id, status: 'succeeded', input, result }
    }
  }
  const service = createRagContentExtractionService({
    taskStore,
    artifactStore: { readCommitted: async (id) => { assert.equal(id, 49); return artifact } },
    timeoutMs: 100,
    pollIntervalMs: 1
  })
  const extracted = await service.extract(input)
  assert.equal(request.taskType, 'rag.content.extract')
  assert.equal(request.executionClass, 'cpu')
  assert.equal(request.subjectId, 'document:33')
  assert.equal(request.subjectVersionId, 'document:91')
  assert.equal(request.subjectContentSha256, input.sourceContentSha256)
  assert.equal(Object.hasOwn(request, 'model'), false)
  assert.equal(reads, 1)
  assert.equal(extracted.extractorVersion, 'pc-worker-structured-text.v1')
  assert.deepEqual(extracted.sections, artifact.sections)
})

test('keeps timed-out work durable so the same identity can finish and be reused later', async () => {
  const { input } = fixture()
  const pending = { id: 50, status: 'pending', input }
  let clock = 0
  const taskStore = {
    enqueueExclusiveRun: () => ({ task: pending, created: true }),
    getById: () => pending
  }
  const service = createRagContentExtractionService({
    taskStore,
    artifactStore: { readCommitted: async () => { throw new Error('must not read') } },
    timeoutMs: 2,
    pollIntervalMs: 1,
    now: () => clock++
  })
  await assert.rejects(service.extract(input), { code: 'RAG_SOURCE_EXTRACTION_TIMEOUT' })
  assert.equal(pending.status, 'pending')
})

test('does not consume an active extraction bound to a different source version', async () => {
  const { input } = fixture()
  const taskStore = {
    enqueueExclusiveRun: () => ({
      task: { id: 51, status: 'pending', input: { ...input, sourceVersionId: 'old' } },
      activeConflict: true
    }),
    getById: () => null
  }
  const service = createRagContentExtractionService({
    taskStore,
    artifactStore: { readCommitted: async () => null }
  })
  await assert.rejects(service.extract(input), { code: 'RAG_SOURCE_EXTRACTION_BUSY' })
})

test('reuses a bounded terminal retry instead of pinning the source to its first failed task', async () => {
  const { input, artifact, result } = fixture()
  let retried
  const taskStore = {
    enqueueExclusiveRun: () => ({ task: { id: 60, status: 'failed', input }, created: false }),
    retryTerminalTask(options) {
      retried = options
      return { task: { id: 61, status: 'succeeded', input, result }, created: true, exhausted: false }
    },
    getById: () => null
  }
  const service = createRagContentExtractionService({
    taskStore,
    artifactStore: { readCommitted: async (id) => { assert.equal(id, 61); return artifact } }
  })
  const extracted = await service.extract(input)
  assert.deepEqual(retried, { id: 60, maxRetries: 3 })
  assert.equal(extracted.taskId, 61)
})

test('creates one deterministic recovery task when a succeeded extraction lost its committed artifact', async () => {
  const { input, artifact, result } = fixture()
  const requests = []
  const tasks = new Map([
    ['document:91', { id: 70, status: 'succeeded', input, result }]
  ])
  const taskStore = {
    enqueueExclusiveRun(request) {
      requests.push(request)
      const existing = tasks.get(request.subjectVersionId)
      if (existing) return { task: existing, created: false }
      const task = { id: 71, status: 'pending', input: request.input, result }
      tasks.set(request.subjectVersionId, { ...task, status: 'succeeded' })
      return { task, created: true }
    },
    getById(id) {
      return [...tasks.values()].find((task) => task.id === id) ?? null
    }
  }
  const artifactStore = {
    async readCommitted(id) {
      if (id === 70) {
        const error = new Error('committed artifact is missing')
        error.code = 'RAG_ARTIFACT_MISSING'
        throw error
      }
      assert.equal(id, 71)
      return artifact
    }
  }
  const service = createRagContentExtractionService({ taskStore, artifactStore })

  const extracted = await service.extract(input)

  assert.equal(extracted.taskId, 71)
  assert.deepEqual(extracted.sections, artifact.sections)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].subjectVersionId, 'document:91')
  assert.match(requests[1].subjectVersionId, /^artifact-recovery:[a-f0-9]{64}$/u)
  assert.notEqual(requests[1].subjectVersionId, requests[0].subjectVersionId)
})

test('does not create a second recovery task after the bounded repair also loses its artifact', async () => {
  const { input, result } = fixture()
  const requests = []
  const taskStore = {
    enqueueExclusiveRun(request) {
      requests.push(request)
      return {
        task: { id: 72 + requests.length, status: 'succeeded', input: request.input, result },
        created: true
      }
    },
    getById() { throw new Error('succeeded tasks should not be polled') }
  }
  const artifactStore = {
    async readCommitted() {
      const error = new Error('committed artifact is missing')
      error.code = 'RAG_ARTIFACT_MISSING'
      throw error
    }
  }
  const service = createRagContentExtractionService({ taskStore, artifactStore })

  await assert.rejects(service.extract(input), { code: 'RAG_SOURCE_EXTRACTION_ARTIFACT_MISSING' })
  assert.equal(requests.length, 2)
  assert.match(requests[1].subjectVersionId, /^artifact-recovery:[a-f0-9]{64}$/u)
})

test('task center projects extraction identity and metadata without artifact content', () => {
  const { input, result } = fixture()
  const projected = projectTask({
    id: 52,
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    subjectType: 'rag-source',
    subjectId: 'document:33',
    subjectVersionId: 'document:91',
    subjectContentHash: input.sourceContentSha256,
    input,
    result,
    status: 'succeeded',
    progress: 100,
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null
  })
  assert.equal(projected.subject.id, 'document:33')
  assert.deepEqual(projected.input, input)
  assert.deepEqual(projected.result, {
    extractorVersion: 'pc-worker-structured-text.v1',
    artifactBytes: result.output.artifactBytes,
    sectionCount: 1,
    format: 'pdf'
  })
  assert.equal(JSON.stringify(projected).includes('设备运行正常'), false)
})
