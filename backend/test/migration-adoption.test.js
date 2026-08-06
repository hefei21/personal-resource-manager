import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  adoptMigrationPrefix,
  MigrationAdoptionError
} from '../src/config/migrationAdoption.js'
import {
  ensureMigrationControlTables,
  getAppliedMigration,
  listAppliedMigrations,
  listMigrationAttempts,
  recordSuccessfulMigration
} from '../src/config/migrationControlStore.js'
import { createMigrationRegistry } from '../src/config/migrationPlan.js'
import { reconcileStartedMigrationAttempts } from '../src/config/migrationRecovery.js'

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

const FIXED_NOW = '2026-08-06T00:00:00.000Z'
const RECOVERY_NOW = '2026-08-06T00:01:00.000Z'

function activeLock() {
  return { state: 'active', releaseCalls: 0, release() { this.releaseCalls += 1 } }
}

function definition(id, table, column, options = {}) {
  return {
    id,
    source: options.source ?? `DROP TABLE observable_${id};`,
    compatibility: {
      kind: 'column',
      table,
      column: {
        name: column,
        type: options.type ?? 'TEXT',
        notNull: options.notNull ?? true,
        defaultValue: Object.hasOwn(options, 'defaultValue')
          ? options.defaultValue
          : "'ready'"
      }
    }
  }
}

function matchingColumn(compatibility, overrides = {}) {
  return {
    name: compatibility.column.name,
    type: compatibility.column.type,
    not_null: compatibility.column.notNull ? 1 : 0,
    dflt_value: compatibility.column.defaultValue,
    hidden: 0,
    ...overrides
  }
}

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }))
}

class FakeAdoptionDatabase {
  constructor(registry) {
    this.schemaTables = new Set()
    this.proofs = new Map()
    this.proofReads = new Map()
    this.checkedColumns = []
    this.ledger = new Map()
    this.attempts = []
    this.nextAttemptId = 1
    this.prepareCalls = 0
    this.transactionCalls = 0
    this.execCalls = 0
    this.runCalls = 0
    this.executedSources = []
    this.beforeTransaction = null
    this.failAppliedFinalization = false
    this.failLedgerList = false
    this.beforeLedgerGet = null

    for (const migration of registry.migrations) {
      if (!migration.compatibility) continue
      const { table, column } = migration.compatibility
      this.schemaTables.add(table)
      this.proofs.set(
        `${table}.${column.name}`,
        [matchingColumn(migration.compatibility), matchingColumn(migration.compatibility)]
      )
    }
  }

  setProofs(migration, proofs) {
    const { table, column } = migration.compatibility
    this.proofs.set(`${table}.${column.name}`, proofs)
    this.proofReads.set(`${table}.${column.name}`, 0)
  }

  seedLedger(migration, checksum = migration.checksum) {
    this.ledger.set(migration.id, {
      migration_id: migration.id,
      checksum,
      applied_at: FIXED_NOW
    })
  }

  prepare(sql) {
    this.prepareCalls += 1
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sqlite_schema')) {
      return {
        get: (table) => this.schemaTables.has(table) ? { present: 1 } : undefined
      }
    }

    if (normalized.includes('from pragma_table_xinfo')) {
      return {
        get: (table, column) => {
          const key = `${table}.${column}`
          this.checkedColumns.push(key)
          const values = this.proofs.get(key) ?? []
          const index = this.proofReads.get(key) ?? 0
          this.proofReads.set(key, index + 1)
          const value = values.length === 0
            ? undefined
            : values[Math.min(index, values.length - 1)]
          if (value instanceof Error) throw value
          return value ? { ...value } : undefined
        }
      }
    }

    if (
      normalized.includes('from prm_schema_migrations') &&
      normalized.includes('where migration_id = ?')
    ) {
      return {
        get: (migrationId) => {
          this.beforeLedgerGet?.(migrationId)
          const row = this.ledger.get(migrationId)
          return row ? { ...row } : undefined
        }
      }
    }

    if (
      normalized.startsWith('select migration_id, checksum, applied_at') &&
      normalized.includes('from prm_schema_migrations')
    ) {
      return {
        all: () => {
          if (this.failLedgerList) {
            throw new Error('C:\\private\\ledger-list-secret')
          }
          return cloneRows([...this.ledger.values()].sort((left, right) =>
            left.migration_id.localeCompare(right.migration_id)
          ))
        }
      }
    }

