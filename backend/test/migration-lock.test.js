import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  MAX_MIGRATION_LOCK_TIMEOUT_MS,
  MIN_MIGRATION_LOCK_TIMEOUT_MS,
  MIGRATION_LOCK_BUSY,
  MIGRATION_LOCK_ACTIVE,
  MIGRATION_LOCK_RELEASED,
  MIGRATION_LOCK_RELEASING,
  acquireMigrationLock,
  createReleaseStateMachine,
  deriveMigrationLockPath,
  isMigrationLockBusyError,
  normalizeMainDbPath,
  normalizeMigrationLockTimeout
} from '../src/config/migrationLock.js'

const require = createRequire(import.meta.url)
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const childFixture = path.join(
  testDirectory,
  'fixtures',
  'migration-lock-child.js'
)

function isKnownNativeBindingMissingError(error) {
  const message = String(error?.message ?? '')
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(
    message
  )
}

let nativeBindingAvailable = true
try {
  const Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) {
    throw error
  }
  nativeBindingAvailable = false
}

const realLockTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : {
      skip:
        'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test'
    }

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-migration-lock-'))
}

function cleanupDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function spawnLockChild(mainDbPath, timeoutMs) {
  const child = spawn(process.execPath, [childFixture, mainDbPath, String(timeoutMs)], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  const messages = []
  const waiters = []
  let stderr = ''

  const deliver = (message) => {
    messages.push(message)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].event === message.event) {
        const waiter = waiters.splice(index, 1)[0]
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== '') {
        deliver(JSON.parse(line))
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  return {
    child,
    waitFor(event, timeoutMs = 5000) {
      const existing = messages.find((message) => message.event === event)
      if (existing) {
        return Promise.resolve(existing)
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve)
          if (index !== -1) {
            waiters.splice(index, 1)
          }
          reject(new Error(`timed out waiting for child event ${event}; stderr: ${stderr}`))
        }, timeoutMs)
        waiters.push({ event, resolve, reject, timer })
      })
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        child.once('close', resolve)
      })
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  }
}

test('derives the side-car path from a normalized main database path', () => {
  const directory = makeTempDirectory()
  try {
    const mainPath = path.join(directory, 'nested', '..', 'app.db')
    const normalized = normalizeMainDbPath(mainPath)
    assert.equal(normalized, path.resolve(mainPath))
    assert.equal(
      deriveMigrationLockPath(mainPath),
      `${path.resolve(mainPath)}.migration-lock.sqlite`
    )
    assert.equal(path.dirname(deriveMigrationLockPath(mainPath)), path.dirname(normalized))
  } finally {
    cleanupDirectory(directory)
  }
})

test('rejects invalid timeout values and caller supplied lock paths', () => {
  const invalidValues = [
    MIN_MIGRATION_LOCK_TIMEOUT_MS - 1,
    MAX_MIGRATION_LOCK_TIMEOUT_MS + 1,
    1.5,
    Number.NaN,
    '5000'
  ]
  for (const value of invalidValues) {
    assert.throws(() => normalizeMigrationLockTimeout(value), RangeError)
  }

  assert.equal(normalizeMigrationLockTimeout(), DEFAULT_MIGRATION_LOCK_TIMEOUT_MS)
})

test('rejects a caller supplied lockPath before opening SQLite', () => {
  const directory = makeTempDirectory()
  try {
    assert.throws(
      () => acquireMigrationLock(path.join(directory, 'app.db'), { lockPath: 'elsewhere' }),
      /lockPath is derived internally/
    )
  } finally {
    cleanupDirectory(directory)
  }
})

test('recognizes only the explicit better-sqlite3 bindings-file failure', () => {
  assert.equal(
    isKnownNativeBindingMissingError(
      new Error('Could not locate the bindings file. Tried:\n → /tmp/better_sqlite3.node')
    ),
    true
  )
  assert.equal(isKnownNativeBindingMissingError(new Error('Cannot find module better-sqlite3')), false)
  assert.equal(isKnownNativeBindingMissingError(new Error('SQLITE_CANTOPEN')), false)
})

test('maps SQLite busy and locked extended codes by prefix', () => {
  assert.equal(isMigrationLockBusyError({ code: 'SQLITE_BUSY' }), true)
  assert.equal(isMigrationLockBusyError({ code: 'SQLITE_BUSY_TIMEOUT' }), true)
  assert.equal(isMigrationLockBusyError({ code: 'SQLITE_LOCKED' }), true)
  assert.equal(isMigrationLockBusyError({ code: 'SQLITE_LOCKED_SHAREDCACHE' }), true)
  assert.equal(isMigrationLockBusyError({ code: 'SQLITE_CANTOPEN' }), false)
  assert.equal(isMigrationLockBusyError({ code: 'BUSY' }), false)
  assert.equal(isMigrationLockBusyError(new Error('SQLITE_BUSY')), false)
})

