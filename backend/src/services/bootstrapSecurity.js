import bcrypt from 'bcryptjs'

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12
const RESERVED_OWNER_NAMES = new Set(['test'])
const KNOWN_WEAK_PASSWORDS = new Set([
  '123456',
  'admin123',
  'password',
  'change-this-password',
  'replace-with-a-random-password'
])

function configurationError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function validateBootstrapPassword(password, variableName) {
  if (!password) {
    throw configurationError(
      `首次初始化前必须设置 ${variableName}`,
      'BOOTSTRAP_PASSWORD_REQUIRED'
    )
  }

  if (
    password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH ||
    KNOWN_WEAK_PASSWORDS.has(password.toLowerCase())
  ) {
    throw configurationError(
      `${variableName} 必须至少 12 位且不能使用已知弱密码`,
      'BOOTSTRAP_PASSWORD_WEAK'
    )
  }

  return password
}

export function resolveOwnerBootstrap(env, existingUserCount) {
  if (existingUserCount > 0) return null

  const username = String(env.DEFAULT_USERNAME || 'admin').trim()
  if (!username || RESERVED_OWNER_NAMES.has(username.toLowerCase())) {
    throw configurationError(
      'DEFAULT_USERNAME 不能为空或使用保留测试账号名',
      'BOOTSTRAP_USERNAME_INVALID'
    )
  }

  return {
    username,
    password: validateBootstrapPassword(
      env.DEFAULT_PASSWORD,
      'DEFAULT_PASSWORD'
    )
  }
}

function insertOwner(database, credentials) {
  const hashedPassword = bcrypt.hashSync(credentials.password, 10)
  database.prepare(
    'INSERT INTO users (username, password) VALUES (?, ?)'
  ).run(credentials.username, hashedPassword)
  return credentials.username
}

export function retireLegacyTestUser(database, env) {
  const legacyUser = database.prepare(
    "SELECT id, password FROM users WHERE username = 'test'"
  ).get()
  if (!legacyUser || !bcrypt.compareSync('123456', legacyUser.password)) {
    return false
  }

  const otherUsers = database.prepare(
    'SELECT COUNT(*) AS count FROM users WHERE id != ?'
  ).get(legacyUser.id).count

  if (otherUsers === 0) {
    insertOwner(database, resolveOwnerBootstrap(env, 0))
  }

  database.prepare('DELETE FROM users WHERE id = ?').run(legacyUser.id)
  return true
}

export function initializeOwner(database, env) {
  const userCount = database.prepare(
    'SELECT COUNT(*) AS count FROM users'
  ).get().count
  const credentials = resolveOwnerBootstrap(env, userCount)
  return credentials ? insertOwner(database, credentials) : null
}
