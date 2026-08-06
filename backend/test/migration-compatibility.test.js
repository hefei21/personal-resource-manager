import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  checkMigrationCompatibility,
  MigrationCompatibilityError,
  normalizeMigrationCompatibility
} from '../src/config/migrationCompatibility.js'

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

function compatibility(overrides = {}) {
  return {
    kind: 'column',
    table: 'items',
    column: {
      name: 'title',
      type: 'TEXT',
      notNull: true,
      defaultValue: "'ready'"
    },
    ...overrides
  }
}

function tableShape(overrides = {}) {
  return {
    strict: false,
    withoutRowid: false,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 1 },
      { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'", primaryKeyPosition: 0 }
    ],
    ...overrides
  }
}

function tableTransition(overrides = {}) {
  return {
    kind: 'table-transition',
    table: 'items',
    target: tableShape(),
    legacy: [tableShape({ strict: true })],
    ...overrides
  }
}

function openDatabase(schema) {
  const database = new Database(':memory:')
  database.exec(schema)
  return database
}

function metadataDatabase(column) {
  let query = 0
  return {
    prepare() {
      query += 1
      return { get: () => query === 1 ? { present: 1 } : column }
    }
  }
}

function tableMetadataColumns(shape) {
  return shape.columns.map((column, cid) => ({
    cid,
    name: column.name,
    type: column.type,
    not_null: column.notNull ? 1 : 0,
    dflt_value: column.defaultValue,
    pk: column.primaryKeyPosition,
    hidden: 0
  }))
}

test('normalizes, detaches, and deeply freezes a table-transition condition', () => {
  const input = tableTransition({
    target: tableShape({
      strict: true,
      columns: tableShape().columns.map((column) => ({ ...column, type: ` ${column.type.toLowerCase()} ` }))
    }),
    legacy: [tableShape(), tableShape({ withoutRowid: true })]
  })
  const normalized = normalizeMigrationCompatibility(input)

  assert.deepEqual(normalized.target.columns[0], {
    name: 'id',
    type: 'INTEGER',
    notNull: false,
    defaultValue: null,
    primaryKeyPosition: 1
  })
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.target))
  assert.ok(Object.isFrozen(normalized.target.columns))
  assert.ok(normalized.target.columns.every(Object.isFrozen))
  assert.ok(Object.isFrozen(normalized.legacy))
  assert.ok(normalized.legacy.every(Object.isFrozen))
  assert.ok(normalized.legacy.every((shape) => Object.isFrozen(shape.columns)))

  input.table = 'changed'
  input.target.columns[0].name = 'changed'
  input.legacy[0].columns.push({
    name: 'extra', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0
  })
  assert.equal(normalized.table, 'items')
  assert.equal(normalized.target.columns[0].name, 'id')
  assert.equal(normalized.legacy[0].columns.length, 2)
})

test('rejects malformed table-transition shapes and unsupported keys', () => {
  const valid = tableTransition()
  const targetWithoutStrict = { ...valid.target }
  delete targetWithoutStrict.strict
  const invalidInputs = [
    { ...valid, extra: true },
    { ...valid, target: targetWithoutStrict },
    { ...valid, target: { ...valid.target, columns: [] } },
    { ...valid, target: { ...valid.target, strict: 'false' } },
    { ...valid, target: { ...valid.target, withoutRowid: 0 } },
    { ...valid, target: { ...valid.target, columns: [valid.target.columns[0], valid.target.columns[0]] } },
    {
      ...valid,
      target: {
        ...valid.target,
        columns: valid.target.columns.map((column) => ({ ...column, primaryKeyPosition: 2 }))
      }
    },
    { ...valid, legacy: [] },
    { ...valid, legacy: [valid.legacy[0], { ...valid.legacy[0] }] },
    {
      ...valid,
      target: {
        ...valid.target,
        columns: valid.target.columns.map((column) => ({ ...column, unknown: true }))
      }
    }
  ]
  const invalidPrimaryKey = tableShape({
    columns: tableShape().columns.map((column) => ({ ...column, primaryKeyPosition: -1 }))
  })
  invalidInputs.push({ ...valid, target: invalidPrimaryKey })

  for (const input of invalidInputs) {
    assert.throws(
      () => normalizeMigrationCompatibility(input),
      (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
    )
  }
})

test('rejects a table-transition target duplicated in legacy', () => {
  assert.throws(
    () => normalizeMigrationCompatibility(tableTransition({ legacy: [tableShape()] })),
    (error) => error instanceof MigrationCompatibilityError && error.code === 'MIGRATION_COMPATIBILITY_INVALID'
  )
})

test('reports a matching table-transition target as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready');"
  )
  try {
    const result = checkMigrationCompatibility(database, tableTransition())
    assert.deepEqual(result, {
      status: 'satisfied',
      kind: 'table-transition',
      table: 'items',
      reason: 'matched'
    })
    assert.ok(Object.isFrozen(result))
  } finally {
    database.close()
  }
})

