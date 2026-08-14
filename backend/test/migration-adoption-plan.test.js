import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  createMigrationAdoptionPlan,
  MigrationAdoptionPlanError
} from '../src/config/migrationAdoptionPlan.js'
import { createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  MIGRATION_LOCK_ACTIVE,
  MIGRATION_LOCK_RELEASED
} from '../src/config/migrationLock.js'

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

const ACTIVE_LOCK = Object.freeze({ state: MIGRATION_LOCK_ACTIVE })

function definition(id, table, column, options = {}) {
  const type = options.type ?? 'TEXT'
  const notNull = options.notNull ?? true
  const defaultValue = Object.hasOwn(options, 'defaultValue')
    ? options.defaultValue
    : "'ready'"
  const constraints = [
    notNull ? 'NOT NULL' : '',
    defaultValue === null ? '' : `DEFAULT ${defaultValue}`
  ].filter(Boolean).join(' ')
  return {
    id,
    source: `ALTER TABLE ${table} ADD COLUMN ${column} ${type} ${constraints};`,
    compatibility: {
      kind: 'column',
      table,
      column: { name: column, type, notNull, defaultValue }
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

function matchingSchemas(registry) {
  const schemas = {}
  for (const migration of registry.migrations) {
    if (!migration.compatibility) continue
    const { table, column } = migration.compatibility
    schemas[table] ??= { columns: {} }
    schemas[table].columns[column.name] = matchingColumn(migration.compatibility)
  }
  return schemas
}

function schemaProbe(schemas = {}) {
  const counts = {
    prepare: 0,
    get: 0,
    exec: 0,
    transaction: 0,
    run: 0
  }
  const checkedColumns = []
  const preparedSql = []
  const database = {
    prepare(sql) {
      counts.prepare += 1
      preparedSql.push(sql)
      if (sql.includes('sqlite_schema')) {
        return {
          get(table) {
            counts.get += 1
            return schemas[table] ? { present: 1 } : undefined
          },
          run() {
            counts.run += 1
            throw new Error('run must not be called')
          }
        }
      }
      if (sql.includes('pragma_table_xinfo')) {
        return {
          get(table, column) {
            counts.get += 1
            checkedColumns.push(`${table}.${column}`)
            return schemas[table]?.columns?.[column]
          },
          run() {
            counts.run += 1
            throw new Error('run must not be called')
          }
        }
      }
      throw new Error('unexpected schema query')
    },
    exec() {
      counts.exec += 1
      throw new Error('exec must not be called')
    },
    transaction() {
      counts.transaction += 1
      throw new Error('transaction must not be called')
    },
    run() {
      counts.run += 1
      throw new Error('run must not be called')
    }
  }
  return {
    database,
    counts,
    checkedColumns,
    preparedSql
  }
}

function thrown(action) {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof MigrationAdoptionPlanError)
    return error
  }
  assert.fail('Expected migration adoption planning to throw.')
}

test('returns a deeply frozen, redacted all-satisfied prefix without writes', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'secret_resources', 'secret_title', {
      defaultValue: "'/synthetic/private.db'"
    }),
    definition('0002_second', 'secret_documents', 'secret_summary')
  ])
  const probe = schemaProbe(matchingSchemas(registry))

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    appliedRecords: [],
    lock: ACTIVE_LOCK
  })

  assert.deepEqual(result, {
    adoptable: [{ id: '0001_first' }, { id: '0002_second' }],
    adoptableCount: 2,
    pendingCount: 2
  })
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.adoptable))
  assert.ok(result.adoptable.every(Object.isFrozen))
  assert.equal(ACTIVE_LOCK.state, MIGRATION_LOCK_ACTIVE)
  assert.deepEqual(
    { exec: probe.counts.exec, transaction: probe.counts.transaction, run: probe.counts.run },
    { exec: 0, transaction: 0, run: 0 }
  )

  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /secret_resources|secret_title|secret_documents|secret_summary/)
  assert.doesNotMatch(serialized, /synthetic|ALTER TABLE|[a-f0-9]{64}/)
})

test('stops on the first missing column without checking later migrations', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column')
  ])
  const schemas = matchingSchemas(registry)
  delete schemas.first_table.columns.first_column
  const probe = schemaProbe(schemas)

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    lock: ACTIVE_LOCK
  })

  assert.deepEqual(result, {
    adoptable: [],
    adoptableCount: 0,
    pendingCount: 2,
    stopped: { id: '0001_first', reason: 'missing' }
  })
  assert.deepEqual(probe.checkedColumns, ['first_table.first_column'])
})

test('returns only the satisfied prefix before a middle missing column', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column'),
    definition('0003_third', 'third_table', 'third_column')
  ])
  const schemas = matchingSchemas(registry)
  delete schemas.second_table.columns.second_column
  const probe = schemaProbe(schemas)

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    lock: ACTIVE_LOCK
  })

  assert.deepEqual(result, {
    adoptable: [{ id: '0001_first' }],
    adoptableCount: 1,
    pendingCount: 3,
    stopped: { id: '0002_second', reason: 'missing' }
  })
  assert.ok(Object.isFrozen(result.stopped))
  assert.deepEqual(probe.checkedColumns, [
    'first_table.first_column',
    'second_table.second_column'
  ])
})

