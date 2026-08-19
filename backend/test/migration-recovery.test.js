import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  ensureMigrationControlTables,
  finishMigrationAttempt,
  listAppliedMigrations,
  listMigrationAttempts,
  recordSuccessfulMigration,
  startMigrationAttempt
} from '../src/config/migrationControlStore.js'
import {
  MIGRATION_RECOVERY_ERROR_CODES,
  MIGRATION_RECOVERY_INTERRUPTED_SUMMARY,
  MigrationRecoveryError,
  reconcileStartedMigrationAttempts
} from '../src/config/migrationRecovery.js'

const require = createRequire(import.meta.url)

function isKnownNativeBindingMissingError(error) {
  const message = String(error?.message ?? '')
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(message)
}

let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

const ACTIVE_LOCK = Object.freeze({ state: 'active' })
const RELEASED_LOCK = Object.freeze({ state: 'released' })
const FIXED_NOW = '2026-08-05T00:00:00.000Z'
const CHECKSUM_A = 'a'.repeat(64)
const CHECKSUM_B = 'b'.repeat(64)
const CHECKSUM_C = 'c'.repeat(64)

function openDatabase() {
  const database = new Database(':memory:')
  ensureMigrationControlTables(database)
  return database
}

function createStarted(database, migrationId, checksum) {
  return startMigrationAttempt(database, {
    migrationId,
    checksum,
    startedAt: '2026-08-04T23:00:00.000Z'
  })
}

function thrown(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationRecoveryError)
    return error
  }
  assert.fail('Expected migration recovery to throw.')
}

test('rejects malformed databases and missing or released locks', () => {
  assert.equal(
    thrown(() => reconcileStartedMigrationAttempts(null)).code,
    MIGRATION_RECOVERY_ERROR_CODES.INPUT_INVALID
  )
  const malformed = { prepare() {}, transaction() {} }
  assert.equal(
    thrown(() => reconcileStartedMigrationAttempts({ database: malformed, lock: ACTIVE_LOCK })).code,
    MIGRATION_RECOVERY_ERROR_CODES.DATABASE_INVALID
  )

  const database = {
    exec() {},
    prepare() {
      throw new Error('must not read without a lock')
    },
    transaction() {
      throw new Error('must not transact without a lock')
    }
  }
  assert.equal(
    thrown(() => reconcileStartedMigrationAttempts({ database, lock: null })).code,
    MIGRATION_RECOVERY_ERROR_CODES.LOCK_NOT_ACTIVE
  )
  assert.equal(
    thrown(() => reconcileStartedMigrationAttempts({ database, lock: RELEASED_LOCK })).code,
    MIGRATION_RECOVERY_ERROR_CODES.LOCK_NOT_ACTIVE
  )
})

test('rechecks the lock after evaluating the recovery clock', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const lock = { state: 'active' }
    const attempt = createStarted(database, '0001_clock_unlock', CHECKSUM_A)
    const error = thrown(() => reconcileStartedMigrationAttempts({
      database,
      lock,
      now: () => {
        lock.state = 'released'
        return FIXED_NOW
      }
    }))
    assert.equal(error.code, MIGRATION_RECOVERY_ERROR_CODES.LOCK_NOT_ACTIVE)
    assert.deepEqual(listMigrationAttempts(database).map(({ attemptId, status }) => ({ attemptId, status })), [
      { attemptId: attempt.attemptId, status: 'started' }
    ])
  } finally {
    database.close()
  }
})

test('empty started-attempt set is safe and idempotent', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const summary = reconcileStartedMigrationAttempts({
      database,
      lock: ACTIVE_LOCK,
      now: () => {
        throw new Error('empty recovery must not need a clock')
      }
    })
    assert.deepEqual(summary, {
      scannedCount: 0,
      appliedCount: 0,
      interruptedCount: 0,
      records: []
    })
    assert.equal(Object.isFrozen(summary), true)
    assert.equal(Object.isFrozen(summary.records), true)
  } finally {
    database.close()
  }
})

test('coordinates a started attempt to applied when the ledger has the same checksum', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const attempt = createStarted(database, '0001_initial', CHECKSUM_A)
    recordSuccessfulMigration(database, {
      migrationId: attempt.migrationId,
      checksum: CHECKSUM_A,
      appliedAt: FIXED_NOW
    })
    const summary = reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    assert.deepEqual(summary, {
      scannedCount: 1,
      appliedCount: 1,
      interruptedCount: 0,
      records: [{ attemptId: attempt.attemptId, migrationId: '0001_initial', finalStatus: 'applied' }]
    })
    assert.equal(listMigrationAttempts(database)[0].status, 'applied')
    assert.equal(listMigrationAttempts(database)[0].finishedAt, FIXED_NOW)
  } finally {
    database.close()
  }
})

test('coordinates an unrecorded started attempt to interrupted with the fixed safe code', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const attempt = createStarted(database, '0001_interrupted', CHECKSUM_B)
    const summary = reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    const finished = listMigrationAttempts(database)[0]
    assert.equal(summary.interruptedCount, 1)
    assert.equal(finished.status, 'interrupted')
    assert.equal(finished.errorCategory, 'interrupted')
    assert.equal(finished.errorSummary, MIGRATION_RECOVERY_INTERRUPTED_SUMMARY)
    assert.equal(finished.finishedAt, FIXED_NOW)
    assert.equal(attempt.attemptId, summary.records[0].attemptId)
  } finally {
    database.close()
  }
})

