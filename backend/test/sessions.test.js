import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  createOwnerSession,
  ensureSessionSchema,
  hashSessionToken,
  ownerSessionCookieOptions,
  pruneOwnerSessions,
  resolveOwnerSession,
  revokeAllOwnerSessions,
  revokeOwnerSession
} from '../src/services/sessions.js'

function createTestDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL
    );
    INSERT INTO users (id, username, password)
    VALUES (1, 'owner', 'not-used-by-session-tests');
  `)
  ensureSessionSchema(db)
  return db
}

test('session credentials are stored as hashes and resolve to owner', () => {
  const db = createTestDatabase()
  const now = Date.UTC(2026, 6, 30)
  const session = createOwnerSession(
    db,
    { id: 1, username: 'owner' },
    { now, remember: false, userAgent: 'test-agent' }
  )

  const row = db.prepare(
    'SELECT token_hash, user_agent FROM auth_sessions'
  ).get()
  assert.notEqual(row.token_hash, session.token)
  assert.equal(row.token_hash, hashSessionToken(session.token))
  assert.equal(row.user_agent, 'test-agent')

  const resolved = resolveOwnerSession(db, session.token, { now: now + 1000 })
  assert.deepEqual(resolved.user, {
    id: 1,
    username: 'owner',
    principal: 'owner',
    isGuest: false
  })
  db.close()
})

test('revoked and expired sessions cannot be resolved', () => {
  const db = createTestDatabase()
  const now = Date.UTC(2026, 6, 30)
  const first = createOwnerSession(
    db,
    { id: 1, username: 'owner' },
    { now }
  )

  assert.equal(revokeOwnerSession(db, first.token, now + 1), true)
  assert.equal(resolveOwnerSession(db, first.token, { now: now + 2 }), null)

  const second = createOwnerSession(
    db,
    { id: 1, username: 'owner' },
    { now }
  )
  assert.equal(
    resolveOwnerSession(db, second.token, {
      now: second.idleExpiresAt + 1
    }),
    null
  )
  assert.equal(pruneOwnerSessions(db, second.expiresAt + 1) >= 1, true)
  db.close()
})

test('password-change revocation invalidates all owner sessions', () => {
  const db = createTestDatabase()
  const now = Date.UTC(2026, 6, 30)
  const sessions = [1, 2].map(() => createOwnerSession(
    db,
    { id: 1, username: 'owner' },
    { now, remember: true }
  ))

  assert.equal(revokeAllOwnerSessions(db, 1, now + 1), 2)
  for (const session of sessions) {
    assert.equal(resolveOwnerSession(db, session.token, { now: now + 2 }), null)
  }
  db.close()
})

test('owner cookie is HttpOnly, strict and request-aware for Secure', () => {
  assert.deepEqual(ownerSessionCookieOptions({ secure: false }), {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: undefined
  })
  assert.equal(
    ownerSessionCookieOptions({ secure: true }, true).secure,
    true
  )
})
