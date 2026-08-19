import Database from 'better-sqlite3'

export const DEFAULT_BUSY_TIMEOUT_MS = 5000
export const MIN_BUSY_TIMEOUT_MS = 100
export const MAX_BUSY_TIMEOUT_MS = 30000

/**
 * Validate the bounded timeout used by SQLite's busy handler.
 *
 * The value is deliberately kept numeric and bounded before it is placed in
 * a PRAGMA statement, because SQLite PRAGMA assignments cannot use bind
 * parameters in better-sqlite3.
 */
export function normalizeBusyTimeout(value = DEFAULT_BUSY_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < MIN_BUSY_TIMEOUT_MS || value > MAX_BUSY_TIMEOUT_MS) {
    throw new RangeError(
      `busy timeout must be an integer between ${MIN_BUSY_TIMEOUT_MS} and ${MAX_BUSY_TIMEOUT_MS} milliseconds`
    )
  }

  return value
}

/**
 * Apply and verify the SQLite settings required by the application.
 *
 * This function intentionally throws on every configuration or verification
 * failure so startup cannot continue with an unsafe or unknown database mode.
 */
export function configureDatabaseConnection(database, options = {}) {
  const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs)

  database.pragma('foreign_keys = ON')
  const foreignKeys = database.pragma('foreign_keys', { simple: true })
  if (foreignKeys !== 1) {
    throw new Error(`SQLite foreign_keys verification failed: expected 1, got ${foreignKeys}`)
  }

  const journalMode = database.pragma('journal_mode = WAL', { simple: true })
  if (String(journalMode).toLowerCase() !== 'wal') {
    throw new Error(`SQLite WAL verification failed: expected wal, got ${journalMode}`)
  }

  database.pragma(`busy_timeout = ${busyTimeoutMs}`)
  const actualBusyTimeout = database.pragma('busy_timeout', { simple: true })
  if (actualBusyTimeout !== busyTimeoutMs) {
    throw new Error(
      `SQLite busy_timeout verification failed: expected ${busyTimeoutMs}, got ${actualBusyTimeout}`
    )
  }

  return database
}

/**
 * Open and configure a better-sqlite3 connection.
 *
 * A failed configuration closes the newly opened handle before rethrowing so
 * callers cannot accidentally retain a partially configured connection.
 */
export function openDatabaseConnection(dbPath, options = {}) {
  const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs)
  const database = new Database(dbPath)

  try {
    return configureDatabaseConnection(database, { busyTimeoutMs })
  } catch (error) {
    database.close()
    throw error
  }
}
