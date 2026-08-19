import {
  createMigrationAdoptionPlan,
  MigrationAdoptionPlanError
} from './migrationAdoptionPlan.js'
import {
  checkMigrationCompatibility,
  COMPATIBILITY_STATUSES
} from './migrationCompatibility.js'
import {
  finishMigrationAttempt,
  getAppliedMigration,
  listAppliedMigrations,
  MIGRATION_ATTEMPT_APPLIED,
  MIGRATION_ATTEMPT_FAILED,
  MigrationControlStoreError,
  recordSuccessfulMigration,
  startMigrationAttempt
} from './migrationControlStore.js'
import { MIGRATION_LOCK_ACTIVE } from './migrationLock.js'

const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const FAILURE_CODES = Object.freeze({
  PROOF_MISSING: 'MIGRATION_ADOPTION_PROOF_MISSING',
  PROOF_INCOMPATIBLE: 'MIGRATION_ADOPTION_PROOF_INCOMPATIBLE',
  PROOF_CHECK_FAILED: 'MIGRATION_ADOPTION_PROOF_CHECK_FAILED',
  LOCK_NOT_ACTIVE: 'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE',
  LEDGER_WRITE_FAILED: 'MIGRATION_ADOPTION_LEDGER_WRITE_FAILED',
  TRANSACTION_FAILED: 'MIGRATION_ADOPTION_TRANSACTION_FAILED'
})

function fail(code, message, options) {
  throw new MigrationAdoptionError(code, message, options)
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== 'function' ||
    typeof database.exec !== 'function' ||
    typeof database.transaction !== 'function'
  ) {
    fail(
      'MIGRATION_ADOPTION_DATABASE_INVALID',
      'Migration adoption database is invalid.',
      { category: 'validation' }
    )
  }
}

function assertActiveLock(lock) {
  if (!lock || lock.state !== MIGRATION_LOCK_ACTIVE) {
    fail(
      'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE',
      'Migration adoption requires an active migration lock.',
      { category: 'lock', machineCode: FAILURE_CODES.LOCK_NOT_ACTIVE }
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
      'MIGRATION_ADOPTION_CLOCK_INVALID',
      'Migration adoption now must be a function.',
      { category: 'validation' }
    )
  }

  const clock = now ?? (() => new Date().toISOString())
  return () => {
    let value
    try {
      value = clock()
    } catch {
      fail(
        'MIGRATION_ADOPTION_CLOCK_FAILED',
        'Migration adoption clock failed.',
        { category: 'validation' }
      )
    }

    let timestamp
    try {
      timestamp = value instanceof Date ? value.toISOString() : value
    } catch {
      fail(
        'MIGRATION_ADOPTION_CLOCK_INVALID',
        'Migration adoption clock returned an invalid timestamp.',
        { category: 'validation' }
      )
    }

    if (
      typeof timestamp !== 'string' ||
      !ISO_UTC_TIMESTAMP_PATTERN.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      fail(
        'MIGRATION_ADOPTION_CLOCK_INVALID',
        'Migration adoption clock returned an invalid timestamp.',
        { category: 'validation' }
      )
    }
    return timestamp
  }
}

function planningResult(input) {
  try {
    return createMigrationAdoptionPlan(input)
  } catch (error) {
    if (error instanceof MigrationAdoptionPlanError) {
      const options = {
        category: 'validation',
        machineCode: error.code
      }
      if (error.diagnostics) options.diagnostics = error.diagnostics
      fail(error.code, 'Migration adoption planning failed.', options)
    }
    fail(
      'MIGRATION_ADOPTION_PLANNING_FAILED',
      'Migration adoption planning failed.',
      { category: 'validation' }
    )
  }
}

function readApplied(database, migration) {
  let applied
  try {
    applied = getAppliedMigration(database, migration.id)
  } catch {
    fail(
      'MIGRATION_ADOPTION_LEDGER_READ_FAILED',
      'Migration adoption could not inspect the success ledger.',
      { category: 'database' }
    )
  }

  if (applied && applied.checksum !== migration.checksum) {
    fail(
      'MIGRATION_ADOPTION_CHECKSUM_CONFLICT',
      'Migration adoption found a success-ledger checksum conflict.',
      { category: 'checksum' }
    )
  }
  return applied
}

function readAppliedRecords(database) {
  try {
    return listAppliedMigrations(database).map(({ migrationId, checksum }) => ({
      id: migrationId,
      checksum,
      status: 'applied'
    }))
  } catch {
    fail(
      'MIGRATION_ADOPTION_LEDGER_READ_FAILED',
      'Migration adoption could not inspect the success ledger.',
      { category: 'database' }
    )
  }
}

function startAttempt(database, migration, clock) {
  try {
    return startMigrationAttempt(database, {
      migrationId: migration.id,
      checksum: migration.checksum,
      startedAt: clock()
    })
  } catch (error) {
    if (error instanceof MigrationAdoptionError) throw error
    fail(
      'MIGRATION_ADOPTION_ATTEMPT_START_FAILED',
      'Migration adoption could not start an attempt.',
      { category: 'database' }
    )
  }
}

