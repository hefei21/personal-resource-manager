import {
  normalizeProcessorIdentity,
  TaskProcessorRegistryError
} from './taskProcessorRegistry.js'

const NAS_EXECUTION_CLASSES = Object.freeze(['cpu', 'disk', 'network'])
const ALL_EXECUTION_CLASSES = Object.freeze(['cpu', 'disk', 'network', 'gpu'])
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000
const DEFAULT_LEASE_DURATION_MS = 60_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_QUOTA = 1
const MAX_ERROR_SUMMARY_LENGTH = 256

export const NAS_TASK_EXECUTOR_ERROR_CODES = Object.freeze({
  PROCESSOR_FAILED: 'TASK_PROCESSOR_FAILED',
  HEARTBEAT_FAILED: 'TASK_HEARTBEAT_FAILED'
})

export class NasTaskExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'NasTaskExecutorError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details = {}) {
  throw new NasTaskExecutorError(code, message, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertOptionsObject(value, fieldName) {
  if (!isPlainObject(value)) fail('NAS_EXECUTOR_INPUT_INVALID', `${fieldName} must be an object.`)
}

function normalizeInteger(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('NAS_EXECUTOR_INPUT_INVALID', `${fieldName} must be an integer in the supported range.`)
  }
  return value
}

function normalizeDuration(value, fieldName, { allowZero = false } = {}) {
  return normalizeInteger(value, fieldName, { min: allowZero ? 0 : 1, max: MAX_DURATION_MS })
}

function normalizeOwner(value) {
  if (typeof value !== 'string') fail('NAS_EXECUTOR_OWNER_INVALID', 'Executor owner is invalid.')
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || !TOKEN_PATTERN.test(normalized)) {
    fail('NAS_EXECUTOR_OWNER_INVALID', 'Executor owner is invalid.')
  }
  return normalized
}

function resolveAlias(source, names, fieldName, normalize, defaultValue) {
  const values = names
    .filter((name) => Object.hasOwn(source, name) && source[name] !== undefined)
    .map((name) => normalize(source[name], fieldName))
  if (values.length === 0) return defaultValue
  if (values.some((value) => value !== values[0])) {
    fail('NAS_EXECUTOR_INPUT_INVALID', `${fieldName} aliases must match.`)
  }
  return values[0]
}

function normalizeQuotas(source) {
  const quotaOptions = ['quotas', 'quota', 'concurrency', 'maxConcurrency']
    .filter((name) => Object.hasOwn(source, name) && source[name] !== undefined)
  if (quotaOptions.length > 1) {
    const values = quotaOptions.map((name) => source[name])
    if (values.some((value) => value !== values[0])) {
      fail('NAS_EXECUTOR_QUOTA_INVALID', 'Quota aliases must match.')
    }
  }
  const candidate = quotaOptions.length === 0 ? {} : source[quotaOptions[0]]
  assertOptionsObject(candidate, 'quotas')
  if (Object.keys(candidate).some((key) => !ALL_EXECUTION_CLASSES.includes(key))) {
    fail('NAS_EXECUTOR_QUOTA_INVALID', 'Quotas contain an unsupported execution class.')
  }
  const quotas = {}
  for (const executionClass of NAS_EXECUTION_CLASSES) {
    quotas[executionClass] = normalizeInteger(
      candidate[executionClass] === undefined ? DEFAULT_QUOTA : candidate[executionClass],
      `quotas.${executionClass}`
    )
  }
  const gpuQuota = candidate.gpu === undefined ? 0 : candidate.gpu
  if (gpuQuota !== 0) fail('NAS_EXECUTOR_QUOTA_INVALID', 'GPU quota is fixed at zero for the NAS executor.')
  quotas.gpu = 0
  return Object.freeze(quotas)
}

function normalizeClock(source) {
  if (source === undefined) return () => new Date()
  if (typeof source === 'function') return source
  if (source && typeof source.now === 'function') return () => source.now.call(source)
  fail('NAS_EXECUTOR_CLOCK_INVALID', 'Executor clock must be a function or clock object.')
}

