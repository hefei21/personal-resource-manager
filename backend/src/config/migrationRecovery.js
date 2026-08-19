import {
  finishMigrationAttempt,
  getAppliedMigration,
  listMigrationAttempts,
  MIGRATION_ATTEMPT_APPLIED,
  MIGRATION_ATTEMPT_INTERRUPTED,
  MIGRATION_ATTEMPT_STARTED
} from './migrationControlStore.js'
import { MIGRATION_LOCK_ACTIVE } from './migrationLock.js'

const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SAFE_RECOVERY_SUMMARY = 'MIGRATION_PROCESS_INTERRUPTED'

export const MIGRATION_RECOVERY_ERROR_CODES = Object.freeze({
  DATABASE_INVALID: 'MIGRATION_RECOVERY_DATABASE_INVALID',
  LOCK_NOT_ACTIVE: 'MIGRATION_RECOVERY_LOCK_NOT_ACTIVE',
  INPUT_INVALID: 'MIGRATION_RECOVERY_INPUT_INVALID',
  CHECKSUM_CONFLICT: 'MIGRATION_RECOVERY_CHECKSUM_CONFLICT',
  CLOCK_INVALID: 'MIGRATION_RECOVERY_CLOCK_INVALID',
  CLOCK_FAILED: 'MIGRATION_RECOVERY_CLOCK_FAILED',
  READ_FAILED: 'MIGRATION_RECOVERY_READ_FAILED',
  FINALIZATION_FAILED: 'MIGRATION_RECOVERY_FINALIZATION_FAILED'
})

export class MigrationRecoveryError extends Error {
  constructor(code, message, { category = 'migration', machineCode = code, cause } = {}) {
    super(message, { cause })
    this.name = 'MigrationRecoveryError'
    this.code = code
    this.category = category
    this.machineCode = machineCode
  }
}

function fail(code, message, options) {
  throw new MigrationRecoveryError(code, message, options)
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== 'function' ||
    typeof database.exec !== 'function' ||
    typeof database.transaction !== 'function'
  ) {
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.DATABASE_INVALID,
      'Migration recovery database is invalid.'
    )
  }
}

function assertActiveLock(lock) {
  if (!lock || lock.state !== MIGRATION_LOCK_ACTIVE) {
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.LOCK_NOT_ACTIVE,
      'Migration recovery requires an active migration lock.',
      { category: 'lock' }
    )
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function normalizeClock(now) {
  if (now !== undefined && typeof now !== 'function') {
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.INPUT_INVALID,
      'Migration recovery now must be a function.'
    )
  }

  const clock = now ?? (() => new Date().toISOString())
  return () => {
    let value
    try {
      value = clock()
    } catch (error) {
      fail(
        MIGRATION_RECOVERY_ERROR_CODES.CLOCK_FAILED,
        'Migration recovery clock failed.',
        { category: 'validation', cause: error }
      )
    }

    let timestamp
    try {
      timestamp = value instanceof Date ? value.toISOString() : value
    } catch (error) {
      fail(
        MIGRATION_RECOVERY_ERROR_CODES.CLOCK_INVALID,
        'Migration recovery clock returned an invalid timestamp.',
        { category: 'validation', cause: error }
      )
    }

    if (
      typeof timestamp !== 'string' ||
      !ISO_UTC_TIMESTAMP_PATTERN.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      fail(
        MIGRATION_RECOVERY_ERROR_CODES.CLOCK_INVALID,
        'Migration recovery clock returned an invalid timestamp.'
      )
    }
    return timestamp
  }
}

function readStartedAttempts(database) {
  try {
    return listMigrationAttempts(database, { status: MIGRATION_ATTEMPT_STARTED })
  } catch (error) {
    if (error instanceof MigrationRecoveryError) throw error
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.READ_FAILED,
      'Migration recovery could not read pending attempts.',
      { category: 'database', cause: error }
    )
  }
}

function preflight(database, attempts) {
  const records = []
  for (const attempt of attempts) {
    let applied
    try {
      applied = getAppliedMigration(database, attempt.migrationId)
    } catch (error) {
      fail(
        MIGRATION_RECOVERY_ERROR_CODES.READ_FAILED,
        'Migration recovery could not inspect the success ledger.',
        { category: 'database', cause: error }
      )
    }

    if (applied && applied.checksum !== attempt.checksum) {
      fail(
        MIGRATION_RECOVERY_ERROR_CODES.CHECKSUM_CONFLICT,
        'Migration recovery found a success-ledger checksum conflict.',
        { category: 'checksum' }
      )
    }

    records.push({
      attemptId: attempt.attemptId,
      migrationId: attempt.migrationId,
      finalStatus: applied ? MIGRATION_ATTEMPT_APPLIED : MIGRATION_ATTEMPT_INTERRUPTED
    })
  }
  return records
}

function finalize(database, lock, records, finishedAt) {
  try {
    database.transaction(() => {
      assertActiveLock(lock)
      for (const record of records) {
        if (record.finalStatus === MIGRATION_ATTEMPT_APPLIED) {
          finishMigrationAttempt(database, record.attemptId, {
            status: MIGRATION_ATTEMPT_APPLIED,
            finishedAt
          })
          continue
        }

        finishMigrationAttempt(database, record.attemptId, {
          status: MIGRATION_ATTEMPT_INTERRUPTED,
          finishedAt,
          errorCategory: 'interrupted',
          safeErrorSummary: SAFE_RECOVERY_SUMMARY
        })
      }
    })()
  } catch (error) {
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.FINALIZATION_FAILED,
      'Migration recovery could not finalize all attempts.',
      { category: 'database', cause: error }
    )
  }
}

/**
 * Reconcile leftover started migration attempts after a process interruption.
 * The caller owns lock acquisition and release; this function never changes
 * lock state and never executes migration SQL.
 */
export function reconcileStartedMigrationAttempts(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail(
      MIGRATION_RECOVERY_ERROR_CODES.INPUT_INVALID,
      'Migration recovery input is invalid.'
    )
  }
  const { database, lock, now } = options
  assertDatabase(database)
  assertActiveLock(lock)

  const clock = normalizeClock(now)
  const attempts = readStartedAttempts(database)
  if (attempts.length === 0) {
    return deepFreeze({
      scannedCount: 0,
      appliedCount: 0,
      interruptedCount: 0,
      records: []
    })
  }

  const records = preflight(database, attempts)
  const finishedAt = clock()
  assertActiveLock(lock)
  finalize(database, lock, records, finishedAt)

  return deepFreeze({
    scannedCount: records.length,
    appliedCount: records.filter(({ finalStatus }) => finalStatus === MIGRATION_ATTEMPT_APPLIED).length,
    interruptedCount: records.filter(({ finalStatus }) => finalStatus === MIGRATION_ATTEMPT_INTERRUPTED).length,
    records
  })
}

export const MIGRATION_RECOVERY_INTERRUPTED_SUMMARY = SAFE_RECOVERY_SUMMARY
