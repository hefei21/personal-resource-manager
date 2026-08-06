import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'

const require = createRequire(import.meta.url)
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const backendDirectory = path.resolve(testDirectory, '..')
const databaseSourcePath = path.join(backendDirectory, 'src', 'config', 'database.js')
const databaseMigrationsSourcePath = path.join(backendDirectory, 'src', 'config', 'databaseMigrations.js')
const indexSourcePath = path.join(backendDirectory, 'src', 'index.js')
const childPath = path.join(testDirectory, 'fixtures', 'database-startup-child.js')

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

const PLACEHOLDER_PASSWORD = 'ci-only-placeholder-password'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-database-startup-'))
}

function removeTemporaryDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function runChild(directory, password = PLACEHOLDER_PASSWORD) {
  const databasePath = path.join(directory, 'app.db')
  const result = spawnSync(process.execPath, [childPath], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PR_DATABASE_STARTUP_CHILD: '1',
      DATA_PATH: directory,
      DB_PATH: databasePath,
      DEFAULT_USERNAME: 'ci-owner',
      DEFAULT_PASSWORD: password,
      NODE_ENV: 'test'
    },
    encoding: 'utf8',
    timeout: 30000
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.doesNotMatch(output, new RegExp(PLACEHOLDER_PASSWORD, 'u'))
  assert.doesNotMatch(output, new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  assert.equal(result.error, undefined, result.error?.message)
  return { databasePath, output, result }
}

function readChildResult(output) {
  const json = output.trim()
  assert.notEqual(json, '', 'child produced no structured result')
  return JSON.parse(json)
}

function readColumn(database, table, column) {
  return database.prepare(
    'SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, hidden FROM pragma_table_xinfo(?) WHERE name = ?'
  ).get(table, column)
}

function assertRegisteredColumn(database, table, column, type, notNull, defaultValue) {
  assert.deepEqual(readColumn(database, table, column), {
    name: column,
    type,
    not_null: notNull,
    default_value: defaultValue,
    hidden: 0
  })
}

function assertApplicationMigrationLedger(database, expectedAttemptCount) {
  assert.deepEqual(
    database.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
    applicationMigrationRegistry.migrations.map(({ id }) => ({ migration_id: id }))
  )
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count, expectedAttemptCount)
}

test('application registry freezes exactly the four C2c single-column migrations', () => {
  assert.ok(Object.isFrozen(applicationMigrationRegistry))
  assert.ok(Object.isFrozen(applicationMigrationRegistry.migrations))
  assert.equal(applicationMigrationRegistry.migrations.length, 4)
  assert.deepEqual(
    applicationMigrationRegistry.migrations.map(({ id }) => id),
    [
      '0001_documents_subcategory',
      '0002_categories_sort_order',
      '0003_todos_confirmed',
      '0004_books_content_cache'
    ]
  )
  assert.deepEqual(applicationMigrationRegistry.migrations.map(({ id, source, checksum, compatibility }) => ({
    id,
    source,
    checksum,
    compatibility
  })), [
    {
      id: '0001_documents_subcategory',
      source: 'ALTER TABLE documents ADD COLUMN subcategory TEXT;',
      checksum: '9a05c2803d06c7ebaac7841b0d08ab5e024aa1e92b7a9494ae29f88dc18d4646',
      compatibility: {
        kind: 'column',
        table: 'documents',
        column: { name: 'subcategory', type: 'TEXT', notNull: false, defaultValue: null }
      }
    },
    {
      id: '0002_categories_sort_order',
      source: 'ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0;',
      checksum: '815d6f288d7daa7cecd94e9ea161fc6a278c9921516b95ec0ae07e2c6a4e5247',
      compatibility: {
        kind: 'column',
        table: 'categories',
        column: { name: 'sort_order', type: 'INTEGER', notNull: false, defaultValue: '0' }
      }
    },
    {
      id: '0003_todos_confirmed',
      source: 'ALTER TABLE todos ADD COLUMN confirmed INTEGER DEFAULT 0;',
      checksum: '4c15f429d72185876d7f36e8aef9c11a848a286e5c504f492034bbfa24bc63ed',
      compatibility: {
        kind: 'column',
        table: 'todos',
        column: { name: 'confirmed', type: 'INTEGER', notNull: false, defaultValue: '0' }
      }
    },
    {
      id: '0004_books_content_cache',
      source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;',
      checksum: '81d4063c0f155df031608f631b6ae5103b7cdfceb2e2dcd1eee04ea2f4468ed0',
      compatibility: {
        kind: 'column',
        table: 'books',
        column: { name: 'content_cache', type: 'TEXT', notNull: false, defaultValue: null }
      }
    }
  ])
})

