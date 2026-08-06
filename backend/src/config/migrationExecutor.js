import { isDeepStrictEqual } from 'node:util'
import { createMigrationRegistry, MigrationPlanError } from './migrationPlan.js'
import {
  finishMigrationAttempt,
  getAppliedMigration,
  MIGRATION_ATTEMPT_APPLIED,
  MIGRATION_ATTEMPT_FAILED,
  recordSuccessfulMigration,
  startMigrationAttempt,
  MigrationControlStoreError
} from './migrationControlStore.js'
import { MIGRATION_LOCK_ACTIVE } from './migrationLock.js'

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/
const SAFE_ID_PATTERN = /^\d{4}_[a-z0-9][a-z0-9._-]*$/
const REQUIRED_PLAN_ARRAYS = ['registered', 'applied', 'pending', 'deferred', 'unknownHistory']
const PLAN_SEGMENTS = ['applied', 'pending', 'deferred']
const SQLITE_BASE_CODES = [
  'SQLITE_ABORT',
  'SQLITE_AUTH',
  'SQLITE_BUSY',
  'SQLITE_CANTOPEN',
  'SQLITE_CONSTRAINT',
  'SQLITE_CORRUPT',
  'SQLITE_ERROR',
  'SQLITE_FULL',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_LOCKED',
  'SQLITE_MISUSE',
  'SQLITE_NOMEM',
  'SQLITE_NOTADB',
  'SQLITE_NOTICE',
  'SQLITE_PROTOCOL',
  'SQLITE_READONLY',
  'SQLITE_RANGE',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_WARNING'
]

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function fail(code, message, cause) {
  throw new MigrationExecutorError(code, message, {
    category: 'validation',
    machineCode: code,
    cause
  })
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MIGRATION_EXECUTOR_INPUT_INVALID', message)
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.exec !== 'function' ||
    typeof database.prepare !== 'function' ||
    typeof database.transaction !== 'function'
  ) {
    fail('MIGRATION_EXECUTOR_DATABASE_INVALID', 'Migration executor database is invalid.')
  }
}

function assertActiveLock(lock) {
  if (!lock || lock.state !== MIGRATION_LOCK_ACTIVE) {
    fail('MIGRATION_LOCK_NOT_ACTIVE', 'Migration execution requires an active migration lock.')
  }
}

function assertChecksum(checksum, fieldName) {
  if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    fail('MIGRATION_EXECUTOR_CHECKSUM_INVALID', `${fieldName} is invalid.`)
  }
}

function assertMigrationId(id, fieldName) {
  if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
    fail('MIGRATION_EXECUTOR_ID_INVALID', `${fieldName} is invalid.`)
  }
}

function normalizeRegistry(registry) {
  assertObject(registry, 'Migration registry is invalid.')
  if (!Array.isArray(registry.migrations)) fail('MIGRATION_EXECUTOR_REGISTRY_INVALID', 'Migration registry is invalid.')

  let normalized
  try {
    normalized = createMigrationRegistry(registry.migrations.map((migration) => {
      const definition = {
        id: migration.id,
        source: migration.source,
        checksum: migration.checksum
      }
      if (Object.hasOwn(migration, 'compatibility')) {
        definition.compatibility = migration.compatibility
      }
      return definition
    }))
  } catch (error) {
    if (error instanceof MigrationPlanError) {
      fail('MIGRATION_EXECUTOR_REGISTRY_INVALID', 'Migration registry is invalid.', error)
    }
    fail('MIGRATION_EXECUTOR_REGISTRY_INVALID', 'Migration registry is invalid.', error)
  }

  if (normalized.migrations.length !== registry.migrations.length) {
    fail('MIGRATION_EXECUTOR_REGISTRY_INVALID', 'Migration registry is invalid.')
  }
  for (let index = 0; index < normalized.migrations.length; index += 1) {
    const source = registry.migrations[index]
    const migration = normalized.migrations[index]
    if (
      source.id !== migration.id ||
      source.checksum !== migration.checksum ||
      source.source !== migration.source ||
      Object.hasOwn(source, 'compatibility') !== Object.hasOwn(migration, 'compatibility') ||
      !isDeepStrictEqual(source.compatibility, migration.compatibility)
    ) {
      fail('MIGRATION_EXECUTOR_REGISTRY_INVALID', 'Migration registry is invalid.')
    }
  }
  return normalized.migrations
}

