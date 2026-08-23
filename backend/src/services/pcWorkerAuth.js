import { createHash, randomBytes as defaultRandomBytes, randomUUID as defaultRandomUUID } from 'node:crypto'

import {
  PC_WORKER_CREDENTIAL_TABLE,
  PC_WORKER_ENROLLMENT_TABLE,
  PC_WORKER_TABLE
} from '../config/pcWorkerSchema.js'
import { normalizeWorkerProfile } from './pcWorkerContract.js'

const ACCESS_TTL_MS = 15 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ENROLLMENT_TTL_MS = 10 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 1000
const REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const WORKER_ID_PATTERN = /^pcw-[0-9a-f-]{36}$/u

export const PC_WORKER_TOKEN_TTLS = Object.freeze({
  accessMs: ACCESS_TTL_MS,
  refreshMs: REFRESH_TTL_MS,
  enrollmentMs: ENROLLMENT_TTL_MS
})

export class PcWorkerAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PcWorkerAuthError'
    this.code = code
  }
}

function fail(code, message) {
  throw new PcWorkerAuthError(code, message)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('PC_WORKER_DATABASE_INVALID', 'A migrated SQLite database is required.')
  }
}

function nowDate(now) {
  const raw = typeof now === 'function' ? now() : now ?? new Date()
  const date = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(date.getTime())) fail('PC_WORKER_TIME_INVALID', 'Worker credential time is invalid.')
  return date
}

function addMs(date, duration) {
  return new Date(date.getTime() + duration).toISOString()
}

function tokenHash(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/u.test(token)) {
    fail('PC_WORKER_AUTH_INVALID', 'Worker credential is invalid.')
  }
  return createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex')
}

function generateToken(prefix, randomBytes) {
  let bytes
  try { bytes = randomBytes(32) } catch { fail('PC_WORKER_RANDOM_INVALID', 'Secure worker credential generation failed.') }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    fail('PC_WORKER_RANDOM_INVALID', 'Secure worker credential generation failed.')
  }
  return `${prefix}_${bytes.toString('base64url')}`
}

