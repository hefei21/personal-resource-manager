import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { classifyWorkerFailure, PcWorker } from '../src/worker.js'
import { createModelReadiness } from '../src/modelReadiness.js'

const content = Buffer.from('worker fixture\n', 'utf8')
const sha256 = createHash('sha256').update(content).digest('hex')

test('Worker uses only a bounded follow-up poll burst after completing chained work', async () => {
  const delays = []
  let calls = 0
  const worker = Object.create(PcWorker.prototype)
  worker.config = { pollIntervalMs: 1_000, followUpPollIntervalMs: 25, followUpPollAttempts: 2 }
  worker.logger = { info() {}, warn() {} }
  worker.stopping = false
  worker.activeController = null
  worker.runOnce = async () => {
    calls += 1
    return calls === 1
  }
  worker.sleep = async (milliseconds) => {
    delays.push(milliseconds)
    if (delays.length === 2) worker.stop()
  }

  await worker.run()

  assert.deepEqual(delays, [25, 25])
  assert.equal(calls, 3)
})

function profile() {
  return {
    displayName: 'Worker', protocolVersion: 1, agentVersion: '0.1.0', platform: 'win32', architecture: 'x64',
    capabilities: {
      processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }],
      resources: { cpuLogicalCores: 16, systemMemoryBytes: 1, gpus: [], loadedModels: [] }
    }
  }
}

