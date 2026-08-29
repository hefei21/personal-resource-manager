import { WorkerApiError } from './apiClient.js'
import { inspectContent } from './contentInspector.js'
import {
  createRagEmbeddingProcessor,
  embeddingProcessorsForConfig
} from './ragEmbeddingProcessor.js'
import {
  answerProcessorsForConfig,
  createRagAnswerProcessor
} from './ragAnswerProcessor.js'
import {
  createRagContentExtractProcessor,
  RAG_CONTENT_EXTRACT_PROCESSOR_CAPABILITY
} from './ragContentExtractProcessor.js'
import {
  createRagRerankProcessor,
  rerankProcessorsForConfig
} from './ragRerankProcessor.js'
import { readState, stateFromCredentialResponse, writeState } from './stateStore.js'
import { collectLoadedModels, collectProfile } from './telemetry.js'
import { createModelReadiness, modelKindForTaskType } from './modelReadiness.js'

const ACCESS_REFRESH_MARGIN_MS = 60_000
const PROFILE_REFRESH_MS = 5 * 60_000
const CONTENT_EXTRACT_FAILURE_CODES = new Set([
  'WORKER_INPUT_STREAM_INVALID',
  'WORKER_CONTENT_EXTRACT_INPUT_INVALID',
  'WORKER_CONTENT_EXTRACT_INPUT_TOO_LARGE',
  'WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID',
  'WORKER_CONTENT_EXTRACT_ARCHIVE_UNSAFE',
  'WORKER_CONTENT_EXTRACT_ARCHIVE_TOO_LARGE',
  'WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE',
  'WORKER_CONTENT_EXTRACT_EMPTY',
  'WORKER_CONTENT_EXTRACT_PDF_INVALID',
  'WORKER_ARTIFACT_UPLOAD_FAILED'
])
const EMBEDDING_CONTRACT_FAILURE_CODES = new Set([
  'WORKER_EMBEDDING_INPUT_INVALID',
  'WORKER_EMBEDDING_INPUT_TOO_LARGE',
  'WORKER_EMBEDDING_BATCH_INVALID',
  'WORKER_EMBEDDING_MODEL_MISMATCH',
  'WORKER_EMBEDDING_TASK_INVALID',
  'WORKER_EMBEDDING_RESULT_INVALID',
  'WORKER_EMBEDDING_NOT_CONFIGURED'
])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeLog(logger, level, event, details = {}) {
  logger[level]?.(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }))
}

