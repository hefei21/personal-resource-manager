import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  createMigrationPlan,
  createMigrationRegistry
} from '../src/config/migrationPlan.js'
import {
  ensureMigrationControlTables,
  getAppliedMigration,
  listAppliedMigrations,
  listMigrationAttempts,
  recordSuccessfulMigration
} from '../src/config/migrationControlStore.js'
import {
  executeMigrationBatch,
  MigrationExecutorError
} from '../src/config/migrationExecutor.js'

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
const FIXED_NOW = '2026-08-05T00:00:00.000Z'

function openDatabase() {
  const database = new Database(':memory:')
  ensureMigrationControlTables(database)
  return database
}

function definition(id, source) {
  return { id, source }
}

function compatibilityDefinition(id, source, overrides = {}) {
  return {
    id,
    source,
    compatibility: {
      kind: 'column',
      table: 'resources',
      column: {
        name: 'title',
        type: 'TEXT',
        notNull: true,
        defaultValue: "'ready'"
      },
      ...overrides
    }
  }
}

function batch(definitions, appliedRecords = []) {
  const registry = createMigrationRegistry(definitions)
  return {
    registry,
    plan: createMigrationPlan(registry, appliedRecords),
    lock: ACTIVE_LOCK,
    now: () => FIXED_NOW
  }
}

function fakeDatabase() {
  return { exec() {}, prepare() {}, transaction(run) { return run } }
}

function probeDatabase() {
  let prepareCalls = 0
  let execCalls = 0
  let transactionCalls = 0
  const database = {
    exec() {
      execCalls += 1
    },
    prepare() {
      prepareCalls += 1
      throw new Error('database access must not occur')
    },
    transaction(run) {
      transactionCalls += 1
      return run
    }
  }
  return { database, get counts() { return { prepareCalls, execCalls, transactionCalls } } }
}

function missingLedgerDatabase() {
  let prepareCalls = 0
  let execCalls = 0
  let transactionCalls = 0
  const database = {
    exec() {
      execCalls += 1
    },
    prepare() {
      prepareCalls += 1
      return { get() { return undefined } }
    },
    transaction(run) {
      transactionCalls += 1
      return run
    }
  }
  return { database, get counts() { return { prepareCalls, execCalls, transactionCalls } } }
}

function thrown(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationExecutorError)
    return error
  }
  assert.fail('Expected migration executor to throw.')
}

test('rejects missing or released locks before execution', () => {
  const request = batch([definition('0001_initial', 'CREATE TABLE initial (id INTEGER);')])
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), lock: null })).code, 'MIGRATION_LOCK_NOT_ACTIVE')
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), lock: { state: 'released' } })).code, 'MIGRATION_LOCK_NOT_ACTIVE')
})

test('rejects malformed plans and registry checksum/source mismatches', () => {
  const request = batch([definition('0001_initial', 'CREATE TABLE initial (id INTEGER);')])
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), plan: { pending: [] } })).code, 'MIGRATION_EXECUTOR_PLAN_INVALID')

  const badRegistry = {
    migrations: [{
      id: '0001_initial',
      source: 'CREATE TABLE initial (id INTEGER);',
      checksum: 'a'.repeat(64)
    }]
  }
  assert.equal(thrown(() => executeMigrationBatch({
    database: fakeDatabase(),
    registry: badRegistry,
    plan: request.plan,
    lock: ACTIVE_LOCK,
    now: () => FIXED_NOW
  })).code, 'MIGRATION_EXECUTOR_REGISTRY_INVALID')

  const mismatchedPlan = { ...request.plan, pending: [{ id: '0001_initial', checksum: 'b'.repeat(64) }] }
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), plan: mismatchedPlan })).code, 'MIGRATION_EXECUTOR_PLAN_REGISTRY_MISMATCH')
})

test('preserves normalized compatibility while validating the registry', () => {
  const request = batch([
    compatibilityDefinition('0001_expand', 'ALTER TABLE resources ADD COLUMN title TEXT NOT NULL DEFAULT \'ready\';')
  ])
  const probe = probeDatabase()
  const error = thrown(() => executeMigrationBatch({ ...request, database: probe.database }))

  assert.equal(error.code, 'MIGRATION_EXECUTION_FAILED')
  assert.notEqual(error.code, 'MIGRATION_EXECUTOR_REGISTRY_INVALID')
  assert.deepEqual(probe.counts, { prepareCalls: 1, execCalls: 0, transactionCalls: 0 })
})

