import { getDatabase } from '../config/database.js'
import { normalizeNasScanRules } from '../config/nasScan.js'
import { scanNasResourceRoot } from './nasResourceScanner.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'

const TASK_TYPES = Object.freeze(['nas.resource.scan', 'nas.resource.repair'])
const POSITIVE_ID = /^[1-9]\d*$/u
const MAX_COUNT = 1_000_000_000

export const NAS_SCAN_TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'NAS_SCAN_INPUT_INVALID',
  ROOT_NOT_FOUND: 'NAS_SCAN_ROOT_NOT_FOUND',
  ROOT_DISABLED: 'NAS_SCAN_ROOT_DISABLED',
  CONFIG_CONFLICT: 'NAS_SCAN_CONFIG_CONFLICT',
  RULES_INVALID: 'NAS_SCAN_RULES_INVALID',
  PATH_INVALID: 'NAS_SCAN_PATH_INVALID',
  CANCELLED: 'NAS_SCAN_CANCELLED',
  FAILED: 'NAS_SCAN_FAILED',
  DATABASE_BUSY: 'NAS_SCAN_DATABASE_BUSY'
})

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function normalizePositive(value) {
  if (typeof value === 'string' && POSITIVE_ID.test(value.trim())) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) return null
  return value
}

function normalizeTaskInput(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null
  if (!TASK_TYPES.includes(task.taskType)) return null
  const input = task.input
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, 'scanRootId') || !Object.hasOwn(input, 'rulesVersion') ||
    !Object.hasOwn(input, 'generation')) return null
  const scanRootId = normalizePositive(input.scanRootId)
  const rulesVersion = normalizePositive(input.rulesVersion)
  const generation = normalizePositive(input.generation)
  if (scanRootId === null || rulesVersion === null || generation === null) return null
  if (task.subjectType !== undefined && task.subjectType !== 'nas-scan-root') return null
  if (task.subjectId !== undefined && String(task.subjectId) !== String(scanRootId)) return null
  return Object.freeze({ scanRootId, rulesVersion, generation })
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw taskError(NAS_SCAN_TASK_ERROR_CODES.CANCELLED, 'NAS scan was cancelled.', false)
}

function stableRootError(code) {
  if (code === 'NAS_RESOURCE_ROOT_NOT_FOUND') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.ROOT_NOT_FOUND, 'NAS scan root was not found.', false)
  }
  if (code === 'NAS_RESOURCE_ROOT_DISABLED') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.ROOT_DISABLED, 'NAS scan root is disabled.', false)
  }
  return null
}

function mapProcessorError(error) {
  if (error instanceof TaskProcessorError) return error
  const knownRootError = stableRootError(error?.code)
  if (knownRootError) return knownRootError
  const code = String(error?.code ?? '')
  if (code === 'NAS_SCAN_CANCELLED' || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.CANCELLED, 'NAS scan was cancelled.', false)
  }
  if (code === 'NAS_RESOURCE_GENERATION_CONFLICT') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.CONFIG_CONFLICT, 'NAS scan configuration changed; run the scan again.', false)
  }
  if (code === 'NAS_RESOURCE_INPUT_INVALID' || code === 'NAS_RESOURCE_GENERATION_INVALID') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.INPUT_INVALID, 'NAS scan input is invalid.', false)
  }
  if (code === 'NAS_SCAN_ROOT_INVALID' || code === 'NAS_SCAN_ROOT_NOT_ABSOLUTE' ||
    code === 'NAS_SCAN_ROOT_MISSING' || code === 'NAS_SCAN_ROOT_ACCESS_DENIED' ||
    code === 'NAS_SCAN_ROOT_NOT_DIRECTORY' || code === 'NAS_SCAN_ROOT_SYMLINK' ||
    code === 'NAS_SCAN_ROOT_REALPATH_FAILED' || code === 'NAS_SCAN_REALPATH_ESCAPE' ||
    code === 'NAS_SCAN_SYMLINK_FORBIDDEN') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.PATH_INVALID, 'NAS scan root could not be accessed safely.', false)
  }
  if (code.startsWith('NAS_SCAN_RULES_')) {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.RULES_INVALID, 'NAS scan rules are invalid.', false)
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT') {
    return taskError(NAS_SCAN_TASK_ERROR_CODES.DATABASE_BUSY, 'NAS scan storage is temporarily busy.', true)
  }
  return taskError(NAS_SCAN_TASK_ERROR_CODES.FAILED, 'NAS resource scan failed.', false)
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : 0
}

