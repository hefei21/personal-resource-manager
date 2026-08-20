import { createTaskStore } from './taskStore.js'
import { createNasTaskExecutor } from './nasTaskExecutor.js'
import { createTaskProcessorRegistry } from './taskProcessorRegistry.js'

const DEFAULT_OWNER = 'nas-task-runtime'

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code, message, details = {}) {
  throw new TaskRuntimeError(code, message, details)
}

function identityKey(identity) {
  return `${identity.taskType}\u001f${identity.processorVersion}\u001f${identity.executionClass}`
}

function registryEntries(registry) {
  const source = typeof registry.list === 'function'
    ? registry.list()
    : typeof registry.getSupportedProcessorIdentities === 'function'
      ? registry.getSupportedProcessorIdentities()
      : null
  if (!Array.isArray(source)) fail('TASK_RUNTIME_REGISTRY_INVALID', 'Processor registry is invalid.')
  return source.map((entry) => {
    const identity = {
      taskType: entry.taskType,
      processorVersion: entry.processorVersion,
      executionClass: entry.executionClass
    }
    const resolved = typeof entry.handler === 'function'
      ? entry
      : typeof registry.resolve === 'function'
        ? registry.resolve(identity)
        : typeof registry.get === 'function'
          ? registry.get(identity)
          : null
    if (!resolved || typeof resolved.handler !== 'function') {
      fail('TASK_RUNTIME_REGISTRY_INVALID', 'Processor registry entry is invalid.')
    }
    return Object.freeze({ ...identity, handler: resolved.handler })
  })
}

function freezeRegistry(registry) {
  const entries = registryEntries(registry)
  const routes = new Map(entries.map((entry) => [identityKey(entry), entry]))
  const identities = Object.freeze(entries.map(({ taskType, processorVersion, executionClass }) => Object.freeze({
    taskType,
    processorVersion,
    executionClass
  })))
  const list = () => Object.freeze([...entries])
  const getIdentities = () => identities
  const resolve = (identity) => routes.get(identityKey(identity)) ?? null
  return Object.freeze({
    list,
    getSupportedProcessorIdentities: getIdentities,
    getProcessorIdentities: getIdentities,
    resolve,
    resolveProcessor: resolve,
    get: resolve
  })
}

function stableStopReport() {
  return Object.freeze({
    status: 'stopped',
    drained: true,
    timedOut: false,
    active: 0
  })
}

export class TaskRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TaskRuntimeError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export class TaskRuntime {
  #database
  #registry
  #storeFactory
  #executorFactory
  #storeOptions
  #executorOptions
  #owner
  #store = null
  #executor = null
  #state = 'idle'
  #stopPromise = null

  constructor(options = {}) {
    if (!isPlainObject(options)) fail('TASK_RUNTIME_INPUT_INVALID', 'Task runtime options must be an object.')
    const allowed = new Set([
      'database', 'registry', 'processorRegistry', 'owner', 'workerId',
      'storeFactory', 'createStore', 'taskStoreFactory',
      'executorFactory', 'createExecutor', 'nasTaskExecutorFactory',
      'storeOptions', 'executorOptions'
    ])
    if (Object.keys(options).some((key) => !allowed.has(key))) {
      fail('TASK_RUNTIME_INPUT_INVALID', 'Task runtime options contain unsupported fields.')
    }
    if (options.storeOptions !== undefined && !isPlainObject(options.storeOptions)) {
      fail('TASK_RUNTIME_INPUT_INVALID', 'Task runtime store options must be an object.')
    }
    if (options.executorOptions !== undefined && !isPlainObject(options.executorOptions)) {
      fail('TASK_RUNTIME_INPUT_INVALID', 'Task runtime executor options must be an object.')
    }
    this.#database = options.database ?? null
    this.#registry = options.registry ?? options.processorRegistry ?? createTaskProcessorRegistry()
    if (!this.#registry || typeof this.#registry.register !== 'function') {
      fail('TASK_RUNTIME_REGISTRY_INVALID', 'Processor registry cannot accept registrations.')
    }
    this.#storeFactory = options.storeFactory ?? options.createStore ?? options.taskStoreFactory ?? createTaskStore
    this.#executorFactory = options.executorFactory ?? options.createExecutor ??
      options.nasTaskExecutorFactory ?? createNasTaskExecutor
    if (typeof this.#storeFactory !== 'function' || typeof this.#executorFactory !== 'function') {
      fail('TASK_RUNTIME_FACTORY_INVALID', 'Task runtime factories are invalid.')
    }
    this.#storeOptions = Object.freeze({ ...(options.storeOptions ?? {}) })
    this.#executorOptions = Object.freeze({ ...(options.executorOptions ?? {}) })
    this.#owner = options.owner ?? options.workerId ?? DEFAULT_OWNER
  }

  get state() {
    return this.#state
  }

