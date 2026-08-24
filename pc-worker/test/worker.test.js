import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { PcWorker } from '../src/worker.js'

const content = Buffer.from('worker fixture\n', 'utf8')
const sha256 = createHash('sha256').update(content).digest('hex')

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
      embedding
    },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => profile(),
    stateReader: () => null,
    stateWriter: (_path, state) => state
  })
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.length >= 1, true)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.embedding.generate')), true)
  assert.equal(profiles.every((value) => value.capabilities.processors.some((item) => item.taskType === 'rag.query.embed')), true)
})

test('Worker removes stale embedding capabilities when local configuration is absent', async () => {
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
  const worker = new PcWorker({
    config: { statePath: path.join(os.tmpdir(), 'pc-worker-no-embedding-state.json'), enrollmentToken: 'enroll', displayName: 'Worker', heartbeatIntervalMs: 20_000, pollIntervalMs: 1_000 },
    api,
    logger: { info() {}, warn() {} },
    profileProvider: async () => staleProfile,
    stateReader: () => null,
    stateWriter: (_path, state) => state
  })
  assert.equal(await worker.runOnce(), false)
  assert.equal(profiles.every((value) => value.capabilities.processors.every((item) => !item.taskType.startsWith('rag.'))), true)
})