    if (normalized.startsWith('insert into prm_schema_migrations')) {
      return {
        run: (migrationId, checksum, appliedAt) => {
          this.runCalls += 1
          if (!this.ledger.has(migrationId)) {
            this.ledger.set(migrationId, {
              migration_id: migrationId,
              checksum,
              applied_at: appliedAt
            })
            return { changes: 1 }
          }
          return { changes: 0 }
        }
      }
    }

    if (normalized.startsWith('insert into prm_migration_attempts')) {
      return {
        run: (migrationId, checksum, status, startedAt) => {
          this.runCalls += 1
          const attemptId = this.nextAttemptId
          this.nextAttemptId += 1
          this.attempts.push({
            attempt_id: attemptId,
            migration_id: migrationId,
            checksum,
            status,
            started_at: startedAt,
            finished_at: null,
            error_category: null,
            error_summary: null
          })
          return { lastInsertRowid: attemptId, changes: 1 }
        }
      }
    }

    if (
      normalized.includes('from prm_migration_attempts') &&
      normalized.includes('where attempt_id = ?')
    ) {
      return {
        get: (attemptId) => {
          const row = this.attempts.find((attempt) => attempt.attempt_id === Number(attemptId))
          return row ? { ...row } : undefined
        }
      }
    }

    if (normalized.startsWith('update prm_migration_attempts')) {
      return {
        run: (status, finishedAt, errorCategory, errorSummary, attemptId, expectedStatus) => {
          this.runCalls += 1
          if (this.failAppliedFinalization && status === 'applied') {
            throw new Error('C:\\private\\attempt-finalization-secret')
          }
          const row = this.attempts.find((attempt) => attempt.attempt_id === Number(attemptId))
          if (!row || row.status !== expectedStatus) return { changes: 0 }
          row.status = status
          row.finished_at = finishedAt
          row.error_category = errorCategory
          row.error_summary = errorSummary
          return { changes: 1 }
        }
      }
    }

    if (normalized.includes('from prm_migration_attempts')) {
      const filtered = (status) => this.attempts
        .filter((attempt) => status === undefined || attempt.status === status)
        .sort((left, right) => left.attempt_id - right.attempt_id)
      return normalized.includes('where status = ?')
        ? { all: (status) => cloneRows(filtered(status)) }
        : { all: () => cloneRows(filtered()) }
    }

    throw new Error(`unexpected SQL in fake adoption database: ${normalized}`)
  }

  transaction(callback) {
    return () => {
      this.transactionCalls += 1
      this.beforeTransaction?.()
      const ledgerSnapshot = new Map(
        [...this.ledger.entries()].map(([id, row]) => [id, { ...row }])
      )
      const attemptsSnapshot = cloneRows(this.attempts)
      try {
        return callback()
      } catch (error) {
        this.ledger = ledgerSnapshot
        this.attempts = attemptsSnapshot
        throw error
      }
    }
  }

  exec(source) {
    this.execCalls += 1
    this.executedSources.push(source)
    throw new Error('migration source must never execute during adoption')
  }
}

function thrown(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationAdoptionError)
    return error
  }
  assert.fail('Expected migration adoption to throw.')
}

function request(registry, database, overrides = {}) {
  return {
    database,
    registry,
    lock: activeLock(),
    now: () => FIXED_NOW,
    ...overrides
  }
}

test('adopts an all-satisfied prefix with applied attempts and no source execution', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'secret_resources', 'secret_title'),
    definition('0002_second', 'secret_documents', 'secret_summary', {
      defaultValue: "'/synthetic/private.db'"
    })
  ])
  const database = new FakeAdoptionDatabase(registry)
  const lock = activeLock()

  const summary = adoptMigrationPrefix(request(registry, database, { lock }))

  assert.deepEqual(summary, {
    adopted: [
      { id: '0001_first', status: 'adopted' },
      { id: '0002_second', status: 'adopted' }
    ],
    skipped: [],
    adoptedCount: 2,
    skippedCount: 0,
    totalAdoptable: 2
  })
  assert.deepEqual(listAppliedMigrations(database).map(({ migrationId }) => migrationId), [
    '0001_first',
    '0002_second'
  ])
  assert.deepEqual(listMigrationAttempts(database).map(({ migrationId, status }) => ({ migrationId, status })), [
    { migrationId: '0001_first', status: 'applied' },
    { migrationId: '0002_second', status: 'applied' }
  ])
  assert.equal(database.execCalls, 0)
  assert.deepEqual(database.executedSources, [])
  assert.equal(lock.releaseCalls, 0)
  assert.ok(Object.isFrozen(summary))
  assert.ok(Object.isFrozen(summary.adopted))
  assert.ok(summary.adopted.every(Object.isFrozen))

  const serialized = JSON.stringify(summary)
  assert.doesNotMatch(serialized, /secret_resources|secret_title|secret_documents|secret_summary/)
  assert.doesNotMatch(serialized, /synthetic|DROP TABLE|[a-f0-9]{64}/)
})

