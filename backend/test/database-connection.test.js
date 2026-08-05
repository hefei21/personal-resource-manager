import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  configureDatabaseConnection,
  openDatabaseConnection
} from '../src/config/sqliteConnection.js'

function withTemporaryDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-db-connection-'))
  const dbPath = path.join(root, 'app.db')

  try {
    return run({ root, dbPath })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('configures and verifies the required SQLite runtime settings', () => {
  withTemporaryDatabase(({ dbPath }) => {
    const database = openDatabaseConnection(dbPath)

    try {
      assert.equal(database.pragma('foreign_keys', { simple: true }), 1)
      assert.equal(String(database.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal')
      assert.equal(database.pragma('busy_timeout', { simple: true }), DEFAULT_BUSY_TIMEOUT_MS)
    } finally {
      database.close()
    }
  })
})

test('rejects invalid timeout values before producing a PRAGMA statement', () => {
  const pragmaCalls = []
  const fakeDatabase = {
    pragma(statement) {
      pragmaCalls.push(statement)
      return 1
    }
  }

  for (const busyTimeoutMs of ['5000', 0, 99, 30001, 1.5, Infinity]) {
    assert.throws(
      () => configureDatabaseConnection(fakeDatabase, { busyTimeoutMs }),
      /busy timeout must be an integer/
    )
  }

  assert.deepEqual(pragmaCalls, [])
})

test('applies and verifies every required setting in a stable order', () => {
  const pragmaCalls = []
  const fakeDatabase = {
    pragma(statement) {
      pragmaCalls.push(statement)
      if (statement === 'foreign_keys') return 1
      if (statement === 'journal_mode = WAL') return 'wal'
      if (statement === 'busy_timeout') return DEFAULT_BUSY_TIMEOUT_MS
      return undefined
    }
  }

  assert.equal(configureDatabaseConnection(fakeDatabase), fakeDatabase)
  assert.deepEqual(pragmaCalls, [
    'foreign_keys = ON',
    'foreign_keys',
    'journal_mode = WAL',
    `busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`,
    'busy_timeout'
  ])
})

test('propagates configuration verification failures', () => {
  const fakeDatabase = {
    pragma(statement) {
      if (statement === 'foreign_keys = ON') return []
      if (statement === 'foreign_keys') return 0
      throw new Error(`unexpected pragma: ${statement}`)
    }
  }

  assert.throws(
    () => configureDatabaseConnection(fakeDatabase),
    /SQLite foreign_keys verification failed/
  )
})