test('Worker enrolls once, persists credentials, and completes an authorized task', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-run-'))
  const calls = []
  const response = {
    headers: new Headers({ 'x-content-sha256': sha256, 'content-length': String(content.length) }),
    body: Readable.from(content)
  }
  const api = {
    enroll: async () => ({
      worker: { id: 'pcw-test' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
    }),
    updateProfile: async () => calls.push('profile'),
    claim: async () => ({
      id: 1, leaseToken: 'lease', input: { sha256 },
      taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu'
    }),
    start: async () => calls.push('start'),
    heartbeat: async () => calls.push('heartbeat'),
    input: async () => response,
    complete: async (_token, _task, result) => calls.push({ complete: result }),
    fail: async () => calls.push('fail')
  }
  try {
    const worker = new PcWorker({
      config: {
        statePath: path.join(directory, 'state.json'), enrollmentToken: 'enroll', displayName: 'Worker',
        heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000
      },
      api,
      logger: { info() {}, warn() {} },
      profileProvider: async () => profile()
    })
    assert.equal(await worker.runOnce(), true)
    assert.equal(fs.existsSync(path.join(directory, 'state.json')), true)
    assert.equal(calls.includes('start'), true)
    assert.equal(calls.includes('fail'), false)
    assert.equal(calls.find((value) => value.complete)?.complete.output.sha256, sha256)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Worker uploads extracted text through the artifact channel before metadata completion', async () => {
  const uploaded = []
  const completed = []
  const artifact = { schemaVersion: 1, format: 'docx', sections: [{ ordinal: 0, title: 'Document', text: 'private extraction', locator: { paragraphStart: 0, paragraphEnd: 0 } }] }
  const serialized = JSON.stringify(artifact)
  const source = Buffer.from('source')
  const task = {
    id: 3,
    leaseToken: 'lease',
    taskType: 'rag.content.extract',
    processorVersion: 'v1',
    executionClass: 'cpu',
    input: {
      schemaVersion: 1, sourceType: 'document', sourceId: 7, sourceVersionId: 'version-7',
      sourceContentSha256: createHash('sha256').update(source).digest('hex'), contentBytes: source.length, format: 'docx'
    }
  }
  const metadata = {
    sourceVersionId: task.input.sourceVersionId,
    sourceContentSha256: task.input.sourceContentSha256,
    extractorVersion: 'pc-worker-structured-text.v1',
    artifactSha256: createHash('sha256').update(serialized).digest('hex'),
    artifactBytes: Buffer.byteLength(serialized), sectionCount: 1, format: 'docx'
  }
  const api = {
    enroll: async () => ({ worker: { id: 'pcw-extract' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z', refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z' }),
    updateProfile: async () => {}, claim: async () => task, start: async () => {}, heartbeat: async () => {},
    input: async () => ({ headers: new Headers({ 'x-content-sha256': task.input.sourceContentSha256, 'content-length': String(source.length) }), body: Readable.from([source]) }),
    uploadArtifact: async (_token, _task, value) => uploaded.push(value),
    complete: async (_token, _task, value) => completed.push(value), fail: async () => { throw new Error('must not fail') }
  }
  const worker = new PcWorker({
    config: { statePath: path.join(os.tmpdir(), 'pc-worker-artifact-state.json'), enrollmentToken: 'enroll', displayName: 'Worker', heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000 },
    api, logger: { info() {}, warn() {} }, profileProvider: async () => profile(), stateReader: () => null, stateWriter: (_path, state) => state,
    contentExtractProcessorFactory: () => ({ supports: (type) => type === 'rag.content.extract', process: async () => ({ schemaVersion: 1, processorVersion: 'v1', output: metadata, artifact }) })
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].artifact.sections[0].text, 'private extraction')
  assert.equal(completed.length, 1)
  assert.equal(Object.hasOwn(completed[0], 'artifact'), false)
  assert.equal(Object.hasOwn(completed[0].output, 'manifest'), false)
})

test('Worker declares embedding capabilities only when local configuration is complete', async () => {
  const profiles = []
  const embedding = {
    baseUrl: 'http://127.0.0.1:1234',
    provider: 'local-provider',
    modelId: 'embedding-model',
    modelRevision: 'rev-1',
    dimensions: 3,
    inputLimit: 2048,
    maxBatchItems: 4,
    maxInputBytes: 1024 * 1024,
    timeoutMs: 2_000,
    configHash: 'a'.repeat(64),
    apiKey: null
  }
  const answer = {
    baseUrl: 'http://127.0.0.1:1234',
    provider: 'local-provider',
    modelId: 'answer-model',
    modelRevision: 'q6-revision-1',
    contextLimit: 4096,
    maxOutputBytes: 8192,
    maxEvidenceItems: 4,
    timeoutMs: 2_000,
    configHash: 'b'.repeat(64),
    apiKey: null
  }
  const api = {
    enroll: async (_token, value) => {
      profiles.push(value)
      return {
        worker: { id: 'pcw-embedding' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
      }
    },
    updateProfile: async (_token, value) => profiles.push(value),
    claim: async () => null,
    refresh: async () => { throw new Error('refresh must not be called') }
  }
  const worker = new PcWorker({
    config: {
      statePath: path.join(os.tmpdir(), 'pc-worker-embedding-state.json'),
      enrollmentToken: 'enroll',
      displayName: 'Worker',
      heartbeatIntervalMs: 20_000,
      pollIntervalMs: 1_000,
      embedding,
      answer
    },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    loadedModelsProvider: async () => [{ modelKey: embedding.modelId }, { identifier: answer.modelId }],
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: embedding.modelId }, { id: answer.modelId }] }) }
      }
      const body = JSON.parse(options.body)
      return body.model === embedding.modelId
        ? { ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }) }
        : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
    }
  })
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.length >= 1, true)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.embedding.generate')), true)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.query.embed')), true)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.answer.generate')), true)
})

