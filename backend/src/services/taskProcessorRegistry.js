const EXECUTION_CLASSES = new Set(['cpu', 'disk', 'network', 'gpu'])
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const ROUTE_SEPARATOR = '\u001f'

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fail(code, message, details = {}) {
  throw new TaskProcessorRegistryError(code, message, details)
}

function normalizeToken(value, fieldName) {
  if (typeof value !== 'string') fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || !TOKEN_PATTERN.test(normalized)) {
    fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

export class TaskProcessorRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TaskProcessorRegistryError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export function normalizeProcessorIdentity(input, fieldName = 'processor identity') {
  if (!isPlainObject(input)) fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName} must be an object.`)
  const allowed = new Set(['taskType', 'processorVersion', 'executionClass'])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName} contains unsupported fields.`)
  }
  return Object.freeze({
    taskType: normalizeToken(input.taskType, `${fieldName}.taskType`),
    processorVersion: normalizeToken(input.processorVersion, `${fieldName}.processorVersion`),
    executionClass: typeof input.executionClass === 'string' && EXECUTION_CLASSES.has(input.executionClass)
      ? input.executionClass
      : fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName}.executionClass is invalid.`)
  })
}

export function processorIdentityKey(input) {
  const identity = normalizeProcessorIdentity({
    taskType: input?.taskType,
    processorVersion: input?.processorVersion,
    executionClass: input?.executionClass
  })
  return [identity.taskType, identity.processorVersion, identity.executionClass].join(ROUTE_SEPARATOR)
}

function normalizeLookupInput(input, processorVersion, executionClass) {
  if (processorVersion !== undefined || executionClass !== undefined) {
    return normalizeProcessorIdentity({
      taskType: input,
      processorVersion,
      executionClass
    })
  }
  return normalizeProcessorIdentity(input)
}

function normalizeRegistrationInput(input, processorVersion, executionClass, handler) {
  const source = isPlainObject(input)
    ? { ...input }
    : { taskType: input, processorVersion, executionClass, handler }
  if (!isPlainObject(source)) fail('TASK_PROCESSOR_REGISTRATION_INVALID', 'Processor registration must be an object.')
  const allowed = new Set(['taskType', 'processorVersion', 'executionClass', 'handler'])
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    fail('TASK_PROCESSOR_REGISTRATION_INVALID', 'Processor registration contains unsupported fields.')
  }
  if (typeof source.handler !== 'function') {
    fail('TASK_PROCESSOR_HANDLER_INVALID', 'Processor handler must be a function.')
  }
  const identity = normalizeProcessorIdentity({
    taskType: source.taskType,
    processorVersion: source.processorVersion,
    executionClass: source.executionClass
  })
  return Object.freeze({ ...identity, handler: source.handler })
}

function cloneIdentity(identity) {
  return Object.freeze({
    taskType: identity.taskType,
    processorVersion: identity.processorVersion,
    executionClass: identity.executionClass
  })
}

export class TaskProcessorRegistry {
  #entries = []
  #routes = new Map()

  constructor(options = {}) {
    let registrations = options
    if (isPlainObject(options)) {
      const allowed = new Set(['processors', 'registrations'])
      if (Object.keys(options).some((key) => !allowed.has(key))) {
        fail('TASK_PROCESSOR_REGISTRY_INPUT_INVALID', 'Registry options contain unsupported fields.')
      }
      const hasProcessors = Object.hasOwn(options, 'processors')
      const hasRegistrations = Object.hasOwn(options, 'registrations')
      if (hasProcessors && hasRegistrations) {
        fail('TASK_PROCESSOR_REGISTRY_INPUT_INVALID', 'Processor registration aliases must not both be supplied.')
      }
      registrations = options.processors ?? options.registrations ?? []
    }
    if (!Array.isArray(registrations)) {
      fail('TASK_PROCESSOR_REGISTRY_INPUT_INVALID', 'Processor registrations must be an array.')
    }
    for (const registration of registrations) this.register(registration)
  }

  register(input, processorVersion, executionClass, handler) {
    const entry = normalizeRegistrationInput(input, processorVersion, executionClass, handler)
    const key = processorIdentityKey(entry)
    const existing = this.#routes.get(key)
    if (existing) {
      if (existing.handler === entry.handler) {
        fail('TASK_PROCESSOR_DUPLICATE', 'Processor route is already registered.', { key })
      }
      fail('TASK_PROCESSOR_CONFLICT', 'Processor route conflicts with an existing registration.', { key })
    }
    this.#routes.set(key, entry)
    this.#entries.push(entry)
    return entry
  }

  registerProcessor(input, processorVersion, executionClass, handler) {
    return this.register(input, processorVersion, executionClass, handler)
  }

  get(input, processorVersion, executionClass) {
    const identity = processorVersion === undefined && executionClass === undefined
      ? normalizeLookupInput(input)
      : normalizeLookupInput(input, processorVersion, executionClass)
    return this.#routes.get(processorIdentityKey(identity)) ?? null
  }

  resolve(input) {
    return this.get(input)
  }

  resolveProcessor(input) {
    return this.get(input)
  }

  has(input, processorVersion, executionClass) {
    return this.get(input, processorVersion, executionClass) !== null
  }

  hasProcessor(input, processorVersion, executionClass) {
    return this.has(input, processorVersion, executionClass)
  }

  list() {
    return Object.freeze([...this.#entries])
  }

  getSupportedProcessorIdentities() {
    return Object.freeze(this.#entries.map(cloneIdentity))
  }

  getProcessorIdentities() {
    return this.getSupportedProcessorIdentities()
  }

  get supportedProcessorIdentities() {
    return this.getSupportedProcessorIdentities()
  }

  toLeaseFilter() {
    return Object.freeze({ supportedProcessors: this.getSupportedProcessorIdentities() })
  }

  get size() {
    return this.#entries.length
  }
}

export function createTaskProcessorRegistry(options) {
  return new TaskProcessorRegistry(options)
}

export default TaskProcessorRegistry