test('rejects stripped, altered, or non-normalized compatibility before any database access', () => {
  const request = batch([
    compatibilityDefinition('0001_expand', 'ALTER TABLE resources ADD COLUMN title TEXT NOT NULL DEFAULT \'ready\';')
  ])
  const migration = request.registry.migrations[0]
  const base = {
    id: migration.id,
    source: migration.source,
    checksum: migration.checksum
  }
  const validCompatibility = migration.compatibility
  const invalidRegistries = [
    { migrations: [{ ...base }] },
    {
      migrations: [{
        ...base,
        compatibility: {
          ...validCompatibility,
          column: { ...validCompatibility.column, type: 'INTEGER' }
        }
      }]
    },
    {
      migrations: [{
        ...base,
        compatibility: {
          ...validCompatibility,
          column: { ...validCompatibility.column, type: ' text ' }
        }
      }]
    },
    {
      migrations: [{
        ...base,
        checksum: 'a'.repeat(64),
        compatibility: validCompatibility
      }]
    },
    {
      migrations: [{
        ...base,
        compatibility: { ...validCompatibility, unsupported: true }
      }]
    },
    {
      migrations: [{ ...base, compatibility: undefined }]
    }
  ]

  for (const registry of invalidRegistries) {
    const probe = probeDatabase()
    const error = thrown(() => executeMigrationBatch({
      ...request,
      database: probe.database,
      registry
    }))
    assert.equal(error.code, 'MIGRATION_EXECUTOR_REGISTRY_INVALID')
    assert.deepEqual(probe.counts, { prepareCalls: 0, execCalls: 0, transactionCalls: 0 })
  }
})

test('requires applied, pending, and deferred segments to be complete and ordered', () => {
  const request = batch([
    definition('0001_initial', 'CREATE TABLE initial (id INTEGER);'),
    definition('0002_second', 'CREATE TABLE second (id INTEGER);')
  ])
  const first = request.registry.migrations[0]
  const second = request.registry.migrations[1]
  const missingPending = { ...request.plan, pending: [{ id: first.id, checksum: first.checksum }] }
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), plan: missingPending })).code, 'MIGRATION_EXECUTOR_PLAN_ORDER_INVALID')

  const reorderedPending = {
    ...request.plan,
    pending: [
      { id: second.id, checksum: second.checksum },
      { id: first.id, checksum: first.checksum }
    ]
  }
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), plan: reorderedPending })).code, 'MIGRATION_EXECUTOR_PLAN_ORDER_INVALID')

  const duplicateSegment = {
    ...request.plan,
    applied: [{ id: first.id, checksum: first.checksum }],
    pending: [{ id: first.id, checksum: first.checksum }, { id: second.id, checksum: second.checksum }],
    targetVersion: second.id
  }
  assert.equal(thrown(() => executeMigrationBatch({ ...request, database: fakeDatabase(), plan: duplicateSegment })).code, 'MIGRATION_EXECUTOR_PLAN_INVALID')
})

test('rejects a plan that claims an applied migration missing from the success ledger before any write', () => {
  const request = batch([
    definition('0001_initial', 'CREATE TABLE initial (id INTEGER);'),
    definition('0002_second', 'CREATE TABLE second (id INTEGER);')
  ])
  const applied = request.registry.migrations[0]
  const pending = request.registry.migrations[1]
  const plan = createMigrationPlan(request.registry, [{ id: applied.id, checksum: applied.checksum }])
  const probe = missingLedgerDatabase()
  const error = thrown(() => executeMigrationBatch({ ...request, database: probe.database, plan }))
  assert.equal(error.code, 'MIGRATION_APPLIED_LEDGER_MISSING')
  assert.deepEqual(probe.counts, { prepareCalls: 1, execCalls: 0, transactionCalls: 0 })
  assert.equal(plan.pending[0].id, pending.id)
})

test('rejects every blocked SQL class before creating any attempt', () => {
  const blockedSources = [
    'BEGIN;',
    'COMMIT;',
    'END;',
    'END TRANSACTION;',
    'ROLLBACK;',
    'SAVEPOINT checkpoint;',
    'RELEASE checkpoint;',
    "ATTACH DATABASE 'other.db' AS other;",
    'DETACH DATABASE other;',
    'VACUUM;',
    'PRAGMA user_version;'
  ]
  for (const [index, source] of blockedSources.entries()) {
    const request = batch([definition(`${String(index + 1).padStart(4, '0')}_blocked`, source)])
    const probe = probeDatabase()
    const error = thrown(() => executeMigrationBatch({ ...request, database: probe.database }))
    assert.equal(error.code, 'MIGRATION_SQL_UNSAFE')
    assert.equal(error.message.includes(source), false)
    assert.deepEqual(probe.counts, { prepareCalls: 0, execCalls: 0, transactionCalls: 0 })
  }
})

