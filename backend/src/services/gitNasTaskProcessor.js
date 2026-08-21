import { getDatabase } from '../config/database.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'
import {
  GIT_NAS_CANDIDATE_SUBJECT_TYPE,
  GIT_NAS_DISCOVER_TASK_TYPE,
  GIT_NAS_EXECUTION_CLASS,
  GIT_NAS_IMPORT_TASK_TYPE,
  GIT_NAS_PROCESSOR_VERSION,
  GIT_NAS_ROOT_SUBJECT_TYPE,
  GitNasRepositoryError,
  discoverGitNasRepositories,
  importGitNasCandidate
} from './gitNasRepositoryService.js'

export const GIT_NAS_TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'GIT_NAS_TASK_INPUT_INVALID',
  ROOT_NOT_FOUND: 'GIT_NAS_TASK_ROOT_NOT_FOUND',
  ROOT_DISABLED: 'GIT_NAS_TASK_ROOT_DISABLED',
  CONFIG_CONFLICT: 'GIT_NAS_TASK_CONFIG_CONFLICT',
  CANDIDATE_NOT_FOUND: 'GIT_NAS_TASK_CANDIDATE_NOT_FOUND',
  PATH_INVALID: 'GIT_NAS_TASK_PATH_INVALID',
  READ_ONLY: 'GIT_NAS_READ_ONLY',
  CANCELLED: 'GIT_NAS_TASK_CANCELLED',
  DATABASE_BUSY: 'GIT_NAS_TASK_DATABASE_BUSY',
  FAILED: 'GIT_NAS_TASK_FAILED'
})

const DISCOVERY_INPUT_KEYS = Object.freeze(['scanRootId', 'rulesVersion', 'generation'])
const IMPORT_INPUT_KEYS = Object.freeze(['candidateId'])
const POSITIVE_ID = /^[1-9]\d*$/u

function taskError(code, summary, retryable = false, causeCategory) {
  return new TaskProcessorError({ code, summary, retryable, ...(causeCategory ? { causeCategory } : {}) })
}

function positive(value) {
  if (typeof value === 'string' && POSITIVE_ID.test(value.trim())) value = Number(value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function strictInput(task, taskType, keys) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.taskType !== taskType) return null
  if (task.processorVersion !== undefined && task.processorVersion !== GIT_NAS_PROCESSOR_VERSION) return null
  if (task.executionClass !== undefined && task.executionClass !== GIT_NAS_EXECUTION_CLASS) return null
  const input = task.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const inputKeys = Object.keys(input)
  if (inputKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)) ||
    inputKeys.some((key) => !keys.includes(key))) return null
  const normalized = {}
  for (const key of keys) {
    const value = positive(input[key])
    if (value === null) return null
    normalized[key] = value
  }
  return Object.freeze(normalized)
}

function normalizeTask(task) {
  if (task?.taskType === GIT_NAS_DISCOVER_TASK_TYPE) {
    const input = strictInput(task, GIT_NAS_DISCOVER_TASK_TYPE, DISCOVERY_INPUT_KEYS)
    if (!input) return null
    if (task.subjectType !== undefined && task.subjectType !== GIT_NAS_ROOT_SUBJECT_TYPE) return null
    if (task.subjectId !== undefined && String(task.subjectId) !== String(input.scanRootId)) return null
    return Object.freeze({ kind: 'discover', taskType: task.taskType, ...input })
  }
  if (task?.taskType === GIT_NAS_IMPORT_TASK_TYPE) {
    const input = strictInput(task, GIT_NAS_IMPORT_TASK_TYPE, IMPORT_INPUT_KEYS)
    if (!input) return null
    if (task.subjectType !== undefined && task.subjectType !== GIT_NAS_CANDIDATE_SUBJECT_TYPE) return null
    if (task.subjectId !== undefined && String(task.subjectId) !== String(input.candidateId)) return null
    return Object.freeze({ kind: 'import', taskType: task.taskType, ...input })
  }
  return null
}