test('reports a matching legacy table-transition shape as missing', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT DEFAULT 'ready');"
  )
  try {
    const result = checkMigrationCompatibility(database, tableTransition({
      target: tableShape(),
      legacy: [tableShape({
        columns: tableShape().columns.map((column) =>
          column.name === 'title' ? { ...column, notNull: false } : column
        )
      })]
    }))
    assert.deepEqual(result, {
      status: 'missing',
      kind: 'table-transition',
      table: 'items',
      reason: 'legacy-matched'
    })
  } finally {
    database.close()
  }
})

test('reports a missing table-transition table as incompatible', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE other (id INTEGER);')
  try {
    assert.deepEqual(checkMigrationCompatibility(database, tableTransition()), {
      status: 'incompatible',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-missing'
    })
  } finally {
    database.close()
  }
})

test('reports missing, extra, and reordered table columns as incompatible', nativeTestOptions, () => {
  const schemas = [
    'CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT, extra BLOB);',
    'CREATE TABLE items (id INTEGER PRIMARY KEY);',
    'CREATE TABLE items (title TEXT, id INTEGER PRIMARY KEY);'
  ]
  for (const schema of schemas) {
    const database = openDatabase(schema)
    try {
      const result = checkMigrationCompatibility(database, tableTransition())
      assert.deepEqual(result, {
        status: 'incompatible',
        kind: 'table-transition',
        table: 'items',
        reason: 'table-shape-incompatible'
      })
    } finally {
      database.close()
    }
  }
})

test('compares STRICT and WITHOUT ROWID table flags', nativeTestOptions, () => {
  const strictDatabase = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready') STRICT;"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(strictDatabase, tableTransition({
        target: tableShape({ strict: true }),
        legacy: [tableShape()]
      })).status,
      'satisfied'
    )
    assert.equal(
      checkMigrationCompatibility(strictDatabase, tableTransition({
        legacy: [tableShape({ withoutRowid: true })]
      })).reason,
      'table-shape-incompatible'
    )
  } finally {
    strictDatabase.close()
  }

  const withoutRowidShape = tableShape({
    withoutRowid: true,
    columns: [
      { name: 'id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKeyPosition: 1 },
      { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'", primaryKeyPosition: 0 }
    ]
  })
  const withoutRowidDatabase = openDatabase(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'ready') WITHOUT ROWID;"
  )
  try {
    assert.equal(
      checkMigrationCompatibility(withoutRowidDatabase, tableTransition({
        target: withoutRowidShape
      })).status,
      'satisfied'
    )
  } finally {
    withoutRowidDatabase.close()
  }
})

test('reports a generated column as incompatible for table-transition', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, source TEXT, title TEXT GENERATED ALWAYS AS (source) STORED);'
  )
  try {
    const result = checkMigrationCompatibility(database, tableTransition({
      target: tableShape({
        columns: [
          tableShape().columns[0],
          { name: 'source', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
          { name: 'title', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
        ]
      })
    }))
    assert.deepEqual(result, {
      status: 'incompatible',
      kind: 'table-transition',
      table: 'items',
      reason: 'table-shape-incompatible'
    })
  } finally {
    database.close()
  }
})

test('keeps table-transition summaries redacted and uses bound read-only metadata queries', () => {
  const prepared = []
  const boundValues = []
  const shape = tableShape()
  const database = {
    prepare(sql) {
      prepared.push(sql)
      if (sql.includes('sqlite_schema')) {
        return {
          get: (...values) => {
            boundValues.push(values)
            return { present: 1 }
          }
        }
      }
      if (sql.includes('pragma_table_list')) {
        return {
          get: (...values) => {
            boundValues.push(values)
            return { wr: 0, strict: 0 }
          }
        }
      }
      if (sql.includes('pragma_table_xinfo')) {
        return {
          all: (...values) => {
            boundValues.push(values)
            return tableMetadataColumns({
              ...shape,
              columns: [
                { ...shape.columns[0], defaultValue: "'/private/secret.db'" },
                shape.columns[1]
              ]
            })
          }
        }
      }
      throw new Error('unexpected query')
    }
  }
  const result = checkMigrationCompatibility(database, tableTransition())
  assert.deepEqual(result, {
    status: 'incompatible',
    kind: 'table-transition',
    table: 'items',
    reason: 'table-shape-incompatible'
  })
  assert.ok(prepared.every((sql) => !sql.includes('items')))
  const tableListSql = prepared.find((sql) => sql.includes('pragma_table_list'))
  assert.match(tableListSql, /schema = 'main'/)
  assert.match(tableListSql, /type = 'table'/)
  assert.deepEqual(boundValues, [['items'], ['items'], ['items']])
  assert.doesNotMatch(JSON.stringify(result), /private|secret|id|title/)
})

