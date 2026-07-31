import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import {
  initializeOwner,
  initializePrivateSetting,
  resolveOwnerBootstrap,
  resolvePrivateBootstrap,
  retireLegacyTestUser,
  validateBootstrapPassword
} from '../src/services/bootstrapSecurity.js'

function createTestDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
    CREATE TABLE private_settings (
      id INTEGER PRIMARY KEY,
      password TEXT NOT NULL
    );
  `)
  return db
}

test('existing installations do not require bootstrap credentials again', () => {
  assert.equal(resolveOwnerBootstrap({}, 1), null)
  assert.equal(resolvePrivateBootstrap({}, true), null)
})

test('new installations reject missing and known weak passwords', () => {
  assert.throws(
    () => resolveOwnerBootstrap({}, 0),
    { code: 'BOOTSTRAP_PASSWORD_REQUIRED' }
  )
  assert.throws(
    () => validateBootstrapPassword('admin123', 'DEFAULT_PASSWORD'),
    { code: 'BOOTSTRAP_PASSWORD_WEAK' }
  )
  assert.throws(
    () => resolvePrivateBootstrap({ PRIVATE_PASSWORD: '123456' }, false),
    { code: 'BOOTSTRAP_PASSWORD_WEAK' }
  )
})

test('new owner bootstrap rejects the retired test username', () => {
  assert.throws(
    () => resolveOwnerBootstrap({
      DEFAULT_USERNAME: 'test',
      DEFAULT_PASSWORD: 'safe-random-password-123'
    }, 0),
    { code: 'BOOTSTRAP_USERNAME_INVALID' }
  )
})

test('strong bootstrap credentials are returned without logging secrets', () => {
  assert.deepEqual(resolveOwnerBootstrap({
    DEFAULT_USERNAME: 'owner',
    DEFAULT_PASSWORD: 'safe-random-password-123'
  }, 0), {
    username: 'owner',
    password: 'safe-random-password-123'
  })
  assert.equal(resolvePrivateBootstrap({
    PRIVATE_PASSWORD: 'different-random-password-456'
  }, false), 'different-random-password-456')
})

test('database bootstrap creates one owner and never creates a test user', () => {
  const db = createTestDatabase()
  const env = {
    DEFAULT_USERNAME: 'owner',
    DEFAULT_PASSWORD: 'safe-random-password-123',
    PRIVATE_PASSWORD: 'different-random-password-456'
  }

  assert.equal(initializeOwner(db, env), 'owner')
  assert.equal(initializePrivateSetting(db, env), true)
  assert.deepEqual(
    db.prepare('SELECT username FROM users').all().map(row => row.username),
    ['owner']
  )
  assert.equal(initializeOwner(db, {}), null)
  assert.equal(initializePrivateSetting(db, {}), false)
  db.close()
})

test('known legacy fixed test users are retired without affecting the owner', () => {
  const db = createTestDatabase()
  initializeOwner(db, {
    DEFAULT_USERNAME: 'owner',
    DEFAULT_PASSWORD: 'safe-random-password-123'
  })
  db.prepare(
    "INSERT INTO users (username, password) VALUES ('test', ?)"
  ).run(bcrypt.hashSync('123456', 4))

  assert.equal(retireLegacyTestUser(db, {}), true)
  assert.deepEqual(
    db.prepare('SELECT username FROM users ORDER BY id').all()
      .map(row => row.username),
    ['owner']
  )
  db.close()
})
