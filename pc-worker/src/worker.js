import { WorkerApiError } from './apiClient.js'
import { inspectContent } from './contentInspector.js'
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
  if (error instanceof WorkerApiError && error.status >= 400 && error.status < 500) {
    return { code: 'WORKER_REQUEST_REJECTED', summary: 'NAS rejected the active task request.', retryable: false }
  }
  return { code: 'WORKER_PROCESSING_FAILED', summary: 'Worker processing failed.', retryable: true }
}

export class PcWorker {
  constructor({ config, api, logger = console, profileProvider = collectProfile, stateReader = readState, stateWriter = writeState }) {
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
  }

  saveCredentials(data) {
    this.state = this.stateWriter(this.config.statePath, stateFromCredentialResponse(data))
    return this.state
  }

  async ensureStateInternal() {
    this.state ??= this.stateReader(this.config.statePath)
    if (!this.profile) this.profile = await this.profileProvider(this.config.displayName)
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
    this.profile = await this.profileProvider(this.config.displayName)
    await this.api.updateProfile(this.state.accessToken, this.profile)
    this.lastProfileAt = Date.now()
  }

  async execute(task) {
    let heartbeatTimer
    let heartbeatBusy = false
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

      await this.ensureState()
      const response = await this.api.input(this.state.accessToken, task)
      const headerHash = response.headers.get('x-content-sha256')
      const headerBytes = Number(response.headers.get('content-length'))
      if (headerHash !== task.input.sha256 || !Number.isSafeInteger(headerBytes) || headerBytes < 0) {
        throw Object.assign(new Error('Authorized input headers are inconsistent.'), { code: 'WORKER_INPUT_MISMATCH', retryable: false })
      }
      const result = await inspectContent(response.body, { sha256: task.input.sha256, bytes: headerBytes })
      await this.ensureState()
      await this.api.complete(this.state.accessToken, task, result)
      safeLog(this.logger, 'info', 'task_succeeded', { taskId: task.id, bytes: result.output.bytes })
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
  }
}