test('Worker executes an answer task through the configured local processor', async () => {
  const completed = []
  const logs = []
  const answer = {
    baseUrl: 'http://127.0.0.1:1234',
    provider: 'local-provider',
    modelId: 'answer-model',
    modelRevision: 'q6-revision-1',
    contextLimit: 4096,
    maxOutputBytes: 8192,
    maxEvidenceItems: 4,
    timeoutMs: 2_000,
    configHash: 'b'.repeat(64),
    apiKey: null
  }
  const model = { provider: answer.provider, modelId: answer.modelId, modelRevision: answer.modelRevision, dimensions: 3, configHash: answer.configHash }
  const task = {
    id: 2,
    leaseToken: 'lease',
    taskType: 'rag.answer.generate',
    processorVersion: 'v1',
    executionClass: 'gpu',
    input: {
      schemaVersion: 1,
      querySha256: 'c'.repeat(64),
      query: '问题',
      model,
      evidence: [{ citationId: 'C1', text: '证据' }]
    }
  }
  const api = {
    enroll: async () => ({
      worker: { id: 'pcw-answer' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
    }),
    updateProfile: async () => {},
    claim: async () => task,
    start: async () => {},
    complete: async (_token, _task, result) => completed.push(result),
    fail: async () => { throw new Error('answer task should not fail') }
  }
  const worker = new PcWorker({
    config: { statePath: path.join(os.tmpdir(), 'pc-worker-answer-state.json'), enrollmentToken: 'enroll', displayName: 'Worker', heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000, answer },
    api,
    logger: { info(value) { logs.push(value) }, warn(value) { logs.push(value) } },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    loadedModelsProvider: async () => [{ modelKey: answer.modelId }],
    fetchImpl: async (_url, options) => {
      if (new URL(_url).pathname.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: answer.modelId }] }) }
      }
      const body = JSON.parse(options.body)
      assert.equal(body.model, answer.modelId)
      return { ok: true, json: async () => ({ model: answer.modelId, choices: [{ message: { content: JSON.stringify({ answer: '结论', abstained: false, citations: ['C1'] }) } }] }) }
    }
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(completed.length, 1)
  assert.deepEqual(completed[0].output.citations, ['C1'])
  assert.doesNotMatch(JSON.stringify(logs), /问题|证据|结论/u)
})

test('Worker removes stale model capabilities but retains the built-in content extractor', async () => {
  const profiles = []
  const api = {
    enroll: async (_token, value) => {
      profiles.push(value)
      return {
        worker: { id: 'pcw-no-embedding' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
      }
    },
    updateProfile: async (_token, value) => profiles.push(value),
    claim: async () => null
  }
  const staleProfile = profile()
  staleProfile.capabilities.processors.push({ taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 })
  staleProfile.capabilities.processors.push({ taskType: 'rag.answer.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 })
  const worker = new PcWorker({
    config: { statePath: path.join(os.tmpdir(), 'pc-worker-no-embedding-state.json'), enrollmentToken: 'enroll', displayName: 'Worker', heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000 },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => staleProfile,
    stateReader: () => null,
    stateWriter: (_path, state) => state
  })
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.content.extract')), true)
  assert.equal(profiles.every((value) => value.capabilities.processors.every((item) =>
    !['rag.embedding.generate', 'rag.query.embed', 'rag.answer.generate'].includes(item.taskType))), true)
})

test('Worker revokes and restores model capabilities independently while content extraction stays online', async () => {
  const profiles = []
  const completed = []
  const source = Buffer.from('worker content\n', 'utf8')
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  const answer = {
    baseUrl: 'http://127.0.0.1:1234', provider: 'local-provider', modelId: 'answer-model', modelRevision: 'rev-1',
    contextLimit: 4096, maxOutputBytes: 8192, maxEvidenceItems: 4, timeoutMs: 2_000, configHash: 'b'.repeat(64), apiKey: null
  }
  const embedding = {
    baseUrl: 'http://127.0.0.1:1234', provider: 'local-provider', modelId: 'embedding-model', modelRevision: 'rev-1',
    dimensions: 3, inputLimit: 2048, maxBatchItems: 4, maxInputBytes: 1024 * 1024, timeoutMs: 2_000, configHash: 'a'.repeat(64), apiKey: null
  }
  const serverState = { answerLoaded: true, embeddingLoaded: true }
  let now = 0
  const tasks = []
  const api = {
    enroll: async (_token, value) => {
      profiles.push(value)
      return {
        worker: { id: 'pcw-readiness' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
      }
    },
    updateProfile: async (_token, value) => profiles.push(value),
    claim: async () => tasks.shift() ?? null,
    start: async () => {},
    input: async () => ({ headers: new Headers({ 'x-content-sha256': sourceSha256, 'content-length': String(source.length) }), body: Readable.from([source]) }),
    uploadArtifact: async () => {},
    complete: async (_token, _task, result) => completed.push(result),
    fail: async (_token, _task, code) => { throw new Error(`unexpected failure ${code}`) }
  }
  const worker = new PcWorker({
    config: {
      statePath: path.join(os.tmpdir(), 'pc-worker-readiness-state.json'), enrollmentToken: 'enroll', displayName: 'Worker',
      heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000, modelReadinessIntervalMs: 1_000,
      modelReadinessMaxBackoffMs: 4_000, answer, embedding
    },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    modelReadinessFactory: (options) => createModelReadiness({ ...options, now: () => now, random: () => 0.5 }),
    loadedModelsProvider: async () => [
      ...(serverState.answerLoaded ? [{ modelKey: answer.modelId }] : []),
      ...(serverState.embeddingLoaded ? [{ identifier: embedding.modelId }] : [])
    ],
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [
          ...(serverState.answerLoaded ? [{ id: answer.modelId }] : []),
          ...(serverState.embeddingLoaded ? [{ id: embedding.modelId }] : [])
        ] }) }
      }
      const body = JSON.parse(options.body)
      if (body.model === embedding.modelId) {
        return serverState.embeddingLoaded
          ? { ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }) }
          : { ok: false, json: async () => ({}) }
      }
      return serverState.answerLoaded
        ? { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
        : { ok: false, json: async () => ({}) }
    },
    contentExtractProcessorFactory: () => ({
      supports: (type) => type === 'rag.content.extract',
      process: async () => ({ schemaVersion: 1, processorVersion: 'v1', output: { bytes: source.length }, artifact: { sections: [] } })
    })
  })

  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.answer.generate'), true)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.embedding.generate'), true)

  serverState.answerLoaded = false
  now = 1_001
  tasks.push({
    id: 10, leaseToken: 'lease', taskType: 'rag.content.extract', processorVersion: 'v1', executionClass: 'cpu',
    input: { schemaVersion: 1, sourceType: 'document', sourceId: 1, sourceVersionId: 'v1', sourceContentSha256: sourceSha256, contentBytes: source.length, format: 'txt' }
  })
  assert.equal(await worker.runOnce(), true)
  assert.equal(completed.length, 1)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.answer.generate'), false)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.embedding.generate'), true)

  serverState.answerLoaded = true
  now = 2_002
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.answer.generate'), true)
})

