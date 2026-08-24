import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyCommandLineConfig,
  ensureNoProxyForUrl,
  loadConfig,
  parentProcessIdFromCommandLine
} from '../src/config.js'

test('Worker adds the NAS host to both proxy bypass variables without losing existing entries', () => {
  const env = {
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'example.test,LOCALHOST'
  }

  const value = ensureNoProxyForUrl(env, 'http://192.168.2.106:15375')

  assert.equal(value, 'localhost,127.0.0.1,example.test,192.168.2.106')
  assert.equal(env.NO_PROXY, value)
  assert.equal(env.no_proxy, value)
})

test('Worker proxy bypass uses the normalized configured NAS hostname', () => {
  const env = {}
  const config = loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://NAS.EXAMPLE.test/',
    LOCALAPPDATA: 'C:\\worker-test'
  })

  assert.equal(ensureNoProxyForUrl(env, config.baseUrl), 'nas.example.test')
})

test('Worker accepts a non-secret NAS base URL from the scheduled-task command line', () => {
  const env = {}

  applyCommandLineConfig(env, ['--nas-base-url', 'https://stage5.example.test'])

  assert.equal(env.PC_WORKER_NAS_BASE_URL, 'https://stage5.example.test')
})

test('Worker rejects a missing scheduled-task NAS base URL value', () => {
  assert.throws(
    () => applyCommandLineConfig({}, ['--nas-base-url']),
    (error) => error.code === 'WORKER_CONFIG_INVALID'
  )
})

test('Worker validates the hidden wrapper parent process id', () => {
  assert.equal(parentProcessIdFromCommandLine(['--watch-parent'], 4321), 4321)
  assert.equal(parentProcessIdFromCommandLine(['--parent-pid', '1234']), 1234)
  assert.equal(parentProcessIdFromCommandLine([]), null)
  assert.throws(
    () => parentProcessIdFromCommandLine(['--parent-pid', 'invalid']),
    (error) => error.code === 'WORKER_CONFIG_INVALID'
  )
})

test('Worker only enables explicit complete embedding configuration', () => {
  const disabled = loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
    LOCALAPPDATA: 'C:\\worker-test'
  })
  assert.equal(disabled.embedding, null)
  assert.equal(disabled.answer, null)

  const enabled = loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
    PC_WORKER_EMBEDDINGS_BASE_URL: 'http://127.0.0.1:1234',
    PC_WORKER_EMBEDDINGS_PROVIDER: 'local-provider',
    PC_WORKER_EMBEDDINGS_MODEL_ID: 'embedding-model',
    PC_WORKER_EMBEDDINGS_MODEL_REVISION: 'rev-1',
    PC_WORKER_EMBEDDINGS_DIMENSIONS: '3',
    PC_WORKER_EMBEDDINGS_CONFIG_HASH: 'a'.repeat(64),
    LOCALAPPDATA: 'C:\\worker-test'
  })
  assert.equal(enabled.embedding.baseUrl, 'http://127.0.0.1:1234')
  assert.equal(enabled.embedding.modelId, 'embedding-model')
  assert.equal(enabled.embedding.dimensions, 3)
  assert.equal(Object.isFrozen(enabled.embedding), true)
  const answerEnabled = loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
    PC_WORKER_ANSWER_BASE_URL: 'http://127.0.0.1:1234',
    PC_WORKER_ANSWER_MODEL_ID: 'answer-model',
    PC_WORKER_ANSWER_MODEL_REVISION: 'q6-revision-1',
    PC_WORKER_ANSWER_CONTEXT_LIMIT: '4096',
    PC_WORKER_ANSWER_MAX_OUTPUT_BYTES: '8192',
    LOCALAPPDATA: 'C:\\worker-test'
  })
  assert.equal(answerEnabled.answer.baseUrl, 'http://127.0.0.1:1234')
  assert.equal(answerEnabled.answer.modelId, 'answer-model')
  assert.equal(answerEnabled.answer.contextLimit, 4096)
  assert.equal(answerEnabled.answer.maxOutputBytes, 8192)
  assert.match(answerEnabled.answer.configHash, /^[a-f0-9]{64}$/u)
  assert.equal(Object.isFrozen(answerEnabled.answer), true)
  assert.throws(() => loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
    PC_WORKER_EMBEDDINGS_BASE_URL: 'https://worker.example.test',
    PC_WORKER_EMBEDDINGS_MODEL_ID: 'embedding-model',
    LOCALAPPDATA: 'C:\\worker-test'
  }), (error) => error.code === 'WORKER_CONFIG_INVALID')
  assert.throws(() => loadConfig({
    PC_WORKER_NAS_BASE_URL: 'https://nas.example.test',
    PC_WORKER_ANSWER_BASE_URL: 'https://worker.example.test',
    PC_WORKER_ANSWER_MODEL_ID: 'answer-model',
    PC_WORKER_ANSWER_MODEL_REVISION: 'q6-revision-1',
    PC_WORKER_ANSWER_CONTEXT_LIMIT: '4096',
    LOCALAPPDATA: 'C:\\worker-test'
  }), (error) => error.code === 'WORKER_CONFIG_INVALID')
})