test('stops at a migration without compatibility and does not inspect later schema', () => {
  const definitions = [
    definition('0001_first', 'first_table', 'first_column'),
    { id: '0002_execute', source: 'CREATE TABLE execution_required (id INTEGER);' },
    definition('0003_third', 'third_table', 'third_column')
  ]
  const registry = createMigrationRegistry(definitions)
  const probe = schemaProbe(matchingSchemas(registry))

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    lock: ACTIVE_LOCK
  })

  assert.deepEqual(result, {
    adoptable: [{ id: '0001_first' }],
    adoptableCount: 1,
    pendingCount: 3,
    stopped: { id: '0002_execute', reason: 'requires-execution' }
  })
  assert.deepEqual(probe.checkedColumns, ['first_table.first_column'])
})

test('fails safely on incompatible schema and does not inspect the suffix', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'private_table', 'private_column', {
      defaultValue: "'/synthetic/private.db'"
    }),
    definition('0003_third', 'third_table', 'third_column')
  ])
  const schemas = matchingSchemas(registry)
  schemas.private_table.columns.private_column.type = 'INTEGER'
  const probe = schemaProbe(schemas)

  const error = thrown(() => createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    lock: ACTIVE_LOCK
  }))

  assert.equal(error.code, 'MIGRATION_ADOPTION_SCHEMA_INCOMPATIBLE')
  assert.deepEqual(error.diagnostics, {
    migrationId: '0002_second',
    category: 'schema-compatibility',
    reason: 'column-incompatible'
  })
  assert.ok(Object.keys(error).includes('diagnostics'))
  assert.ok(Object.isFrozen(error.diagnostics))
  assert.doesNotMatch(error.message, /private_table|private_column|synthetic|ALTER TABLE/)
  assert.doesNotMatch(JSON.stringify(error), /private_table|private_column|synthetic|ALTER TABLE/)
  assert.deepEqual(probe.checkedColumns, [
    'first_table.first_column',
    'private_table.private_column'
  ])
  assert.deepEqual(
    { exec: probe.counts.exec, transaction: probe.counts.transaction, run: probe.counts.run },
    { exec: 0, transaction: 0, run: 0 }
  )
})

test('returns empty without schema queries when every target migration is applied', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column')
  ])
  const appliedRecords = registry.migrations.map(({ id, checksum }) => ({ id, checksum }))
  const probe = schemaProbe()

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    appliedRecords,
    lock: ACTIVE_LOCK
  })

  assert.deepEqual(result, { adoptable: [], adoptableCount: 0, pendingCount: 0 })
  assert.equal(probe.counts.prepare, 0)
})

test('does not inspect migrations deferred beyond targetVersion', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column'),
    definition('0003_third', 'third_table', 'third_column')
  ])
  const probe = schemaProbe(matchingSchemas(registry))

  const result = createMigrationAdoptionPlan({
    database: probe.database,
    registry,
    lock: ACTIVE_LOCK,
    targetVersion: '0001_first'
  })

  assert.deepEqual(result, {
    adoptable: [{ id: '0001_first' }],
    adoptableCount: 1,
    pendingCount: 1
  })
  assert.deepEqual(probe.checkedColumns, ['first_table.first_column'])
})

test('applies existing history and target validation before schema access', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column'),
    definition('0002_second', 'second_table', 'second_column'),
    definition('0003_third', 'third_table', 'third_column')
  ])
  const [first, second] = registry.migrations
  const cases = [
    {
      appliedRecords: [{ id: first.id, checksum: '0'.repeat(64) }],
      code: 'MIGRATION_CHECKSUM_DRIFT'
    },
    {
      appliedRecords: [{ id: second.id, checksum: second.checksum }],
      code: 'MIGRATION_HISTORY_GAP'
    },
    {
      appliedRecords: [
        { id: first.id, checksum: first.checksum },
        { id: second.id, checksum: second.checksum }
      ],
      targetVersion: first.id,
      code: 'MIGRATION_TARGET_BEHIND_APPLIED'
    },
    {
      appliedRecords: [{ id: first.id, checksum: first.checksum, status: 'running' }],
      code: 'MIGRATION_RECORD_BLOCKED'
    },
    {
      appliedRecords: [],
      targetVersion: '9999_unknown',
      code: 'MIGRATION_TARGET_UNKNOWN'
    }
  ]

  for (const entry of cases) {
    const probe = schemaProbe(matchingSchemas(registry))
    const error = thrown(() => createMigrationAdoptionPlan({
      database: probe.database,
      registry,
      appliedRecords: entry.appliedRecords,
      lock: ACTIVE_LOCK,
      targetVersion: entry.targetVersion
    }))
    assert.equal(error.code, entry.code)
    assert.equal(error.message, 'Migration adoption plan input is invalid.')
    assert.equal(probe.counts.prepare, 0)
  }
})

