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
import { readState, stateFromCredentialResponse, writeState } from './stateStore.js'
import { collectProfile } from './telemetry.js'

const ACCESS_REFRESH_MARGIN_MS = 60_000
const PROFILE_REFRESH_MS = 5 * 60_000

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
  if (error?.code === 'WORKER_PROCESSOR_CANCELLED') {
    return { code: 'WORKER_PROCESSOR_CANCELLED', summary: 'Worker processing was cancelled.', retryable: false }
  }
  if (['WORKER_PROCESSOR_UNSUPPORTED', 'WORKER_EMBEDDING_INPUT_INVALID', 'WORKER_EMBEDDING_INPUT_TOO_LARGE', 'WORKER_EMBEDDING_BATCH_INVALID',
    'WORKER_EMBEDDING_MODEL_MISMATCH', 'WORKER_EMBEDDING_TASK_INVALID', 'WORKER_EMBEDDING_RESPONSE_INVALID',
    'WORKER_EMBEDDING_RESULT_INVALID', 'WORKER_EMBEDDING_NOT_CONFIGURED', 'WORKER_ANSWER_INPUT_INVALID',
    'WORKER_ANSWER_INPUT_TOO_LARGE', 'WORKER_ANSWER_MODEL_MISMATCH', 'WORKER_ANSWER_TASK_INVALID',
    'WORKER_ANSWER_RESULT_INVALID', 'WORKER_ANSWER_RESPONSE_INVALID', 'WORKER_ANSWER_NOT_CONFIGURED',
    'WORKER_ANSWER_BUDGET_INVALID'].includes(error?.code)) {
    return { code: 'WORKER_PROCESSOR_INPUT_INVALID', summary: 'Worker processor input was rejected.', retryable: false }
  }
  if (error instanceof WorkerApiError && error.status >= 400 && error.status < 500) {
    return { code: 'WORKER_REQUEST_REJECTED', summary: 'NAS rejected the active task request.', retryable: false }
  }
  return { code: 'WORKER_PROCESSING_FAILED', summary: 'Worker processing failed.', retryable: true }
}

export class PcWorker {
  constructor({ config, api, logger = console, profileProvider = collectProfile, stateReader = readState, stateWriter = writeState,
    embeddingProcessorFactory = createRagEmbeddingProcessor, answerProcessorFactory = createRagAnswerProcessor, fetchImpl = fetch }) {
    this.config = config
    this.api = api
    this.logger = logger
    this.profileProvider = profileProvider
    this.stateReader = stateReader
    this.stateWriter = stateWriter
    this.state = null
    this.profile = null
    this.lastProfileAt = 0
    this.stopping = false
    this.statePromise = null
    this.embeddingProcessor = embeddingProcessorFactory({ config: config?.embedding, fetchImpl })
    this.answerProcessor = answerProcessorFactory({ config: config?.answer, fetchImpl })
    this.activeController = null
  }

  profileWithConfiguredProcessors(profile) {
    const extra = [
      ...embeddingProcessorsForConfig(this.config?.embedding),
      ...answerProcessorsForConfig(this.config?.answer)
    ]
    if (!profile?.capabilities || !Array.isArray(profile.capabilities.processors)) return profile
    const localTaskTypes = new Set(['rag.embedding.generate', 'rag.query.embed', 'rag.answer.generate'])
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
    if (!this.profile) this.profile = this.profileWithConfiguredProcessors(await this.profileProvider(this.config.displayName))
    if (!this.state) {
      if (!this.config.enrollmentToken) {
        throw Object.assign(new Error('Worker is not paired; PC_WORKER_ENROLLMENT_TOKEN is required once.'), { code: 'WORKER_NOT_ENROLLED' })
      }
      const enrolled = await this.api.enroll(this.config.enrollmentToken, this.profile)
      this.saveCredentials(enrolled)
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

  async refreshProfileIfDue() {
    if (Date.now() - this.lastProfileAt < PROFILE_REFRESH_MS) return
    this.profile = this.profileWithConfiguredProcessors(await this.profileProvider(this.config.displayName))
    await this.api.updateProfile(this.state.accessToken, this.profile)
    this.lastProfileAt = Date.now()
  }

  async execute(task) {
    let heartbeatTimer
    let heartbeatBusy = false
    const controller = new AbortController()
    this.activeController = controller
    try {
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
      if (task.taskType === 'content.inspect') {
        await this.ensureState()
        const response = await this.api.input(this.state.accessToken, task)
        const headerHash = response.headers.get('x-content-sha256')
        const headerBytes = Number(response.headers.get('content-length'))
        if (headerHash !== task.input.sha256 || !Number.isSafeInteger(headerBytes) || headerBytes < 0) {
          throw Object.assign(new Error('Authorized input headers are inconsistent.'), { code: 'WORKER_INPUT_MISMATCH', retryable: false })
        }
        result = await inspectContent(response.body, { sha256: task.input.sha256, bytes: headerBytes })
      } else if (this.embeddingProcessor.supports(task.taskType)) {
        result = await this.embeddingProcessor.process(task, { signal: controller.signal })
      } else if (this.answerProcessor.supports(task.taskType)) {
        result = await this.answerProcessor.process(task, { signal: controller.signal })
      } else {
        throw Object.assign(new Error('Worker processor is not configured.'), { code: 'WORKER_PROCESSOR_UNSUPPORTED', retryable: false })
      }
      await this.ensureState()
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
      const failure = failureFor(error)
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
    await this.refreshProfileIfDue()
    const task = await this.api.claim(this.state.accessToken)
    if (!task) return false
    await this.execute(task)
    return true
  }

  async run() {
    safeLog(this.logger, 'info', 'worker_started')
    while (!this.stopping) {
      try {
        const worked = await this.runOnce()
        if (!worked) await sleep(this.config.pollIntervalMs)
      } catch (error) {
        safeLog(this.logger, 'warn', 'worker_iteration_failed', { code: error.code || 'UNKNOWN' })
        await sleep(this.config.pollIntervalMs)
      }
    }
    safeLog(this.logger, 'info', 'worker_stopped')
  }

  stop() {
    this.stopping = true
    this.activeController?.abort()
  }
}
