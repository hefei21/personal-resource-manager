import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { StorageService } from '../src/services/storageService.js'
import {
  CREATE_STORAGE_COMMIT_OPERATIONS_SQL,
  STORAGE_COMMIT_DATABASE_COMMITTED,
  STORAGE_COMMIT_ORPHANED,
  coordinateStorageCommit,
  getStorageCommitOperation
} from '../src/services/storageCommitCoordinator.js'

const require = createRequire(import.meta.url)
function bindingMissing(error) { return /^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? '')) }
let Database
let nativeAvailable = true
try { Database = require('better-sqlite3'); const probe = new Database(':memory:'); probe.close() } catch (error) {
  if (!bindingMissing(error)) throw error
  nativeAvailable = false
}
const nativeOptions = process.env.CI || nativeAvailable ? undefined : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-storage-commit-')) }
function cleanup(value) { fs.rmSync(value, { recursive: true, force: true }) }
function randomBytes() { return Buffer.alloc(16, 0xab) }
const now = () => new Date('2026-08-12T05:06:07.008Z')

function setup(directory) {
  const database = new Database(path.join(directory, 'app.db'))
  database.exec(CREATE_STORAGE_COMMIT_OPERATIONS_SQL)
  database.exec('CREATE TABLE resources (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE)')
  const storageService = new StorageService({ rootPath: path.join(directory, 'storage'), randomBytes })
  return { database, storageService }
}

test('commits object and database state once for an idempotency key', nativeOptions, async () => {
  const directory = root()
  let database
  try {
    const setupResult = setup(directory); database = setupResult.database
    const staged = await setupResult.storageService.stageFromStream(Readable.from(['coordinated']))
    let callbacks = 0
    const run = () => coordinateStorageCommit({
      database,
      storageService: setupResult.storageService,
      idempotencyKey: 'upload:document:0001',
      stagingToken: staged.token,
      kind: 'documents',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes,
      now,
      writeDatabase: ({ storageKey }) => {
        callbacks += 1
        database.prepare('INSERT INTO resources (id, storage_key) VALUES (?, ?)').run(1, storageKey)
      }
    })
    const first = await run()
    const second = await run()
    assert.equal(first.state, STORAGE_COMMIT_DATABASE_COMMITTED)
    assert.deepEqual(second, first)
    assert.equal(callbacks, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 1)
  } finally { database?.close(); cleanup(directory) }
})

test('records orphan state after database failure and retries without recommitting object', nativeOptions, async () => {
  const directory = root()
  let database
  try {
    const setupResult = setup(directory); database = setupResult.database
    const staged = await setupResult.storageService.stageFromStream(Readable.from(['retry-database']))
    await assert.rejects(coordinateStorageCommit({
      database,
      storageService: setupResult.storageService,
      idempotencyKey: 'upload:document:0002',
      stagingToken: staged.token,
      kind: 'documents',
      now,
      writeDatabase: () => { throw Object.assign(new Error('private SQL detail'), { code: 'SQLITE_CONSTRAINT' }) }
    }), { code: 'STORAGE_COMMIT_DATABASE_FAILED' })
    const orphan = getStorageCommitOperation(database, 'upload:document:0002')
    assert.equal(orphan.state, STORAGE_COMMIT_ORPHANED)
    assert.equal(orphan.errorCode, 'SQLITE_CONSTRAINT')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 0)

    const restored = await coordinateStorageCommit({
      database,
      storageService: setupResult.storageService,
      idempotencyKey: 'upload:document:0002',
      stagingToken: staged.token,
      kind: 'documents',
      now,
      writeDatabase: ({ storageKey }) => database.prepare(
        'INSERT INTO resources (id, storage_key) VALUES (?, ?)'
      ).run(2, storageKey)
    })
    assert.equal(restored.state, STORAGE_COMMIT_DATABASE_COMMITTED)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 1)
  } finally { database?.close(); cleanup(directory) }
})

test('rolls back business writes for async callbacks and binds idempotency key to staging token', nativeOptions, async () => {
  const directory = root()
  let database
  try {
    let tokenCounter = 0
    const storageService = new StorageService({
      rootPath: path.join(directory, 'storage'),
      randomBytes: () => Buffer.alloc(16, ++tokenCounter)
    })
    database = new Database(path.join(directory, 'app.db'))
    database.exec(CREATE_STORAGE_COMMIT_OPERATIONS_SQL)
    database.exec('CREATE TABLE resources (id INTEGER PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE)')
    const first = await storageService.stageFromStream(Readable.from(['first']))
    await assert.rejects(coordinateStorageCommit({
      database, storageService, idempotencyKey: 'upload:document:0003', stagingToken: first.token,
      kind: 'documents', now,
      writeDatabase: ({ storageKey }) => {
        database.prepare('INSERT INTO resources VALUES (?, ?)').run(3, storageKey)
        return Promise.resolve()
      }
    }), { code: 'STORAGE_COMMIT_DATABASE_FAILED' })
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM resources').get().count, 0)
    const second = await storageService.stageFromStream(Readable.from(['second']))
    await assert.rejects(coordinateStorageCommit({
      database, storageService, idempotencyKey: 'upload:document:0003', stagingToken: second.token,
      kind: 'documents', now, writeDatabase: () => {}
    }), { code: 'STORAGE_COMMIT_IDEMPOTENCY_CONFLICT' })
  } finally { database?.close(); cleanup(directory) }
})
