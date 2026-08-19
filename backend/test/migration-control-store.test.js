import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  MIGRATION_ATTEMPT_FAILED,
  MIGRATION_ATTEMPT_INTERRUPTED,
  MIGRATION_ATTEMPT_APPLIED,
  MIGRATION_ATTEMPT_STARTED,
  MigrationControlStoreError,
  ensureMigrationControlTables,
  finishMigrationAttempt,
  getAppliedMigration,
  getMigrationAttempt,
  listAppliedMigrations,
  listMigrationAttempts,
  recordSuccessfulMigration,
  startMigrationAttempt
} from '../src/config/migrationControlStore.js'

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

const CHECKSUM_A = 'a'.repeat(64)
const CHECKSUM_B = 'b'.repeat(64)
const STARTED_AT = '2026-08-05T00:00:00.000Z'
const FINISHED_AT = '2026-08-05T00:01:00.000Z'

function openDatabase() {
  return new Database(':memory:')
}

function errorCode(run) {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof MigrationControlStoreError)
    return error.code
  }
  return null
}

test('validates inputs before requiring a database connection', () => {
  assert.equal(errorCode(() => recordSuccessfulMigration(null, {
    migrationId: 'bad',
    checksum: CHECKSUM_A
  })), 'MIGRATION_ID_INVALID')
  assert.equal(errorCode(() => startMigrationAttempt(null, {
    migrationId: '0001_initial',
    checksum: 'bad'
  })), 'MIGRATION_CHECKSUM_INVALID')
  assert.equal(errorCode(() => finishMigrationAttempt(null, 1, {
    status: 'unknown'
  })), 'MIGRATION_ATTEMPT_STATUS_INVALID')
})

test('fails closed when another caller wins an attempt completion race', () => {
  const started = {
    attempt_id: 1,
    migration_id: '0001_initial',
    checksum: CHECKSUM_A,
    status: MIGRATION_ATTEMPT_STARTED,
    started_at: STARTED_AT,
    finished_at: null,
    error_category: null,
    error_summary: null
  }
  const competingTerminal = {
    ...started,
    status: MIGRATION_ATTEMPT_FAILED,
    finished_at: FINISHED_AT,
    error_category: 'database',
    error_summary: 'SQLITE_LOCKED'
  }
  let readCount = 0
  const database = {
    exec() {},
    transaction(run) { return run },
    prepare(sql) {
      if (/^\s*select\b/i.test(sql)) {
        return {
          get() {
            readCount += 1
            return readCount === 1 ? started : competingTerminal
          }
        }
      }
      if (/^\s*update\b/i.test(sql)) {
        return { run: () => ({ changes: 0 }) }
      }
      throw new Error('unexpected SQL in race fixture')
    }
  }

  assert.equal(errorCode(() => finishMigrationAttempt(database, 1, {
    status: MIGRATION_ATTEMPT_FAILED,
    finishedAt: FINISHED_AT,
    errorCategory: 'database',
    safeErrorSummary: 'SQLITE_BUSY'
  })), 'MIGRATION_ATTEMPT_TRANSITION_INVALID')
})

test('creates and validates the independent control tables idempotently', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`CREATE TABLE schema_migrations (version TEXT NOT NULL)`)
    ensureMigrationControlTables(database)
    ensureMigrationControlTables(database)
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'prm_%' ORDER BY name").all(),
      [{ name: 'prm_migration_attempts' }, { name: 'prm_schema_migrations' }]
    )
    assert.deepEqual(database.pragma('table_info(prm_schema_migrations)').map(({ name }) => name), [
      'migration_id', 'checksum', 'applied_at'
    ])
    assert.deepEqual(database.pragma('table_info(prm_migration_attempts)').map(({ name }) => name), [
      'attempt_id', 'migration_id', 'checksum', 'status', 'started_at',
      'finished_at', 'error_category', 'error_summary'
    ])
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), [])
  } finally {
    database.close()
  }
})

test('records a successful migration idempotently and rejects checksum drift', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    const first = recordSuccessfulMigration(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, appliedAt: STARTED_AT
    })
    const second = recordSuccessfulMigration(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, appliedAt: FINISHED_AT
    })
    assert.deepEqual(second, first)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 1)
    assert.deepEqual(listAppliedMigrations(database), [first])
    assert.equal(errorCode(() => recordSuccessfulMigration(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_B, appliedAt: FINISHED_AT
    })), 'MIGRATION_CHECKSUM_CONFLICT')
  } finally {
    database.close()
  }
})

test('writes the success ledger in the caller-owned transaction', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    database.transaction(() => {
      recordSuccessfulMigration(database, {
        migrationId: '0001_committed', checksum: CHECKSUM_A, appliedAt: STARTED_AT
      })
    })()
    assert.ok(getAppliedMigration(database, '0001_committed'))

    assert.throws(() => database.transaction(() => {
      recordSuccessfulMigration(database, {
        migrationId: '0002_rolled_back', checksum: CHECKSUM_B, appliedAt: STARTED_AT
      })
      throw new Error('test transaction rollback')
    })())
    assert.equal(getAppliedMigration(database, '0002_rolled_back'), null)
  } finally {
    database.close()
  }
})