test('Worker immediately revokes a model after an in-flight endpoint failure and recovers later', async () => {
  const profiles = []
  const failures = []
  let answerLoaded = true
  let now = 0
  let claimCount = 0
  const answer = {
    baseUrl: 'http://127.0.0.1:1234', provider: 'local-provider', modelId: 'answer-model', modelRevision: 'rev-1',
    contextLimit: 4096, maxOutputBytes: 8192, maxEvidenceItems: 4, timeoutMs: 2_000, configHash: 'b'.repeat(64), apiKey: null
  }
  const task = {
    id: 11, leaseToken: 'lease', taskType: 'rag.answer.generate', processorVersion: 'v1', executionClass: 'gpu',
    input: {
      schemaVersion: 1, querySha256: 'c'.repeat(64), query: '问题',
      model: { provider: answer.provider, modelId: answer.modelId, modelRevision: answer.modelRevision, dimensions: 3, configHash: answer.configHash },
      evidence: [{ citationId: 'C1', text: '证据' }]
    }
  }
  const api = {
    enroll: async (_token, value) => {
      profiles.push(value)
      return {
        worker: { id: 'pcw-eject' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z'
      }
    },
    updateProfile: async (_token, value) => profiles.push(value),
    claim: async () => {
      if (claimCount++ === 0) {
        answerLoaded = false
        return task
      }
      return null
    },
    start: async () => {},
    fail: async (_token, _task, code, _summary, retryable) => failures.push({ code, retryable })
  }
  const worker = new PcWorker({
    config: {
      statePath: path.join(os.tmpdir(), 'pc-worker-inflight-eject-state.json'), enrollmentToken: 'enroll', displayName: 'Worker',
      heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000, modelReadinessIntervalMs: 1_000,
      modelReadinessMaxBackoffMs: 4_000, answer
    },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    modelReadinessFactory: (options) => createModelReadiness({ ...options, now: () => now, random: () => 0.5 }),
    loadedModelsProvider: async () => (answerLoaded ? [{ modelKey: answer.modelId }] : []),
    fetchImpl: async (url, options) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/models')) {
        return { ok: true, json: async () => ({ data: answerLoaded ? [{ id: answer.modelId }] : [] }) }
      }
      return answerLoaded
        ? { ok: true, json: async () => ({ model: answer.modelId, choices: [{ message: { content: JSON.stringify({ answer: '结论', abstained: false, citations: ['C1'] }) } }] }) }
        : { ok: false, json: async () => ({}) }
    }
  })

  now = 500
  await assert.rejects(worker.runOnce(), /endpoint rejected|unavailable|model/i)
  assert.deepEqual(failures, [{ code: 'WORKER_MODEL_NOT_READY', retryable: true }])
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.answer.generate'), false)

  answerLoaded = true
  now = 1_501
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.at(-1).capabilities.processors.some((item) => item.taskType === 'rag.answer.generate'), true)
})

