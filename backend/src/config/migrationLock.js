import { createRequire } from 'node:module'
import path from 'node:path'

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5000
export const MIN_MIGRATION_LOCK_TIMEOUT_MS = 100
export const MAX_MIGRATION_LOCK_TIMEOUT_MS = 30000

export const MIGRATION_LOCK_BUSY = 'MIGRATION_LOCK_BUSY'
export const MIGRATION_LOCK_IO_ERROR = 'MIGRATION_LOCK_IO_ERROR'

export const MIGRATION_LOCK_ACTIVE = 'active'
export const MIGRATION_LOCK_RELEASING = 'releasing'
export const MIGRATION_LOCK_RELEASED = 'released'

const require = createRequire(import.meta.url)
let Database

/**
 * Error boundary for the side-car lock. The public message intentionally does
 * not contain either the main database path or the derived lock path.
 */
export class MigrationLockError extends Error {
  constructor(code, message, cause) {
    super(message, { cause })
    this.name = 'MigrationLockError'
    this.code = code
  }
}

export function normalizeMigrationLockTimeout(value = DEFAULT_MIGRATION_LOCK_TIMEOUT_MS) {
  if (
    !Number.isInteger(value) ||
    value < MIN_MIGRATION_LOCK_TIMEOUT_MS ||
    value > MAX_MIGRATION_LOCK_TIMEOUT_MS
  ) {
    throw new RangeError(
      `migration lock timeout must be an integer between ${MIN_MIGRATION_LOCK_TIMEOUT_MS} and ${MAX_MIGRATION_LOCK_TIMEOUT_MS} milliseconds`
    )
  }

  return value
}

export function normalizeMainDbPath(mainDbPath) {
  if (typeof mainDbPath !== 'string' || mainDbPath.trim() === '') {
    throw new TypeError('mainDbPath must be a non-empty path string')
  }

  return path.resolve(mainDbPath)
}

export function deriveMigrationLockPath(mainDbPath) {
  return `${normalizeMainDbPath(mainDbPath)}.migration-lock.sqlite`
}

function loadDatabase() {
  if (!Database) {
    Database = require('better-sqlite3')
  }

  return Database
}

export function isMigrationLockBusyError(error) {
  return (
    typeof error?.code === 'string' &&
    (error.code.startsWith('SQLITE_BUSY') || error.code.startsWith('SQLITE_LOCKED'))
  )
}

function asMigrationLockError(error, fallbackCode = MIGRATION_LOCK_IO_ERROR) {
  if (error instanceof MigrationLockError) {
    return error
  }

  if (isMigrationLockBusyError(error)) {
    return new MigrationLockError(
      MIGRATION_LOCK_BUSY,
      'migration lock is busy',
      error
    )
  }

  return new MigrationLockError(
    fallbackCode,
    'migration lock I/O error',
    error
  )
}

function closeQuietly(database) {
  if (!database) {
    return null
  }

  try {
    if (database.open) {
      database.close()
    }
    return null
  } catch (error) {
    return error
  }
}

/**
 * Keep release ordering and retry semantics independent from SQLite so they
 * can be tested without a native better-sqlite3 binding.
 */
export function createReleaseStateMachine({ rollback, close, isOpen = () => true }) {
  if (typeof rollback !== 'function' || typeof close !== 'function') {
    throw new TypeError('release state machine requires rollback and close functions')
  }
  if (typeof isOpen !== 'function') {
    throw new TypeError('release state machine requires an isOpen function')
  }

  let state = MIGRATION_LOCK_ACTIVE

  return Object.freeze({
    get state() {
      return state
    },
    release() {
      if (state === MIGRATION_LOCK_RELEASED || state === MIGRATION_LOCK_RELEASING) {
        return false
      }

      state = MIGRATION_LOCK_RELEASING
      let rollbackError = null
      try {
        rollback()
      } catch (error) {
        rollbackError = error
      }

      let closeError = null
      try {
        close()
      } catch (error) {
        closeError = error
      }

      if (!closeError) {
        state = MIGRATION_LOCK_RELEASED
        if (rollbackError) {
          throw rollbackError
        }
        return true
      }

      let stillOpen = true
      try {
        stillOpen = isOpen()
      } catch {
        stillOpen = true
      }

      state = stillOpen ? MIGRATION_LOCK_ACTIVE : MIGRATION_LOCK_RELEASED
      if (rollbackError) {
        throw new AggregateError(
          [rollbackError, closeError],
          'migration lock release encountered multiple errors'
        )
      }
      throw closeError
    }
  })
}

function configureLockDatabase(database, timeoutMs) {
  const journalMode = database.pragma('journal_mode = DELETE', { simple: true })
  if (String(journalMode).toLowerCase() !== 'delete') {
    throw new Error('side-car journal mode verification failed')
  }

  database.pragma(`busy_timeout = ${timeoutMs}`)
  const actualTimeout = database.pragma('busy_timeout', { simple: true })
  if (actualTimeout !== timeoutMs) {
    throw new Error('side-car busy timeout verification failed')
  }
}

/**
 * Acquire the process-wide migration lock for a main database.
 *
 * The lock database is always derived beside mainDbPath. The returned handle
 * owns one independent SQLite connection and keeps BEGIN IMMEDIATE open until
 * release() is called.
 */
export function acquireMigrationLock(mainDbPath, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('migration lock options must be an object')
  }
  if (Object.prototype.hasOwnProperty.call(options, 'lockPath')) {
    throw new TypeError('lockPath is derived internally and cannot be supplied')
  }

  const normalizedMainDbPath = normalizeMainDbPath(mainDbPath)
  const lockDbPath = deriveMigrationLockPath(normalizedMainDbPath)
  const timeoutMs = normalizeMigrationLockTimeout(options.busyTimeoutMs)
  let database

  try {
    const SqliteDatabase = loadDatabase()
    database = new SqliteDatabase(lockDbPath)
    configureLockDatabase(database, timeoutMs)
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    const closeError = closeQuietly(database)
    const originalError = closeError && !error ? closeError : error
    throw asMigrationLockError(originalError)
  }

  const releaseState = createReleaseStateMachine({
    rollback() {
      if (database.inTransaction) {
        database.exec('ROLLBACK')
      }
    },
    close() {
      const closeError = closeQuietly(database)
      if (closeError) {
        throw closeError
      }
    },
    isOpen() {
      return Boolean(database.open)
    }
  })

  return Object.freeze({
    release() {
      try {
        return releaseState.release()
      } catch (error) {
        throw asMigrationLockError(error)
      }
    },
    get state() {
      return releaseState.state
    }
  })
}