test('records started, applied, failed and interrupted attempt transitions', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    const started = startMigrationAttempt(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, startedAt: STARTED_AT
    })
    assert.equal(started.status, MIGRATION_ATTEMPT_STARTED)
    const applied = finishMigrationAttempt(database, started.attemptId, {
      status: MIGRATION_ATTEMPT_APPLIED, finishedAt: FINISHED_AT
    })
    assert.equal(applied.status, MIGRATION_ATTEMPT_APPLIED)
    assert.deepEqual(
      finishMigrationAttempt(database, started.attemptId, {
        status: MIGRATION_ATTEMPT_APPLIED, finishedAt: FINISHED_AT
      }),
      applied
    )

    const failedAttempt = startMigrationAttempt(database, {
      migrationId: '0002_failed', checksum: CHECKSUM_B, startedAt: STARTED_AT
    })
    const failed = finishMigrationAttempt(database, failedAttempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: FINISHED_AT,
      errorCategory: 'database',
      safeErrorSummary: 'SQLITE_BUSY'
    })
    assert.equal(failed.status, MIGRATION_ATTEMPT_FAILED)
    assert.equal(failed.errorSummary, 'SQLITE_BUSY')
    assert.deepEqual(listMigrationAttempts(database, { status: MIGRATION_ATTEMPT_FAILED }), [failed])

    const interruptedAttempt = startMigrationAttempt(database, {
      migrationId: '0003_interrupted', checksum: CHECKSUM_A, startedAt: STARTED_AT
    })
    const interrupted = finishMigrationAttempt(database, interruptedAttempt.attemptId, {
      status: MIGRATION_ATTEMPT_INTERRUPTED,
      finishedAt: FINISHED_AT,
      errorCategory: 'interrupted',
      safeErrorSummary: 'PROCESS_EXIT'
    })
    assert.equal(interrupted.status, MIGRATION_ATTEMPT_INTERRUPTED)
    assert.equal(interrupted.errorCategory, 'interrupted')
    assert.deepEqual(listMigrationAttempts(database, { status: MIGRATION_ATTEMPT_INTERRUPTED }), [interrupted])
  } finally {
    database.close()
  }
})

test('rejects invalid statuses, transitions, timestamps and error details', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    assert.equal(errorCode(() => startMigrationAttempt(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, startedAt: 'not-a-time'
    })), 'MIGRATION_TIMESTAMP_INVALID')
    const attempt = startMigrationAttempt(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, startedAt: STARTED_AT
    })
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: FINISHED_AT,
      errorCategory: 'other',
      safeErrorSummary: 'SAFE_CODE'
    })), 'MIGRATION_ERROR_CATEGORY_INVALID')
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: FINISHED_AT,
      errorCategory: 'database',
      safeErrorSummary: 'SQLITE_BUSY: /secret/app.db'
    })), 'MIGRATION_ERROR_SUMMARY_INVALID')
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_STARTED,
      finishedAt: FINISHED_AT
    })), 'MIGRATION_ATTEMPT_TRANSITION_INVALID')
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: FINISHED_AT,
      errorCategory: 'database',
      safeErrorSummary: 'SQLITE_BUSY'
    })), null)
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: '2026-08-04T23:59:00.000Z',
      errorCategory: 'database',
      safeErrorSummary: 'SQLITE_BUSY'
    })), 'MIGRATION_TIMESTAMP_ORDER_INVALID')
  } finally {
    database.close()
  }
})

test('does not persist SQL, paths, credentials, stacks or raw error messages', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    const attempt = startMigrationAttempt(database, {
      migrationId: '0001_initial', checksum: CHECKSUM_A, startedAt: STARTED_AT
    })
    assert.equal(errorCode(() => finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: FINISHED_AT,
      errorCategory: 'database',
      safeErrorSummary: 'DROP TABLE prm_schema_migrations'
    })), 'MIGRATION_ERROR_SUMMARY_INVALID')
    assert.equal(errorCode(() => startMigrationAttempt(database, {
      migrationId: "0001_' OR 1=1 --",
      checksum: CHECKSUM_A,
      startedAt: STARTED_AT
    })), 'MIGRATION_ID_INVALID')
    assert.deepEqual(database.prepare('SELECT error_category, error_summary FROM prm_migration_attempts').get(), {
      error_category: null,
      error_summary: null
    })
  } finally {
    database.close()
  }
})

test('fails closed when an existing control table has an incompatible schema', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TABLE prm_schema_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    assert.equal(errorCode(() => ensureMigrationControlTables(database)), 'MIGRATION_CONTROL_SCHEMA_INVALID')
    assert.deepEqual(database.pragma('table_info(prm_schema_migrations)').map(({ name }) => name), [
      'migration_id', 'checksum', 'applied_at'
    ])
  } finally {
    database.close()
  }
})

test('rolls back the first control table when the second schema is incompatible', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TABLE prm_migration_attempts (
        attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_category TEXT,
        error_summary TEXT
      )
    `)
    assert.equal(errorCode(() => ensureMigrationControlTables(database)), 'MIGRATION_CONTROL_SCHEMA_INVALID')
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prm_schema_migrations'").get(),
      undefined
    )
  } finally {
    database.close()
  }
})

test('keeps an existing legacy schema_migrations table unchanged', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT NOT NULL);
      INSERT INTO schema_migrations (version) VALUES ('legacy-001');
    `)
    const before = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'").get().sql
    ensureMigrationControlTables(database)
    const after = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'").get().sql
    assert.equal(after, before)
    assert.deepEqual(database.prepare('SELECT version FROM schema_migrations').all(), [{ version: 'legacy-001' }])
  } finally {
    database.close()
  }
})

test('returns null for unknown control records', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    ensureMigrationControlTables(database)
    assert.equal(getAppliedMigration(database, '0001_initial'), null)
    assert.equal(getMigrationAttempt(database, 1), null)
  } finally {
    database.close()
  }
})