function toDate(value) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === 'number'
      ? new Date(value)
      : typeof value === 'string'
        ? new Date(value)
        : null
  if (!date || Number.isNaN(date.getTime())) {
    fail('NAS_EXECUTOR_CLOCK_INVALID', 'Executor clock returned an invalid time.')
  }
  return date
}

function safeErrorSummary(error) {
  const message = error && typeof error.message === 'string'
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  const firstLine = message.split(/[\r\n]/u, 1)[0].trim()
  if (!firstLine) return 'Processor execution failed.'
  const withoutWindowsPath = firstLine.replace(/[A-Za-z]:[\\/][^<>:"|?*\r\n]*/gu, '<path>')
  const withoutPosixPath = withoutWindowsPath.replace(
    /(^|[\s("'=,:;])\/(?:[^\s/"'=,:;]+\/)*[^\s/"'=,:;]*/gu,
    '$1<path>'
  )
  const withoutRelativePath = withoutPosixPath.replace(/(?:\.\.[\\/])+[^\s]*/gu, '<path>')
  const summary = withoutRelativePath.replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_SUMMARY_LENGTH)
  if (/[\\/]/u.test(summary)) return 'Processor execution failed.'
  return summary || 'Processor execution failed.'
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function identityKey(identity) {
  return `${identity.taskType}\u001f${identity.processorVersion}\u001f${identity.executionClass}`
}

function snapshotSupportedIdentities(registry) {
  let source
  if (registry && typeof registry.getSupportedProcessorIdentities === 'function') {
    source = registry.getSupportedProcessorIdentities()
  } else if (registry && typeof registry.getProcessorIdentities === 'function') {
    source = registry.getProcessorIdentities()
  } else if (registry && typeof registry.list === 'function') {
    source = registry.list()
  } else {
    fail('NAS_EXECUTOR_REGISTRY_INVALID', 'Processor registry is invalid.')
  }
  if (!Array.isArray(source)) fail('NAS_EXECUTOR_REGISTRY_INVALID', 'Processor registry identities are invalid.')
  const seen = new Set()
  const identities = []
  for (const value of source) {
    let identity
    try {
      const identityInput = value && typeof value === 'object' &&
        Object.hasOwn(value, 'handler') && typeof value.handler === 'function'
        ? {
            taskType: value.taskType,
            processorVersion: value.processorVersion,
            executionClass: value.executionClass
          }
        : value
      identity = normalizeProcessorIdentity(identityInput)
    } catch (error) {
      if (error instanceof TaskProcessorRegistryError) throw error
      throw error
    }
    const key = identityKey(identity)
    if (!seen.has(key)) {
      seen.add(key)
      identities.push(identity)
    }
  }
  return Object.freeze(identities)
}

function resolveHandler(registry, task) {
  const identity = {
    taskType: task.taskType,
    processorVersion: task.processorVersion,
    executionClass: task.executionClass
  }
  const entry = typeof registry.resolve === 'function'
    ? registry.resolve(identity)
    : typeof registry.resolveProcessor === 'function'
      ? registry.resolveProcessor(identity)
      : typeof registry.get === 'function'
        ? registry.get(identity)
        : null
  if (typeof entry === 'function') return entry
  return entry && typeof entry.handler === 'function' ? entry.handler : null
}

function emptyRoundSummary(activeCount) {
  return Object.freeze({
    claimed: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    active: activeCount
  })
}

export class NasTaskExecutor {
  constructor(options = {}) {
    assertOptionsObject(options, 'executor options')
    const allowed = new Set([
      'store', 'taskStore', 'registry', 'processorRegistry', 'owner', 'workerId', 'leaseDurationMs', 'leaseDuration',
      'heartbeatIntervalMs', 'heartbeatInterval', 'pollIntervalMs', 'pollInterval',
      'drainTimeoutMs', 'drainTimeout', 'retryDelayMs', 'retryDelay', 'quotas', 'quota',
      'concurrency', 'maxConcurrency', 'clock', 'now', 'timers', 'timer', 'setTimeout',
      'clearTimeout', 'cpuQuota', 'diskQuota', 'networkQuota', 'gpuQuota'
    ])
    if (Object.keys(options).some((key) => !allowed.has(key))) {
      fail('NAS_EXECUTOR_INPUT_INVALID', 'Executor options contain unsupported fields.')
    }
    this.store = options.store ?? options.taskStore
    if (!this.store || typeof this.store.leaseNext !== 'function' ||
      typeof this.store.markRunning !== 'function' || typeof this.store.heartbeat !== 'function' ||
      typeof this.store.succeed !== 'function' || typeof this.store.fail !== 'function') {
      fail('NAS_EXECUTOR_STORE_INVALID', 'Task store does not implement the executor contract.')
    }
    this.registry = options.registry ?? options.processorRegistry
    if (!this.registry) fail('NAS_EXECUTOR_REGISTRY_INVALID', 'Processor registry is required.')
    this.owner = resolveAlias(options, ['owner', 'workerId'], 'owner', normalizeOwner)
    if (!this.owner) fail('NAS_EXECUTOR_OWNER_INVALID', 'Executor owner is required.')

    this.leaseDurationMs = resolveAlias(
      options,
      ['leaseDurationMs', 'leaseDuration'],
      'leaseDurationMs',
      (value, fieldName) => normalizeDuration(value, fieldName),
      DEFAULT_LEASE_DURATION_MS
    )
    this.heartbeatIntervalMs = resolveAlias(
      options,
      ['heartbeatIntervalMs', 'heartbeatInterval'],
      'heartbeatIntervalMs',
      (value, fieldName) => normalizeDuration(value, fieldName),
      DEFAULT_HEARTBEAT_INTERVAL_MS
    )
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      fail('NAS_EXECUTOR_HEARTBEAT_INTERVAL_INVALID', 'Heartbeat interval must be shorter than lease duration.')
    }
    this.pollIntervalMs = resolveAlias(
      options,
      ['pollIntervalMs', 'pollInterval'],
      'pollIntervalMs',
      (value, fieldName) => normalizeDuration(value, fieldName),
      DEFAULT_POLL_INTERVAL_MS
    )
    this.drainTimeoutMs = resolveAlias(
      options,
      ['drainTimeoutMs', 'drainTimeout'],
      'drainTimeoutMs',
      (value, fieldName) => normalizeDuration(value, fieldName, { allowZero: true }),
      DEFAULT_DRAIN_TIMEOUT_MS
    )
    this.retryDelayMs = resolveAlias(
      options,
      ['retryDelayMs', 'retryDelay'],
      'retryDelayMs',
      (value, fieldName) => normalizeDuration(value, fieldName, { allowZero: true }),
      DEFAULT_RETRY_DELAY_MS
    )

    const quotaSource = options.quotas ?? options.quota ?? options.concurrency ?? options.maxConcurrency
    const directQuotaNames = ['cpuQuota', 'diskQuota', 'networkQuota', 'gpuQuota']
      .filter((name) => Object.hasOwn(options, name) && options[name] !== undefined)
    if (quotaSource !== undefined && directQuotaNames.length > 0) {
      fail('NAS_EXECUTOR_QUOTA_INVALID', 'Quota aliases must not be combined.')
    }
    if (directQuotaNames.length > 0) {
      const direct = {}
      for (const name of directQuotaNames) direct[name.slice(0, -5)] = options[name]
      this.quotas = normalizeQuotas({ quotas: direct })
    } else {
      this.quotas = normalizeQuotas(options)
    }

    const timerSource = options.timers ?? options.timer ?? {}
    if (!timerSource || typeof timerSource !== 'object' || Array.isArray(timerSource)) {
      fail('NAS_EXECUTOR_TIMER_INVALID', 'Executor timers are invalid.')
    }
    const setTimeoutFunction = options.setTimeout ?? timerSource.setTimeout ?? globalThis.setTimeout
    const clearTimeoutFunction = options.clearTimeout ?? timerSource.clearTimeout ?? globalThis.clearTimeout
    if (typeof setTimeoutFunction !== 'function' || typeof clearTimeoutFunction !== 'function') {
      fail('NAS_EXECUTOR_TIMER_INVALID', 'Executor timers are invalid.')
    }
    this._setTimeout = (callback, delay) => setTimeoutFunction.call(timerSource, callback, delay)
    this._clearTimeout = (handle) => clearTimeoutFunction.call(timerSource, handle)
    this._clock = normalizeClock(options.clock ?? options.now)
    this.supportedProcessorIdentities = Object.freeze(
      snapshotSupportedIdentities(this.registry).filter(({ executionClass }) => executionClass !== 'gpu')
    )
    this._state = 'idle'
    this._pollTimer = null
    this._drainTimer = null
    this._stopPromise = null
    this._stopResolve = null
    this._runOncePromise = null
    this._dispatching = false
    this._timedOut = false
    this._active = new Map()
    this._activeCounts = Object.fromEntries(ALL_EXECUTION_CLASSES.map((executionClass) => [executionClass, 0]))
  }

  get state() {
    return this._state
  }

  get activeCount() {
    return this._active.size
  }

  get activeQuotas() {
    return Object.freeze({ ...this._activeCounts })
  }

  start() {
    if (this._state === 'running') return this
    if (this._state !== 'idle') fail('NAS_EXECUTOR_STATE_INVALID', 'Executor cannot be started in its current state.')
    this._state = 'running'
    this._schedulePoll(0)
    return this
  }

  poll() {
    return this.runOnce()
  }

  runOnce() {
    if (this._state === 'stopping' || this._state === 'stopped') {
      return Promise.resolve(emptyRoundSummary(this.activeCount))
    }
    if (this._runOncePromise) return this._runOncePromise
    this._runOncePromise = this._dispatchRound({ waitForExecutions: true })
      .finally(() => {
        this._runOncePromise = null
      })
    return this._runOncePromise
  }

  stop(options = {}) {
    if (this._stopPromise) return this._stopPromise
    if (this._state === 'stopped') return Promise.resolve(this._stopReport())
    const timeoutMs = this._normalizeStopTimeout(options)
    this._state = 'stopping'
    this._clearPollTimer()
    this._stopPromise = new Promise((resolve) => {
      this._stopResolve = resolve
      this._drainTimer = this._setTimeout(() => this._timeoutDrain(), timeoutMs)
      this._maybeFinishDrain()
    })
    return this._stopPromise
  }

  drain(options = {}) {
    return this.stop(options)
  }

  _normalizeStopTimeout(options) {
    if (typeof options === 'number') return normalizeDuration(options, 'stop timeout', { allowZero: true })
    if (options === undefined) return this.drainTimeoutMs
    assertOptionsObject(options, 'stop options')
    if (Object.keys(options).some((key) => !['timeoutMs', 'deadlineMs', 'drainTimeoutMs', 'drainTimeout'].includes(key))) {
      fail('NAS_EXECUTOR_INPUT_INVALID', 'Stop options contain unsupported fields.')
    }
    return resolveAlias(
      options,
      ['timeoutMs', 'deadlineMs', 'drainTimeoutMs', 'drainTimeout'],
      'stop timeout',
      (value, fieldName) => normalizeDuration(value, fieldName, { allowZero: true }),
      this.drainTimeoutMs
    )
  }

  _schedulePoll(delay) {
    if (this._state !== 'running') return
    this._clearPollTimer()
    this._pollTimer = this._setTimeout(() => {
      this._pollTimer = null
      void this._poll()
    }, delay)
  }

  async _poll() {
    if (this._state !== 'running') return
    try {
      await this._dispatchRound({ waitForExecutions: false, suppressStoreErrors: true })
    } catch {
      // The background loop stays available after a transient store/processor-registry failure.
    } finally {
      if (this._state === 'running') this._schedulePoll(this.pollIntervalMs)
    }
  }

  _clearPollTimer() {
    if (this._pollTimer !== null) {
      this._clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }

  async _dispatchRound({ waitForExecutions, suppressStoreErrors = false }) {
    if (this._dispatching) return emptyRoundSummary(this.activeCount)
    this._dispatching = true
    const summary = {
      claimed: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      active: this.activeCount
    }
    const executions = []
    try {
      for (const executionClass of NAS_EXECUTION_CLASSES) {
        const quota = this.quotas[executionClass]
        const availableSlots = Math.max(0, quota - this._activeCounts[executionClass])
        for (let slot = 0; slot < availableSlots; slot += 1) {
          if (this._state === 'stopping' || this._state === 'stopped') break
          let task
          try {
            task = await this.store.leaseNext({
              owner: this.owner,
              leaseDurationMs: this.leaseDurationMs,
              executionClass,
              supportedProcessors: this.supportedProcessorIdentities
            })
          } catch (error) {
            if (!suppressStoreErrors) throw error
            summary.skipped += 1
            break
          }
          if (!task) break
          summary.claimed += 1
          const handler = resolveHandler(this.registry, task)
          if (!handler || task.executionClass !== executionClass) {
            summary.skipped += 1
            break
          }
          let runningTask
          try {
            runningTask = await this.store.markRunning({
              id: task.id,
              owner: this.owner,
              token: task.leaseToken
            })
          } catch (error) {
            if (!suppressStoreErrors) throw error
            summary.skipped += 1
            continue
          }
          const record = this._createRecord(runningTask ?? task, executionClass, handler)
          summary.started += 1
          executions.push(record)
        }
      }
    } finally {
      this._dispatching = false
      this._maybeFinishDrain()
    }
    if (waitForExecutions && executions.length > 0) {
      await Promise.allSettled(executions.map(({ promise }) => promise))
    }
    summary.succeeded = executions.filter(({ outcome }) => outcome === 'succeeded').length
    summary.failed = executions.filter(({ outcome }) => outcome === 'failed').length
    summary.active = this.activeCount
    return Object.freeze(summary)
  }

  _createRecord(task, executionClass, handler) {
    const controller = new AbortController()
    const record = {
      task: deepFreeze(task),
      executionClass,
      handler,
      controller,
      heartbeatTimer: null,
      heartbeatStopped: false,
      heartbeatFailed: false,
      allowTerminalWrite: true,
      settled: false,
      outcome: 'running',
      promise: null
    }
    this._active.set(task.id, record)
    this._activeCounts[executionClass] += 1
    try {
      this._startHeartbeat(record)
      record.promise = this._executeRecord(record)
    } catch (error) {
      record.settled = true
      this._active.delete(task.id)
      this._activeCounts[executionClass] = Math.max(0, this._activeCounts[executionClass] - 1)
      throw error
    }
    return record
  }

  _contextFor(record) {
    return Object.freeze({
      task: record.task,
      signal: record.controller.signal,
      heartbeat: () => this._controlledHeartbeat(record)
    })
  }

  async _executeRecord(record) {
    try {
      let result
      try {
        result = await record.handler(this._contextFor(record))
      } catch (error) {
        if (record.allowTerminalWrite && !record.heartbeatFailed) {
          await this._failRecord(record, error)
          record.outcome = 'failed'
        } else {
          record.outcome = 'abandoned'
        }
        return
      }
      if (!record.allowTerminalWrite || record.heartbeatFailed) {
        record.outcome = 'abandoned'
        return
      }
      try {
        await this.store.succeed({
          id: record.task.id,
          owner: this.owner,
          token: record.task.leaseToken,
          result: result === undefined ? null : result
        })
        record.outcome = 'succeeded'
      } catch {
        record.outcome = 'abandoned'
        return
      }
    } finally {
      this._settleRecord(record)
    }
  }

  async _failRecord(record, error) {
    let retryAt
    try {
      retryAt = new Date(this._nowDate().getTime() + this.retryDelayMs).toISOString()
    } catch {
      retryAt = undefined
    }
    try {
      await this.store.fail({
        id: record.task.id,
        owner: this.owner,
        token: record.task.leaseToken,
        errorCode: NAS_TASK_EXECUTOR_ERROR_CODES.PROCESSOR_FAILED,
        errorSummary: safeErrorSummary(error),
        ...(retryAt === undefined ? {} : { retryAt })
      })
    } catch {
      // A lost/expired lease is intentionally left for lease recovery.
    }
  }

  _nowDate() {
    return toDate(this._clock())
  }

  _startHeartbeat(record) {
    const schedule = () => {
      if (record.settled || record.heartbeatStopped) return
      record.heartbeatTimer = this._setTimeout(() => {
        record.heartbeatTimer = null
        void this._heartbeatTick(record)
      }, this.heartbeatIntervalMs)
    }
    record.scheduleHeartbeat = schedule
    schedule()
  }

  async _heartbeatTick(record) {
    if (record.settled || record.heartbeatStopped) return
    try {
      await this._controlledHeartbeat(record)
    } catch {
      return
    } finally {
      if (!record.settled && !record.heartbeatStopped && !record.heartbeatFailed) {
        record.scheduleHeartbeat()
      }
    }
  }

  _controlledHeartbeat(record) {
    if (record.settled || record.heartbeatStopped || !record.allowTerminalWrite) return Promise.resolve(null)
    return Promise.resolve(this.store.heartbeat({
      id: record.task.id,
      owner: this.owner,
      token: record.task.leaseToken,
      leaseDurationMs: this.leaseDurationMs
    })).catch((error) => {
      record.heartbeatFailed = true
      record.allowTerminalWrite = false
      this._stopHeartbeat(record)
      record.controller.abort()
      throw error
    })
  }

  _stopHeartbeat(record) {
    record.heartbeatStopped = true
    if (record.heartbeatTimer !== null) {
      this._clearTimeout(record.heartbeatTimer)
      record.heartbeatTimer = null
    }
  }

  _settleRecord(record) {
    if (record.settled) return
    record.settled = true
    this._stopHeartbeat(record)
    if (this._active.get(record.task.id) === record) this._active.delete(record.task.id)
    this._activeCounts[record.executionClass] = Math.max(0, this._activeCounts[record.executionClass] - 1)
    this._maybeFinishDrain()
  }

  _timeoutDrain() {
    if (this._state !== 'stopping') return
    this._timedOut = true
    for (const record of this._active.values()) {
      record.allowTerminalWrite = false
      this._stopHeartbeat(record)
      record.controller.abort()
    }
    this._finishStop()
  }

  _maybeFinishDrain() {
    if (this._state !== 'stopping' || this._dispatching || this._active.size > 0) return
    this._finishStop()
  }

  _clearDrainTimer() {
    if (this._drainTimer !== null) {
      this._clearTimeout(this._drainTimer)
      this._drainTimer = null
    }
  }

  _stopReport() {
    return Object.freeze({
      status: 'stopped',
      drained: !this._timedOut && this._active.size === 0,
      timedOut: this._timedOut,
      active: this._active.size
    })
  }

  _finishStop() {
    if (this._state === 'stopped') return
    this._state = 'stopped'
    this._clearPollTimer()
    this._clearDrainTimer()
    const resolve = this._stopResolve
    this._stopResolve = null
    if (resolve) resolve(this._stopReport())
  }
}

export function createNasTaskExecutor(options) {
  return new NasTaskExecutor(options)
}

export default NasTaskExecutor