function proofFailure(status) {
  if (status === COMPATIBILITY_STATUSES.MISSING) {
    return new MigrationAdoptionError(
      'MIGRATION_ADOPTION_PROOF_MISSING',
      'Migration adoption proof changed before commit.',
      { category: 'migration', machineCode: FAILURE_CODES.PROOF_MISSING }
    )
  }
  if (status === COMPATIBILITY_STATUSES.INCOMPATIBLE) {
    return new MigrationAdoptionError(
      'MIGRATION_ADOPTION_PROOF_INCOMPATIBLE',
      'Migration adoption proof changed before commit.',
      { category: 'migration', machineCode: FAILURE_CODES.PROOF_INCOMPATIBLE }
    )
  }
  return new MigrationAdoptionError(
    'MIGRATION_ADOPTION_SCHEMA_CHECK_FAILED',
    'Migration adoption schema check failed.',
    { category: 'database', machineCode: FAILURE_CODES.PROOF_CHECK_FAILED }
  )
}

function writeLedger(database, migration, clock) {
  try {
    recordSuccessfulMigration(database, {
      migrationId: migration.id,
      checksum: migration.checksum,
      appliedAt: clock()
    })
  } catch (error) {
    if (
      error instanceof MigrationControlStoreError &&
      error.code === 'MIGRATION_CHECKSUM_CONFLICT'
    ) {
      fail(
        'MIGRATION_ADOPTION_CHECKSUM_CONFLICT',
        'Migration adoption found a success-ledger checksum conflict.',
        { category: 'checksum', machineCode: 'MIGRATION_ADOPTION_CHECKSUM_CONFLICT' }
      )
    }
    if (error instanceof MigrationAdoptionError) throw error
    fail(
      'MIGRATION_ADOPTION_LEDGER_WRITE_FAILED',
      'Migration adoption could not write the success ledger.',
      { category: 'database', machineCode: FAILURE_CODES.LEDGER_WRITE_FAILED }
    )
  }
}

function transactionFailure(error) {
  if (error instanceof MigrationAdoptionError) return error
  return new MigrationAdoptionError(
    'MIGRATION_ADOPTION_TRANSACTION_FAILED',
    'Migration adoption transaction failed.',
    { category: 'database', machineCode: FAILURE_CODES.TRANSACTION_FAILED }
  )
}

function coordinationError() {
  return new MigrationAdoptionError(
    'MIGRATION_ADOPTION_COORDINATION_REQUIRED',
    'Migration adoption requires coordination before startup can continue.',
    {
      category: 'migration',
      machineCode: 'MIGRATION_ADOPTION_COORDINATION_REQUIRED'
    }
  )
}

function finishFailed(database, attempt, clock, failure) {
  try {
    finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: clock(),
      errorCategory: failure.category,
      safeErrorSummary: failure.machineCode
    })
  } catch {
    throw coordinationError()
  }
}

function adoptOne(database, migration, lock, clock) {
  const attempt = startAttempt(database, migration, clock)

  try {
    database.transaction(() => {
      assertActiveLock(lock)

      let proof
      try {
        proof = checkMigrationCompatibility(database, migration.compatibility)
      } catch {
        throw proofFailure('check-failed')
      }
      if (proof.status !== COMPATIBILITY_STATUSES.SATISFIED) {
        throw proofFailure(proof.status)
      }

      writeLedger(database, migration, clock)
    })()
  } catch (error) {
    const failure = transactionFailure(error)
    finishFailed(database, attempt, clock, failure)
    throw failure
  }

  try {
    finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_APPLIED,
      finishedAt: clock()
    })
  } catch {
    throw coordinationError()
  }
}

function adoptionSummary(plan, adopted, skipped) {
  const result = {
    adopted,
    skipped,
    adoptedCount: adopted.length,
    skippedCount: skipped.length,
    totalAdoptable: plan.adoptableCount
  }
  if (plan.stopped) result.stopped = { ...plan.stopped }
  return deepFreeze(result)
}

/**
 * Adopt the currently satisfied continuous migration prefix. The prefix is
 * always recalculated internally, and migration source text is never run.
 */
export function adoptMigrationPrefix({
  database,
  registry,
  lock,
  targetVersion,
  now
} = {}) {
  assertDatabase(database)
  const clock = normalizeClock(now)
  assertActiveLock(lock)
  const appliedRecords = readAppliedRecords(database)
  const plan = planningResult({
    database,
    registry,
    appliedRecords,
    lock,
    targetVersion
  })
  const migrationsById = new Map(registry.migrations.map((migration) => [migration.id, migration]))
  const adopted = []
  const skipped = []

  for (const entry of plan.adoptable) {
    assertActiveLock(lock)
    const migration = migrationsById.get(entry.id)
    const applied = readApplied(database, migration)
    if (applied) {
      skipped.push({ id: migration.id, status: 'skipped' })
      continue
    }

    adoptOne(database, migration, lock, clock)
    adopted.push({ id: migration.id, status: 'adopted' })
  }

  return adoptionSummary(plan, adopted, skipped)
}

export class MigrationAdoptionError extends Error {
  constructor(
    code,
    message,
    { category = 'migration', machineCode = code, diagnostics } = {}
  ) {
    super(message)
    this.name = 'MigrationAdoptionError'
    this.code = code
    this.category = category
    this.machineCode = machineCode
    if (diagnostics) {
      this.diagnostics = Object.freeze({
        migrationId: diagnostics.migrationId,
        category: diagnostics.category,
        reason: diagnostics.reason
      })
    }
  }
}

export const MIGRATION_ADOPTION_FAILURE_CODES = FAILURE_CODES