function failureFor(error) {
  if (error?.code === 'WORKER_INPUT_MISMATCH') {
    return { code: 'WORKER_INPUT_MISMATCH', summary: 'Authorized content identity mismatch.', retryable: false }
  }
  if (CONTENT_EXTRACT_FAILURE_CODES.has(error?.code)) {
    return {
      code: error.code,
      summary: 'Worker content extraction failed.',
      retryable: error?.retryable === true
    }
  }
  if (EMBEDDING_CONTRACT_FAILURE_CODES.has(error?.code)) {
    return {
      code: error.code,
      summary: 'Worker embedding contract rejected the task.',
      retryable: false
    }
  }
  if (error?.code === 'WORKER_PROCESSOR_CANCELLED') {
    // A local stop aborts the in-flight request. The lease must be offered
    // again after the worker comes back rather than being lost permanently.
    return { code: 'WORKER_PROCESSOR_CANCELLED', summary: 'Worker processing was cancelled.', retryable: true }
  }
  if (error?.code === 'WORKER_MODEL_NOT_READY') {
    return { code: 'WORKER_MODEL_NOT_READY', summary: 'The configured local model is not ready.', retryable: true }
  }
  if (['WORKER_EMBEDDING_UNAVAILABLE', 'WORKER_EMBEDDING_HTTP_FAILED', 'WORKER_EMBEDDING_TIMEOUT',
    'WORKER_EMBEDDING_RESPONSE_INVALID', 'WORKER_ANSWER_UNAVAILABLE', 'WORKER_ANSWER_HTTP_FAILED',
    'WORKER_ANSWER_TIMEOUT', 'WORKER_ANSWER_RESPONSE_INVALID', 'WORKER_RERANK_UNAVAILABLE',
    'WORKER_RERANK_HTTP_FAILED', 'WORKER_RERANK_TIMEOUT'].includes(error?.code)) {
    return { code: 'WORKER_MODEL_UNAVAILABLE', summary: 'The configured local model became unavailable.', retryable: true }
  }
  if (['WORKER_PROCESSOR_UNSUPPORTED', 'WORKER_ANSWER_INPUT_INVALID',
    'WORKER_ANSWER_INPUT_TOO_LARGE', 'WORKER_ANSWER_MODEL_MISMATCH', 'WORKER_ANSWER_TASK_INVALID',
    'WORKER_ANSWER_RESULT_INVALID', 'WORKER_ANSWER_RESPONSE_INVALID', 'WORKER_ANSWER_NOT_CONFIGURED',
    'WORKER_ANSWER_BUDGET_INVALID', 'WORKER_RERANK_INPUT_INVALID', 'WORKER_RERANK_INPUT_TOO_LARGE',
    'WORKER_RERANK_MODEL_MISMATCH', 'WORKER_RERANK_TASK_INVALID', 'WORKER_RERANK_RESULT_INVALID',
    'WORKER_RERANK_NOT_CONFIGURED', 'WORKER_RERANK_RESPONSE_INVALID',
    'WORKER_RERANK_RESPONSE_INPUT_MISMATCH', 'WORKER_RERANK_RESPONSE_COUNT_INVALID'].includes(error?.code)) {
    return { code: 'WORKER_PROCESSOR_INPUT_INVALID', summary: 'Worker processor input was rejected.', retryable: false }
  }
  if (error instanceof WorkerApiError && error.status >= 400 && error.status < 500) {
    return { code: 'WORKER_REQUEST_REJECTED', summary: 'NAS rejected the active task request.', retryable: false }
  }
  return { code: 'WORKER_PROCESSING_FAILED', summary: 'Worker processing failed.', retryable: true }
}

export function classifyWorkerFailure(error) {
  return failureFor(error)
}

const MODEL_AVAILABILITY_ERRORS = Object.freeze({
  answer: new Set(['WORKER_ANSWER_UNAVAILABLE', 'WORKER_ANSWER_HTTP_FAILED', 'WORKER_ANSWER_TIMEOUT', 'WORKER_ANSWER_RESPONSE_INVALID']),
  embedding: new Set(['WORKER_EMBEDDING_UNAVAILABLE', 'WORKER_EMBEDDING_HTTP_FAILED', 'WORKER_EMBEDDING_TIMEOUT', 'WORKER_EMBEDDING_RESPONSE_INVALID']),
  reranker: new Set(['WORKER_RERANK_UNAVAILABLE', 'WORKER_RERANK_HTTP_FAILED', 'WORKER_RERANK_TIMEOUT',
    'WORKER_RERANK_RESPONSE_INVALID', 'WORKER_RERANK_RESPONSE_INPUT_MISMATCH',
    'WORKER_RERANK_RESPONSE_COUNT_INVALID'])
})

function isModelAvailabilityError(kind, error) {
  return Boolean(kind && MODEL_AVAILABILITY_ERRORS[kind]?.has(error?.code))
}

