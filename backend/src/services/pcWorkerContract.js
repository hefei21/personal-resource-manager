export const PC_WORKER_PROTOCOL_VERSION = 1
export const PC_WORKER_TASK_TYPE = 'content.inspect'
export const PC_WORKER_PROCESSOR_VERSION = 'v1'
export const PC_WORKER_EXECUTION_CLASS = 'gpu'
export const PC_WORKER_OUTPUT_SCHEMA_VERSION = 1
export const PC_WORKER_IMPLEMENTATION = Object.freeze({
  name: 'builtin-content-inspector',
  version: '1'
})

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER

export class PcWorkerContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PcWorkerContractError'
    this.code = code
  }
}

function fail(code, message) {
  throw new PcWorkerContractError(code, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value, keys, fieldName) {
  if (!isPlainObject(value)) fail('PC_WORKER_INPUT_INVALID', `${fieldName} must be an object.`)
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('PC_WORKER_INPUT_INVALID', `${fieldName} contains unsupported fields.`)
  }
}

function requiredText(value, fieldName, maxLength = 128) {
  if (typeof value !== 'string') fail('PC_WORKER_INPUT_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('PC_WORKER_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function token(value, fieldName) {
  const normalized = requiredText(value, fieldName)
  if (!TOKEN_PATTERN.test(normalized)) fail('PC_WORKER_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function integer(value, fieldName, { min = 0, max = MAX_SAFE_BYTES } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('PC_WORKER_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return value
}

function normalizeGpu(value, index) {
  exactKeys(value, ['vendor', 'name', 'totalMemoryBytes', 'freeMemoryBytes', 'driverVersion'], `capabilities.resources.gpus[${index}]`)
  const totalMemoryBytes = integer(value.totalMemoryBytes, `capabilities.resources.gpus[${index}].totalMemoryBytes`)
  const freeMemoryBytes = integer(value.freeMemoryBytes, `capabilities.resources.gpus[${index}].freeMemoryBytes`, { max: totalMemoryBytes })
  return Object.freeze({
    vendor: requiredText(value.vendor, `capabilities.resources.gpus[${index}].vendor`, 64),
    name: requiredText(value.name, `capabilities.resources.gpus[${index}].name`, 160),
    totalMemoryBytes,
    freeMemoryBytes,
    ...(value.driverVersion === undefined
      ? {}
      : { driverVersion: requiredText(value.driverVersion, `capabilities.resources.gpus[${index}].driverVersion`, 64) })
  })
}

function normalizeLoadedModel(value, index) {
  exactKeys(value, ['id', 'backend', 'version', 'memoryBytes'], `capabilities.resources.loadedModels[${index}]`)
  return Object.freeze({
    id: requiredText(value.id, `capabilities.resources.loadedModels[${index}].id`, 256),
    backend: token(value.backend, `capabilities.resources.loadedModels[${index}].backend`),
    ...(value.version === undefined
      ? {}
      : { version: requiredText(value.version, `capabilities.resources.loadedModels[${index}].version`, 128) }),
    ...(value.memoryBytes === undefined
      ? {}
      : { memoryBytes: integer(value.memoryBytes, `capabilities.resources.loadedModels[${index}].memoryBytes`) })
  })
}

function normalizeResources(value = {}) {
  exactKeys(value, ['cpuLogicalCores', 'systemMemoryBytes', 'gpus', 'loadedModels'], 'capabilities.resources')
  const gpus = value.gpus ?? []
  const loadedModels = value.loadedModels ?? []
  if (!Array.isArray(gpus) || gpus.length > 8 || !Array.isArray(loadedModels) || loadedModels.length > 16) {
    fail('PC_WORKER_INPUT_INVALID', 'capabilities.resources exceeds supported limits.')
  }
  return Object.freeze({
    cpuLogicalCores: integer(value.cpuLogicalCores, 'capabilities.resources.cpuLogicalCores', { min: 1, max: 1024 }),
    systemMemoryBytes: integer(value.systemMemoryBytes, 'capabilities.resources.systemMemoryBytes'),
    gpus: Object.freeze(gpus.map(normalizeGpu)),
    loadedModels: Object.freeze(loadedModels.map(normalizeLoadedModel))
  })
}

function normalizeProcessor(value, index) {
  exactKeys(value, ['taskType', 'processorVersion', 'executionClass', 'outputSchemaVersion'], `capabilities.processors[${index}]`)
  const normalized = {
    taskType: token(value.taskType, `capabilities.processors[${index}].taskType`),
    processorVersion: token(value.processorVersion, `capabilities.processors[${index}].processorVersion`),
    executionClass: token(value.executionClass, `capabilities.processors[${index}].executionClass`),
    outputSchemaVersion: integer(value.outputSchemaVersion, `capabilities.processors[${index}].outputSchemaVersion`, { min: 1, max: 1000 })
  }
  return Object.freeze(normalized)
}

export function normalizeWorkerProfile(value) {
  exactKeys(value, ['displayName', 'protocolVersion', 'agentVersion', 'platform', 'architecture', 'capabilities'], 'worker profile')
  if (value.protocolVersion !== PC_WORKER_PROTOCOL_VERSION) {
    fail('PC_WORKER_PROTOCOL_UNSUPPORTED', 'Worker protocol version is not supported.')
  }
  exactKeys(value.capabilities, ['processors', 'resources'], 'capabilities')
  if (!Array.isArray(value.capabilities.processors) || value.capabilities.processors.length < 1 || value.capabilities.processors.length > 32) {
    fail('PC_WORKER_INPUT_INVALID', 'capabilities.processors is invalid.')
  }
  const processors = value.capabilities.processors.map(normalizeProcessor)
  return Object.freeze({
    displayName: requiredText(value.displayName, 'displayName', 80),
    protocolVersion: PC_WORKER_PROTOCOL_VERSION,
    agentVersion: token(value.agentVersion, 'agentVersion'),
    platform: token(value.platform, 'platform'),
    architecture: token(value.architecture, 'architecture'),
    capabilities: Object.freeze({
      processors: Object.freeze(processors),
      resources: normalizeResources(value.capabilities.resources)
    })
  })
}

export function supportedRemoteProcessors(capabilities) {
  const source = capabilities?.processors
  if (!Array.isArray(source)) return Object.freeze([])
  return Object.freeze(source
    .filter((processor) =>
      processor.taskType === PC_WORKER_TASK_TYPE &&
      processor.processorVersion === PC_WORKER_PROCESSOR_VERSION &&
      processor.executionClass === PC_WORKER_EXECUTION_CLASS &&
      processor.outputSchemaVersion === PC_WORKER_OUTPUT_SCHEMA_VERSION)
    .map(({ taskType, processorVersion, executionClass }) => Object.freeze({ taskType, processorVersion, executionClass })))
}

export function projectWorkerTask(task) {
  if (!isPlainObject(task) || task.taskType !== PC_WORKER_TASK_TYPE ||
    task.processorVersion !== PC_WORKER_PROCESSOR_VERSION || task.executionClass !== PC_WORKER_EXECUTION_CLASS) return null
  try {
    const input = task.input
    exactKeys(input, ['schemaVersion', 'resourceVersionId', 'contentObjectId'], 'task.input')
    if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.resourceVersionId) || input.resourceVersionId < 1 ||
      !Number.isSafeInteger(input.contentObjectId) || input.contentObjectId < 1 || !HASH_PATTERN.test(task.subjectContentHash ?? '')) return null
    return Object.freeze({
      id: task.id,
      taskType: task.taskType,
      processorVersion: task.processorVersion,
      executionClass: task.executionClass,
      leaseToken: task.leaseToken,
      leaseExpiresAt: task.leaseExpiresAt,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      input: Object.freeze({
        schemaVersion: 1,
        resourceVersionId: input.resourceVersionId,
        contentObjectId: input.contentObjectId,
        sha256: task.subjectContentHash
      })
    })
  } catch (error) {
    if (error instanceof PcWorkerContractError) return null
    throw error
  }
}

export function normalizeContentInspectionResult(value, expected) {
  exactKeys(value, ['schemaVersion', 'processorVersion', 'implementation', 'input', 'output'], 'result')
  if (value.schemaVersion !== PC_WORKER_OUTPUT_SCHEMA_VERSION || value.processorVersion !== PC_WORKER_PROCESSOR_VERSION) {
    fail('PC_WORKER_RESULT_SCHEMA_INVALID', 'Result schema or processor version is invalid.')
  }
  exactKeys(value.implementation, ['name', 'version'], 'result.implementation')
  if (value.implementation.name !== PC_WORKER_IMPLEMENTATION.name || value.implementation.version !== PC_WORKER_IMPLEMENTATION.version) {
    fail('PC_WORKER_RESULT_PROCESSOR_INVALID', 'Result implementation version is invalid.')
  }
  exactKeys(value.input, ['sha256', 'bytes'], 'result.input')
  exactKeys(value.output, ['sha256', 'bytes', 'nulBytes', 'lineFeedBytes', 'carriageReturnBytes', 'utf8Valid'], 'result.output')
  const inputSha256 = requiredText(value.input.sha256, 'result.input.sha256', 64).toLowerCase()
  const outputSha256 = requiredText(value.output.sha256, 'result.output.sha256', 64).toLowerCase()
  const inputBytes = integer(value.input.bytes, 'result.input.bytes')
  const outputBytes = integer(value.output.bytes, 'result.output.bytes')
  if (!HASH_PATTERN.test(inputSha256) || !HASH_PATTERN.test(outputSha256) ||
    inputSha256 !== expected.sha256 || outputSha256 !== expected.sha256 ||
    inputBytes !== expected.bytes || outputBytes !== expected.bytes) {
    fail('PC_WORKER_RESULT_INPUT_MISMATCH', 'Result does not match the authorized input.')
  }
  if (typeof value.output.utf8Valid !== 'boolean') fail('PC_WORKER_RESULT_SCHEMA_INVALID', 'Result UTF-8 flag is invalid.')
  return Object.freeze({
    schemaVersion: PC_WORKER_OUTPUT_SCHEMA_VERSION,
    processorVersion: PC_WORKER_PROCESSOR_VERSION,
    implementation: PC_WORKER_IMPLEMENTATION,
    input: Object.freeze({ sha256: inputSha256, bytes: inputBytes }),
    output: Object.freeze({
      sha256: outputSha256,
      bytes: outputBytes,
      nulBytes: integer(value.output.nulBytes, 'result.output.nulBytes', { max: outputBytes }),
      lineFeedBytes: integer(value.output.lineFeedBytes, 'result.output.lineFeedBytes', { max: outputBytes }),
      carriageReturnBytes: integer(value.output.carriageReturnBytes, 'result.output.carriageReturnBytes', { max: outputBytes }),
      utf8Valid: value.output.utf8Valid
    })
  })
}
