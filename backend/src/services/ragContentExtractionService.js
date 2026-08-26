import { createRagArtifactStore } from './ragArtifactStore.js'
import { lookupPcWorkerProcessor, normalizeRagContentArtifact } from './pcWorkerProcessorCatalog.js'
import { getTaskRuntime } from './taskRuntime.js'

export const RAG_CONTENT_EXTRACT_TASK_TYPE = 'rag.content.extract'
export const RAG_CONTENT_EXTRACT_PROCESSOR_VERSION = 'v1'
export const RAG_CONTENT_EXTRACT_EXECUTION_CLASS = 'cpu'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 100
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

export class RagContentExtractionError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options)
    this.name = 'RagContentExtractionError'
    this.code = code
  }
}

function fail(code, message, options) {
  throw new RagContentExtractionError(code, message, options)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function duration(value, fallback, fieldName) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000) {
    throw new TypeError(`${fieldName} is invalid`)
  }
  return value
}

function abortError() {
  return new RagContentExtractionError('RAG_SOURCE_CANCELLED', 'RAG source extraction was cancelled.')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function delay(milliseconds, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function taskStoreFromRuntime() {
  try { return getTaskRuntime().getStore() } catch {
    fail('RAG_SOURCE_EXTRACTION_TASK_STORE_UNAVAILABLE', 'RAG extraction task storage is unavailable.')
  }
}

function sameInput(left, right) {
  return isPlainObject(left) && JSON.stringify(left) === JSON.stringify(right)
}

export function createRagContentExtractionService({
  taskStore,
  taskStoreProvider = taskStoreFromRuntime,
  artifactStore,
  artifactStoreProvider = createRagArtifactStore,
  timeoutMs,
  pollIntervalMs,
  now = Date.now
} = {}) {
  if (taskStore === undefined && typeof taskStoreProvider !== 'function') throw new TypeError('taskStoreProvider must be a function')
  if (artifactStore !== undefined && (!artifactStore || typeof artifactStore.readCommitted !== 'function')) {
    throw new TypeError('artifactStore must expose readCommitted()')
  }
  if (artifactStore === undefined && typeof artifactStoreProvider !== 'function') throw new TypeError('artifactStoreProvider must be a function')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const waitLimit = duration(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const pollInterval = duration(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs')
  const processor = lookupPcWorkerProcessor(RAG_CONTENT_EXTRACT_TASK_TYPE, RAG_CONTENT_EXTRACT_PROCESSOR_VERSION)
  if (!processor) throw new TypeError('rag.content.extract processor is unavailable')
  let resolvedArtifactStore = artifactStore

  const getArtifactStore = () => {
    resolvedArtifactStore ??= artifactStoreProvider()
    if (!resolvedArtifactStore || typeof resolvedArtifactStore.readCommitted !== 'function') {
      fail('RAG_SOURCE_EXTRACTION_ARTIFACT_STORE_UNAVAILABLE', 'RAG extraction artifact storage is unavailable.')
    }
    return resolvedArtifactStore
  }

  return Object.freeze({
    async extract(input, { signal } = {}) {
      throwIfAborted(signal)
      let projected
      try { projected = processor.projectInput(input) } catch (error) {
        fail('RAG_SOURCE_EXTRACTION_INPUT_INVALID', 'RAG extraction input is invalid.', { cause: error })
      }
      const store = taskStore ?? await Promise.resolve(taskStoreProvider())
      if (!store || typeof store.getById !== 'function' ||
          (typeof store.enqueueExclusiveRun !== 'function' && typeof store.enqueue !== 'function')) {
        fail('RAG_SOURCE_EXTRACTION_TASK_STORE_UNAVAILABLE', 'RAG extraction task storage is unavailable.')
      }
      const request = {
        taskType: RAG_CONTENT_EXTRACT_TASK_TYPE,
        processorVersion: RAG_CONTENT_EXTRACT_PROCESSOR_VERSION,
        executionClass: RAG_CONTENT_EXTRACT_EXECUTION_CLASS,
        subjectType: 'rag-source',
        subjectId: `${projected.sourceType}:${projected.sourceId}`,
        subjectVersionId: `${projected.sourceType}:${projected.sourceVersionId}`,
        subjectContentSha256: projected.sourceContentSha256,
        input: projected,
        priority: 50,
        maxAttempts: 3
      }
      let outcome
      try {
        outcome = typeof store.enqueueExclusiveRun === 'function'
          ? await Promise.resolve(store.enqueueExclusiveRun(request, { taskTypes: [RAG_CONTENT_EXTRACT_TASK_TYPE] }))
          : await Promise.resolve(store.enqueue(request))
      } catch (error) {
        fail('RAG_SOURCE_EXTRACTION_ENQUEUE_FAILED', 'RAG extraction task could not be enqueued.', { cause: error })
      }
      let queued = outcome?.task ?? outcome
      if (!queued || !Number.isSafeInteger(queued.id) || queued.id < 1) {
        fail('RAG_SOURCE_EXTRACTION_ENQUEUE_FAILED', 'RAG extraction task identity is invalid.')
      }
      if (['failed', 'cancelled'].includes(queued.status) && typeof store.retryTerminalTask === 'function') {
        let retry
        try { retry = await Promise.resolve(store.retryTerminalTask({ id: queued.id, maxRetries: 3 })) } catch (error) {
          fail('RAG_SOURCE_EXTRACTION_RETRY_FAILED', 'RAG extraction retry could not be enqueued.', { cause: error })
        }
        queued = retry?.task ?? retry
        if (!queued || !Number.isSafeInteger(queued.id) || queued.id < 1 ||
            (retry?.exhausted === true && ['failed', 'cancelled'].includes(queued.status))) {
          fail('RAG_SOURCE_EXTRACTION_RETRY_EXHAUSTED', 'RAG extraction retry budget is exhausted.')
        }
      }
      if (outcome?.activeConflict && !sameInput(queued.input, projected)) {
        fail('RAG_SOURCE_EXTRACTION_BUSY', 'A different extraction for this source is already active.')
      }
      const deadline = now() + waitLimit
      let current = queued
      while (!TERMINAL_STATUSES.has(current.status)) {
        throwIfAborted(signal)
        if (now() >= deadline) {
          fail('RAG_SOURCE_EXTRACTION_TIMEOUT', 'RAG extraction did not finish before its bounded deadline.')
        }
        await delay(Math.min(pollInterval, Math.max(1, deadline - now())), signal)
        current = await Promise.resolve(store.getById(queued.id))
        if (!current) fail('RAG_SOURCE_EXTRACTION_TASK_MISSING', 'RAG extraction task disappeared before completion.')
      }
      if (current.status !== 'succeeded') {
        fail('RAG_SOURCE_EXTRACTION_FAILED', 'RAG extraction task did not succeed.')
      }
      let result
      try { result = processor.normalizeResult(current.result, projected) } catch (error) {
        fail('RAG_SOURCE_EXTRACTION_RESULT_INVALID', 'RAG extraction result is invalid.', { cause: error })
      }
      let artifact
      try { artifact = await getArtifactStore().readCommitted(current.id) } catch (error) {
        fail('RAG_SOURCE_EXTRACTION_ARTIFACT_MISSING', 'RAG extraction artifact is unavailable.', { cause: error })
      }
      try {
        const artifactValue = normalizeRagContentArtifact(artifact, result.output)
        return Object.freeze({
          taskId: current.id,
          extractorVersion: result.output.extractorVersion,
          format: artifactValue.format,
          sections: artifactValue.sections
        })
      } catch (error) {
        fail('RAG_SOURCE_EXTRACTION_ARTIFACT_INVALID', 'RAG extraction artifact is invalid.', { cause: error })
      }
    }
  })
}

const defaultService = createRagContentExtractionService()

export function extractRagBinaryContent(input, options) {
  return defaultService.extract(input, options)
}

export default createRagContentExtractionService