test('preflights mixed and duplicate started attempts using one ledger fact and one timestamp', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const first = createStarted(database, '0001_applied', CHECKSUM_A)
    const second = createStarted(database, '0002_interrupted', CHECKSUM_B)
    const third = createStarted(database, '0001_applied', CHECKSUM_A)
    recordSuccessfulMigration(database, {
      migrationId: first.migrationId,
      checksum: CHECKSUM_A,
      appliedAt: FIXED_NOW
    })
    const summary = reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    assert.deepEqual(summary.records, [
      { attemptId: first.attemptId, migrationId: '0001_applied', finalStatus: 'applied' },
      { attemptId: second.attemptId, migrationId: '0002_interrupted', finalStatus: 'interrupted' },
      { attemptId: third.attemptId, migrationId: '0001_applied', finalStatus: 'applied' }
    ])
    assert.deepEqual(
      listMigrationAttempts(database).map(({ attemptId, status, finishedAt }) => ({ attemptId, status, finishedAt })),
      [
        { attemptId: first.attemptId, status: 'applied', finishedAt: FIXED_NOW },
        { attemptId: second.attemptId, status: 'interrupted', finishedAt: FIXED_NOW },
        { attemptId: third.attemptId, status: 'applied', finishedAt: FIXED_NOW }
      ]
    )
  } finally {
    database.close()
  }
})

test('checksum conflict blocks every write before finalization', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const conflicting = createStarted(database, '0001_conflict', CHECKSUM_A)
    const unblocked = createStarted(database, '0002_unblocked', CHECKSUM_B)
    recordSuccessfulMigration(database, {
      migrationId: conflicting.migrationId,
      checksum: CHECKSUM_C,
      appliedAt: FIXED_NOW
    })
    const error = thrown(() => reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW }))
    assert.equal(error.code, MIGRATION_RECOVERY_ERROR_CODES.CHECKSUM_CONFLICT)
    assert.equal(error.message.includes(CHECKSUM_A), false)
    assert.equal(error.message.includes(CHECKSUM_C), false)
    assert.deepEqual(listMigrationAttempts(database).map(({ attemptId, status }) => ({ attemptId, status })), [
      { attemptId: conflicting.attemptId, status: 'started' },
      { attemptId: unblocked.attemptId, status: 'started' }
    ])
  } finally {
    database.close()
  }
})

test('rolls back the entire finalization batch when a terminal update fails', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const first = createStarted(database, '0001_committed', CHECKSUM_A)
    const second = createStarted(database, '0002_interrupted', CHECKSUM_B)
    recordSuccessfulMigration(database, {
      migrationId: first.migrationId,
      checksum: CHECKSUM_A,
      appliedAt: FIXED_NOW
    })
    database.exec(`
      CREATE TRIGGER fail_recovery_finalization
      BEFORE UPDATE OF status ON prm_migration_attempts
      WHEN OLD.attempt_id = ${second.attemptId}
      BEGIN
        SELECT RAISE(ABORT, 'recovery-secret');
      END
    `)
    const error = thrown(() => reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW }))
    assert.equal(error.code, MIGRATION_RECOVERY_ERROR_CODES.FINALIZATION_FAILED)
    assert.equal(error.message.includes('recovery-secret'), false)
    assert.equal(error.message.includes('prm_migration_attempts'), false)
    assert.match(String(error.cause?.message), /recovery-secret/)
    assert.deepEqual(listMigrationAttempts(database).map(({ attemptId, status }) => ({ attemptId, status })), [
      { attemptId: first.attemptId, status: 'started' },
      { attemptId: second.attemptId, status: 'started' }
    ])
  } finally {
    database.close()
  }
})

test('does not change either ledger and leaves the legacy schema_migrations table untouched', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec("CREATE TABLE schema_migrations (version TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('legacy-1')")
    const attempt = createStarted(database, '0001_legacy_probe', CHECKSUM_A)
    const beforeLedger = listAppliedMigrations(database)
    const beforeLegacy = database.prepare('SELECT version FROM schema_migrations').all()
    reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    assert.deepEqual(listAppliedMigrations(database), beforeLedger)
    assert.deepEqual(database.prepare('SELECT version FROM schema_migrations').all(), beforeLegacy)
    assert.equal(listMigrationAttempts(database)[0].attemptId, attempt.attemptId)
  } finally {
    database.close()
  }
})

test('returns a deeply frozen summary without checksum, source, or error text', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const attempt = createStarted(database, '0001_summary', CHECKSUM_A)
    const summary = reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    assert.equal(Object.isFrozen(summary), true)
    assert.equal(Object.isFrozen(summary.records), true)
    assert.equal(Object.isFrozen(summary.records[0]), true)
    assert.equal('checksum' in summary.records[0], false)
    assert.equal('source' in summary.records[0], false)
    assert.equal('errorSummary' in summary.records[0], false)
    assert.equal(summary.records[0].attemptId, attempt.attemptId)
    assert.throws(() => {
      summary.records[0].finalStatus = 'started'
    }, TypeError)
  } finally {
    database.close()
  }
})

test('does not process already terminal attempts', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const attempt = createStarted(database, '0001_terminal', CHECKSUM_A)
    finishMigrationAttempt(database, attempt.attemptId, {
      status: 'failed',
      finishedAt: FIXED_NOW,
      errorCategory: 'database',
      safeErrorSummary: 'PREVIOUS_FAILURE'
    })
    const summary = reconcileStartedMigrationAttempts({ database, lock: ACTIVE_LOCK, now: () => FIXED_NOW })
    assert.equal(summary.scannedCount, 0)
    assert.deepEqual(listMigrationAttempts(database).map(({ status, errorCategory, errorSummary }) => ({ status, errorCategory, errorSummary })), [{
      status: 'failed',
      errorCategory: 'database',
      errorSummary: 'PREVIOUS_FAILURE'
    }])
  } finally {
    database.close()
  }
})
