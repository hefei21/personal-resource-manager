import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFileLogger } from '../src/fileLogger.js'

test('file logger persists bounded single-line events and rotates the owned log', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-log-'))
  try {
    const logPath = path.join(directory, 'nested', 'worker.log')
    const logger = createFileLogger(logPath, { maxBytes: 1024 })
    logger.info('{"event":"worker_started"}\nforged')
    assert.equal(fs.readFileSync(logPath, 'utf8'), '{"event":"worker_started"} forged\n')

    fs.writeFileSync(logPath, 'x'.repeat(1024))
    logger.warn('{"event":"task_failed","code":"WORKER_CONTENT_EXTRACT_EMPTY"}')
    assert.equal(fs.statSync(`${logPath}.1`).size, 1024)
    assert.match(fs.readFileSync(logPath, 'utf8'), /WORKER_CONTENT_EXTRACT_EMPTY/u)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
