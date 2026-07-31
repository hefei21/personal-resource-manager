import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH = path.resolve(
  import.meta.dirname,
  '../../.codex/test-runtime/unit'
)

const {
  PRINCIPALS,
  authenticateToken,
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

test('production authentication rejects demo, bearer and URL credentials', () => {
  for (const req of [
    { cookies: { pr_demo_session: 'opaque-demo-token' }, headers: {}, query: {} },
    { cookies: {}, headers: { authorization: 'Bearer legacy-token' }, query: {} },
    { cookies: {}, headers: {}, query: { token: 'legacy-token' } }
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