test('static contract runs the startup gate once after base tables and before all later initialization', () => {
  const databaseSource = fs.readFileSync(databaseSourcePath, 'utf8')
  const databaseMigrationsSource = fs.readFileSync(databaseMigrationsSourcePath, 'utf8')
  const indexSource = fs.readFileSync(indexSourcePath, 'utf8').replace(/\r\n?/gu, '\n')

  assert.doesNotMatch(databaseSource, /schema_migrations/u)
  assert.doesNotMatch(databaseSource, /reading_progress_add_user_id/u)
  assert.doesNotMatch(databaseSource, /anime_status_v1/u)
  assert.doesNotMatch(databaseSource, /hasSubcategory|hasSortOrder|hasConfirmed/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE documents ADD COLUMN subcategory/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE categories ADD COLUMN sort_order/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE todos ADD COLUMN confirmed/u)
  assert.doesNotMatch(databaseSource, /PRAGMA table_info\(categories\)/u)
  assert.doesNotMatch(databaseSource, /PRAGMA table_info\(todos\)/u)
  assert.match(databaseSource, /const versionCol = documentColumns\.find\(col => col\.name === 'version'\)/u)
  assert.match(databaseSource, /last_read_at DATETIME,\s+content_cache TEXT/u)
  assert.doesNotMatch(databaseSource, /hasContentCache|ALTER TABLE books ADD COLUMN content_cache TEXT/u)
  assert.doesNotMatch(databaseSource, /AS notNull|AS defaultValue/u)
  assert.match(databaseMigrationsSource, /id: '0004_books_content_cache'/u)
  assert.match(databaseMigrationsSource, /source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;'/u)

  const instanceCall = databaseSource.indexOf("initDatabaseInstance(mainDb, 'main', () => {")
  const gateCall = databaseSource.indexOf('runMigrationStartupGate({', instanceCall)
  const returnCall = databaseSource.indexOf('return mainDb', gateCall)
  assert.ok(instanceCall >= 0)
  assert.ok(gateCall > instanceCall)
  assert.ok(returnCall > gateCall)
  assert.equal(databaseSource.match(/runMigrationStartupGate\(\{/gu)?.length, 1)

  const instanceDefinition = databaseSource.indexOf('function initDatabaseInstance(')
  const baseTableLoop = databaseSource.indexOf('tables.forEach(sql => {', instanceDefinition)
  const schemaGateHook = databaseSource.indexOf('runBaseSchemaGate()', baseTableLoop)
  const firstIndexes = databaseSource.indexOf('const indexes = [', schemaGateHook)
  const firstPragma = databaseSource.indexOf('PRAGMA table_info(documents)', schemaGateHook)
  const ownerInitialization = databaseSource.indexOf('initializeOwner(database, process.env)', schemaGateHook)
  assert.ok(instanceDefinition >= 0)
  assert.ok(baseTableLoop > instanceDefinition)
  assert.ok(schemaGateHook > baseTableLoop)
  assert.equal(databaseSource.match(/runBaseSchemaGate\(\)/gu)?.length, 1)
  assert.ok(firstIndexes > schemaGateHook)
  assert.ok(firstPragma > schemaGateHook)
  assert.ok(ownerInitialization > schemaGateHook)

  const initializeStart = indexSource.indexOf('async function initialize()')
  const initializeTry = indexSource.indexOf('try {', initializeStart)
  const databaseCall = indexSource.indexOf('initDatabase()', initializeTry)
  const listenCall = indexSource.indexOf('app.listen(', databaseCall)
  const initializeCatch = indexSource.indexOf(
    "  } catch (error) {\n    console.error('初始化失败:',",
    initializeTry
  )
  assert.ok(initializeStart >= 0)
  assert.ok(databaseCall > initializeTry)
  assert.ok(listenCall > databaseCall)
  assert.ok(initializeCatch > listenCall)
})

test('empty database adopts all four registered columns without executing ALTER and records applied attempts', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })

    const verification = new Database(databasePath)
    try {
      assertApplicationMigrationLedger(verification, 4)
      assertRegisteredColumn(verification, 'documents', 'subcategory', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'categories', 'sort_order', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'todos', 'confirmed', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'books', 'content_cache', 'TEXT', 0, null)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('restarting the current database does not add registered migration attempts', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  try {
    const first = runChild(directory)
    assert.equal(first.result.status, 0, first.output)
    const database = new Database(databasePath)
    let firstCounts
    try {
      firstCounts = {
        ledger: database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count,
        attempts: database.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count
      }
    } finally {
      database.close()
    }

    const second = runChild(directory)
    assert.equal(second.result.status, 0, second.output)
    const verification = new Database(databasePath)
    try {
      assert.deepEqual({
        ledger: verification.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count,
        attempts: verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count
      }, firstCounts)
      assertApplicationMigrationLedger(verification, 4)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('preserves a version-only legacy table and installs three connection-local guards', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let beforeSchema
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT NOT NULL, note TEXT);
      INSERT INTO schema_migrations (version, note) VALUES ('v1', 'preserve me');
    `)
    beforeSchema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get().sql
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: true,
      controlTablesPresent: true,
      legacyGuardCount: 3
    })

    const verification = new Database(databasePath)
    try {
      assert.equal(verification.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      ).get().sql, beforeSchema)
      assert.deepEqual(verification.prepare('SELECT * FROM schema_migrations').all(), [
        { version: 'v1', note: 'preserve me' }
      ])
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('preserves a legacy migration_key/version/description table and its row', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let beforeSchema
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        migration_key TEXT,
        version TEXT,
        description TEXT
      );
      INSERT INTO schema_migrations (migration_key, version, description)
      VALUES ('legacy-v1', '1.0.0', 'preserve this row');
    `)
    beforeSchema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get().sql
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: true,
      controlTablesPresent: true,
      legacyGuardCount: 3
    })

    const verification = new Database(databasePath)
    try {
      assert.equal(verification.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      ).get().sql, beforeSchema)
      assert.deepEqual(verification.prepare('SELECT * FROM schema_migrations').all(), [
        {
          migration_key: 'legacy-v1',
          version: '1.0.0',
          description: 'preserve this row'
        }
      ])
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('does not report READY when initialization fails', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  try {
    const { output, result } = runChild(directory, 'too-short')
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, /READY/u)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'BOOTSTRAP_PASSWORD_WEAK'
    })
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('does not report READY when the startup gate rejects an incompatible control table', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE prm_schema_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, /READY/u)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'MIGRATION_STARTUP_GATE_FAILED'
    })
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('incompatible books.content_cache prevents indexes, inline upgrades, and Owner initialization', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_cache INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_read_at DATETIME
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'MIGRATION_STARTUP_GATE_FAILED'
    })

    const verification = new Database(databasePath)
    try {
      const bookColumns = verification.pragma('table_info(books)')
      assert.equal(bookColumns.find(column => column.name === 'content_cache').type, 'INTEGER')
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_title'"
      ).get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('old schema executes the four registered columns before remaining inline upgrades', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version REAL DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER,
        path TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        date TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_read_at DATETIME
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })

    const verification = new Database(databasePath)
    try {
      assertApplicationMigrationLedger(verification, 4)
      assertRegisteredColumn(verification, 'documents', 'subcategory', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'categories', 'sort_order', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'todos', 'confirmed', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'books', 'content_cache', 'TEXT', 0, null)
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_categories_sort_order'"
      ).get().count, 1)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})