test('returns a first-missing stop with zero control writes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  database.setProofs(registry.migrations[0], [undefined])

  const summary = adoptMigrationPrefix(request(registry, database))

  assert.deepEqual(summary, {
    adopted: [],
    skipped: [],
    adoptedCount: 0,
    skippedCount: 0,
    totalAdoptable: 0,
    stopped: { id: '0001_first', reason: 'missing' }
  })
  assert.equal(database.ledger.size, 0)
  assert.equal(database.attempts.length, 0)
  assert.equal(database.runCalls, 0)
  assert.equal(database.transactionCalls, 0)
  assert.ok(Object.isFrozen(summary.stopped))
})

test('adopts only the satisfied prefix before a missing stop', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column'),
    definition('0003_third', 'third_table', 'third_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  database.setProofs(registry.migrations[1], [undefined])

  const summary = adoptMigrationPrefix(request(registry, database))

  assert.deepEqual(summary, {
    adopted: [{ id: '0001_first', status: 'adopted' }],
    skipped: [],
    adoptedCount: 1,
    skippedCount: 0,
    totalAdoptable: 1,
    stopped: { id: '0002_second', reason: 'missing' }
  })
  assert.deepEqual([...database.ledger.keys()], ['0001_first'])
  assert.deepEqual(database.checkedColumns, [
    'first_table.first_column',
    'second_table.second_column',
    'first_table.first_column'
  ])
})

test('preserves a requires-execution stop without running the stopped source', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    {
      id: '0002_execute',
      source: 'CREATE TABLE must_not_be_created (id INTEGER);'
    }
  ])
  const database = new FakeAdoptionDatabase(registry)

  const summary = adoptMigrationPrefix(request(registry, database))

  assert.deepEqual(summary, {
    adopted: [{ id: '0001_first', status: 'adopted' }],
    skipped: [],
    adoptedCount: 1,
    skippedCount: 0,
    totalAdoptable: 1,
    stopped: { id: '0002_execute', reason: 'requires-execution' }
  })
  assert.equal(database.execCalls, 0)
  assert.doesNotMatch(JSON.stringify(summary), /CREATE TABLE|must_not_be_created/)
})

test('skips a same-checksum ledger record that appears after the authoritative snapshot', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  const migration = registry.migrations[0]
  database.beforeLedgerGet = () => {
    database.beforeLedgerGet = null
    database.seedLedger(migration)
  }

  const summary = adoptMigrationPrefix(request(registry, database))

  assert.deepEqual(summary, {
    adopted: [],
    skipped: [{ id: '0001_first', status: 'skipped' }],
    adoptedCount: 0,
    skippedCount: 1,
    totalAdoptable: 1
  })
  assert.equal(database.attempts.length, 0)
})

test('fails closed on a ledger checksum conflict before starting an attempt', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'private_table', 'private_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  const migration = registry.migrations[0]
  database.beforeLedgerGet = () => {
    database.beforeLedgerGet = null
    database.seedLedger(migration, '0'.repeat(64))
  }

  const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

  assert.equal(error.code, 'MIGRATION_ADOPTION_CHECKSUM_CONFLICT')
  assert.equal(error.category, 'checksum')
  assert.doesNotMatch(error.message, /private_table|private_column|[a-f0-9]{64}/)
  assert.equal(database.attempts.length, 0)
})