export class PcWorker {
  constructor({ config, api, logger = console, profileProvider = collectProfile, stateReader = readState, stateWriter = writeState,
    embeddingProcessorFactory = createRagEmbeddingProcessor, answerProcessorFactory = createRagAnswerProcessor,
    contentExtractProcessorFactory = createRagContentExtractProcessor, modelReadinessFactory = createModelReadiness,
    rerankProcessorFactory = createRagRerankProcessor, loadedModelsProvider = collectLoadedModels,
    rerankerManifestProvider = null, fetchImpl = fetch, sleepImpl = sleep }) {
    this.config = config
    this.api = api
    this.logger = logger
    this.profileProvider = profileProvider
    this.stateReader = stateReader
    this.stateWriter = stateWriter
    this.state = null
    this.profile = null
    this.lastProfileAt = 0
    this.profileDirty = true
    this.stopping = false
    this.statePromise = null
    this.modelReadiness = modelReadinessFactory({
      answer: config?.answer,
      embedding: config?.embedding,
      reranker: config?.reranker,
      fetchImpl,
      intervalMs: config?.modelReadinessIntervalMs,
      maxBackoffMs: config?.modelReadinessMaxBackoffMs,
      loadedModelsProvider,
      rerankerManifestProvider
    })
    this.embeddingProcessor = embeddingProcessorFactory({ config: config?.embedding, fetchImpl })
    this.answerProcessor = answerProcessorFactory({ config: config?.answer, fetchImpl })
    this.rerankProcessor = rerankProcessorFactory({ config: config?.reranker, fetchImpl })
    this.contentExtractProcessor = contentExtractProcessorFactory()
    this.activeController = null
    this.sleep = sleepImpl
  }

  profileWithConfiguredProcessors(profile) {
    const extra = [
      RAG_CONTENT_EXTRACT_PROCESSOR_CAPABILITY
    ]
    if (this.modelReadiness.isReady('embedding')) extra.push(...embeddingProcessorsForConfig(this.config?.embedding))
    if (this.modelReadiness.isReady('answer')) extra.push(...answerProcessorsForConfig(this.config?.answer))
    if (this.modelReadiness.isReady('reranker')) extra.push(...rerankProcessorsForConfig(this.config?.reranker))
    if (!profile?.capabilities || !Array.isArray(profile.capabilities.processors)) return profile
    const localTaskTypes = new Set(['rag.content.extract', 'rag.embedding.generate', 'rag.query.embed', 'rag.rerank', 'rag.answer.generate'])
    const existing = profile.capabilities.processors.filter((item) => !localTaskTypes.has(item?.taskType))
    if (extra.length === 0 && existing.length === profile.capabilities.processors.length) return profile
    const keys = new Set(existing.map((item) => `${item.taskType}:${item.processorVersion}:${item.executionClass}:${item.outputSchemaVersion}`))
    const processors = [...existing]
    for (const processor of extra) {
      const key = `${processor.taskType}:${processor.processorVersion}:${processor.executionClass}:${processor.outputSchemaVersion}`
      if (keys.has(key)) continue
      keys.add(key)
      processors.push(processor)
    }
    return {
      ...profile,
      capabilities: {
        ...profile.capabilities,
        processors
      }
    }
  }

  saveCredentials(data) {
    this.state = this.stateWriter(this.config.statePath, stateFromCredentialResponse(data))
    return this.state
  }

  async ensureStateInternal() {
    this.state ??= this.stateReader(this.config.statePath)
    if (!this.profile) {
      await this.modelReadiness.refresh({ force: true })
      this.profile = this.profileWithConfiguredProcessors(await this.profileProvider(this.config.displayName))
    }
    if (!this.state) {
      if (!this.config.enrollmentToken) {
        throw Object.assign(new Error('Worker is not paired; PC_WORKER_ENROLLMENT_TOKEN is required once.'), { code: 'WORKER_NOT_ENROLLED' })
      }
      const enrolled = await this.api.enroll(this.config.enrollmentToken, this.profile)
      this.saveCredentials(enrolled)
      this.lastProfileAt = Date.now()
      this.profileDirty = false
      safeLog(this.logger, 'info', 'worker_enrolled', { workerId: this.state.workerId })
    }
    if (Date.parse(this.state.accessExpiresAt) <= Date.now() + ACCESS_REFRESH_MARGIN_MS) {
      const refreshed = await this.api.refresh(this.state.refreshToken)
      this.saveCredentials(refreshed)
      safeLog(this.logger, 'info', 'worker_credentials_rotated', { workerId: this.state.workerId })
    }
    return this.state
  }

  async ensureState() {
    if (this.statePromise) return this.statePromise
    this.statePromise = this.ensureStateInternal()
    try { return await this.statePromise } finally { this.statePromise = null }
  }

  async refreshModelReadinessIfDue({ force = false } = {}) {
    const changed = await this.modelReadiness.refresh({ force })
    if (changed) this.profileDirty = true
    return changed
  }

