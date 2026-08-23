import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureNoProxyForUrl, loadConfig } from '../src/config.js'

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
