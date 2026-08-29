import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

function normalizeLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, ' ')
    .slice(0, 4096)
}

function rotateIfNeeded(logPath, maxBytes) {
  try {
    if (fs.statSync(logPath).size < maxBytes) return
    const previousPath = `${logPath}.1`
    try { fs.rmSync(previousPath, { force: true }) } catch {}
    fs.renameSync(logPath, previousPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function createFileLogger(logPath, { maxBytes = DEFAULT_MAX_BYTES, fallback = console } = {}) {
  if (typeof logPath !== 'string' || !path.isAbsolute(logPath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('Worker log configuration is invalid.')
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  rotateIfNeeded(logPath, maxBytes)

  const write = (level, value) => {
    const line = normalizeLine(value)
    try {
      rotateIfNeeded(logPath, maxBytes)
      fs.appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      fallback?.[level]?.(line)
    }
  }

  return Object.freeze({
    info(value) { write('info', value) },
    warn(value) { write('warn', value) }
  })
}

export default createFileLogger
