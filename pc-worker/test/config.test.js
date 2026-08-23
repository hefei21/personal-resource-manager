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
  assert.equal(parentProcessIdFromCommandLine(['--parent-pid', '1234']), 1234)
  assert.equal(parentProcessIdFromCommandLine([]), null)
  assert.throws(
    () => parentProcessIdFromCommandLine(['--parent-pid', 'invalid']),
    (error) => error.code === 'WORKER_CONFIG_INVALID'
  )
})