test('Worker reports an actively stopped processor as retryable', async () => {
  const failures = []
  let started
  const startPromise = new Promise((resolve) => { started = resolve })
  const answer = {
    baseUrl: 'http://127.0.0.1:1234', provider: 'local-provider', modelId: 'answer-model', modelRevision: 'rev-1',
    contextLimit: 4096, maxOutputBytes: 8192, maxEvidenceItems: 4, timeoutMs: 2_000, configHash: 'b'.repeat(64), apiKey: null
  }
  const task = {
    id: 12, leaseToken: 'lease', taskType: 'rag.answer.generate', processorVersion: 'v1', executionClass: 'gpu',
    input: {
      schemaVersion: 1, querySha256: 'c'.repeat(64), query: '问题',
      model: { provider: answer.provider, modelId: answer.modelId, modelRevision: answer.modelRevision, dimensions: 3, configHash: answer.configHash },
      evidence: [{ citationId: 'C1', text: '证据' }]
    }
  }
  const api = {
    enroll: async () => ({ worker: { id: 'pcw-stop' }, accessToken: 'access', accessExpiresAt: '2999-01-01T00:00:00.000Z', refreshToken: 'refresh', refreshExpiresAt: '2999-02-01T00:00:00.000Z' }),
    updateProfile: async () => {},
    claim: async () => task,
    start: async () => started(),
    complete: async () => { throw new Error('stopped task must not complete') },
    fail: async (_token, _task, code, _summary, retryable) => failures.push({ code, retryable })
  }
  const worker = new PcWorker({
    config: { statePath: path.join(os.tmpdir(), 'pc-worker-stop-state.json'), enrollmentToken: 'enroll', displayName: 'Worker', heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000, answer },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state,
    loadedModelsProvider: async () => [{ modelKey: answer.modelId }],
    answerProcessorFactory: () => ({
      supports: (taskType) => taskType === 'rag.answer.generate',
      process: async (_task, { signal }) => new Promise((_resolve, reject) => {
        const cancel = () => reject(Object.assign(new Error('cancelled'), { code: 'WORKER_PROCESSOR_CANCELLED' }))
        if (signal.aborted) return cancel()
        signal.addEventListener('abort', cancel, { once: true })
      })
    })
  })
  const running = worker.runOnce()
  await startPromise
  worker.stop()
  await assert.rejects(running, /cancelled/u)
  assert.deepEqual(failures, [{ code: 'WORKER_PROCESSOR_CANCELLED', retryable: true }])
})

test('Worker does not retry deterministic reranker contract failures', () => {
  for (const code of [
    'WORKER_RERANK_RESPONSE_INVALID',
    'WORKER_RERANK_RESPONSE_INPUT_MISMATCH',
    'WORKER_RERANK_RESPONSE_COUNT_INVALID'
  ]) {
    assert.deepEqual(classifyWorkerFailure({ code }), {
      code: 'WORKER_PROCESSOR_INPUT_INVALID',
      summary: 'Worker processor input was rejected.',
      retryable: false
    })
  }
  assert.equal(classifyWorkerFailure({ code: 'WORKER_RERANK_TIMEOUT' }).retryable, true)
})
