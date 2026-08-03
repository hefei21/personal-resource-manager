import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSafePublicUrl,
  isBlockedAddress,
  normalizePublicDomain
} from '../src/services/outboundRequest.js'

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
const privateResolver = async () => [{ address: '192.168.1.10', family: 4 }]

test('private, loopback and documentation addresses are blocked', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    '2001:db8::1'
  ]) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false)
})

test('public URL validation rejects credentials and unsafe protocols', async () => {
  for (const value of [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'http://user:secret@example.com',
    'http://localhost/admin'
  ]) {
    await assert.rejects(() => assertSafePublicUrl(value, {
      resolver: publicResolver
    }))
  }
})

test('DNS results and exact host allowlists are enforced', async () => {
  await assert.rejects(() => assertSafePublicUrl('https://example.com', {
    resolver: privateResolver
  }), { code: 'OUTBOUND_ADDRESS_FORBIDDEN' })

  await assert.doesNotReject(() => assertSafePublicUrl(
    'https://cdn.example.com/image.jpg',
    { resolver: publicResolver, allowedHosts: ['*.example.com'] }
  ))
  await assert.rejects(() => assertSafePublicUrl(
    'https://example.com.evil.test/image.jpg',
    { resolver: publicResolver, allowedHosts: ['*.example.com'] }
  ), { code: 'OUTBOUND_HOST_NOT_ALLOWED' })
})

test('configurable domains cannot contain URLs, ports or paths', () => {
  assert.equal(normalizePublicDomain('Example.COM'), 'example.com')
  for (const value of [
    'https://example.com',
    'example.com:8443',
    'example.com/path',
    'localhost'
  ]) {
    assert.throws(() => normalizePublicDomain(value))
  }
})
