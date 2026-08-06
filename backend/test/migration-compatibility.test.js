import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  checkMigrationCompatibility,
  MigrationCompatibilityError
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