function mapError(error) {
  if (error instanceof TaskProcessorError) return error
  if (error instanceof GitNasRepositoryError) {
    const mapping = {
      GIT_NAS_ROOT_NOT_FOUND: GIT_NAS_TASK_ERROR_CODES.ROOT_NOT_FOUND,
      GIT_NAS_ROOT_DISABLED: GIT_NAS_TASK_ERROR_CODES.ROOT_DISABLED,
      GIT_NAS_CONFIG_CONFLICT: GIT_NAS_TASK_ERROR_CODES.CONFIG_CONFLICT,
      GIT_NAS_CANDIDATE_NOT_FOUND: GIT_NAS_TASK_ERROR_CODES.CANDIDATE_NOT_FOUND,
      GIT_NAS_CANDIDATE_STATE_INVALID: GIT_NAS_TASK_ERROR_CODES.PATH_INVALID,
      GIT_NAS_PATH_INVALID: GIT_NAS_TASK_ERROR_CODES.PATH_INVALID,
      GIT_NAS_SYMLINK_FORBIDDEN: GIT_NAS_TASK_ERROR_CODES.PATH_INVALID,
      GIT_NAS_REALPATH_ESCAPE: GIT_NAS_TASK_ERROR_CODES.PATH_INVALID,
      GIT_NAS_READ_ONLY: GIT_NAS_TASK_ERROR_CODES.READ_ONLY,
      GIT_NAS_CANCELLED: GIT_NAS_TASK_ERROR_CODES.CANCELLED,
      GIT_NAS_DATABASE_BUSY: GIT_NAS_TASK_ERROR_CODES.DATABASE_BUSY
    }
    const code = mapping[error.code] ?? GIT_NAS_TASK_ERROR_CODES.FAILED
    const retryable = code === GIT_NAS_TASK_ERROR_CODES.DATABASE_BUSY
    return taskError(code, code === GIT_NAS_TASK_ERROR_CODES.DATABASE_BUSY
      ? 'NAS Git storage is temporarily busy.'
      : 'The NAS Git operation failed.', retryable)
  }
  if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return taskError(GIT_NAS_TASK_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.')
  }
  if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
    return taskError(GIT_NAS_TASK_ERROR_CODES.DATABASE_BUSY, 'NAS Git storage is temporarily busy.', true)
  }
  return taskError(GIT_NAS_TASK_ERROR_CODES.FAILED, 'The NAS Git operation failed.')
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeDiscoveryResult(result) {
  return Object.freeze({
    generation: safeCount(result?.generation),
    rulesVersion: safeCount(result?.rulesVersion),
    visitedEntries: safeCount(result?.visitedEntries),
    candidates: safeCount(result?.candidates),
    rejected: safeCount(result?.rejected),
    created: safeCount(result?.created),
    existing: safeCount(result?.existing),
    missing: safeCount(result?.missing)
  })
}

function safeImportResult(result) {
  return Object.freeze({
    repositoryId: safeCount(result?.repositoryId),
    resourceId: safeCount(result?.resourceId),
    status: result?.status === 'already-imported' ? 'already-imported' : 'imported'
  })
}

export function createGitNasTaskProcessor({
  database,
  databaseProvider = getDatabase,
  discover = discoverGitNasRepositories,
  importCandidate = importGitNasCandidate
} = {}) {
  const getDatabaseForTask = database ? () => database : databaseProvider
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof discover !== 'function') throw new TypeError('discover must be a function')
  if (typeof importCandidate !== 'function') throw new TypeError('importCandidate must be a function')

  return async function processGitNasTask(context = {}) {
    const normalized = normalizeTask(context.task)
    if (!normalized) throw taskError(GIT_NAS_TASK_ERROR_CODES.INPUT_INVALID, 'NAS Git task input is invalid.')
    if (context.signal?.aborted) throw taskError(GIT_NAS_TASK_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.')
    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    try {
      const databaseConnection = getDatabaseForTask()
      if (normalized.kind === 'discover') {
        let lastProgress = 0
        const updateProgress = async (event = {}) => {
          if (context.signal?.aborted) throw taskError(GIT_NAS_TASK_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.')
          const visited = Number.isSafeInteger(event.visitedEntries) ? event.visitedEntries : 0
          const next = Math.min(95, Math.max(lastProgress, 5 + Math.floor(Math.log10(visited + 1) * 20)))
          if (next <= lastProgress) return
          lastProgress = next
          await progress(next)
        }
        await progress(1)
        const result = await discover({
          database: databaseConnection,
          scanRootId: normalized.scanRootId,
          rulesVersion: normalized.rulesVersion,
          generation: normalized.generation,
          signal: context.signal,
          onProgress: updateProgress
        })
        if (context.signal?.aborted) throw taskError(GIT_NAS_TASK_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.')
        return safeDiscoveryResult(result)
      }
      await progress(1)
      const result = await importCandidate({
        database: databaseConnection,
        candidateId: normalized.candidateId,
        signal: context.signal
      })
      if (context.signal?.aborted) throw taskError(GIT_NAS_TASK_ERROR_CODES.CANCELLED, 'The NAS Git operation was cancelled.')
      return safeImportResult(result)
    } catch (error) {
      throw mapError(error)
    }
  }
}

const registeredProcessor = createGitNasTaskProcessor()
registerTaskProcessor(GIT_NAS_DISCOVER_TASK_TYPE, GIT_NAS_PROCESSOR_VERSION, GIT_NAS_EXECUTION_CLASS, registeredProcessor)
registerTaskProcessor(GIT_NAS_IMPORT_TASK_TYPE, GIT_NAS_PROCESSOR_VERSION, GIT_NAS_EXECUTION_CLASS, registeredProcessor)

export default registeredProcessor