function assertPlanEntry(entry, fieldName) {
  assertObject(entry, `${fieldName} entry is invalid.`)
  assertMigrationId(entry.id, `${fieldName} id`)
  assertChecksum(entry.checksum, `${fieldName} checksum`)
}

function normalizePlan(plan, migrations) {
  assertObject(plan, 'Migration plan is invalid.')
  for (const field of REQUIRED_PLAN_ARRAYS) {
    if (!Array.isArray(plan[field])) fail('MIGRATION_EXECUTOR_PLAN_INVALID', 'Migration plan is invalid.')
  }

  const registered = plan.registered
  if (registered.length !== migrations.length) fail('MIGRATION_EXECUTOR_PLAN_INVALID', 'Migration plan is invalid.')
  for (let index = 0; index < migrations.length; index += 1) {
    assertPlanEntry(registered[index], 'registered')
    if (registered[index].id !== migrations[index].id || registered[index].checksum !== migrations[index].checksum) {
      fail('MIGRATION_EXECUTOR_PLAN_REGISTRY_MISMATCH', 'Migration plan does not match the migration registry.')
    }
  }

  const migrationsById = new Map(migrations.map((migration) => [migration.id, migration]))
  const segments = Object.fromEntries(PLAN_SEGMENTS.map((field) => [field, []]))
  const seen = new Set()
  for (const field of PLAN_SEGMENTS) {
    for (const entry of plan[field]) {
      assertPlanEntry(entry, field)
      if (seen.has(entry.id)) fail('MIGRATION_EXECUTOR_PLAN_INVALID', 'Migration plan contains duplicate migrations.')
      seen.add(entry.id)
      const migration = migrationsById.get(entry.id)
      if (!migration || migration.checksum !== entry.checksum) {
        fail('MIGRATION_EXECUTOR_PLAN_REGISTRY_MISMATCH', 'Migration plan does not match the migration registry.')
      }
      segments[field].push(Object.freeze({ id: entry.id, checksum: entry.checksum }))
    }
  }

  const combined = [...segments.applied, ...segments.pending, ...segments.deferred]
  if (
    combined.length !== migrations.length ||
    combined.some((entry, index) => {
      const migration = migrations[index]
      return !migration || entry.id !== migration.id || entry.checksum !== migration.checksum
    })
  ) {
    fail('MIGRATION_EXECUTOR_PLAN_ORDER_INVALID', 'Migration plan segments are incomplete or out of order.')
  }

  const inScope = [...segments.applied, ...segments.pending]
  const expectedTarget = inScope.length > 0 ? inScope[inScope.length - 1].id : null
  if (plan.targetVersion !== expectedTarget) {
    fail('MIGRATION_EXECUTOR_PLAN_TARGET_INVALID', 'Migration plan target does not match its in-scope migrations.')
  }

  return Object.freeze({
    applied: Object.freeze(segments.applied),
    pending: Object.freeze(segments.pending),
    deferred: Object.freeze(segments.deferred)
  })
}

