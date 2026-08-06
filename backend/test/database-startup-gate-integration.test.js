import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const databaseSourcePath = path.resolve('backend/src/config/database.js')
const indexSourcePath = path.resolve('backend/src/index.js')
const childPath = path.resolve('backend/test/fixtures/database-startup-child.js')

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
    cwd: path.resolve('backend'),
    env: {
      ...process.env,
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

test('static contract removes retired migration branches and keeps the startup gate before return', () => {
  const databaseSource = fs.readFileSync(databaseSourcePath, 'utf8')
  const indexSource = fs.readFileSync(indexSourcePath, 'utf8').replace(/\r\n?/gu, '\n')

  assert.doesNotMatch(databaseSource, /schema_migrations/u)
  assert.doesNotMatch(databaseSource, /reading_progress_add_user_id/u)
  assert.doesNotMatch(databaseSource, /anime_status_v1/u)

  const instanceCall = databaseSource.indexOf("initDatabaseInstance(mainDb, 'main')")
  const gateCall = databaseSource.indexOf('runMigrationStartupGate({', instanceCall)
  const returnCall = databaseSource.indexOf('return mainDb', gateCall)
  assert.ok(instanceCall >= 0)
  assert.ok(gateCall > instanceCall)
  assert.ok(returnCall > gateCall)

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

test('empty database starts with only the new migration control tables', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })
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