test('ignores blocked words in literals, quoted identifiers, and comments', () => {
  const safeSource = `
    CREATE TABLE "BEGIN" (value TEXT DEFAULT 'COMMIT; ROLLBACK');
    -- ATTACH DATABASE 'secret.db';
    /* PRAGMA user_version; VACUUM; SAVEPOINT x; */
  `
  const request = batch([definition('0001_safe_words', safeSource)])
  const probe = probeDatabase()
  const error = thrown(() => executeMigrationBatch({ ...request, database: probe.database }))
  assert.notEqual(error.code, 'MIGRATION_SQL_UNSAFE')
  assert.equal(error.cause?.message, 'database access must not occur')
  assert.deepEqual(probe.counts, { prepareCalls: 1, execCalls: 0, transactionCalls: 0 })
})

test('does not allow comments to separate transaction-control words from detection', () => {
  for (const source of ['BEGIN /* comment */ TRANSACTION;', 'END /* comment */ TRANSACTION;']) {
    const request = batch([definition('0001_commented_control', source)])
    const probe = probeDatabase()
    assert.equal(thrown(() => executeMigrationBatch({ ...request, database: probe.database })).code, 'MIGRATION_SQL_UNSAFE')
    assert.deepEqual(probe.counts, { prepareCalls: 0, execCalls: 0, transactionCalls: 0 })
  }
})

test('allows CASE expression END while rejecting END at a later statement boundary', () => {
  const safeRequest = batch([definition(
    '0001_case_expression',
    'CREATE TABLE case_probe AS SELECT CASE WHEN 1 THEN 1 ELSE 0 END AS value;'
  )])
  const safeProbe = probeDatabase()
  const safeError = thrown(() => executeMigrationBatch({ ...safeRequest, database: safeProbe.database }))
  assert.notEqual(safeError.code, 'MIGRATION_SQL_UNSAFE')

  const unsafeRequest = batch([definition(
    '0001_end_alias',
    'CREATE TABLE end_probe (id INTEGER); /* boundary */ END;'
  )])
  const unsafeProbe = probeDatabase()
  assert.equal(
    thrown(() => executeMigrationBatch({ ...unsafeRequest, database: unsafeProbe.database })).code,
    'MIGRATION_SQL_UNSAFE'
  )
  assert.deepEqual(unsafeProbe.counts, { prepareCalls: 0, execCalls: 0, transactionCalls: 0 })
})

test('executes pending migrations in order and records applied attempts', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const request = batch([
      definition('0001_initial', `CREATE TABLE migration_order (name TEXT); INSERT INTO migration_order VALUES ('one');`),
      definition('0002_second', `INSERT INTO migration_order VALUES ('two');`)
    ])
    const summary = executeMigrationBatch({ database, ...request })
    assert.deepEqual(summary.executed, [
      { id: '0001_initial', status: 'applied' },
      { id: '0002_second', status: 'applied' }
    ])
    assert.deepEqual(database.prepare('SELECT name FROM migration_order ORDER BY rowid').all(), [{ name: 'one' }, { name: 'two' }])
    assert.deepEqual(listAppliedMigrations(database).map(({ migrationId, checksum }) => ({ migrationId, checksum })), request.registry.migrations.map(({ id, checksum }) => ({ migrationId: id, checksum })))
    assert.deepEqual(listMigrationAttempts(database).map(({ migrationId, status }) => ({ migrationId, status })), [
      { migrationId: '0001_initial', status: 'applied' },
      { migrationId: '0002_second', status: 'applied' }
    ])
    assert.equal(Object.isFrozen(summary), true)
    assert.equal(Object.isFrozen(summary.executed), true)
    assert.equal('source' in summary, false)
  } finally {
    database.close()
  }
})

test('executes a pending compatibility migration without exposing its condition', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec('CREATE TABLE private_resources (id INTEGER);')
    const request = batch([{
      id: '0001_expand',
      source: "ALTER TABLE private_resources ADD COLUMN private_title TEXT NOT NULL DEFAULT '/synthetic/private.db';",
      compatibility: {
        kind: 'column',
        table: 'private_resources',
        column: {
          name: 'private_title',
          type: 'TEXT',
          notNull: true,
          defaultValue: "'/synthetic/private.db'"
        }
      }
    }])
    const migration = request.registry.migrations[0]

    const summary = executeMigrationBatch({ database, ...request })

    assert.deepEqual(summary, {
      executed: [{ id: '0001_expand', status: 'applied' }],
      skipped: [],
      executedCount: 1,
      skippedCount: 0,
      total: 1
    })
    assert.ok(database.pragma('table_xinfo(private_resources)').some(({ name }) => name === 'private_title'))
    assert.equal(getAppliedMigration(database, migration.id).checksum, migration.checksum)
    assert.deepEqual(listMigrationAttempts(database).map(({ migrationId, status }) => ({ migrationId, status })), [
      { migrationId: '0001_expand', status: 'applied' }
    ])

    const serialized = JSON.stringify(summary)
    assert.doesNotMatch(serialized, /private_resources|private_title|ALTER TABLE|synthetic\/private\.db/)
    assert.equal(serialized.includes(migration.checksum), false)
  } finally {
    database.close()
  }
})

