import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readState, stateFromCredentialResponse, writeState } from '../src/stateStore.js'

function credentials(suffix) {
  return {
    worker: { id: `pcw-${suffix}` },
    accessToken: `access-${suffix}`,
    accessExpiresAt: '2999-01-01T00:00:00.000Z',
    refreshToken: `refresh-${suffix}`,
    refreshExpiresAt: '2999-02-01T00:00:00.000Z'
  }
}

test('credential state writes atomically and rotates without leaving raw temp files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-state-'))
  const statePath = path.join(directory, 'nested', 'state.json')
  try {
    writeState(statePath, stateFromCredentialResponse(credentials('one')))
    writeState(statePath, stateFromCredentialResponse(credentials('two')))
    assert.equal(readState(statePath).workerId, 'pcw-two')
    assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ['state.json'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('malformed state is rejected without exposing its contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-state-'))
  const statePath = path.join(directory, 'state.json')
  try {
    fs.writeFileSync(statePath, '{"token":"secret"}')
    assert.throws(() => readState(statePath), (error) => error.code === 'WORKER_STATE_INVALID' && !error.message.includes('secret'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
