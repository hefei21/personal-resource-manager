import assert from 'node:assert/strict'
import test from 'node:test'

import { collectLoadedModels, collectProfile } from '../src/telemetry.js'
import { normalizeWorkerProfile } from '../../backend/src/services/pcWorkerContract.js'

test('loaded model telemetry never falls back to a local path as model identity', async () => {
  let calls = 0
  const models = await collectLoadedModels(async (command, args) => {
    calls += 1
    assert.equal(command, 'lms')
    assert.deepEqual(args, ['ps', '--json'])
    return {
      stdout: JSON.stringify([
        { path: 'C:\\private\\downloaded-model.gguf', estimatedVramUsageBytes: 123 },
        { modelKey: 'file:///private/secret' },
        { identifier: 'https://private.example/model' },
        { modelKey: 'answer-model', identifier: 'answer-identifier' },
        { identifier: 'embedding-model' }
      ])
    }
  })

  assert.equal(calls, 1)
  assert.equal(models[0].id, 'unknown')
  assert.equal(Object.hasOwn(models[0], 'path'), false)
  assert.equal(models[1].id, 'unknown')
  assert.equal(models[2].id, 'unknown')
  assert.equal(models[3].id, 'answer-model')
  assert.equal(models[3].modelKey, 'answer-model')
  assert.equal(models[3].identifier, 'answer-identifier')
  assert.equal(models[4].id, 'embedding-model')
})

test('collectProfile projects loaded model telemetry through the backend contract', async () => {
  const profile = await collectProfile('worker-a', {
    execFile: async (command, args) => {
      if (command === 'nvidia-smi') {
        assert.deepEqual(args, [
          '--query-gpu=name,memory.total,memory.free,driver_version',
          '--format=csv,noheader,nounits'
        ])
        return { stdout: 'RTX 5080, 16384, 12000, 555.1\n' }
      }
      assert.equal(command, 'lms')
      assert.deepEqual(args, ['ps', '--json'])
      return {
        stdout: JSON.stringify([{
          path: 'C:\\private\\nomic.gguf',
          modelKey: 'nomic-embed-text-v1.5',
          identifier: 'private-local-identifier',
          quantization: { name: 'Q4_K_M' },
          estimatedVramUsageBytes: 1024
        }])
      }
    }
  })

  const loadedModel = profile.capabilities.resources.loadedModels[0]
  assert.deepEqual(Object.keys(loadedModel).sort(), ['backend', 'id', 'memoryBytes', 'version'])
  assert.equal(Object.hasOwn(loadedModel, 'modelKey'), false)
  assert.equal(Object.hasOwn(loadedModel, 'identifier'), false)
  assert.equal(Object.hasOwn(loadedModel, 'path'), false)
  const normalized = normalizeWorkerProfile(profile)
  assert.deepEqual(normalized.capabilities.resources.loadedModels[0], loadedModel)
})
