import crypto from 'node:crypto'

import {
  lookupPcWorkerProcessor,
  rerankCandidateSetSha256
} from './pcWorkerProcessorCatalog.js'

export const RAG_RERANK_TASK_TYPE = 'rag.rerank'
export const RAG_RERANK_PROCESSOR_VERSION = 'v1'
export const RAG_RERANK_EXECUTION_CLASS = 'gpu'
// The query route remains responsive: a cold Reranker task is allowed to finish
// asynchronously and can be reused by a later identical query.
export const RAG_RERANK_WAIT_MS = 250
export const RAG_RERANK_POLL_MS = 25

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const PENDING = new Set(['pending', 'leased', 'running'])
const HASH_PATTERN = /^[a-f0-9]{64}$/u

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function boundedInteger(value, field, min, max, fallback) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    const error = new Error(`${field} is invalid.`)
    error.code = 'RAG_RERANK_CONFIG_INVALID'
    throw error
  }
  return normalized
}

function modelIdentity(value) {
  if (!isPlainObject(value)) return null
  const model = {
    provider: value.provider,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    dimensions: value.dimensions,
    inputLimit: value.inputLimit,
    configHash: value.configHash
  }
  if (typeof model.provider !== 'string' || !model.provider ||
      typeof model.modelId !== 'string' || !model.modelId ||
      typeof model.modelRevision !== 'string' || !model.modelRevision ||
      !Number.isSafeInteger(model.dimensions) || model.dimensions < 1 ||
      !Number.isSafeInteger(model.inputLimit) || model.inputLimit < 1 ||
      typeof model.configHash !== 'string' || !HASH_PATTERN.test(model.configHash)) return null
  return Object.freeze(model)
}

function normalizedQuery(value) {
  if (typeof value !== 'string') return null
  const query = value.normalize('NFKC').trim()
  if (!query || Buffer.byteLength(query, 'utf8') > 64 * 1024 || /[\u0000-\u001f\u007f]/u.test(query)) return null
  return query
}

function normalizeCandidates(value, maxCandidates) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCandidates) return null
  const seen = new Set()
  const candidates = []
  for (const candidate of value) {
    const candidateId = candidate?.citationId ?? candidate?.candidateId
    const text = candidate?.body ?? candidate?.text
    if (typeof candidateId !== 'string' || !candidateId || Buffer.byteLength(candidateId, 'utf8') > 128 ||
        typeof text !== 'string' || !text.trim() || seen.has(candidateId)) return null
    seen.add(candidateId)
    candidates.push(Object.freeze({
      candidateId,
      text: text.normalize('NFKC').trim(),
      ...(Number.isFinite(candidate?.score) ? { score: candidate.score } : {}),
      original: candidate
    }))
  }
  return Object.freeze(candidates)
}

function status(task) {
  return typeof task?.status === 'string' ? task.status : null
}

function taskId(task) {
  const value = task?.id ?? task?.taskId
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function unchanged(candidates, reason, task = null) {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    applied: false,
    degraded: true,
    reason,
    ...(task ? { task } : {})
  })
}

export class RagRerankService {
  constructor({
    taskStore = null,
    workerAvailable = async () => false,
    model = null,
    enabled = true,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitMs = RAG_RERANK_WAIT_MS,
    pollMs = RAG_RERANK_POLL_MS,
    maxCandidates = 10,
    maxAttempts = 1,
    terminalRetryBudget = 1
  } = {}) {
    if (typeof workerAvailable !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') {
      const error = new Error('Reranker dependencies are invalid.')
      error.code = 'RAG_RERANK_CONFIG_INVALID'
      throw error
    }
    this.taskStore = taskStore
    this.workerAvailable = workerAvailable
    this.model = modelIdentity(model)
    this.enabled = enabled === true
    this.now = now
    this.sleep = sleep
    this.waitMs = boundedInteger(waitMs, 'waitMs', 0, 60_000, RAG_RERANK_WAIT_MS)
    this.pollMs = boundedInteger(pollMs, 'pollMs', 1, 5_000, RAG_RERANK_POLL_MS)
    this.maxCandidates = boundedInteger(maxCandidates, 'maxCandidates', 1, 50, 10)
    this.maxAttempts = boundedInteger(maxAttempts, 'maxAttempts', 1, 10, 1)
    this.terminalRetryBudget = boundedInteger(terminalRetryBudget, 'terminalRetryBudget', 0, 3, 1)
  }

