import {
  CREATE_STORAGE_COMMIT_OPERATIONS_SQL,
  STORAGE_COMMIT_OPERATION_TABLE
} from '../config/storageCommitSchema.js'

export { CREATE_STORAGE_COMMIT_OPERATIONS_SQL }

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const STORAGE_OPERATION_TABLE = STORAGE_COMMIT_OPERATION_TABLE

export const STORAGE_COMMIT_STAGED = 'staged'
export const STORAGE_COMMIT_OBJECT_COMMITTED = 'object_committed'
export const STORAGE_COMMIT_DATABASE_COMMITTED = 'database_committed'
export const STORAGE_COMMIT_ORPHANED = 'orphaned'

const TERMINAL_STATES = new Set([STORAGE_COMMIT_DATABASE_COMMITTED])

export class StorageCommitError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'StorageCommitError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new StorageCommitError(code, message, cause ? { cause } : undefined)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('STORAGE_COMMIT_DATABASE_INVALID', 'A SQLite database connection is required.')
  }
}

function assertIdempotencyKey(value) {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value ?? '')) {
    fail('STORAGE_COMMIT_IDEMPOTENCY_KEY_INVALID', 'Storage commit idempotency key is invalid.')
  }
  return value
}

function nowText(now) {
  const value = typeof now === 'function' ? now() : new Date()
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('STORAGE_COMMIT_TIME_INVALID', 'Storage commit time is invalid.')
  }
  return value.toISOString()
}

function row(database, idempotencyKey) {
  return database.prepare(`
    SELECT idempotency_key, state, staging_token, storage_key, sha256, bytes,
           error_code, created_at, updated_at
      FROM ${STORAGE_OPERATION_TABLE}
     WHERE idempotency_key = ?
  `).get(idempotencyKey)
}

function publicOperation(value) {
  if (!value) return null
  return Object.freeze({
    idempotencyKey: value.idempotency_key,
    state: value.state,
    stagingToken: value.staging_token,
    storageKey: value.storage_key,
    sha256: value.sha256,
    bytes: value.bytes,
    errorCode: value.error_code,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  })
}

export function getStorageCommitOperation(database, idempotencyKey) {
  assertDatabase(database)
  assertIdempotencyKey(idempotencyKey)
  try { return publicOperation(row(database, idempotencyKey)) } catch (error) {
    if (error instanceof StorageCommitError) throw error
    fail('STORAGE_COMMIT_LEDGER_UNAVAILABLE', 'Storage commit ledger is unavailable.', error)
  }
}

