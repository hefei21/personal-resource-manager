import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  MIGRATION_LOCK_BUSY,
  acquireMigrationLock
} from '../../src/config/migrationLock.js'

const POLL_INTERVAL_MS = 100
const WAIT_TIMEOUT_MS = 20000

function markerPath(runDirectory, name) {
  return path.join(runDirectory, `${name}.json`)
}

function writeMarker(runDirectory, name, payload = {}) {
  fs.writeFileSync(
    markerPath(runDirectory, name),
    `${JSON.stringify({ event: name, ...payload })}\n`,
    { encoding: 'utf8', flag: 'wx' }
  )
}

async function waitForMarker(runDirectory, name) {
  const target = markerPath(runDirectory, name)
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`timed out waiting for ${name}`)
}

function validateToken(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(`${label} must be a safe token`)
  }
  return value
}

async function runHolder(runDirectory, databasePath) {
  const handle = acquireMigrationLock(databasePath, { busyTimeoutMs: 500 })
  try {
    writeMarker(runDirectory, 'holder-ready')
    await waitForMarker(runDirectory, 'contender-busy')
  } finally {
    handle.release()
  }
  writeMarker(runDirectory, 'holder-released')
  await waitForMarker(runDirectory, 'contender-reacquired')
}

async function runContender(runDirectory, databasePath) {
  await waitForMarker(runDirectory, 'holder-ready')
  try {
    const unexpected = acquireMigrationLock(databasePath, { busyTimeoutMs: 500 })
    unexpected.release()
    throw new Error('contender unexpectedly acquired the held lock')
  } catch (error) {
    if (error?.code !== MIGRATION_LOCK_BUSY) throw error
  }
  writeMarker(runDirectory, 'contender-busy', { code: MIGRATION_LOCK_BUSY })
  await waitForMarker(runDirectory, 'holder-released')
  const handle = acquireMigrationLock(databasePath, { busyTimeoutMs: 5000 })
  handle.release()
  writeMarker(runDirectory, 'contender-reacquired')
}

async function main() {
  const role = validateToken(process.argv[2], 'role')
  if (role !== 'holder' && role !== 'contender') {
    throw new Error('role must be holder or contender')
  }
  const sharedRoot = path.resolve(process.argv[3] ?? '')
  const runId = validateToken(process.argv[4], 'run id')
  const runDirectory = path.join(sharedRoot, runId)
  fs.mkdirSync(runDirectory, { recursive: true })
  const databasePath = path.join(runDirectory, 'probe.db')

  if (role === 'holder') {
    await runHolder(runDirectory, databasePath)
  } else {
    await runContender(runDirectory, databasePath)
  }
  process.stdout.write(`${JSON.stringify({ role, status: 'passed' })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'failed', message: error.message })}\n`)
  process.exitCode = 1
})
