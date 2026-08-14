import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createMigrationRegistry,
  defineMigration
} from '../src/config/migrationPlan.js'
import {
  MIGRATION_LOCK_BUSY,
  acquireMigrationLock,
  deriveMigrationLockPath
} from '../src/config/migrationLock.js'
import {
  ensureMigrationControlTables,
  recordSuccessfulMigration,
  startMigrationAttempt
} from '../src/config/migrationControlStore.js'
import {
  MIGRATION_STARTUP_GATE_ERROR_CODES,
  MigrationStartupGateError,
  runMigrationStartupGate
} from '../src/config/migrationStartupGate.js'

const require = createRequire(import.meta.url)
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const startupGateSourcePath = path.join(testDirectory, '..', 'src', 'config', 'migrationStartupGate.js')

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

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-migration-gate-'))
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function openDatabase(directory) {
  return new Database(path.join(directory, 'app.db'))
}

function definition(id, source) {
  return defineMigration({ id, source })
}

function compatibilityDefinition(id, source, table, column, options = {}) {
  return defineMigration({
    id,
    source,
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
  })
}

function thrown(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationStartupGateError)
    return error
  }
  assert.fail('Expected migration startup gate to throw.')
}

test('rejects invalid database, empty path and memory database before lock acquisition', () => {
  const error = thrown(() => runMigrationStartupGate({
    database: { name: ':memory:' },
    mainDbPath: ':memory:',
    registry: createMigrationRegistry([])
  }))
  assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_INVALID)
  assert.doesNotMatch(error.message, /memory|path|:/i)
})

test('rejects null input with the stable input error', () => {
  const error = thrown(() => runMigrationStartupGate(null))
  assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.INPUT_INVALID)
})

test('requires a real better-sqlite3 connection and matching ordinary file', () => {
  const directory = tempDirectory()
  try {
    const databasePath = path.join(directory, 'app.db')
    fs.writeFileSync(databasePath, '')
    const malformed = thrown(() => runMigrationStartupGate({
      database: { name: databasePath, prepare() {}, exec() {}, transaction() {}, pragma() {} },
      mainDbPath: databasePath,
      registry: createMigrationRegistry([])
    }))
    assert.equal(malformed.code, MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_INVALID)
  } finally {
    cleanup(directory)
  }
})

test('rejects a real connection when mainDbPath points at another file', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  const otherPath = path.join(directory, 'other.db')
  const other = new Database(otherPath)
  try {
    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: other.name,
      registry: createMigrationRegistry([])
    }))
    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.DATABASE_PATH_MISMATCH)
    assert.doesNotMatch(error.message, /other\.db|app\.db|\\|\//)
  } finally {
    other.close()
    database.close()
    cleanup(directory)
  }
})