test('rejects a non-canonical registry before schema access', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'private_table', 'private_column')
  ])
  const migration = registry.migrations[0]
  const base = { id: migration.id, source: migration.source, checksum: migration.checksum }
  const compatibility = migration.compatibility
  const invalidRegistries = [
    { migrations: [{ ...base }] },
    { migrations: [{ ...base, source: `${base.source} -- changed`, compatibility }] },
    { migrations: [{ ...base, checksum: '0'.repeat(64), compatibility }] },
    {
      migrations: [{
        ...base,
        compatibility: {
          ...compatibility,
          column: { ...compatibility.column, type: 'INTEGER' }
        }
      }]
    },
    {
      migrations: [{
        ...base,
        compatibility: {
          ...compatibility,
          column: { ...compatibility.column, type: ' text ' }
        }
      }]
    },
    { migrations: [{ ...base, compatibility: undefined }] }
  ]

  for (const invalidRegistry of invalidRegistries) {
    const probe = schemaProbe(matchingSchemas(registry))
    const error = thrown(() => createMigrationAdoptionPlan({
      database: probe.database,
      registry: invalidRegistry,
      lock: ACTIVE_LOCK
    }))
    assert.equal(error.code, 'MIGRATION_ADOPTION_REGISTRY_INVALID')
    assert.doesNotMatch(error.message, /private_table|private_column|ALTER TABLE/)
    assert.equal(probe.counts.prepare, 0)
  }
})

test('rejects reordered source variants before schema access', () => {
  const columns = [{
    name: 'id',
    type: 'INTEGER',
    notNull: false,
    defaultValue: null,
    primaryKeyPosition: 1
  }]
  const shape = (overrides = {}) => ({
    strict: false,
    withoutRowid: false,
    columns,
    foreignKeys: [],
    uniqueConstraints: [],
    ...overrides
  })
  const compatibility = {
    kind: 'table-transition',
    table: 'items',
    target: shape(),
    legacy: [
      { proofKey: 'legacy-a', shape: shape({ strict: true }), createTableSqlSha256: 'a'.repeat(64), indexes: [], triggers: [] },
      { proofKey: 'legacy-b', shape: shape({ withoutRowid: true }), createTableSqlSha256: 'b'.repeat(64), indexes: [], triggers: [] }
    ]
  }
  const registry = createMigrationRegistry([{
    id: '0001_variant',
    sourceVariants: [
      { proofKey: 'legacy-a', source: 'SELECT 1;' },
      { proofKey: 'legacy-b', source: 'SELECT 2;' }
    ],
    compatibility
  }])
  const migration = registry.migrations[0]
  const probe = schemaProbe()
  const error = thrown(() => createMigrationAdoptionPlan({
    database: probe.database,
    registry: { migrations: [{ ...migration, sourceVariants: [...migration.sourceVariants].reverse() }] },
    lock: ACTIVE_LOCK
  }))
  assert.equal(error.code, 'MIGRATION_ADOPTION_REGISTRY_INVALID')
  assert.equal(probe.counts.prepare, 0)
})

test('rejects missing or released locks before schema access', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'first_table', 'first_column')
  ])
  for (const lock of [null, { state: MIGRATION_LOCK_RELEASED }]) {
    const probe = schemaProbe(matchingSchemas(registry))
    const error = thrown(() => createMigrationAdoptionPlan({
      database: probe.database,
      registry,
      lock
    }))
    assert.equal(error.code, 'MIGRATION_ADOPTION_LOCK_NOT_ACTIVE')
    assert.equal(probe.counts.prepare, 0)
  }
})

test('redacts underlying schema query failures', () => {
  const registry = createMigrationRegistry([
    definition('0001_first', 'private_table', 'private_column')
  ])
  const database = {
    prepare() {
      throw new Error('C:\\private\\nas.sqlite secret-business-row')
    }
  }

  const error = thrown(() => createMigrationAdoptionPlan({
    database,
    registry,
    lock: ACTIVE_LOCK
  }))
  assert.equal(error.code, 'MIGRATION_ADOPTION_SCHEMA_CHECK_FAILED')
  assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row|private_table|private_column/)
})

test('plans a real SQLite satisfied prefix without changing schema', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE first_table (first_column TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE second_table (id INTEGER);
    `)
    const registry = createMigrationRegistry([
      definition('0001_first', 'first_table', 'first_column'),
      definition('0002_second', 'second_table', 'second_column')
    ])
    const before = database
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
      .all()

    const result = createMigrationAdoptionPlan({
      database,
      registry,
      lock: ACTIVE_LOCK
    })

    const after = database
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
      .all()
    assert.deepEqual(result, {
      adoptable: [{ id: '0001_first' }],
      adoptableCount: 1,
      pendingCount: 2,
      stopped: { id: '0002_second', reason: 'missing' }
    })
    assert.deepEqual(after, before)
  } finally {
    database.close()
  }
})