  async refreshProfileIfDue() {
    if (!this.profileDirty && Date.now() - this.lastProfileAt < PROFILE_REFRESH_MS) return false
    this.profile = this.profileWithConfiguredProcessors(await this.profileProvider(this.config.displayName))
    await this.api.updateProfile(this.state.accessToken, this.profile)
    this.lastProfileAt = Date.now()
    this.profileDirty = false
    return true
  }

  async publishReadinessAfterFailure(kind, error) {
    if (!isModelAvailabilityError(kind, error)) return
    if (!this.modelReadiness.markUnavailable(kind, error.code)) return
    this.profileDirty = true
    try {
      await this.refreshProfileIfDue()
    } catch (profileError) {
      safeLog(this.logger, 'warn', 'model_readiness_profile_update_failed', {
        modelKind: kind,
        code: profileError.code || 'UNKNOWN'
      })
    }
  }

  async rejectNotReadyTask(task, kind) {
    const error = Object.assign(new Error('Configured local model is not ready.'), { code: 'WORKER_MODEL_NOT_READY', retryable: true })
    try {
      await this.api.fail(this.state.accessToken, task, 'WORKER_MODEL_NOT_READY', 'The configured local model is not ready.', true)
    } catch (reportError) {
      safeLog(this.logger, 'warn', 'task_failure_report_deferred', { taskId: task.id, code: reportError.code || 'UNKNOWN' })
    }
    safeLog(this.logger, 'warn', 'model_task_skipped_not_ready', { taskId: task.id, modelKind: kind })
    return error
  }

  async execute(task) {
    let heartbeatTimer
    let heartbeatBusy = false
    const controller = new AbortController()
    this.activeController = controller
    try {
      const modelKind = modelKindForTaskType(task.taskType)
      if (modelKind) {
        const readinessChanged = await this.refreshModelReadinessIfDue({ force: true })
        if (readinessChanged) await this.refreshProfileIfDue()
      }
      if (modelKind && !this.modelReadiness.isReady(modelKind)) {
        throw Object.assign(new Error('Configured local model is not ready.'), {
          code: 'WORKER_MODEL_NOT_READY', retryable: true
        })
      }
      await this.api.start(this.state.accessToken, task)
      heartbeatTimer = setInterval(() => {
        if (heartbeatBusy) return
        heartbeatBusy = true
        void this.ensureState().then(() => this.api.heartbeat(this.state.accessToken, task)).catch((error) => {
          safeLog(this.logger, 'warn', 'task_heartbeat_failed', { taskId: task.id, code: error.code || 'UNKNOWN' })
        }).finally(() => { heartbeatBusy = false })
      }, this.config.heartbeatIntervalMs)
      heartbeatTimer.unref?.()

      let result
      if (task.taskType === 'content.inspect' || this.contentExtractProcessor.supports(task.taskType)) {
        await this.ensureState()
        const response = await this.api.input(this.state.accessToken, task)
        const headerHash = response.headers.get('x-content-sha256')
        const headerBytes = Number(response.headers.get('content-length'))
        const expectedHash = task.taskType === 'content.inspect' ? task.input.sha256 : task.input.sourceContentSha256
        const expectedBytes = task.taskType === 'content.inspect' ? headerBytes : task.input.contentBytes
        if (headerHash !== expectedHash || headerBytes !== expectedBytes || !Number.isSafeInteger(headerBytes) || headerBytes < 0) {
          throw Object.assign(new Error('Authorized input headers are inconsistent.'), { code: 'WORKER_INPUT_MISMATCH', retryable: false })
        }
        result = task.taskType === 'content.inspect'
          ? await inspectContent(response.body, { sha256: task.input.sha256, bytes: headerBytes })
          : await this.contentExtractProcessor.process(task, response.body, { signal: controller.signal })
      } else if (this.embeddingProcessor.supports(task.taskType)) {
        result = await this.embeddingProcessor.process(task, { signal: controller.signal })
      } else if (this.rerankProcessor.supports(task.taskType)) {
        result = await this.rerankProcessor.process(task, { signal: controller.signal })
      } else if (this.answerProcessor.supports(task.taskType)) {
        result = await this.answerProcessor.process(task, { signal: controller.signal })
      } else {
        throw Object.assign(new Error('Worker processor is not configured.'), { code: 'WORKER_PROCESSOR_UNSUPPORTED', retryable: false })
      }
      await this.ensureState()
      if (this.contentExtractProcessor.supports(task.taskType)) {
        const artifact = result?.artifact
        const metadata = result?.output
        if (!artifact || !metadata) {
          throw Object.assign(new Error('Worker extractor did not produce a staged artifact.'), {
            code: 'WORKER_ARTIFACT_UPLOAD_FAILED', retryable: false
          })
        }
        await this.api.uploadArtifact(this.state.accessToken, task, { artifact, metadata })
        result = { ...result }
        delete result.artifact
      }
      await this.api.complete(this.state.accessToken, task, result)
      safeLog(this.logger, 'info', 'task_succeeded', {
        taskId: task.id,
        ...(Number.isSafeInteger(result?.output?.bytes) ? { bytes: result.output.bytes } : {}),
        ...(Array.isArray(result?.output?.vectors) ? { vectorCount: result.output.vectors.length } : {}),
        ...(Array.isArray(result?.output?.embedding) ? { dimensions: result.output.embedding.length } : {}),
        ...(Array.isArray(result?.output?.citations) ? { citationCount: result.output.citations.length } : {}),
        ...(typeof result?.output?.abstained === 'boolean' ? { abstained: result.output.abstained } : {})
      })
    } catch (error) {
      await this.publishReadinessAfterFailure(modelKindForTaskType(task.taskType), error)
      const failure = failureFor(error)
      safeLog(this.logger, 'warn', 'task_failed', {
        taskId: task.id,
        taskType: task.taskType,
        code: error?.code || 'UNKNOWN',
        reportedCode: failure.code,
        retryable: failure.retryable
      })
      try {
        await this.api.fail(this.state.accessToken, task, failure.code, failure.summary, failure.retryable)
      } catch (reportError) {
        safeLog(this.logger, 'warn', 'task_failure_report_deferred', { taskId: task.id, code: reportError.code || 'UNKNOWN' })
      }
      throw error
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (this.activeController === controller) this.activeController = null
    }
  }