function safeResult(root, collected) {
  const counts = collected?.counts ?? {}
  return Object.freeze({
    generation: Number(root.generation),
    rulesVersion: Number(root.rulesVersion),
    visitedEntries: safeCount(collected?.visitedEntries),
    files: safeCount(collected?.files),
    excluded: safeCount(collected?.excluded),
    counts: Object.freeze({
      added: safeCount(counts.added),
      moved: safeCount(counts.moved),
      modified: safeCount(counts.modified),
      unchanged: safeCount(counts.unchanged),
      excluded: safeCount(counts.excluded),
      errors: safeCount(counts.errors),
      missing: safeCount(counts.missing),
      conflicts: safeCount(counts.conflicts)
    })
  })
}

function loadRoot(database, input) {
  let row
  try {
    row = database.prepare(`
      SELECT id, enabled, rules_json, rules_version, last_successful_generation
      FROM nas_scan_roots
      WHERE id = ?
    `).get(input.scanRootId)
  } catch (error) {
    throw error
  }
  if (!row) throw taskError(NAS_SCAN_TASK_ERROR_CODES.ROOT_NOT_FOUND, 'NAS scan root was not found.', false)
  if (Number(row.enabled) !== 1) throw taskError(NAS_SCAN_TASK_ERROR_CODES.ROOT_DISABLED, 'NAS scan root is disabled.', false)
  const rulesVersion = Number(row.rules_version)
  const generation = Number(row.last_successful_generation) + 1
  if (rulesVersion !== input.rulesVersion || generation !== input.generation) {
    throw taskError(NAS_SCAN_TASK_ERROR_CODES.CONFIG_CONFLICT, 'NAS scan configuration changed; run the scan again.', false)
  }
  try {
    normalizeNasScanRules(JSON.parse(row.rules_json))
  } catch {
    throw taskError(NAS_SCAN_TASK_ERROR_CODES.RULES_INVALID, 'NAS scan rules are invalid.', false)
  }
  return Object.freeze({ rulesVersion, generation })
}

export function createNasScanTaskProcessor({
  database,
  databaseProvider = getDatabase,
  scan = scanNasResourceRoot
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof scan !== 'function') throw new TypeError('scan must be a function')

  return async function processNasScanTask(context = {}) {
    const task = context.task
    const signal = context.signal
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    const input = normalizeTaskInput(task)
    if (!input) throw taskError(NAS_SCAN_TASK_ERROR_CODES.INPUT_INVALID, 'NAS scan input is invalid.', false)
    assertNotAborted(signal)

    let root
    try {
      const databaseConnection = getDatabaseForTask()
      root = loadRoot(databaseConnection, input)
      let lastProgress = 0
      const updateProgress = async (event = {}) => {
        assertNotAborted(signal)
        const visited = Number.isSafeInteger(event.visitedEntries) ? event.visitedEntries : 0
        const files = Number.isSafeInteger(event.files) ? event.files : 0
        const observed = Math.max(visited, files)
        const candidate = Math.min(95, Math.max(lastProgress, 5 + Math.floor(Math.log10(observed + 1) * 20)))
        if (candidate <= lastProgress) return
        lastProgress = candidate
        await progress(candidate)
      }
      await progress(1)
      const collected = await scan({
        database: databaseConnection,
        scanRootId: input.scanRootId,
        generation: root.generation,
        signal,
        onProgress: updateProgress
      })
      assertNotAborted(signal)
      return safeResult(root, collected)
    } catch (error) {
      throw mapProcessorError(error)
    }
  }
}

const registeredProcessor = createNasScanTaskProcessor()
registerTaskProcessor('nas.resource.scan', 'v1', 'disk', registeredProcessor)
registerTaskProcessor('nas.resource.repair', 'v1', 'disk', registeredProcessor)

export default registeredProcessor
