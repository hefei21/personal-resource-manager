import process from 'node:process'
import { acquireMigrationLock } from '../../src/config/migrationLock.js'

const mainDbPath = process.argv[2]
const timeoutMs = Number(process.argv[3] ?? 500)

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let handle
try {
  handle = acquireMigrationLock(mainDbPath, { busyTimeoutMs: timeoutMs })
  send({ event: 'acquired' })
} catch (error) {
  send({ event: 'error', code: error?.code ?? 'UNKNOWN' })
  process.exitCode = 0
}

if (handle) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (chunk.trim() !== 'release') {
      return
    }

    try {
      handle.release()
      send({ event: 'released' })
      process.exit(0)
    } catch (error) {
      send({ event: 'error', code: error?.code ?? 'UNKNOWN' })
      process.exit(1)
    }
  })
}