test('redacts table-transition metadata query failures', () => {
  const database = {
    prepare() {
      throw new Error('C:\\private\\nas.sqlite secret-business-row')
    }
  }
  assert.throws(
    () => checkMigrationCompatibility(database, tableTransition()),
    (error) => {
      assert.ok(error instanceof MigrationCompatibilityError)
      assert.equal(error.code, 'MIGRATION_COMPATIBILITY_CHECK_FAILED')
      assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row|items|title/)
      return true
    }
  )
})

test('reports a missing table as incompatible', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE other (id INTEGER);')
  try {
    assert.deepEqual(
      checkMigrationCompatibility(database, compatibility()),
      {
        status: 'incompatible',
        kind: 'column',
        table: 'items',
        column: 'title',
        reason: 'table-missing'
      }
    )
  } finally {
    database.close()
  }
})

test('reports a missing column as missing', nativeTestOptions, () => {
  const database = openDatabase('CREATE TABLE items (id INTEGER);')
  try {
    assert.equal(checkMigrationCompatibility(database, compatibility()).status, 'missing')
  } finally {
    database.close()
  }
})

test('reports a fully matching column as satisfied', nativeTestOptions, () => {
  const database = openDatabase(
    "CREATE TABLE items (id INTEGER, title text NOT NULL DEFAULT 'ready', extra BLOB);"
  )
  try {
    const result = checkMigrationCompatibility(database, compatibility())
    assert.equal(result.status, 'satisfied')
    assert.ok(Object.isFrozen(result))
  } finally {
    database.close()
  }
})

test('reports a generated column as incompatible', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (source TEXT, title TEXT GENERATED ALWAYS AS (source) STORED);'
  )
  try {
    const result = checkMigrationCompatibility(database, compatibility({
      column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: null }
    }))
    assert.equal(result.status, 'incompatible')
    assert.equal(result.reason, 'column-incompatible')
  } finally {
    database.close()
  }
})

test('normalizes type case and formatting whitespace without merging declarations', nativeTestOptions, () => {
  const database = openDatabase(
    'CREATE TABLE items (title varchar ( 255 ) NOT NULL DEFAULT 0);'
  )
  try {
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: ' VARCHAR(255) ', notNull: true, defaultValue: '0' }
      })).status,
      'satisfied'
    )
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'INTEGER', notNull: true, defaultValue: '0' }
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('reports NOT NULL and default conflicts as incompatible', nativeTestOptions, () => {
  const database = openDatabase("CREATE TABLE items (title TEXT DEFAULT 'ready');")
  try {
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'TEXT', notNull: true, defaultValue: "'ready'" }
      })).status,
      'incompatible'
    )
    assert.equal(
      checkMigrationCompatibility(database, compatibility({
        column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: "'other'" }
      })).status,
      'incompatible'
    )
  } finally {
    database.close()
  }
})

test('does not expose database paths, default expressions, or row content on check failure', () => {
  const database = {
    prepare() {
      throw new Error('C:\\private\\nas.sqlite secret-business-row')
    }
  }
  assert.throws(
    () => checkMigrationCompatibility(database, compatibility()),
    (error) => {
      assert.ok(error instanceof MigrationCompatibilityError)
      assert.equal(error.code, 'MIGRATION_COMPATIBILITY_CHECK_FAILED')
      assert.doesNotMatch(error.message, /nas\.sqlite|secret-business-row/)
      return true
    }
  )
})

test('treats unexpected column metadata as incompatible without native SQLite', () => {
  for (const column of [
    { name: 'other', type: 'TEXT', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: '', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: 'VARCHAR(255)', not_null: 1, dflt_value: "'ready'", hidden: 0 },
    { name: 'title', type: 'TEXT', not_null: 1, dflt_value: "('ready')", hidden: 0 }
  ]) {
    assert.equal(
      checkMigrationCompatibility(metadataDatabase(column), compatibility()).status,
      'incompatible'
    )
  }
})

test('requires hidden metadata to identify an ordinary column without native SQLite', () => {
  const ordinary = {
    name: 'title',
    type: 'TEXT',
    not_null: 1,
    dflt_value: "'ready'",
    hidden: 0
  }
  assert.equal(
    checkMigrationCompatibility(metadataDatabase(ordinary), compatibility()).status,
    'satisfied'
  )

  for (const hidden of [2, 3, undefined, 'unexpected']) {
    const column = { ...ordinary, hidden }
    if (hidden === undefined) delete column.hidden
    const result = checkMigrationCompatibility(metadataDatabase(column), compatibility())
    assert.equal(result.status, 'incompatible')
    assert.equal(result.reason, 'column-incompatible')
    assert.ok(!('hidden' in result))
  }
})

test('does not include schema values beyond the declared object in summaries', nativeTestOptions, () => {
  const database = openDatabase("CREATE TABLE items (title TEXT DEFAULT 'secret-business-row');")
  try {
    const result = checkMigrationCompatibility(database, compatibility({
      column: { name: 'title', type: 'TEXT', notNull: false, defaultValue: "'other'" }
    }))
    assert.equal(result.status, 'incompatible')
    assert.doesNotMatch(JSON.stringify(result), /secret-business-row/)
  } finally {
    database.close()
  }
})