test('blocks legacy table writes before acquiring a native lock', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry: { migrations: [{ id: '0001_legacy', source: 'INSERT INTO schema_migrations (version) VALUES (\'blocked\');' }] }
    }))
    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_MUTATION_BLOCKED)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('blocks quoted DROP and ALTER rename targets before lock acquisition', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    for (const [id, source] of [
      ['0001_drop_legacy', "DROP TABLE 'schema_migrations';"],
      ['0001_rename_legacy', 'ALTER TABLE source_table RENAME TO schema_migrations;'],
      ['0001_create_view', 'CREATE VIEW schema_migrations AS SELECT 1 AS version;'],
      ['0001_create_index', 'CREATE INDEX schema_migrations ON source_table(id);'],
      ['0001_drop_view', 'DROP VIEW schema_migrations;']
    ]) {
      const error = thrown(() => runMigrationStartupGate({
        database,
        mainDbPath: database.name,
        registry: createMigrationRegistry([definition(id, source)])
      }))
      assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_MUTATION_BLOCKED)
      assert.equal(fs.existsSync(deriveMigrationLockPath(database.name)), false)
    }
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('runs an empty registry without creating the legacy table', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const databasePath = database.name
    const summary = runMigrationStartupGate({
      database,
      mainDbPath: databasePath,
      registry: createMigrationRegistry([]),
      now: () => FIXED_NOW
    })
    assert.deepEqual(summary, {
      recovery: { scannedCount: 0, appliedCount: 0, interruptedCount: 0 },
      adoption: {
        adoptedCount: 0,
        skippedCount: 0,
        totalAdoptable: 0,
        records: []
      },
      execution: { executedCount: 0, skippedCount: 0, total: 0, records: [] },
      targetVersion: null,
      legacyTablePresent: false
    })
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined)
    assert.ok(Object.isFrozen(summary))
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('executes pending migrations and reports only safe records', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const registry = createMigrationRegistry([
      definition('0001_initial', 'CREATE TABLE app_items (id INTEGER PRIMARY KEY, value TEXT);'),
      definition('0002_second', "ALTER TABLE app_items ADD COLUMN note TEXT DEFAULT 'ok';")
    ])
    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    assert.equal(summary.execution.executedCount, 2)
    assert.deepEqual(summary.adoption, {
      adoptedCount: 0,
      skippedCount: 0,
      totalAdoptable: 0,
      records: []
    })
    assert.deepEqual(summary.execution.records.map(({ id, status }) => ({ id, status })), [
      { id: '0001_initial', status: 'applied' },
      { id: '0002_second', status: 'applied' }
    ])
    assert.equal(JSON.stringify(summary).includes('checksum'), false)
    assert.equal(JSON.stringify(summary).includes('hash'), false)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('runs the preparation hook exactly once before the first migration source', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const observations = []
    const registry = createMigrationRegistry([
      definition('0001_initial', 'CREATE TABLE prepared_items (id INTEGER PRIMARY KEY);'),
      definition('0002_second', 'ALTER TABLE prepared_items ADD COLUMN note TEXT;')
    ])
    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW,
      beforeFirstExecution: ({ database: hookDatabase, mainDbPath, pendingMigrationId }) => {
        observations.push({
          sameDatabase: hookDatabase === database,
          samePath: mainDbPath === path.resolve(database.name),
          pendingMigrationId,
          sourceNotRun: database.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prepared_items'"
          ).get() === undefined
        })
      }
    })
    assert.equal(summary.execution.executedCount, 2)
    assert.deepEqual(observations, [{
      sameDatabase: true,
      samePath: true,
      pendingMigrationId: '0001_initial',
      sourceNotRun: true
    }])
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('does not run the preparation hook when all migrations can be adopted', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec("CREATE TABLE adopted_items (title TEXT NOT NULL DEFAULT 'ready');")
    let hookCalls = 0
    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry: createMigrationRegistry([
        compatibilityDefinition(
          '0001_adopt',
          'DROP TABLE adopted_items;',
          'adopted_items',
          'title'
        )
      ]),
      now: () => FIXED_NOW,
      beforeFirstExecution: () => { hookCalls += 1 }
    })
    assert.equal(summary.adoption.adoptedCount, 1)
    assert.equal(summary.execution.executedCount, 0)
    assert.equal(hookCalls, 0)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('preparation failure blocks migration source execution', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry: createMigrationRegistry([
        definition('0001_blocked', 'CREATE TABLE must_not_exist (id INTEGER PRIMARY KEY);')
      ]),
      now: () => FIXED_NOW,
      beforeFirstExecution: () => {
        const failure = new Error('sensitive backup path must not escape')
        failure.code = 'DATABASE_BACKUP_CREATE_FAILED'
        throw failure
      }
    }))
    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED)
    assert.equal(error.message, 'Migration startup gate failed.')
    assert.equal(error.message.includes('sensitive'), false)
    assert.equal(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_exist'"
    ).get(), undefined)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('adopts satisfied schema without executing dangerous source', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE private_resources (private_title TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_resources (second_title TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE must_survive (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_adopt',
        'DROP TABLE must_survive;',
        'private_resources',
        'private_title'
      ),
      compatibilityDefinition(
        '0002_adopt',
        "ALTER TABLE second_resources ADD COLUMN second_title TEXT NOT NULL DEFAULT 'ready';",
        'second_resources',
        'second_title'
      )
    ])

    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    })

    assert.deepEqual(summary.adoption, {
      adoptedCount: 2,
      skippedCount: 0,
      totalAdoptable: 2,
      records: [
        { id: '0001_adopt', status: 'adopted' },
        { id: '0002_adopt', status: 'adopted' }
      ]
    })
    assert.equal(summary.execution.executedCount, 0)
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'must_survive'").get())
    assert.ok(Object.isFrozen(summary.adoption))
    assert.ok(Object.isFrozen(summary.adoption.records))
    assert.ok(Object.isFrozen(summary.adoption.records[0]))
    const serialized = JSON.stringify(summary)
    assert.doesNotMatch(serialized, /private_resources|private_title|second_resources|second_title|DROP TABLE|ALTER TABLE|checksum|[A-Za-z]:\\/)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('adopts a satisfied prefix then executes from the missing stop', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE first_table (first_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_table (id INTEGER);
      CREATE TABLE must_survive (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_first',
        'DROP TABLE must_survive;',
        'first_table',
        'first_column'
      ),
      compatibilityDefinition(
        '0002_second',
        "ALTER TABLE second_table ADD COLUMN second_column TEXT NOT NULL DEFAULT 'ready';",
        'second_table',
        'second_column'
      )
    ])

    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    })

    assert.deepEqual(summary.adoption, {
      adoptedCount: 1,
      skippedCount: 0,
      totalAdoptable: 1,
      records: [{ id: '0001_first', status: 'adopted' }]
    })
    assert.deepEqual(summary.execution.records, [
      { id: '0002_second', status: 'applied' }
    ])
    assert.equal(summary.execution.executedCount, 1)
    assert.ok(database.pragma('table_xinfo(second_table)').some(({ name }) => name === 'second_column'))
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'must_survive'").get())
    assert.ok(Object.isFrozen(summary.adoption.stopped))
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('adopts satisfied migrations after a missing migration without executing their source', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE first_table (first_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_table (id INTEGER);
      CREATE TABLE third_table (third_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE must_survive (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition('0001_first', 'DROP TABLE must_survive;', 'first_table', 'first_column'),
      compatibilityDefinition(
        '0002_second',
        "ALTER TABLE second_table ADD COLUMN second_column TEXT NOT NULL DEFAULT 'ready';",
        'second_table',
        'second_column'
      ),
      compatibilityDefinition(
        '0003_third',
        "ALTER TABLE third_table ADD COLUMN third_column TEXT NOT NULL DEFAULT 'ready';",
        'third_table',
        'third_column'
      )
    ])

    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    })

    assert.deepEqual(summary.adoption.records, [
      { id: '0001_first', status: 'adopted' },
      { id: '0003_third', status: 'adopted' }
    ])
    assert.deepEqual(summary.execution.records, [
      { id: '0002_second', status: 'applied' }
    ])
    assert.equal(summary.adoption.adoptedCount, 2)
    assert.equal(summary.execution.executedCount, 1)
    assert.equal(Object.hasOwn(summary.adoption, 'stopped'), false)
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'must_survive'").get())
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('coordinates alternating satisfied and missing migrations one pending step at a time', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE first_table (first_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_table (id INTEGER);
      CREATE TABLE third_table (third_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE fourth_table (id INTEGER);
      CREATE TABLE first_sentinel (id INTEGER);
      CREATE TABLE third_sentinel (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition('0001_first', 'DROP TABLE first_sentinel;', 'first_table', 'first_column'),
      compatibilityDefinition(
        '0002_second',
        "ALTER TABLE second_table ADD COLUMN second_column TEXT NOT NULL DEFAULT 'ready';",
        'second_table',
        'second_column'
      ),
      compatibilityDefinition('0003_third', 'DROP TABLE third_sentinel;', 'third_table', 'third_column'),
      compatibilityDefinition(
        '0004_fourth',
        "ALTER TABLE fourth_table ADD COLUMN fourth_column TEXT NOT NULL DEFAULT 'ready';",
        'fourth_table',
        'fourth_column'
      )
    ])

    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })

    assert.deepEqual(summary.adoption.records, [
      { id: '0001_first', status: 'adopted' },
      { id: '0003_third', status: 'adopted' }
    ])
    assert.deepEqual(summary.execution.records, [
      { id: '0002_second', status: 'applied' },
      { id: '0004_fourth', status: 'applied' }
    ])
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'first_sentinel'").get())
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'third_sentinel'").get())
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('executes an all-missing compatibility registry as isolated single steps', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE first_table (id INTEGER);
      CREATE TABLE second_table (id INTEGER);
      CREATE TABLE third_table (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_first',
        "ALTER TABLE first_table ADD COLUMN first_column TEXT NOT NULL DEFAULT 'ready';",
        'first_table',
        'first_column'
      ),
      compatibilityDefinition(
        '0002_second',
        "ALTER TABLE second_table ADD COLUMN second_column TEXT NOT NULL DEFAULT 'ready';",
        'second_table',
        'second_column'
      ),
      compatibilityDefinition(
        '0003_third',
        "ALTER TABLE third_table ADD COLUMN third_column TEXT NOT NULL DEFAULT 'ready';",
        'third_table',
        'third_column'
      )
    ])

    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })

    assert.deepEqual(summary.adoption.records, [])
    assert.deepEqual(summary.execution.records, [
      { id: '0001_first', status: 'applied' },
      { id: '0002_second', status: 'applied' },
      { id: '0003_third', status: 'applied' }
    ])
    assert.equal(summary.execution.total, 3)
    assert.equal(Object.hasOwn(summary.adoption, 'stopped'), false)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('preserves the legacy schema and rows, including special text', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT, note TEXT);
      INSERT INTO schema_migrations (version, note) VALUES ('v1', 'a; ''quoted''');
      INSERT INTO schema_migrations (version, note) VALUES ('v2', '汉字');
      CREATE TABLE adoption_probe (ready TEXT NOT NULL DEFAULT 'ready');
    `)
    const beforeSchema = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'").get()
    const beforeRows = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry: createMigrationRegistry([
        compatibilityDefinition(
          '0001_adopt',
          'DROP TABLE adoption_probe;',
          'adoption_probe',
          'ready'
        )
      ]),
      now: () => FIXED_NOW
    })
    const afterSchema = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'").get()
    const afterRows = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
    assert.equal(summary.legacyTablePresent, true)
    assert.equal(summary.adoption.adoptedCount, 1)
    assert.equal(summary.execution.executedCount, 0)
    assert.deepEqual(afterSchema, beforeSchema)
    assert.deepEqual(afterRows, beforeRows)
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'adoption_probe'").get())
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('installs idempotent connection-local legacy guards and keeps them installed', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec('CREATE TABLE schema_migrations (version TEXT);')
    const registry = createMigrationRegistry([])
    const first = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    const second = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    assert.equal(first.legacyTablePresent, true)
    assert.equal(second.legacyTablePresent, true)
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'prm_legacy_schema_migrations_%_guard'").get().count,
      3
    )
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('blocks cascaded legacy deletes and rolls back the migration transaction', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.pragma('foreign_keys = ON')
    database.exec(`
      CREATE TABLE legacy_parent (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES legacy_parent(id) ON DELETE CASCADE
      );
      INSERT INTO legacy_parent (id, value) VALUES (1, 'keep');
      INSERT INTO schema_migrations (version, parent_id) VALUES ('v1', 1);
    `)
    const registry = createMigrationRegistry([
      definition('0001_delete_parent', "DELETE FROM legacy_parent WHERE id = 1;")
    ])
    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    }))
    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED)
    assert.deepEqual(database.prepare('SELECT * FROM legacy_parent').all(), [{ id: 1, value: 'keep' }])
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), [{ version: 'v1', parent_id: 1 }])
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('reconciles an applied started attempt without re-executing it', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    ensureMigrationControlTables(database)
    const registry = createMigrationRegistry([
      definition('0001_existing', 'CREATE TABLE must_not_execute (id INTEGER);')
    ])
    startMigrationAttempt(database, {
      migrationId: '0001_existing',
      checksum: registry.migrations[0].checksum,
      startedAt: FIXED_NOW
    })
    recordSuccessfulMigration(database, {
      migrationId: '0001_existing',
      checksum: registry.migrations[0].checksum,
      appliedAt: FIXED_NOW
    })
    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    assert.equal(summary.recovery.appliedCount, 1)
    assert.equal(summary.recovery.interruptedCount, 0)
    assert.equal(summary.adoption.totalAdoptable, 0)
    assert.deepEqual(summary.adoption.records, [])
    assert.equal(summary.execution.executedCount, 0)
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'must_not_execute'").get(), undefined)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('does not treat an ordinary string value as a legacy table name', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const registry = createMigrationRegistry([definition(
      '0001_string_value',
      "CREATE TABLE string_values (value TEXT); INSERT INTO string_values (value) VALUES ('schema_migrations');"
    )])
    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    assert.equal(summary.execution.executedCount, 1)
    assert.deepEqual(database.prepare('SELECT value FROM string_values').all(), [{ value: 'schema_migrations' }])
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('reconciles started attempts and rebuilds the plan from the ledger', nativeTestOptions, () => {
  const directory = tempDirectory()
    const database = openDatabase(directory)
  try {
    const registry = createMigrationRegistry([definition('0001_initial', 'CREATE TABLE recovered (id INTEGER);')])
    ensureMigrationControlTables(database)
    startMigrationAttempt(database, {
      migrationId: '0001_initial',
      checksum: registry.migrations[0].checksum,
      startedAt: FIXED_NOW
    })
    const summary = runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW })
    assert.equal(summary.recovery.interruptedCount, 1)
    assert.equal(summary.execution.executedCount, 1)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('supports deferred target versions', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec('CREATE TABLE first (id INTEGER);')
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_initial',
        'DROP TABLE first;',
        'first',
        'id',
        { type: 'INTEGER', notNull: false, defaultValue: null }
      ),
      compatibilityDefinition(
        '0002_deferred',
        'CREATE TABLE deferred (id INTEGER);',
        'deferred',
        'id',
        { type: 'INTEGER', notNull: false, defaultValue: null }
      )
    ])
    const summary = runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      targetVersion: '0001_initial',
      now: () => FIXED_NOW
    })
    assert.equal(summary.targetVersion, '0001_initial')
    assert.equal(summary.adoption.adoptedCount, 1)
    assert.deepEqual(summary.adoption.records, [{ id: '0001_initial', status: 'adopted' }])
    assert.equal(summary.execution.executedCount, 0)
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'first'").get())
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'deferred'").get(), undefined)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('maps adoption failures safely and releases the sidecar lock', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('legacy-1');
      CREATE TABLE private_resources (
        private_title INTEGER NOT NULL DEFAULT 'ready'
      );
      CREATE TABLE must_survive (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_incompatible',
        'DROP TABLE must_survive;',
        'private_resources',
        'private_title'
      )
    ])
    const beforeLegacy = database.prepare('SELECT * FROM schema_migrations').all()

    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    }))

    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED)
    assert.equal(error.cause?.code, 'MIGRATION_ADOPTION_SCHEMA_INCOMPATIBLE')
    assert.deepEqual(error.cause?.diagnostics, {
      migrationId: '0001_incompatible',
      category: 'schema-compatibility',
      reason: 'column-incompatible'
    })
    assert.ok(Object.keys(error.cause).includes('diagnostics'))
    assert.ok(Object.isFrozen(error.cause.diagnostics))
    assert.doesNotMatch(
      error.message,
      /private_resources|private_title|DROP TABLE|must_survive|schema_migrations|checksum|\\|\//
    )
    assert.doesNotMatch(
      JSON.stringify(error.cause),
      /private_resources|private_title|DROP TABLE|must_survive|schema_migrations|checksum|\\|\//
    )
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), beforeLegacy)
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'must_survive'").get())

    const lock = acquireMigrationLock(database.name, { busyTimeoutMs: 100 })
    assert.equal(lock.state, 'active')
    lock.release()
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('releases the lock after migration failure and permits reacquisition', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const registry = createMigrationRegistry([definition('0001_bad', 'CREATE TABLE broken (id INTEGER); CREATE TABLE broken (id INTEGER);')])
    assert.throws(() => runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW }), MigrationStartupGateError)
    const lock = acquireMigrationLock(database.name, { busyTimeoutMs: 100 })
    assert.equal(lock.state, 'active')
    lock.release()
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('preserves earlier committed progress when a later single-step execution fails', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec(`
      CREATE TABLE first_table (id INTEGER);
      CREATE TABLE second_table (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      compatibilityDefinition(
        '0001_first',
        "ALTER TABLE first_table ADD COLUMN first_column TEXT NOT NULL DEFAULT 'ready';",
        'first_table',
        'first_column'
      ),
      compatibilityDefinition(
        '0002_second',
        "ALTER TABLE second_table ADD COLUMN second_column TEXT; ALTER TABLE second_table ADD COLUMN second_column TEXT;",
        'second_table',
        'second_column',
        { notNull: false, defaultValue: null }
      )
    ])

    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    }))

    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.FAILED)
    assert.ok(database.pragma('table_xinfo(first_table)').some(({ name }) => name === 'first_column'))
    assert.equal(database.pragma('table_xinfo(second_table)').some(({ name }) => name === 'second_column'), false)
    assert.deepEqual(database.prepare(
      'SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id'
    ).all(), [{ migration_id: '0001_first' }])

    const lock = acquireMigrationLock(database.name, { busyTimeoutMs: 100 })
    assert.equal(lock.state, 'active')
    lock.release()
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('fails safely when a completed step does not increase the in-scope ledger', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    const registry = createMigrationRegistry([
      definition('0001_first', 'CREATE TABLE first_table (id INTEGER);'),
      definition(
        '0002_stall',
        'DELETE FROM prm_schema_migrations; CREATE TABLE private_stall_probe (id INTEGER);'
      )
    ])

    const error = thrown(() => runMigrationStartupGate({
      database,
      mainDbPath: database.name,
      registry,
      now: () => FIXED_NOW
    }))

    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.PROGRESS_STALLED)
    assert.doesNotMatch(error.message, /prm_schema_migrations|private_stall_probe|DELETE|checksum|\\|\//i)
    assert.deepEqual(database.prepare(
      'SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id'
    ).all(), [{ migration_id: '0002_stall' }])

    const lock = acquireMigrationLock(database.name, { busyTimeoutMs: 100 })
    assert.equal(lock.state, 'active')
    lock.release()
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('static coordinator has a target-scoped iteration guard and explicit stall failure', () => {
  const source = fs.readFileSync(startupGateSourcePath, 'utf8')
  assert.match(source, /const iterationLimit = scopeMigrations\.length \+ 1/u)
  assert.match(source, /iterationCount >= iterationLimit/u)
  assert.match(source, /MIGRATION_STARTUP_GATE_ITERATION_LIMIT_EXCEEDED/u)
  assert.match(source, /appliedAfter <= appliedBefore/u)
  assert.match(source, /MIGRATION_STARTUP_GATE_PROGRESS_STALLED/u)
})

test('detects committed legacy changes and keeps the public error safe', nativeTestOptions, () => {
  const directory = tempDirectory()
  const database = openDatabase(directory)
  try {
    database.exec('CREATE TABLE schema_migrations (version TEXT);')
    const registry = createMigrationRegistry([definition('0001_bad', 'UPDATE schema_migrations SET version = \'changed\';')])
    const error = thrown(() => runMigrationStartupGate({ database, mainDbPath: database.name, registry, now: () => FIXED_NOW }))
    assert.equal(error.code, MIGRATION_STARTUP_GATE_ERROR_CODES.LEGACY_MUTATION_BLOCKED)
    assert.doesNotMatch(error.message, /schema_migrations|SQL|hash|checksum|[A-Za-z]:\\/i)
  } finally {
    database.close()
    cleanup(directory)
  }
})

test('exposes a stable busy code without exposing a path', nativeTestOptions, () => {
  const directory = tempDirectory()
  const first = openDatabase(directory)
  const second = openDatabase(directory)
  try {
    const lock = acquireMigrationLock(first.name, { busyTimeoutMs: 100 })
    const error = thrown(() => runMigrationStartupGate({
      database: second,
      mainDbPath: second.name,
      registry: createMigrationRegistry([]),
      lockOptions: { busyTimeoutMs: 100 }
    }))
    assert.equal(error.code, MIGRATION_LOCK_BUSY)
    assert.doesNotMatch(error.message, /\\|\//)
    lock.release()
  } finally {
    first.close()
    second.close()
    cleanup(directory)
  }
})