test('rolls back and safely fails attempts when transaction proof changes', () => {
  for (const scenario of [
    {
      proof: undefined,
      code: 'MIGRATION_ADOPTION_PROOF_MISSING',
      summary: 'MIGRATION_ADOPTION_PROOF_MISSING'
    },
    {
      proof: { type: 'INTEGER' },
      code: 'MIGRATION_ADOPTION_PROOF_INCOMPATIBLE',
      summary: 'MIGRATION_ADOPTION_PROOF_INCOMPATIBLE'
    }
  ]) {
    const registry = createMigrationRegistry([
      definition('0001_first', 'private_table', 'private_column', {
        defaultValue: "'/synthetic/private.db'"
      })
    ])
    const migration = registry.migrations[0]
    const database = new FakeAdoptionDatabase(registry)
    const secondProof = scenario.proof === undefined
      ? undefined
      : matchingColumn(migration.compatibility, scenario.proof)
    database.setProofs(migration, [matchingColumn(migration.compatibility), secondProof])

    const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

    assert.equal(error.code, scenario.code)
    assert.doesNotMatch(error.message, /private_table|private_column|synthetic|DROP TABLE/)
    assert.equal(database.ledger.size, 0)
    assert.deepEqual(listMigrationAttempts(database).map(({ status, errorCategory, errorSummary }) => ({
      status,
      errorCategory,
      errorSummary
    })), [{
      status: 'failed',
      errorCategory: 'migration',
      errorSummary: scenario.summary
    }])
    assert.equal(database.execCalls, 0)
  }
})

test('redacts transaction-time schema checker failures and records a fixed code', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'private_table', 'private_column')
  ])
  const migration = registry.migrations[0]
  const database = new FakeAdoptionDatabase(registry)
  database.setProofs(migration, [
    matchingColumn(migration.compatibility),
    new Error('C:\\private\\nas.sqlite secret-business-row')
  ])

  const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

  assert.equal(error.code, 'MIGRATION_ADOPTION_SCHEMA_CHECK_FAILED')
  assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row|private_table|private_column/)
  assert.equal(database.ledger.size, 0)
  assert.deepEqual(listMigrationAttempts(database).map(({ status, errorCategory, errorSummary }) => ({
    status,
    errorCategory,
    errorSummary
  })), [{
    status: 'failed',
    errorCategory: 'database',
    errorSummary: 'MIGRATION_ADOPTION_PROOF_CHECK_FAILED'
  }])
})

test('keeps the first adoption committed when the second proof changes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column')
  ])
  const first = registry.migrations[0]
  const second = registry.migrations[1]
  const database = new FakeAdoptionDatabase(registry)
  database.setProofs(first, [matchingColumn(first.compatibility), matchingColumn(first.compatibility)])
  database.setProofs(second, [matchingColumn(second.compatibility), undefined])

  const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

  assert.equal(error.code, 'MIGRATION_ADOPTION_PROOF_MISSING')
  assert.deepEqual([...database.ledger.keys()], ['0001_first'])
  assert.deepEqual(listMigrationAttempts(database).map(({ migrationId, status }) => ({ migrationId, status })), [
    { migrationId: '0001_first', status: 'applied' },
    { migrationId: '0002_second', status: 'failed' }
  ])
})

test('leaves a committed ledger and started attempt for recovery after applied finalization fails', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  database.failAppliedFinalization = true

  const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

  assert.equal(error.code, 'MIGRATION_ADOPTION_COORDINATION_REQUIRED')
  assert.doesNotMatch(error.message, /attempt-finalization-secret|first_table|DROP TABLE/)
  assert.ok(getAppliedMigration(database, '0001_first'))
  assert.equal(listMigrationAttempts(database)[0].status, 'started')

  database.failAppliedFinalization = false
  const recovery = reconcileStartedMigrationAttempts({
    database,
    lock: activeLock(),
    now: () => RECOVERY_NOW
  })
  assert.equal(recovery.appliedCount, 1)
  assert.equal(listMigrationAttempts(database)[0].status, 'applied')
})

test('handles initial and transaction-time lock loss without releasing the lock', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])

  const initialDatabase = new FakeAdoptionDatabase(registry)
  const released = { state: 'released', releaseCalls: 0, release() { this.releaseCalls += 1 } }
  const initialError = thrown(() => adoptMigrationPrefix(request(registry, initialDatabase, {
    lock: released
  })))
  assert.equal(initialError.code, 'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE')
  assert.equal(initialDatabase.attempts.length, 0)
  assert.equal(released.releaseCalls, 0)

  const database = new FakeAdoptionDatabase(registry)
  const lock = activeLock()
  database.beforeTransaction = () => { lock.state = 'released' }
  const transactionError = thrown(() => adoptMigrationPrefix(request(registry, database, { lock })))
  assert.equal(transactionError.code, 'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE')
  assert.deepEqual(listMigrationAttempts(database).map(({ status, errorCategory, errorSummary }) => ({
    status,
    errorCategory,
    errorSummary
  })), [{
    status: 'failed',
    errorCategory: 'lock',
    errorSummary: 'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE'
  }])
  assert.equal(database.ledger.size, 0)
  assert.equal(lock.releaseCalls, 0)
})

