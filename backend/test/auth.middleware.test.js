import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters'
process.env.DATA_PATH = path.resolve(
  import.meta.dirname,
  '../../.codex/test-runtime/unit'
)

const {
  PRINCIPALS,
  LEGACY_DEMO_COOKIE,
  authenticateToken,
  generateDemoToken,
  requireOwner,
  requireWritePermission
} = await import('../src/middlewares/auth.js')

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    listeners: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    },
    on(event, listener) {
      this.listeners[event] = listener
    }
  }
}

test('legacy demo cookie authenticates only as demo', async () => {
  const token = generateDemoToken({ id: 'demo', username: 'demo' })
  const req = {
    cookies: { [LEGACY_DEMO_COOKIE]: token },
    headers: {},
    query: {}
  }
  const res = responseRecorder()

  await new Promise((resolve) => authenticateToken(req, res, resolve))
  assert.equal(req.user.principal, PRINCIPALS.DEMO)
  assert.equal(req.user.isGuest, true)
  assert.equal(req.auth.type, 'legacy_demo_cookie')
  res.listeners.finish?.()
})

test('bearer and URL tokens are not authentication mechanisms', () => {
  const token = generateDemoToken({ id: 'demo', username: 'demo' })

  for (const req of [
    { cookies: {}, headers: { authorization: `Bearer ${token}` }, query: {} },
    { cookies: {}, headers: {}, query: { token } }
  ]) {
    const res = responseRecorder()
    let called = false
    authenticateToken(req, res, () => {
      called = true
    })
    assert.equal(called, false)
    assert.equal(res.statusCode, 401)
  }
})

test('owner guards reject demo principals', () => {
  for (const guard of [requireOwner, requireWritePermission]) {
    const req = {
      user: { id: 'demo', principal: PRINCIPALS.DEMO, isGuest: true }
    }
    const res = responseRecorder()
    let called = false

    guard(req, res, () => {
      called = true
    })

    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
    assert.equal(res.payload.code, 'OWNER_REQUIRED')
  }
})

test('owner guards allow owner principals', () => {
  const req = {
    user: { id: 1, principal: PRINCIPALS.OWNER, isGuest: false }
  }
  const res = responseRecorder()
  let called = false

  requireOwner(req, res, () => {
    called = true
  })

  assert.equal(called, true)
  assert.equal(res.statusCode, 200)
})
