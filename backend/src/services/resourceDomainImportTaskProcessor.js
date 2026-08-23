import { getDatabase } from '../config/database.js'
import {
  adaptResourceDomains,
  normalizeResourceDomainImportInput,
  reconcileMissingDomainRecords,
  RESOURCE_DOMAIN_IMPORT_ERROR_CODES,
  RESOURCE_DOMAIN_IMPORT_EXECUTION_CLASS,
  RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION,
  RESOURCE_DOMAIN_IMPORT_TASK_TYPE
} from './resourceDomainAdapter.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'

const SUBJECT_TYPE = 'resource-domain-import'
const SUBJECT_ID = 'owner'
const MAX_COUNT = 1_000_000_000
const IMPORT_SCOPES = Object.freeze(['documents', 'ebooks', 'music'])
const RESULT_KEYS = Object.freeze([
  'processed',
  'resourcesCreated',
  'resourcesReused',
  'sourcesCreated',
  'versionsCreated',
  'versionsReused',
  'contentObjectsCreated',
  'contentObjectsReused',
  'missingContent',
  'missingRecords',
  'errors',
  'conflicts',
  'skipped'
])

export const RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RESOURCE_DOMAIN_IMPORT_INPUT_INVALID',
  DATABASE_BUSY: 'RESOURCE_DOMAIN_IMPORT_DATABASE_BUSY',
  CANCELLED: 'RESOURCE_DOMAIN_IMPORT_CANCELLED',
  FAILED: 'RESOURCE_DOMAIN_IMPORT_FAILED'
})

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.CANCELLED, 'Resource domain import was cancelled.', false)
  }
}

function normalizeTaskInput(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) ||
      task.taskType !== RESOURCE_DOMAIN_IMPORT_TASK_TYPE) return null
  if (task.processorVersion !== undefined && task.processorVersion !== RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION) return null
  if (task.executionClass !== undefined && task.executionClass !== RESOURCE_DOMAIN_IMPORT_EXECUTION_CLASS) return null
  if (task.subjectType !== undefined && task.subjectType !== SUBJECT_TYPE) return null
  if (task.subjectId !== undefined && String(task.subjectId) !== SUBJECT_ID) return null
  try {
    return normalizeResourceDomainImportInput(task.input)
  } catch {
    return null
  }
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : 0
}

function safeResult(report) {
  return Object.freeze(Object.fromEntries(RESULT_KEYS.map((key) => [key, safeCount(report?.[key])])))
}

function emptyResult() {
  return Object.fromEntries(RESULT_KEYS.map((key) => [key, 0]))
}

function mapProcessorError(error) {
  if (error instanceof TaskProcessorError) return error
  const code = String(error?.code ?? '')
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.CANCELLED || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.CANCELLED, 'Resource domain import was cancelled.', false)
  }
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_BUSY ||
      code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT') {
    return taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.DATABASE_BUSY, 'Resource domain import storage is temporarily busy.', true)
  }
  if (code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.INPUT_INVALID || code === RESOURCE_DOMAIN_IMPORT_ERROR_CODES.DATABASE_INVALID) {
    return taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.INPUT_INVALID, 'Resource domain import input is invalid.', false)
  }
  return taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.FAILED, 'Resource domain import failed.', false)
}

export function createResourceDomainImportTaskProcessor({
  database,
  databaseProvider = getDatabase,
  adapt = adaptResourceDomains,
  reconcile = reconcileMissingDomainRecords
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof adapt !== 'function') throw new TypeError('adapt must be a function')
  if (typeof reconcile !== 'function') throw new TypeError('reconcile must be a function')

  return async function processResourceDomainImportTask(context = {}) {
    const signal = context.signal
    assertNotAborted(signal)
    const input = normalizeTaskInput(context.task)
    if (!input) {
      throw taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.INPUT_INVALID, 'Resource domain import input is invalid.', false)
    }

    let databaseConnection
    try {
      databaseConnection = await getDatabaseForTask()
    } catch {
      throw taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.FAILED, 'Resource domain import database is unavailable.', true)
    }
    if (!databaseConnection || typeof databaseConnection.prepare !== 'function') {
      throw taskError(RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.FAILED, 'Resource domain import database is unavailable.', true)
    }

    const progress = typeof context.progress === 'function' ? context.progress : async () => {}
    try {
      let lastProgress = 1
      await progress(lastProgress)
      const aggregate = emptyResult()
      const scopes = input.scope === 'all' ? IMPORT_SCOPES : [input.scope]
      for (const scope of scopes) {
        let cursor = input.cursor ?? 0
        while (true) {
          assertNotAborted(signal)
          const report = await adapt({
            input: { scope, cursor, batchSize: input.batchSize },
            database: databaseConnection,
            signal,
            onProgress: async () => {
              assertNotAborted(signal)
            }
          })
          for (const key of RESULT_KEYS) aggregate[key] += safeCount(report?.[key])
          const candidate = Math.min(95, 5 + Math.floor(Math.log10(aggregate.processed + 1) * 20))
          if (candidate > lastProgress) {
            lastProgress = candidate
            await progress(candidate)
          }
          const nextCursor = Number(report?.nextCursor)
          if (report?.hasMore !== true || !Number.isSafeInteger(nextCursor) || nextCursor <= cursor) break
          cursor = nextCursor
        }
        const reconciled = await reconcile(databaseConnection, scope)
        aggregate.missingRecords += safeCount(reconciled?.missingRecords)
      }
      assertNotAborted(signal)
      return safeResult(aggregate)
    } catch (error) {
      throw mapProcessorError(error)
    }
  }
}

const registeredProcessor = createResourceDomainImportTaskProcessor()
registerTaskProcessor(
  RESOURCE_DOMAIN_IMPORT_TASK_TYPE,
  RESOURCE_DOMAIN_IMPORT_PROCESSOR_VERSION,
  RESOURCE_DOMAIN_IMPORT_EXECUTION_CLASS,
  registeredProcessor
)

export { normalizeTaskInput as normalizeResourceDomainImportTaskInput }
export default registeredProcessor