test('uses the authoritative ledger to block history gaps before attempt writes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  database.seedLedger(registry.migrations[1])

  const error = thrown(() => adoptMigrationPrefix(request(registry, database, {
    appliedRecords: []
  })))

  assert.equal(error.code, 'MIGRATION_HISTORY_GAP')
  assert.equal(error.message, 'Migration adoption planning failed.')
  assert.deepEqual(database.checkedColumns, [])
  assert.equal(database.attempts.length, 0)
  assert.equal(database.transactionCalls, 0)
  assert.deepEqual([...database.ledger.keys()], ['0002_second'])
})

test('redacts authoritative ledger list failures before attempt writes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])
  const database = new FakeAdoptionDatabase(registry)
  database.failLedgerList = true

  const error = thrown(() => adoptMigrationPrefix(request(registry, database)))

  assert.equal(error.code, 'MIGRATION_ADOPTION_LEDGER_READ_FAILED')
  assert.doesNotMatch(error.message, /ledger-list-secret|private/)
  assert.deepEqual(database.checkedColumns, [])
  assert.equal(database.attempts.length, 0)
  assert.equal(database.transactionCalls, 0)
})

test('blocks invalid clocks before attempt writes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])

  const clockDatabase = new FakeAdoptionDatabase(registry)
  const clockError = thrown(() => adoptMigrationPrefix(request(registry, clockDatabase, {
    now: 'not-a-clock'
  })))
  assert.equal(clockError.code, 'MIGRATION_ADOPTION_CLOCK_INVALID')
  assert.equal(clockDatabase.prepareCalls, 0)
  assert.equal(clockDatabase.attempts.length, 0)

  for (const [now, code] of [
    [() => '2026-08-06T00:00:00Z', 'MIGRATION_ADOPTION_CLOCK_INVALID'],
    [() => { throw new Error('clock-secret') }, 'MIGRATION_ADOPTION_CLOCK_FAILED']
  ]) {
    const database = new FakeAdoptionDatabase(registry)
    const error = thrown(() => adoptMigrationPrefix(request(registry, database, { now })))
    assert.equal(error.code, code)
    assert.doesNotMatch(error.message, /clock-secret/)
    assert.equal(database.attempts.length, 0)
  }
})

test('adopts with real SQLite while leaving dangerous source untouched', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    ensureMigrationControlTables(database)
    database.exec(`
      CREATE TABLE resources (title TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE must_survive (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      definition('0001_first', 'resources', 'title', {
        source: 'DROP TABLE must_survive;'
      })
    ])

    const summary = adoptMigrationPrefix(request(registry, database))

    assert.deepEqual(summary, {
      adopted: [{ id: '0001_first', status: 'adopted' }],
      skipped: [],
      adoptedCount: 1,
      skippedCount: 0,
      totalAdoptable: 1
    })
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'must_survive'").get())
    assert.equal(getAppliedMigration(database, '0001_first').checksum, registry.migrations[0].checksum)
    assert.equal(listMigrationAttempts(database)[0].status, 'applied')
    assert.doesNotMatch(JSON.stringify(summary), /resources|title|DROP TABLE|[a-f0-9]{64}/)
  } finally {
    database.close()
  }
})

test('uses the real success ledger to reject a forged empty history snapshot', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    ensureMigrationControlTables(database)
    database.exec(`
      CREATE TABLE first_table (first_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_table (second_column TEXT NOT NULL DEFAULT 'ready');
    `)
    const registry = createMigrationRegistry([
      definition('0001_first', 'first_table', 'first_column'),
      definition('0002_second', 'second_table', 'second_column')
    ])
    const second = registry.migrations[1]
    recordSuccessfulMigration(database, {
      migrationId: second.id,
      checksum: second.checksum,
      appliedAt: FIXED_NOW
    })

    const error = thrown(() => adoptMigrationPrefix({
      database,
      registry,
      appliedRecords: [],
      lock: activeLock(),
      now: () => FIXED_NOW
    }))

    assert.equal(error.code, 'MIGRATION_HISTORY_GAP')
    assert.deepEqual(listAppliedMigrations(database).map(({ migrationId }) => migrationId), [
      '0002_second'
    ])
    assert.deepEqual(listMigrationAttempts(database), [])
  } finally {
    database.close()
  }
})