  registerProcessor(input, processorVersion, executionClass, handler) {
    if (this.#state !== 'idle') {
      fail('TASK_RUNTIME_REGISTRATION_FROZEN', 'Processor registration is frozen after runtime start.')
    }
    return this.#registry.register(input, processorVersion, executionClass, handler)
  }

  start(value) {
    if (this.#state === 'running') return this
    if (this.#state !== 'idle') {
      fail('TASK_RUNTIME_STATE_INVALID', 'Task runtime cannot be started in its current state.')
    }
    if (isPlainObject(value) && typeof value.prepare !== 'function') {
      const keys = Object.keys(value)
      if (keys.some((key) => key !== 'database')) {
        fail('TASK_RUNTIME_INPUT_INVALID', 'Task runtime start options contain unsupported fields.')
      }
    }
    const database = value && typeof value.prepare === 'function'
      ? value
      : isPlainObject(value) && Object.hasOwn(value, 'database')
        ? value.database
        : this.#database
    if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
      fail('TASK_RUNTIME_DATABASE_REQUIRED', 'Task runtime requires a migrated database connection.')
    }

    this.#state = 'starting'
    let executor = null
    try {
      const frozenRegistry = freezeRegistry(this.#registry)
      const store = this.#storeFactory({ ...this.#storeOptions, database })
      executor = this.#executorFactory({
        ...this.#executorOptions,
        store,
        registry: frozenRegistry,
        owner: this.#owner
      })
      if (!executor || typeof executor.start !== 'function' || typeof executor.stop !== 'function') {
        fail('TASK_RUNTIME_EXECUTOR_INVALID', 'Task runtime executor is invalid.')
      }
      this.#store = store
      this.#executor = executor
      executor.start()
      this.#state = 'running'
      return this
    } catch (error) {
      if (executor && typeof executor.stop === 'function') {
        try { void Promise.resolve(executor.stop({ timeoutMs: 0 })).catch(() => {}) } catch {}
      }
      this.#store = null
      this.#executor = null
      this.#state = 'failed'
      if (error instanceof TaskRuntimeError) throw error
      fail('TASK_RUNTIME_START_FAILED', 'Task runtime could not start.')
    }
  }

  stop(options = {}) {
    if (this.#stopPromise) return this.#stopPromise
    if (this.#state === 'idle' || this.#state === 'failed') {
      this.#state = 'stopped'
      return Promise.resolve(stableStopReport())
    }
    if (this.#state === 'stopped') return Promise.resolve(stableStopReport())
    this.#state = 'stopping'
    this.#stopPromise = Promise.resolve()
      .then(() => this.#executor.stop(options))
      .then((report) => {
        this.#state = 'stopped'
        return Object.freeze({
          status: 'stopped',
          drained: report?.drained === true,
          timedOut: report?.timedOut === true,
          active: Number.isSafeInteger(report?.active) ? report.active : 0
        })
      }, () => {
        this.#state = 'failed'
        fail('TASK_RUNTIME_STOP_FAILED', 'Task runtime could not stop.')
      })
    return this.#stopPromise
  }

  drain(options = {}) {
    return this.stop(options)
  }

  getStore() {
    if (this.#state !== 'running' || !this.#store) {
      fail('TASK_RUNTIME_NOT_RUNNING', 'Task runtime is not running.')
    }
    return this.#store
  }

  getExecutor() {
    if (this.#state !== 'running' || !this.#executor) {
      fail('TASK_RUNTIME_NOT_RUNNING', 'Task runtime is not running.')
    }
    return this.#executor
  }

  status() {
    const identities = typeof this.#registry.getSupportedProcessorIdentities === 'function'
      ? this.#registry.getSupportedProcessorIdentities()
      : []
    return Object.freeze({
      state: this.#state,
      acceptingRegistrations: this.#state === 'idle',
      registeredProcessorCount: Array.isArray(identities) ? identities.length : 0,
      executorState: this.#executor?.state ?? null,
      activeCount: this.#executor?.activeCount ?? 0
    })
  }

}

let runtime

export function createTaskRuntime(options) {
  return new TaskRuntime(options)
}

export function getTaskRuntime() {
  runtime ??= createTaskRuntime()
  return runtime
}

export function startTaskRuntime(options = {}) {
  if (isPlainObject(options) && options.runtime) {
    const { runtime: target, ...startOptions } = options
    return target.start(startOptions)
  }
  return getTaskRuntime().start(options)
}

export function stopTaskRuntime(options = {}) {
  return runtime ? runtime.stop(options) : Promise.resolve(stableStopReport())
}

export function registerTaskProcessor(input, processorVersion, executionClass, handler) {
  return getTaskRuntime().registerProcessor(input, processorVersion, executionClass, handler)
}

export function resetTaskRuntimeForTests() {
  runtime = undefined
}

export default TaskRuntime
