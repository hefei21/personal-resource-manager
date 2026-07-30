import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters'
process.env.DATA_PATH = path.resolve(
  import.meta.dirname,
  '../../.codex/test-runtime/unit'
)

const {
  PRINCIPALS,
  authenticateToken,
  generateToken,
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

test('new tokens carry explicit principals', () => {
  const owner = jwt.decode(generateToken({ id: 1, username: 'owner' }))
  const demo = jwt.decode(generateToken({ id: 'demo', username: 'demo' }, true))

  assert.equal(owner.principal, PRINCIPALS.OWNER)
  assert.equal(owner.isGuest, false)
  assert.equal(demo.principal, PRINCIPALS.DEMO)
  assert.equal(demo.isGuest, true)
})

test('legacy tokens are normalized without granting demo owner access', async () => {
  const cases = [
    [{ id: 1, username: 'legacy-owner', isGuest: false }, PRINCIPALS.OWNER],
    [{ id: 'guest', username: 'legacy-demo', isGuest: true }, PRINCIPALS.DEMO]
  ]

  for (const [claims, expectedPrincipal] of cases) {
    const token = jwt.sign(claims, process.env.JWT_SECRET)
    const req = { headers: { authorization: `Bearer ${token}` }, query: {} }
    const res = responseRecorder()

    await new Promise((resolve) => authenticateToken(req, res, resolve))
    assert.equal(req.user.principal, expectedPrincipal)
    assert.equal(req.user.isGuest, expectedPrincipal === PRINCIPALS.DEMO)
    res.listeners.finish?.()
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