  async runOnce() {
    await this.ensureState()
    await this.refreshModelReadinessIfDue()
    await this.refreshProfileIfDue()
    // The readiness/profile pair is published before claiming, so a model eject
    // cannot leave the server advertising a capability after this point.
    await this.refreshModelReadinessIfDue()
    await this.refreshProfileIfDue()
    const task = await this.api.claim(this.state.accessToken)
    if (!task) return false
    const modelKind = modelKindForTaskType(task.taskType)
    if (modelKind && !this.modelReadiness.isReady(modelKind)) {
      await this.rejectNotReadyTask(task, modelKind)
      return true
    }
    await this.execute(task)
    return true
  }

  async run() {
    safeLog(this.logger, 'info', 'worker_started')
    let followUpPollsRemaining = 0
    while (!this.stopping) {
      try {
        const worked = await this.runOnce()
        if (worked) {
          // A completed query-embedding task is commonly followed immediately
          // by rerank and answer tasks. Keep a short bounded burst so those
          // chained tasks meet the route budget without increasing idle load.
          followUpPollsRemaining = this.config.followUpPollAttempts ?? 8
        } else if (followUpPollsRemaining > 0) {
          followUpPollsRemaining -= 1
          await this.sleep(this.config.followUpPollIntervalMs ?? 25)
        } else {
          await this.sleep(this.config.pollIntervalMs)
        }
      } catch (error) {
        safeLog(this.logger, 'warn', 'worker_iteration_failed', { code: error.code || 'UNKNOWN' })
        followUpPollsRemaining = 0
        await this.sleep(this.config.pollIntervalMs)
      }
    }
    safeLog(this.logger, 'info', 'worker_stopped')
  }

  stop() {
    this.stopping = true
    this.activeController?.abort()
  }
}