function credentials(database, workerId, generation, now, randomBytes) {
  const accessToken = generateToken('pcwa', randomBytes)
  const refreshToken = generateToken('pcwr', randomBytes)
  const accessExpiresAt = addMs(now, ACCESS_TTL_MS)
  const refreshExpiresAt = addMs(now, REFRESH_TTL_MS)
  const createdAt = now.toISOString()
  const insert = database.prepare(`
    INSERT INTO ${PC_WORKER_CREDENTIAL_TABLE} (
      token_hash, worker_id, kind, generation, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  insert.run(tokenHash(accessToken), workerId, 'access', generation, accessExpiresAt, createdAt)
  insert.run(tokenHash(refreshToken), workerId, 'refresh', generation, refreshExpiresAt, createdAt)
  return Object.freeze({ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt })
}

function parseCapabilities(value) {
  try { return JSON.parse(value) } catch { fail('PC_WORKER_DATA_INVALID', 'Stored worker capabilities are invalid.') }
}

function projectWorker(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    protocolVersion: row.protocol_version,
    agentVersion: row.agent_version,
    platform: row.platform,
    architecture: row.architecture,
    capabilities: parseCapabilities(row.capabilities_json),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at
  })
}

function pruneCredentialHistory(database, now) {
  const timestamp = now.toISOString()
  const replayCutoff = new Date(now.getTime() - REPLAY_RETENTION_MS).toISOString()
  database.prepare(`DELETE FROM ${PC_WORKER_ENROLLMENT_TABLE}
    WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?)`)
    .run(timestamp, replayCutoff)
  database.prepare(`DELETE FROM ${PC_WORKER_CREDENTIAL_TABLE}
    WHERE (kind = 'access' AND (expires_at <= ? OR revoked_at IS NOT NULL))
       OR (kind = 'refresh' AND (
         expires_at <= ?
         OR (consumed_at IS NOT NULL AND consumed_at <= ?)
         OR (revoked_at IS NOT NULL AND revoked_at <= ?)
       ))`)
    .run(timestamp, timestamp, replayCutoff, replayCutoff)
}

const WORKER_COLUMNS = `
  id, display_name, status, protocol_version, agent_version, platform, architecture,
  capabilities_json, last_seen_at, created_at, updated_at, revoked_at`

export function createWorkerEnrollment(database, options = {}, dependencies = {}) {
  assertDatabase(database)
  if (options && (typeof options !== 'object' || Array.isArray(options)) ||
    Object.keys(options ?? {}).some((key) => key !== 'ttlMs')) {
    fail('PC_WORKER_INPUT_INVALID', 'Enrollment options are invalid.')
  }
  const ttlMs = options.ttlMs ?? ENROLLMENT_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60 * 1000) {
    fail('PC_WORKER_INPUT_INVALID', 'Enrollment lifetime is invalid.')
  }
  const now = nowDate(dependencies.now)
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes
  const token = generateToken('pcwe', randomBytes)
  const expiresAt = addMs(now, ttlMs)
  pruneCredentialHistory(database, now)
  database.prepare(`
    INSERT INTO ${PC_WORKER_ENROLLMENT_TABLE} (token_hash, expires_at, created_at)
    VALUES (?, ?, ?)
  `).run(tokenHash(token), expiresAt, now.toISOString())
  return Object.freeze({ token, expiresAt })
}

export function enrollWorker(database, enrollmentToken, rawProfile, dependencies = {}) {
  assertDatabase(database)
  const profile = normalizeWorkerProfile(rawProfile)
  const now = nowDate(dependencies.now)
  const timestamp = now.toISOString()
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes
  const randomUUID = dependencies.randomUUID ?? defaultRandomUUID
  const workerId = `pcw-${randomUUID()}`
  if (!WORKER_ID_PATTERN.test(workerId)) fail('PC_WORKER_RANDOM_INVALID', 'Worker identifier generation failed.')
  const enrollmentHash = tokenHash(enrollmentToken)
  const outcome = database.transaction(() => {
    const enrollment = database.prepare(`
      SELECT token_hash, expires_at, consumed_at
      FROM ${PC_WORKER_ENROLLMENT_TABLE}
      WHERE token_hash = ?
    `).get(enrollmentHash)
    if (!enrollment || enrollment.consumed_at !== null || enrollment.expires_at <= timestamp) {
      fail('PC_WORKER_ENROLLMENT_INVALID', 'Worker enrollment credential is invalid or expired.')
    }
    const consumed = database.prepare(`
      UPDATE ${PC_WORKER_ENROLLMENT_TABLE}
      SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(timestamp, enrollmentHash, timestamp)
    if (consumed.changes !== 1) fail('PC_WORKER_ENROLLMENT_INVALID', 'Worker enrollment credential is invalid or expired.')
    database.prepare(`
      INSERT INTO ${PC_WORKER_TABLE} (
        id, display_name, status, protocol_version, agent_version, platform, architecture,
        capabilities_json, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workerId,
      profile.displayName,
      profile.protocolVersion,
      profile.agentVersion,
      profile.platform,
      profile.architecture,
      JSON.stringify(profile.capabilities),
      timestamp,
      timestamp,
      timestamp
    )
    return credentials(database, workerId, 1, now, randomBytes)
  }).immediate()
  return Object.freeze({ worker: getWorker(database, workerId), ...outcome })
}

export function refreshWorkerCredentials(database, refreshToken, dependencies = {}) {
  assertDatabase(database)
  const now = nowDate(dependencies.now)
  const timestamp = now.toISOString()
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes
  const hash = tokenHash(refreshToken)
  const outcome = database.transaction(() => {
    pruneCredentialHistory(database, now)
    const row = database.prepare(`
      SELECT c.token_hash, c.worker_id, c.kind, c.generation, c.expires_at,
             c.consumed_at, c.revoked_at, w.status
      FROM ${PC_WORKER_CREDENTIAL_TABLE} c
      JOIN ${PC_WORKER_TABLE} w ON w.id = c.worker_id
      WHERE c.token_hash = ?
    `).get(hash)
    if (!row || row.kind !== 'refresh') return { invalid: true }
    if (row.consumed_at !== null) {
      database.prepare(`UPDATE ${PC_WORKER_TABLE}
        SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'`).run(timestamp, timestamp, row.worker_id)
      database.prepare(`UPDATE ${PC_WORKER_CREDENTIAL_TABLE}
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE worker_id = ?`).run(timestamp, row.worker_id)
      return { replay: true }
    }
    if (row.revoked_at !== null || row.expires_at <= timestamp || row.status !== 'active') return { invalid: true }
    const consumed = database.prepare(`
      UPDATE ${PC_WORKER_CREDENTIAL_TABLE}
      SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).run(timestamp, hash, timestamp)
    if (consumed.changes !== 1) return { invalid: true }
    database.prepare(`
      UPDATE ${PC_WORKER_CREDENTIAL_TABLE}
      SET revoked_at = ?
      WHERE worker_id = ? AND kind = 'access' AND revoked_at IS NULL
    `).run(timestamp, row.worker_id)
    return { workerId: row.worker_id, credentials: credentials(database, row.worker_id, row.generation + 1, now, randomBytes) }
  }).immediate()
  if (outcome.replay) fail('PC_WORKER_REFRESH_REPLAYED', 'Worker refresh credential was replayed; the Worker was revoked.')
  if (outcome.invalid) fail('PC_WORKER_AUTH_INVALID', 'Worker credential is invalid or expired.')
  return Object.freeze({ worker: getWorker(database, outcome.workerId), ...outcome.credentials })
}

export function authenticateWorkerAccess(database, accessToken, dependencies = {}) {
  assertDatabase(database)
  const timestamp = nowDate(dependencies.now).toISOString()
  const row = database.prepare(`
    SELECT c.kind AS credential_kind,
           c.expires_at AS credential_expires_at,
           c.consumed_at AS credential_consumed_at,
           c.revoked_at AS credential_revoked_at,
           ${WORKER_COLUMNS.split(',').map((column) => `w.${column.trim()}`).join(', ')}
    FROM ${PC_WORKER_CREDENTIAL_TABLE} c
    JOIN ${PC_WORKER_TABLE} w ON w.id = c.worker_id
    WHERE c.token_hash = ?
  `).get(tokenHash(accessToken))
  if (!row || row.credential_kind !== 'access' || row.credential_consumed_at !== null ||
    row.credential_revoked_at !== null || row.credential_expires_at <= timestamp || row.status !== 'active') {
    fail('PC_WORKER_AUTH_INVALID', 'Worker credential is invalid or expired.')
  }
  if (row.last_seen_at === null || Date.parse(row.last_seen_at) <= Date.parse(timestamp) - TOUCH_INTERVAL_MS) {
    database.prepare(`UPDATE ${PC_WORKER_TABLE} SET last_seen_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(timestamp, timestamp, row.id)
    row.last_seen_at = timestamp
    row.updated_at = timestamp
  }
  return projectWorker(row)
}

