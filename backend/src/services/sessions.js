import crypto from 'node:crypto'

export const OWNER_SESSION_COOKIE = 'pr_owner_session'

const DEFAULT_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000
const REMEMBER_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000
const REMEMBER_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 5 * 60 * 1000
const initializedDatabases = new WeakSet()

export function ensureSessionSchema(db) {
  if (initializedDatabases.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      principal TEXT NOT NULL CHECK (principal = 'owner'),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
      ON auth_sessions(user_id, revoked_at);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at, idle_expires_at);
  `)
  initializedDatabases.add(db)
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function createOwnerSession(db, user, options = {}) {
  ensureSessionSchema(db)
  const now = options.now ?? Date.now()
  const remember = options.remember === true
  const token = createSessionToken()
  const tokenHash = hashSessionToken(token)
  const absoluteTtl = remember
    ? REMEMBER_ABSOLUTE_TTL_MS
    : DEFAULT_ABSOLUTE_TTL_MS
  const idleTtl = remember ? REMEMBER_IDLE_TTL_MS : DEFAULT_IDLE_TTL_MS

  db.prepare(`
    INSERT INTO auth_sessions (
      token_hash,
      user_id,
      principal,
      created_at,
      last_seen_at,
      idle_expires_at,
      expires_at,
      user_agent
    ) VALUES (?, ?, 'owner', ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    user.id,
    now,
    now,
    now + idleTtl,
    now + absoluteTtl,
    options.userAgent?.slice(0, 512) || null
  )

  return {
    token,
    expiresAt: now + absoluteTtl,
    idleExpiresAt: now + idleTtl
  }
}

export function resolveOwnerSession(db, token, options = {}) {
  if (!token || typeof token !== 'string') return null

  ensureSessionSchema(db)
  const now = options.now ?? Date.now()
  const tokenHash = hashSessionToken(token)
  const session = db.prepare(`
    SELECT
      s.token_hash,
      s.user_id,
      s.principal,
      s.last_seen_at,
      s.idle_expires_at,
      s.expires_at,
      u.username
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND s.idle_expires_at > ?
  `).get(tokenHash, now, now)

  if (!session || session.principal !== 'owner') return null

  if (session.last_seen_at <= now - TOUCH_INTERVAL_MS) {
    const idleTtl = Math.min(
      session.idle_expires_at - session.last_seen_at,
      session.expires_at - now
    )
    db.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?, idle_expires_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now, now + idleTtl, tokenHash)
  }

  return {
    tokenHash,
    user: {
      id: session.user_id,
      username: session.username,
      principal: 'owner',
      isGuest: false
    }
  }
}

export function revokeOwnerSession(db, token, now = Date.now()) {
  if (!token || typeof token !== 'string') return false
  ensureSessionSchema(db)
  const result = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(now, hashSessionToken(token))
  return result.changes > 0
}

export function revokeAllOwnerSessions(db, userId, now = Date.now()) {
  ensureSessionSchema(db)
  const result = db.prepare(`
    UPDATE auth_sessions
    SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).run(now, userId)
  return result.changes
}

export function pruneOwnerSessions(db, now = Date.now()) {
  ensureSessionSchema(db)
  return db.prepare(`
    DELETE FROM auth_sessions
    WHERE expires_at <= ?
       OR idle_expires_at <= ?
       OR (revoked_at IS NOT NULL AND revoked_at <= ?)
  `).run(now, now, now - 7 * 24 * 60 * 60 * 1000).changes
}

export function ownerSessionCookieOptions(req, remember = false) {
  const configuredSecure = process.env.SESSION_COOKIE_SECURE
  const secure = configuredSecure === 'true' ||
    (configuredSecure !== 'false' && req.secure === true)

  return {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: remember ? REMEMBER_ABSOLUTE_TTL_MS : undefined
  }
}

export function clearOwnerSessionCookieOptions(req) {
  const { maxAge, ...options } = ownerSessionCookieOptions(req)
  return options
}