function assertSafeMigrationSql(source) {
  const tokens = []
  let index = 0
  let token = ''

  const pushToken = () => {
    if (token.length > 0) {
      tokens.push(token.toUpperCase())
      token = ''
    }
  }

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]

    if (character === '-' && next === '-') {
      pushToken()
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      pushToken()
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index = Math.min(source.length, index + 2)
      continue
    }
    if (character === "'") {
      pushToken()
      index += 1
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          index += 2
          continue
        }
        if (source[index] === "'") {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '"' || character === '`') {
      pushToken()
      const quote = character
      index += 1
      while (index < source.length) {
        if (source[index] === quote && source[index + 1] === quote) {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '[') {
      pushToken()
      index += 1
      while (index < source.length && source[index] !== ']') index += 1
      index = Math.min(source.length, index + 1)
      continue
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      token += character
    } else {
      pushToken()
      if (character === ';') tokens.push(';')
    }
    index += 1
  }
  pushToken()

  const blocked = new Set([
    // BEGIN is intentionally blocked, so CREATE TRIGGER bodies are not supported in C1b-3a.
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT',
    'RELEASE',
    'ATTACH',
    'DETACH',
    'VACUUM',
    'PRAGMA'
  ])
  let statementStart = true
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const currentToken = tokens[tokenIndex]
    if (currentToken === ';') {
      statementStart = true
      continue
    }
    if (blocked.has(currentToken)) {
      throw new MigrationExecutorError('MIGRATION_SQL_UNSAFE', 'Migration SQL is not allowed.', {
        category: 'validation',
        machineCode: 'MIGRATION_SQL_UNSAFE'
      })
    }
    // SQLite accepts both END and END TRANSACTION as COMMIT aliases. Only an
    // END at statement start is transaction control; CASE ... END remains valid.
    if (currentToken === 'END' && (statementStart || tokens[tokenIndex + 1] === 'TRANSACTION')) {
      throw new MigrationExecutorError('MIGRATION_SQL_UNSAFE', 'Migration SQL is not allowed.', {
        category: 'validation',
        machineCode: 'MIGRATION_SQL_UNSAFE'
      })
    }
    statementStart = false
  }
}

function validatePendingSql(migrations, pending) {
  const migrationsById = new Map(migrations.map((migration) => [migration.id, migration]))
  for (const entry of pending) assertSafeMigrationSql(migrationsById.get(entry.id).source)
}

function validateAppliedLedger(database, applied) {
  for (const entry of applied) {
    let record
    try {
      record = getAppliedMigration(database, entry.id)
    } catch (error) {
      throw safeExecutionError(error)
    }
    if (!record) {
      throw new MigrationExecutorError(
        'MIGRATION_APPLIED_LEDGER_MISSING',
        'Migration plan references an unrecorded applied migration.',
        { category: 'checksum', machineCode: 'MIGRATION_APPLIED_LEDGER_MISSING' }
      )
    }
    if (record.checksum !== entry.checksum) {
      throw new MigrationExecutorError(
        'MIGRATION_APPLIED_LEDGER_CONFLICT',
        'Migration plan conflicts with the success ledger.',
        { category: 'checksum', machineCode: 'MIGRATION_APPLIED_LEDGER_CONFLICT' }
      )
    }
  }
}

