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