  async #wait(task) {
    let current = task
    if (!current || typeof current !== 'object') return null
    if (TERMINAL.has(status(current)) || (status(current) === null && current.result)) return current
    const id = taskId(current)
    if (id === null || typeof this.taskStore?.getById !== 'function') return null
    const deadline = this.now() + this.waitMs
    while (this.now() < deadline) {
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())))
      current = await Promise.resolve(this.taskStore.getById(id)).catch(() => null)
      if (!current) return null
      const currentStatus = status(current)
      if (TERMINAL.has(currentStatus) || currentStatus === null) return current
      if (!PENDING.has(currentStatus)) return null
    }
    return null
  }

  async rerank({ query, candidates } = {}) {
    const sourceCandidates = Array.isArray(candidates) ? candidates : []
    if (!this.enabled || !this.model) return unchanged(sourceCandidates, 'reranker_disabled')
    const normalized = normalizedQuery(query)
    const projectedCandidates = normalizeCandidates(candidates, this.maxCandidates)
    if (!normalized || !projectedCandidates) return unchanged(sourceCandidates, 'reranker_input_invalid')
    const processor = lookupPcWorkerProcessor(RAG_RERANK_TASK_TYPE, RAG_RERANK_PROCESSOR_VERSION)
    if (!processor) return unchanged(sourceCandidates, 'reranker_processor_unavailable')
    const available = await Promise.resolve(this.workerAvailable({
      taskType: RAG_RERANK_TASK_TYPE,
      processorVersion: RAG_RERANK_PROCESSOR_VERSION,
      model: this.model
    })).catch(() => false)
    if (available !== true && !(isPlainObject(available) && available.available === true)) {
      return unchanged(sourceCandidates, 'reranker_offline')
    }
    if (!this.taskStore || (typeof this.taskStore.enqueueExclusiveRun !== 'function' && typeof this.taskStore.enqueue !== 'function')) {
      return unchanged(sourceCandidates, 'reranker_task_store_unavailable')
    }
    const querySha256 = sha256(normalized)
    let input
    try {
      const candidateInput = projectedCandidates.map(({ candidateId, text, score }) => ({
        candidateId,
        text,
        ...(score === undefined ? {} : { score })
      }))
      input = processor.projectInput({
        schemaVersion: 1,
        querySha256,
        candidateSetSha256: rerankCandidateSetSha256(candidateInput),
        query: normalized,
        model: this.model,
        candidates: candidateInput
      })
    } catch {
      return unchanged(sourceCandidates, 'reranker_input_invalid')
    }
    const contentSha256 = input.candidateSetSha256
    const request = {
      taskType: RAG_RERANK_TASK_TYPE,
      processorVersion: RAG_RERANK_PROCESSOR_VERSION,
      subjectType: 'rag-rerank-query',
      subjectId: querySha256,
      subjectVersionId: this.model.configHash,
      subjectContentSha256: contentSha256,
      executionClass: RAG_RERANK_EXECUTION_CLASS,
      priority: 100,
      maxAttempts: this.maxAttempts,
      input
    }
    let task
    try {
      const outcome = typeof this.taskStore.enqueueExclusiveRun === 'function'
        ? await this.taskStore.enqueueExclusiveRun(request, { taskTypes: [RAG_RERANK_TASK_TYPE] })
        : await this.taskStore.enqueue(request)
      task = outcome?.task ?? outcome
      let completed = await this.#wait(task)
      const completedId = taskId(completed)
      if (completedId !== null && ['failed', 'cancelled'].includes(status(completed)) &&
          this.terminalRetryBudget > 0 && typeof this.taskStore.retryTerminalTask === 'function') {
        const retried = await this.taskStore.retryTerminalTask({ id: completedId, maxRetries: this.terminalRetryBudget })
        task = retried?.task ?? retried
        completed = await this.#wait(task)
      }
      if (!completed || status(completed) !== 'succeeded' || !completed.result) {
        return unchanged(sourceCandidates, completed ? 'reranker_failed' : 'reranker_timeout', task)
      }
      const result = processor.normalizeResult(completed.result, { input })?.output
      if (!result || result.querySha256 !== querySha256 || result.candidateSetSha256 !== input.candidateSetSha256 ||
          result.model?.configHash !== this.model.configHash || result.candidates.length !== projectedCandidates.length) {
        return unchanged(sourceCandidates, 'reranker_result_invalid', task)
      }
      const originals = new Map(projectedCandidates.map(({ candidateId, original }) => [candidateId, original]))
      const ranked = result.candidates.map(({ candidateId }) => originals.get(candidateId))
      if (ranked.some((candidate) => !candidate) || new Set(ranked).size !== projectedCandidates.length) {
        return unchanged(sourceCandidates, 'reranker_result_invalid', task)
      }
      return Object.freeze({
        candidates: Object.freeze(ranked),
        applied: true,
        degraded: false,
        reason: null,
        task
      })
    } catch {
      return unchanged(sourceCandidates, 'reranker_failed', task)
    }
  }
}

export function createRagRerankService(options) {
  return new RagRerankService(options)
}
