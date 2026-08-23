import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  CREATE_PC_WORKER_CREDENTIALS_SQL,
  CREATE_PC_WORKER_ENROLLMENTS_SQL,
  CREATE_PC_WORKERS_SQL
} from '../src/config/pcWorkerSchema.js'
import {
  authenticateWorkerAccess,
  createWorkerEnrollment,
  enrollWorker,
  refreshWorkerCredentials,
  revokeWorker
} from '../src/services/pcWorkerAuth.js'
import {
  PC_WORKER_EXECUTION_CLASS,
  PC_WORKER_OUTPUT_SCHEMA_VERSION,
  PC_WORKER_PROCESSOR_VERSION,
  PC_WORKER_PROTOCOL_VERSION,
  PC_WORKER_TASK_TYPE
} from '../src/services/pcWorkerContract.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}
const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

function database() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`${CREATE_PC_WORKERS_SQL};${CREATE_PC_WORKER_ENROLLMENTS_SQL};${CREATE_PC_WORKER_CREDENTIALS_SQL}`)
  return db
}

function bytesFactory() {
  let value = 0
  return (length) => Buffer.alloc(length, ++value)
}

function profile() {
  return {
    displayName: 'RTX Worker',
    protocolVersion: PC_WORKER_PROTOCOL_VERSION,
    agentVersion: '0.1.0',
    platform: 'win32',
    architecture: 'x64',
    capabilities: {
      processors: [{
        taskType: PC_WORKER_TASK_TYPE,
        processorVersion: PC_WORKER_PROCESSOR_VERSION,
        executionClass: PC_WORKER_EXECUTION_CLASS,
        outputSchemaVersion: PC_WORKER_OUTPUT_SCHEMA_VERSION
      }],
      resources: { cpuLogicalCores: 16, systemMemoryBytes: 64 * 1024 ** 3, gpus: [], loadedModels: [] }
    }
  }
}

test('enrollment stores only hashes and access credentials authenticate the Worker', nativeTestOptions, () => {
  const db = database()
  const randomBytes = bytesFactory()
  try {
    const enrollment = createWorkerEnrollment(db, {}, { now: '2026-08-23T00:00:00.000Z', randomBytes })
    assert.equal(db.prepare('SELECT token_hash FROM pc_worker_enrollments').get().token_hash.includes(enrollment.token), false)
    const enrolled = enrollWorker(db, enrollment.token, profile(), {
      now: '2026-08-23T00:00:01.000Z',
      randomBytes,
      randomUUID: () => '00000000-0000-4000-8000-000000000001'
    })
    assert.equal(enrolled.worker.displayName, 'RTX Worker')
    assert.equal(authenticateWorkerAccess(db, enrolled.accessToken, { now: '2026-08-23T00:00:02.000Z' }).id, enrolled.worker.id)
    const stored = JSON.stringify(db.prepare('SELECT * FROM pc_worker_credentials').all())
    assert.doesNotMatch(stored, new RegExp(enrolled.accessToken, 'u'))
    assert.doesNotMatch(stored, new RegExp(enrolled.refreshToken, 'u'))
    assert.throws(() => enrollWorker(db, enrollment.token, profile(), {
      now: '2026-08-23T00:00:03.000Z', randomBytes
    }), (error) => error.code === 'PC_WORKER_ENROLLMENT_INVALID')
  } finally { db.close() }
})

test('refresh rotates both credentials and replay revokes the Worker', nativeTestOptions, () => {
  const db = database()
  const randomBytes = bytesFactory()
  try {
    const enrollment = createWorkerEnrollment(db, {}, { now: '2026-08-23T00:00:00.000Z', randomBytes })
    const enrolled = enrollWorker(db, enrollment.token, profile(), {
      now: '2026-08-23T00:00:01.000Z', randomBytes,
      randomUUID: () => '00000000-0000-4000-8000-000000000002'
    })
    const rotated = refreshWorkerCredentials(db, enrolled.refreshToken, {
      now: '2026-08-23T00:01:00.000Z', randomBytes
    })
    assert.throws(() => authenticateWorkerAccess(db, enrolled.accessToken, {
      now: '2026-08-23T00:01:01.000Z'
    }), (error) => error.code === 'PC_WORKER_AUTH_INVALID')
    assert.equal(authenticateWorkerAccess(db, rotated.accessToken, {
      now: '2026-08-23T00:01:01.000Z'
    }).status, 'active')
    assert.throws(() => refreshWorkerCredentials(db, enrolled.refreshToken, {
      now: '2026-08-23T00:01:02.000Z', randomBytes
    }), (error) => error.code === 'PC_WORKER_REFRESH_REPLAYED')
    assert.throws(() => authenticateWorkerAccess(db, rotated.accessToken, {
      now: '2026-08-23T00:01:03.000Z'
    }), (error) => error.code === 'PC_WORKER_AUTH_INVALID')
    assert.equal(db.prepare('SELECT status FROM pc_workers').get().status, 'revoked')
  } finally { db.close() }
})

test('Owner revocation invalidates live access immediately', nativeTestOptions, () => {
  const db = database()
  const randomBytes = bytesFactory()
  try {
    const enrollment = createWorkerEnrollment(db, {}, { now: '2026-08-23T00:00:00.000Z', randomBytes })
    const enrolled = enrollWorker(db, enrollment.token, profile(), {
      now: '2026-08-23T00:00:01.000Z', randomBytes,
      randomUUID: () => '00000000-0000-4000-8000-000000000003'
    })
    assert.equal(revokeWorker(db, enrolled.worker.id, { now: '2026-08-23T00:00:02.000Z' }).status, 'revoked')
    assert.throws(() => authenticateWorkerAccess(db, enrolled.accessToken, {
      now: '2026-08-23T00:00:03.000Z'
    }), (error) => error.code === 'PC_WORKER_AUTH_INVALID')
  } finally { db.close() }
})