test('rolls back a failing migration, records failed, and stops the batch without leaking SQL', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const secretSql = `CREATE TABLE rollback_probe (value TEXT); INSERT INTO missing_table VALUES ('migration-secret');`
    const request = batch([
      definition('0001_broken', secretSql),
      definition('0002_never', 'CREATE TABLE must_not_run (id INTEGER);')
    ])
    const error = thrown(() => executeMigrationBatch({ database, ...request }))
    assert.equal(error.code, 'MIGRATION_EXECUTION_FAILED')
    assert.equal(error.category, 'database')
    assert.equal(error.machineCode, 'SQLITE_ERROR')
    assert.match(String(error.cause?.message), /missing_table/)
    assert.doesNotMatch(error.message, /missing_table|migration-secret|CREATE TABLE/)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_probe'").get(), undefined)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'must_not_run'").get(), undefined)
    assert.deepEqual(listMigrationAttempts(database).map(({ migrationId, status, errorCategory, errorSummary }) => ({ migrationId, status, errorCategory, errorSummary })), [{
      migrationId: '0001_broken',
      status: 'failed',
      errorCategory: 'database',
      errorSummary: 'SQLITE_ERROR'
    }])
  } finally {
    database.close()
  }
})

test('keeps the first migration committed when the second migration fails', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const request = batch([
      definition('0001_first', 'CREATE TABLE first_committed (id INTEGER);'),
      definition('0002_second', 'CREATE TABLE first_committed (id INTEGER);')
    ])
    thrown(() => executeMigrationBatch({ database, ...request }))
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'first_committed'").get())
    assert.equal(getAppliedMigration(database, '0001_first').checksum, request.registry.migrations[0].checksum)
    assert.equal(getAppliedMigration(database, '0002_second'), null)
  } finally {
    database.close()
  }
})

test('skips a stale plan when the ledger has the same checksum and blocks a conflicting checksum', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    const request = batch([definition('0001_initial', 'CREATE TABLE stale_probe (id INTEGER);')])
    const migration = request.registry.migrations[0]
    recordSuccessfulMigration(database, { migrationId: migration.id, checksum: migration.checksum, appliedAt: FIXED_NOW })
    const skipped = executeMigrationBatch({ database, ...request })
    assert.deepEqual(skipped.skipped, [{ id: '0001_initial', status: 'skipped' }])
    assert.equal(listMigrationAttempts(database).length, 0)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'stale_probe'").get(), undefined)

    const conflictDatabase = openDatabase()
    try {
      const conflictingChecksum = 'c'.repeat(64)
      recordSuccessfulMigration(conflictDatabase, { migrationId: migration.id, checksum: conflictingChecksum, appliedAt: FIXED_NOW })
      const error = thrown(() => executeMigrationBatch({ database: conflictDatabase, ...request }))
      assert.equal(error.code, 'MIGRATION_CHECKSUM_CONFLICT')
      assert.equal(listMigrationAttempts(conflictDatabase).length, 0)
    } finally {
      conflictDatabase.close()
    }
  } finally {
    database.close()
  }
})

test('reports a coordination error when applied finalization fails after commit', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TRIGGER fail_applied_attempt
      BEFORE UPDATE OF status ON prm_migration_attempts
      WHEN NEW.status = 'applied'
      BEGIN
        SELECT RAISE(ABORT, 'finalization-secret');
      END
    `)
    const request = batch([definition('0001_committed', 'CREATE TABLE committed_before_coordination (id INTEGER);')])
    const error = thrown(() => executeMigrationBatch({ database, ...request }))
    assert.equal(error.code, 'MIGRATION_EXECUTION_COORDINATION_REQUIRED')
    assert.doesNotMatch(error.message, /finalization-secret|CREATE TABLE/)
    assert.ok(getAppliedMigration(database, '0001_committed'))
    assert.equal(listMigrationAttempts(database)[0].status, 'started')
  } finally {
    database.close()
  }
})

test('leaves legacy schema_migrations unchanged', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec('CREATE TABLE schema_migrations (version TEXT NOT NULL); INSERT INTO schema_migrations VALUES (\'legacy-1\');')
    const request = batch([definition('0001_new_controlled', 'CREATE TABLE new_controlled (id INTEGER);')])
    executeMigrationBatch({ database, ...request })
    assert.deepEqual(database.prepare('SELECT version FROM schema_migrations').all(), [{ version: 'legacy-1' }])
  } finally {
    database.close()
  }
})
