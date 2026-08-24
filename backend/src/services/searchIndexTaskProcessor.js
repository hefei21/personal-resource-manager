import { getDatabase } from '../config/database.js'
import { createSearchIndexService, SEARCH_INDEX_ERROR_CODES, SearchIndexError } from './searchIndexService.js'
import { collectSearchEntries } from './searchSourceCollector.js'
import { collectCodeSymbolSnapshots } from './codeSymbolSnapshotCollector.js'
import {
  CODE_SYMBOL_INDEX_ERROR_CODES,
  CodeSymbolIndexError,
  createCodeSymbolIndexService
} from './codeSymbolIndexService.js'
import { registerTaskProcessor } from './taskRuntime.js'
import { TaskProcessorError } from './taskProcessorError.js'

export const SEARCH_INDEX_TASK_TYPE = 'search.index.refresh'
export const SEARCH_INDEX_PROCESSOR_VERSION = 'v1'
export const SEARCH_INDEX_EXECUTION_CLASS = 'disk'
const SUBJECT_TYPE = 'search-index'
const SUBJECT_ID = 'owner'

export const SEARCH_INDEX_TASK_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'SEARCH_INDEX_INPUT_INVALID',
  DATABASE_BUSY: 'SEARCH_INDEX_DATABASE_BUSY',
  CANCELLED: 'SEARCH_INDEX_CANCELLED',
  FAILED: 'SEARCH_INDEX_REFRESH_FAILED'
})

function taskError(code, summary, retryable) {
  return new TaskProcessorError({ code, summary, retryable })
}

export function normalizeSearchIndexTaskInput(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.taskType !== SEARCH_INDEX_TASK_TYPE) return null
  if (task.processorVersion !== undefined && task.processorVersion !== SEARCH_INDEX_PROCESSOR_VERSION) return null
  if (task.executionClass !== undefined && task.executionClass !== SEARCH_INDEX_EXECUTION_CLASS) return null
  if (task.subjectType !== undefined && task.subjectType !== SUBJECT_TYPE) return null
  if (task.subjectId !== undefined && String(task.subjectId) !== SUBJECT_ID) return null
  const input = task.input
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['rebuild', 'includeCodeFiles'].includes(key))) return null
  const rebuild = input.rebuild === undefined ? false : input.rebuild
  const includeCodeFiles = input.includeCodeFiles === undefined ? true : input.includeCodeFiles
  if (typeof rebuild !== 'boolean' || typeof includeCodeFiles !== 'boolean') return null
  return Object.freeze({ rebuild, includeCodeFiles })
}

function mapError(error) {
  if (error instanceof TaskProcessorError) return error
  const code = String(error?.code ?? '')
  if (code === 'SEARCH_INDEX_CANCELLED' || code === 'CODE_SYMBOL_CANCELLED' || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return taskError(SEARCH_INDEX_TASK_ERROR_CODES.CANCELLED, 'Search index refresh was cancelled.', false)
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_BUSY_SNAPSHOT') {
    return taskError(SEARCH_INDEX_TASK_ERROR_CODES.DATABASE_BUSY, 'Search index storage is temporarily busy.', true)
  }
  if (error instanceof SearchIndexError && code === SEARCH_INDEX_ERROR_CODES.INPUT_INVALID) {
    return taskError(SEARCH_INDEX_TASK_ERROR_CODES.INPUT_INVALID, 'Search index input is invalid.', false)
  }
  if (error instanceof CodeSymbolIndexError && code === CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID) {
    return taskError(SEARCH_INDEX_TASK_ERROR_CODES.INPUT_INVALID, 'Code symbol index input is invalid.', false)
  }
  return taskError(SEARCH_INDEX_TASK_ERROR_CODES.FAILED, 'Search index refresh failed.', false)
}

export function createSearchIndexTaskProcessor({
  database,
  databaseProvider = getDatabase,
  collectEntries = collectSearchEntries,
  serviceFactory = createSearchIndexService,
  collectSnapshots = collectCodeSymbolSnapshots,
  symbolServiceFactory = createCodeSymbolIndexService
} = {}) {
  const getDatabaseForTask = database === undefined ? databaseProvider : () => database
  if (typeof getDatabaseForTask !== 'function') throw new TypeError('databaseProvider must be a function')
  if (typeof collectEntries !== 'function') throw new TypeError('collectEntries must be a function')
  if (typeof serviceFactory !== 'function') throw new TypeError('serviceFactory must be a function')
  if (typeof collectSnapshots !== 'function') throw new TypeError('collectSnapshots must be a function')
  if (typeof symbolServiceFactory !== 'function') throw new TypeError('symbolServiceFactory must be a function')
  return async function processSearchIndexTask(context = {}) {
    const input = normalizeSearchIndexTaskInput(context.task)
    if (!input) throw taskError(SEARCH_INDEX_TASK_ERROR_CODES.INPUT_INVALID, 'Search index input is invalid.', false)
    if (context.signal?.aborted) throw taskError(SEARCH_INDEX_TASK_ERROR_CODES.CANCELLED, 'Search index refresh was cancelled.', false)
    try {
      const databaseConnection = await getDatabaseForTask()
      const service = serviceFactory({ database: databaseConnection, collectEntries })
      const progress = typeof context.progress === 'function' ? context.progress : async () => {}
      const searchResult = await service.refresh({
        ...input,
        signal: context.signal,
        onProgress: async (value) => progress(Math.round(Number(value) * (input.includeCodeFiles ? 0.7 : 1)))
      })
      if (!input.includeCodeFiles) return searchResult
      const symbolService = symbolServiceFactory({ database: databaseConnection, collectSnapshots })
      const symbolResult = await symbolService.refresh({
        rebuild: input.rebuild,
        signal: context.signal,
        onProgress: async (value) => progress(70 + Math.round(Number(value) * 0.3))
      })
      return Object.freeze({
        ...searchResult,
        status: searchResult.status === 'partial' || symbolResult.status === 'partial' ? 'partial' : 'ready',
        errorCount: searchResult.errorCount + symbolResult.errorCount,
        symbolRepositories: symbolResult.repositoryCount,
        symbolRefreshed: symbolResult.refreshed,
        symbolSkipped: symbolResult.skipped,
        symbolFiles: symbolResult.fileCount,
        symbolCount: symbolResult.symbolCount,
        symbolErrors: symbolResult.errorCount
      })
    } catch (error) {
      throw mapError(error)
    }
  }
}

const registeredProcessor = createSearchIndexTaskProcessor()
registerTaskProcessor(
  SEARCH_INDEX_TASK_TYPE,
  SEARCH_INDEX_PROCESSOR_VERSION,
  SEARCH_INDEX_EXECUTION_CLASS,
  registeredProcessor
)

export default registeredProcessor