export function updateWorkerProfile(database, workerId, rawProfile, dependencies = {}) {
  assertDatabase(database)
  const profile = normalizeWorkerProfile(rawProfile)
  const timestamp = nowDate(dependencies.now).toISOString()
  const update = database.prepare(`
    UPDATE ${PC_WORKER_TABLE}
    SET display_name = ?, protocol_version = ?, agent_version = ?, platform = ?, architecture = ?,
        capabilities_json = ?, last_seen_at = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(
    profile.displayName,
    profile.protocolVersion,
    profile.agentVersion,
    profile.platform,
    profile.architecture,
    JSON.stringify(profile.capabilities),
    timestamp,
    timestamp,
    workerId
  )
  if (update.changes !== 1) fail('PC_WORKER_NOT_FOUND', 'Active Worker was not found.')
  return getWorker(database, workerId)
}

export function getWorker(database, workerId) {
  assertDatabase(database)
  if (typeof workerId !== 'string' || !WORKER_ID_PATTERN.test(workerId)) fail('PC_WORKER_ID_INVALID', 'Worker identifier is invalid.')
  return projectWorker(database.prepare(`SELECT ${WORKER_COLUMNS} FROM ${PC_WORKER_TABLE} WHERE id = ?`).get(workerId))
}

export function listWorkers(database) {
  assertDatabase(database)
  return Object.freeze(database.prepare(`SELECT ${WORKER_COLUMNS} FROM ${PC_WORKER_TABLE} ORDER BY created_at DESC, id DESC`)
    .all().map(projectWorker))
}

export function revokeWorker(database, workerId, dependencies = {}) {
  assertDatabase(database)
  if (typeof workerId !== 'string' || !WORKER_ID_PATTERN.test(workerId)) fail('PC_WORKER_ID_INVALID', 'Worker identifier is invalid.')
  const timestamp = nowDate(dependencies.now).toISOString()
  const outcome = database.transaction(() => {
    const update = database.prepare(`
      UPDATE ${PC_WORKER_TABLE}
      SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, workerId)
    if (update.changes !== 1) return null
    database.prepare(`
      UPDATE ${PC_WORKER_CREDENTIAL_TABLE}
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE worker_id = ?
    `).run(timestamp, workerId)
    return getWorker(database, workerId)
  }).immediate()
  return outcome
}
