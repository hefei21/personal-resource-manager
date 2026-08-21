import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyNetworkTaskFailure, taskNetworkError } from '../src/services/networkTaskError.js'

test('network failure classifier distinguishes Clash DNS and connection failures', () => {
  const dns = classifyNetworkTaskFailure(Object.assign(
    new Error('getaddrinfo ENOTFOUND clash https://user:secret@example.test'),
    { code: 'ENOTFOUND', hostname: 'clash' }
  ))
  assert.deepEqual(dns, {
    code: 'PROXY_DNS_FAILED',
    summary: '代理服务名称无法解析，请检查容器网络。',
    retryable: true,
    causeCategory: 'PROXY_DNS'
  })

  const connection = classifyNetworkTaskFailure(Object.assign(
    new Error('connect ECONNREFUSED clash:7890'),
    { code: 'ECONNREFUSED', host: 'clash' }
  ))
  assert.equal(connection.code, 'PROXY_CONNECTION_FAILED')
  assert.equal(connection.causeCategory, 'PROXY_CONNECTION')
})

test('network task errors expose only stable public fields', () => {
  const source = Object.assign(
    new Error('getaddrinfo ENOTFOUND clash https://user:secret@example.test/private'),
    { code: 'ENOTFOUND', hostname: 'clash', stderr: 'token=private' }
  )
  const error = taskNetworkError(source, {
    code: 'REMOTE_NETWORK_FAILED',
    summary: '远程请求失败。',
    retryable: true
  })
  assert.equal(error.code, 'PROXY_DNS_FAILED')
  assert.equal(error.causeCategory, 'PROXY_DNS')
  assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /user|secret|example|private|token/iu)
})