function normalizeNow(now) {
  if (now !== undefined && typeof now !== 'function') {
    fail('MIGRATION_EXECUTOR_CLOCK_INVALID', 'Migration executor now must be a function.')
  }
  const clock = now ?? (() => new Date().toISOString())
  return () => {
    let value
    try {
      value = clock()
    } catch (error) {
      throw new MigrationExecutorError('MIGRATION_EXECUTOR_CLOCK_FAILED', 'Migration executor clock failed.', {
        category: 'validation',
        machineCode: 'MIGRATION_EXECUTOR_CLOCK_FAILED',
        cause: error
      })
    }
    let timestamp
    try {
      timestamp = value instanceof Date ? value.toISOString() : value
    } catch (error) {
      throw new MigrationExecutorError('MIGRATION_EXECUTOR_CLOCK_INVALID', 'Migration executor clock must return a timestamp.', {
        category: 'validation',
        machineCode: 'MIGRATION_EXECUTOR_CLOCK_INVALID',
        cause: error
      })
    }
    if (
      typeof timestamp !== 'string' ||
      Number.isNaN(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    ) {
      fail('MIGRATION_EXECUTOR_CLOCK_INVALID', 'Migration executor clock must return a timestamp.')
    }
    return timestamp
  }
}

function sqliteMachineCode(error) {
  const rawCode = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  for (const baseCode of SQLITE_BASE_CODES) {
    if (rawCode === baseCode || rawCode.startsWith(`${baseCode}_`)) return baseCode
  }
  return null
}

function classifyFailure(error) {
  const sqliteCode = sqliteMachineCode(error)
  if (sqliteCode) return { category: 'database', machineCode: sqliteCode }
  if (error instanceof MigrationControlStoreError) {
    return { category: 'database', machineCode: 'MIGRATION_CONTROL_STORE_ERROR' }
  }
  return { category: 'migration', machineCode: 'MIGRATION_EXECUTION_FAILED' }
}

function safeExecutionError(error, classification = classifyFailure(error)) {
  return new MigrationExecutorError('MIGRATION_EXECUTION_FAILED', 'Migration execution failed.', {
    category: classification.category,
    machineCode: classification.machineCode,
    cause: error
  })
}

function coordinationError(error) {
  return new MigrationExecutorError(
    'MIGRATION_EXECUTION_COORDINATION_REQUIRED',
    'Migration execution requires coordination before startup can continue.',
    {
      category: 'migration',
      machineCode: 'MIGRATION_COORDINATION_REQUIRED',
      cause: error
    }
  )
}

function finishFailed(database, attempt, now, failure) {
  try {
    finishMigrationAttempt(database, attempt.attemptId, {
      status: MIGRATION_ATTEMPT_FAILED,
      finishedAt: now(),
      errorCategory: failure.category,
      safeErrorSummary: failure.machineCode
    })
  } catch (error) {
    throw coordinationError(new AggregateError([failure.cause, error], 'Migration failure finalization failed.'))
  }
}

/**
 * Execute the pending portion of one validated migration plan. The caller
 * owns lock acquisition and release; this function never changes lock state.
 */
export function executeMigrationBatch({ database, registry, plan, lock, now } = {}) {
  assertDatabase(database)
  const migrations = normalizeRegistry(registry)
  const normalizedPlan = normalizePlan(plan, migrations)
  const clock = normalizeNow(now)
  assertActiveLock(lock)
  validatePendingSql(migrations, normalizedPlan.pending)
  validateAppliedLedger(database, normalizedPlan.applied)

  const migrationsById = new Map(migrations.map((migration) => [migration.id, migration]))
  const executed = []
  const skipped = []

  for (const migration of normalizedPlan.pending) {
    assertActiveLock(lock)

    let existing
    try {
      existing = getAppliedMigration(database, migration.id)
    } catch (error) {
      throw safeExecutionError(error)
    }

    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new MigrationExecutorError(
          'MIGRATION_CHECKSUM_CONFLICT',
          'Migration success ledger conflicts with the execution plan.',
          { category: 'checksum', machineCode: 'MIGRATION_CHECKSUM_CONFLICT' }
        )
      }
      skipped.push(Object.freeze({ id: migration.id, status: 'skipped' }))
      continue
    }

    let attempt
    try {
      attempt = startMigrationAttempt(database, {
        migrationId: migration.id,
        checksum: migration.checksum,
        startedAt: clock()
      })
    } catch (error) {
      throw safeExecutionError(error)
    }

    try {
      database.transaction(() => {
        const source = migrationsById.get(migration.id).source
        database.exec(source)
        recordSuccessfulMigration(database, {
          migrationId: migration.id,
          checksum: migration.checksum,
          appliedAt: clock()
        })
      })()
    } catch (error) {
      const failure = classifyFailure(error)
      finishFailed(database, attempt, clock, failure)
      throw safeExecutionError(error, failure)
    }

    try {
      finishMigrationAttempt(database, attempt.attemptId, {
        status: MIGRATION_ATTEMPT_APPLIED,
        finishedAt: clock()
      })
    } catch (error) {
      throw coordinationError(error)
    }
    executed.push(Object.freeze({ id: migration.id, status: 'applied' }))
  }

  return deepFreeze({
    executed,
    skipped,
    executedCount: executed.length,
    skippedCount: skipped.length,
    total: normalizedPlan.pending.length
  })
}

export class MigrationExecutorError extends Error {
  constructor(code, message, { category, machineCode, cause } = {}) {
    super(message, { cause })
    this.name = 'MigrationExecutorError'
    this.code = code
    this.category = category
    this.machineCode = machineCode
  }
}