test('release state machine closes after rollback failure and becomes released', () => {
  let rollbackCalls = 0
  let closeCalls = 0
  const rollbackError = new Error('rollback failed')
  const stateMachine = createReleaseStateMachine({
    rollback() {
      rollbackCalls += 1
      throw rollbackError
    },
    close() {
      closeCalls += 1
    }
  })

  assert.equal(stateMachine.state, MIGRATION_LOCK_ACTIVE)
  assert.throws(() => stateMachine.release(), (error) => error === rollbackError)
  assert.equal(stateMachine.state, MIGRATION_LOCK_RELEASED)
  assert.equal(rollbackCalls, 1)
  assert.equal(closeCalls, 1)
  assert.equal(stateMachine.release(), false)
  assert.equal(rollbackCalls, 1)
  assert.equal(closeCalls, 1)
})

test('release state machine retries close when the connection remains open', () => {
  let open = true
  let rollbackCalls = 0
  let closeCalls = 0
  const closeError = new Error('close failed')
  const stateMachine = createReleaseStateMachine({
    rollback() {
      rollbackCalls += 1
    },
    close() {
      closeCalls += 1
      if (closeCalls === 1) {
        throw closeError
      }
      open = false
    },
    isOpen() {
      return open
    }
  })

  assert.throws(() => stateMachine.release(), (error) => error === closeError)
  assert.equal(stateMachine.state, MIGRATION_LOCK_ACTIVE)
  assert.equal(stateMachine.release(), true)
  assert.equal(stateMachine.state, MIGRATION_LOCK_RELEASED)
  assert.equal(rollbackCalls, 2)
  assert.equal(closeCalls, 2)
})

test('release state machine ignores reentrant release while releasing', () => {
  let stateMachine
  let rollbackCalls = 0
  let closeCalls = 0
  stateMachine = createReleaseStateMachine({
    rollback() {
      rollbackCalls += 1
      assert.equal(stateMachine.state, MIGRATION_LOCK_RELEASING)
      assert.equal(stateMachine.release(), false)
    },
    close() {
      closeCalls += 1
    }
  })

  assert.equal(stateMachine.release(), true)
  assert.equal(stateMachine.state, MIGRATION_LOCK_RELEASED)
  assert.equal(rollbackCalls, 1)
  assert.equal(closeCalls, 1)
})

test('one of two processes acquires the lock and the other receives MIGRATION_LOCK_BUSY', realLockTestOptions, async () => {
  const directory = makeTempDirectory()
  const mainDbPath = path.join(directory, 'app.db')
  const first = spawnLockChild(mainDbPath, 500)
  let second
  try {
    await first.waitFor('acquired')
    second = spawnLockChild(mainDbPath, 250)
    const result = await second.waitFor('error', 3000)
    assert.equal(result.code, MIGRATION_LOCK_BUSY)
  } finally {
    first.kill()
    second?.kill()
    await Promise.all([first.close(), second?.close()])
    cleanupDirectory(directory)
  }
})

test('a normally released lock can be acquired again', realLockTestOptions, async () => {
  const directory = makeTempDirectory()
  const mainDbPath = path.join(directory, 'app.db')
  const child = spawnLockChild(mainDbPath, 500)
  try {
    await child.waitFor('acquired')
    child.child.stdin.write('release\n')
    await child.waitFor('released')
    await child.close()

    const handle = acquireMigrationLock(mainDbPath)
    handle.release()
    assert.equal(fs.existsSync(deriveMigrationLockPath(mainDbPath)), true)
  } finally {
    child.kill()
    await child.close()
    cleanupDirectory(directory)
  }
})

test('a force-terminated holder releases the OS lock without deleting the side-car file', realLockTestOptions, async () => {
  const directory = makeTempDirectory()
  const mainDbPath = path.join(directory, 'app.db')
  const child = spawnLockChild(mainDbPath, 500)
  try {
    await child.waitFor('acquired')
    child.kill()
    await child.close()
    assert.equal(fs.existsSync(deriveMigrationLockPath(mainDbPath)), true)

    const handle = acquireMigrationLock(mainDbPath)
    handle.release()
  } finally {
    child.kill()
    await child.close()
    cleanupDirectory(directory)
  }
})

test('release is idempotent and does not remove the side-car file', realLockTestOptions, () => {
  const directory = makeTempDirectory()
  const mainDbPath = path.join(directory, 'app.db')
  try {
    const handle = acquireMigrationLock(mainDbPath)
    handle.release()
    handle.release()
    assert.equal(fs.existsSync(deriveMigrationLockPath(mainDbPath)), true)
  } finally {
    cleanupDirectory(directory)
  }
})

test('does not create or modify the main database', realLockTestOptions, () => {
  const directory = makeTempDirectory()
  const absentMainDbPath = path.join(directory, 'absent.db')
  const existingMainDbPath = path.join(directory, 'existing.db')
  const originalContent = Buffer.from('main database sentinel')
  try {
    const absentHandle = acquireMigrationLock(absentMainDbPath)
    absentHandle.release()
    assert.equal(fs.existsSync(absentMainDbPath), false)

    fs.writeFileSync(existingMainDbPath, originalContent)
    const before = fs.statSync(existingMainDbPath)
    const existingHandle = acquireMigrationLock(existingMainDbPath)
    existingHandle.release()
    assert.deepEqual(fs.readFileSync(existingMainDbPath), originalContent)
    assert.equal(fs.statSync(existingMainDbPath).size, before.size)
  } finally {
    cleanupDirectory(directory)
  }
})
