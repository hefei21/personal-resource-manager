import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configuredAllowedOrigins,
  enforceOwnerRequestOrigin,
  isTrustedRequestOrigin
} from '../src/middlewares/requestOrigin.js'

function request(overrides = {}) {
  const headers = Object.fromEntries(
    Object.entries(overrides.headers || {})
      .map(([name, value]) => [name.toLowerCase(), value])
  )

  return {
    method: 'POST',
    protocol: 'https',
    cookies: { pr_owner_session: 'opaque-owner-session' },
    get(name) {
      return headers[name.toLowerCase()]
    },
    ...overrides,
    headers
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

function runMiddleware(req) {
  const res = responseRecorder()
  let called = false
  enforceOwnerRequestOrigin(req, res, () => {
    called = true
  })
  return { res, called }
}

test('safe requests and requests without an owner cookie bypass CSRF checks', () => {
  assert.equal(runMiddleware(request({ method: 'GET' })).called, true)
  assert.equal(runMiddleware(request({ cookies: {} })).called, true)
})

test('owner cookie writes require a verifiable source origin', () => {
  const missing = runMiddleware(request({ headers: { host: 'nas.test' } }))
  assert.equal(missing.called, false)
  assert.equal(missing.res.statusCode, 403)
  assert.equal(missing.res.payload.code, 'ORIGIN_REQUIRED')
})

test('same-origin owner writes are accepted', () => {
  const result = runMiddleware(request({
    headers: {
      host: 'nas.test',
      origin: 'https://nas.test'
    }
  }))
  assert.equal(result.called, true)
})

test('configured origins use exact URL origins and never wildcard matching', () => {
  const env = {
    CORS_ORIGIN: 'https://app.example.com, *, invalid-value'
  }
  assert.deepEqual(
    [...configuredAllowedOrigins(env)],
    ['https://app.example.com']
  )

  const req = request({ headers: { host: 'nas.test' } })
  assert.equal(
    isTrustedRequestOrigin(req, 'https://app.example.com/path', env),
    true
  )
  assert.equal(
    isTrustedRequestOrigin(req, 'https://app.example.com.evil.test', env),
    false
  )
})

test('foreign origins are rejected for owner cookie writes', () => {
  const result = runMiddleware(request({
    headers: {
      host: 'nas.test',
      origin: 'https://evil.test'
    }
  }))
  assert.equal(result.called, false)
  assert.equal(result.res.statusCode, 403)
  assert.equal(result.res.payload.code, 'ORIGIN_FORBIDDEN')
})

test('an opaque Origin cannot fall back to a trusted Referer', () => {
  const result = runMiddleware(request({
    headers: {
      host: 'nas.test',
      origin: 'null',
      referer: 'https://nas.test/app'
    }
  }))
  assert.equal(result.called, false)
  assert.equal(result.res.payload.code, 'ORIGIN_REQUIRED')
})