function beginOperation(database, input, now) {
  const existing = getStorageCommitOperation(database, input.idempotencyKey)
  if (existing) {
    if (existing.stagingToken !== input.stagingToken) {
      fail('STORAGE_COMMIT_IDEMPOTENCY_CONFLICT', 'Idempotency key is bound to another staging token.')
    }
    return existing
  }
  const timestamp = nowText(now)
  try {
    database.prepare(`
      INSERT INTO ${STORAGE_OPERATION_TABLE}
        (idempotency_key, state, staging_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.idempotencyKey, STORAGE_COMMIT_STAGED, input.stagingToken, timestamp, timestamp)
  } catch (error) {
    fail('STORAGE_COMMIT_LEDGER_WRITE_FAILED', 'Storage commit operation could not be started.', error)
  }
  return getStorageCommitOperation(database, input.idempotencyKey)
}

function recordObject(database, operation, committed, now) {
  const timestamp = nowText(now)
  try {
    database.prepare(`
      UPDATE ${STORAGE_OPERATION_TABLE}
         SET state = ?, storage_key = ?, sha256 = ?, bytes = ?, error_code = NULL, updated_at = ?
       WHERE idempotency_key = ? AND state = ?
    `).run(
      STORAGE_COMMIT_OBJECT_COMMITTED,
      committed.storageKey,
      committed.sha256,
      committed.bytes,
      timestamp,
      operation.idempotencyKey,
      STORAGE_COMMIT_STAGED
    )
  } catch (error) {
    fail('STORAGE_COMMIT_LEDGER_WRITE_FAILED', 'Committed object could not be recorded.', error)
  }
  return getStorageCommitOperation(database, operation.idempotencyKey)
}

function markOrphaned(database, operation, errorCode, now) {
  if (!/^[A-Z][A-Z0-9_.-]{0,127}$/.test(errorCode ?? '')) {
    errorCode = 'DATABASE_COMMIT_FAILED'
  }
  try {
    database.prepare(`
      UPDATE ${STORAGE_OPERATION_TABLE}
         SET state = ?, error_code = ?, updated_at = ?
       WHERE idempotency_key = ? AND state IN (?, ?)
    `).run(
      STORAGE_COMMIT_ORPHANED,
      errorCode,
      nowText(now),
      operation.idempotencyKey,
      STORAGE_COMMIT_OBJECT_COMMITTED,
      STORAGE_COMMIT_ORPHANED
    )
  } catch (error) {
    fail('STORAGE_COMMIT_LEDGER_WRITE_FAILED', 'Orphaned object could not be recorded.', error)
  }
}

function commitDatabase(database, operation, writeDatabase, now) {
  if (typeof writeDatabase !== 'function') {
    fail('STORAGE_COMMIT_CALLBACK_INVALID', 'Database commit callback is required.')
  }
  try {
    database.transaction(() => {
      const callbackResult = writeDatabase(Object.freeze({
        storageKey: operation.storageKey,
        sha256: operation.sha256,
        bytes: operation.bytes,
        idempotencyKey: operation.idempotencyKey
      }))
      if (callbackResult && typeof callbackResult.then === 'function') {
        fail('STORAGE_COMMIT_CALLBACK_ASYNC', 'Database commit callback must be synchronous.')
      }
      const result = database.prepare(`
        UPDATE ${STORAGE_OPERATION_TABLE}
           SET state = ?, error_code = NULL, updated_at = ?
         WHERE idempotency_key = ? AND state IN (?, ?)
      `).run(
        STORAGE_COMMIT_DATABASE_COMMITTED,
        nowText(now),
        operation.idempotencyKey,
        STORAGE_COMMIT_OBJECT_COMMITTED,
        STORAGE_COMMIT_ORPHANED
      )
      if (result.changes !== 1) {
        fail('STORAGE_COMMIT_STATE_CONFLICT', 'Storage commit operation is not ready for database commit.')
      }
    })()
  } catch (error) {
    if (error instanceof StorageCommitError) throw error
    throw error
  }
  return getStorageCommitOperation(database, operation.idempotencyKey)
}

export async function coordinateStorageCommit(options = {}) {
  const { database, storageService, writeDatabase, now } = options
  assertDatabase(database)
  if (!storageService || typeof storageService.commitStaged !== 'function') {
    fail('STORAGE_COMMIT_SERVICE_INVALID', 'Storage service is required.')
  }
  const input = {
    idempotencyKey: assertIdempotencyKey(options.idempotencyKey),
    stagingToken: options.stagingToken
  }
  let operation = beginOperation(database, input, now)
  if (TERMINAL_STATES.has(operation.state)) return operation

  if (operation.state === STORAGE_COMMIT_STAGED) {
    const committed = await storageService.commitStaged({
      token: operation.stagingToken,
      kind: options.kind,
      expectedSha256: options.expectedSha256,
      expectedBytes: options.expectedBytes
    })
    operation = recordObject(database, operation, committed, now)
  }

  try {
    return commitDatabase(database, operation, writeDatabase, now)
  } catch (error) {
    try {
      markOrphaned(database, operation, error?.code, now)
    } catch (orphanError) {
      fail(
        'STORAGE_COMMIT_COMPENSATION_FAILED',
        'Database commit and orphan compensation both failed.',
        new AggregateError([error, orphanError], 'storage commit compensation failed')
      )
    }
    fail('STORAGE_COMMIT_DATABASE_FAILED', 'Database commit failed after object commit.', error)
  }
}

export const storageCommitOperationTable = STORAGE_OPERATION_TABLE
