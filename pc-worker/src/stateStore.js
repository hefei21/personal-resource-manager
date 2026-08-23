import fs from 'node:fs'
import path from 'node:path'

const STATE_KEYS = new Set(['formatVersion', 'workerId', 'accessToken', 'accessExpiresAt', 'refreshToken', 'refreshExpiresAt'])

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !STATE_KEYS.has(key)) ||
    value.formatVersion !== 1 || typeof value.workerId !== 'string' || typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' || Number.isNaN(Date.parse(value.accessExpiresAt)) || Number.isNaN(Date.parse(value.refreshExpiresAt))) {
    throw Object.assign(new Error('Worker credential state is invalid.'), { code: 'WORKER_STATE_INVALID' })
  }
  return Object.freeze({ ...value })
}

export function readState(statePath) {
  try {
    return validateState(JSON.parse(fs.readFileSync(statePath, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const previous = `${statePath}.previous`
      try { return validateState(JSON.parse(fs.readFileSync(previous, 'utf8'))) } catch (previousError) {
        if (previousError?.code === 'ENOENT') return null
        throw Object.assign(new Error('Worker credential recovery state could not be read.'), { code: 'WORKER_STATE_INVALID', cause: previousError })
      }
    }
    if (error?.code === 'WORKER_STATE_INVALID') throw error
    throw Object.assign(new Error('Worker credential state could not be read.'), { code: 'WORKER_STATE_INVALID', cause: error })
  }
}

export function writeState(statePath, value) {
  const state = validateState(value)
  const directory = path.dirname(statePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${process.pid}.tmp`
  const previous = `${statePath}.previous`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.rmSync(previous, { force: true })
    if (fs.existsSync(statePath)) fs.renameSync(statePath, previous)
    fs.renameSync(temporary, statePath)
    fs.rmSync(previous, { force: true })
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    if (!fs.existsSync(statePath) && fs.existsSync(previous)) fs.renameSync(previous, statePath)
    throw Object.assign(new Error('Worker credential state could not be saved.'), { code: 'WORKER_STATE_WRITE_FAILED', cause: error })
  }
  return state
}

export function stateFromCredentialResponse(data) {
  return validateState({
    formatVersion: 1,
    workerId: data.worker.id,
    accessToken: data.accessToken,
    accessExpiresAt: data.accessExpiresAt,
    refreshToken: data.refreshToken,
    refreshExpiresAt: data.refreshExpiresAt
  })
}
