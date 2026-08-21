import { createHash, randomBytes } from 'node:crypto'

import { TASK_TABLE } from '../config/taskSchema.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const GENERATED_KEY_PATTERN = /^task:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SUBJECT_ID_MAX_LENGTH = 512
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_LEASE_DURATION_MS = 60_000
const MAX_LEASE_DURATION_MS = 365 * 24 * 60 * 60 * 1000
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_SUPPORTED_PROCESSOR_IDENTITIES = 100
const MAX_EXCLUSIVE_TASK_TYPES = 100
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const MAX_ERROR_SUMMARY_LENGTH = 2048
const TASK_STATUS_SET = new Set(['pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled'])
const EXECUTION_CLASS_SET = new Set(['cpu', 'disk', 'network', 'gpu'])
const TASK_ORDER_SET = new Set(['asc', 'desc'])
const TASK_CLEANUP_DAY_MS = 24 * 60 * 60 * 1000

export const TASK_CLEANUP_RETENTION_DAYS = Object.freeze({
  succeeded: 30,
  failed: 90,
  cancelled: 90
})
export const TASK_CLEANUP_BATCH_LIMIT = 100

export const TASK_STATUS_PENDING = 'pending'
export const TASK_STATUS_LEASED = 'leased'
export const TASK_STATUS_RUNNING = 'running'
export const TASK_STATUS_SUCCEEDED = 'succeeded'
export const TASK_STATUS_FAILED = 'failed'
export const TASK_STATUS_CANCELLED = 'cancelled'
export const TASK_ERROR_LEASE_EXPIRED = 'TASK_LEASE_EXPIRED'

export class TaskStoreError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'TaskStoreError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details, cause) {
  throw new TaskStoreError(code, message, details, cause ? { cause } : undefined)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertDatabase(database, needsTransaction = false) {
  if (!database || typeof database.prepare !== 'function' ||
    (needsTransaction && typeof database.transaction !== 'function')) {
    fail('TASK_STORE_DATABASE_INVALID', 'A SQLite database connection is required.')
  }
}

function assertOptionsObject(value, fieldName) {
  if (!isPlainObject(value)) fail('TASK_STORE_INPUT_INVALID', `${fieldName} must be an object.`)
}

function normalizeToken(value, fieldName) {
  if (typeof value !== 'string') fail('TASK_IDENTITY_INVALID', `${fieldName} must be text.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || !TOKEN_PATTERN.test(normalized)) {
    fail('TASK_IDENTITY_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function normalizeSubjectId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('TASK_SUBJECT_ID_INVALID', 'subjectId must be a non-negative safe integer or non-empty text.')
    }
    return String(value)
  }
  if (typeof value !== 'string') {
    fail('TASK_SUBJECT_ID_INVALID', 'subjectId must be a non-negative safe integer or non-empty text.')
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > SUBJECT_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('TASK_SUBJECT_ID_INVALID', 'subjectId is invalid.')
  }
  return normalized
}

function normalizeOptionalVersionId(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('TASK_SUBJECT_VERSION_INVALID', 'subjectVersionId is invalid.')
    return String(value)
  }
  if (typeof value !== 'string') fail('TASK_SUBJECT_VERSION_INVALID', 'subjectVersionId is invalid.')
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('TASK_SUBJECT_VERSION_INVALID', 'subjectVersionId is invalid.')
  }
  return normalized
}

function normalizeOptionalHash(value, fieldName = 'subjectContentSha256') {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !HASH_PATTERN.test(value.toLowerCase())) {
    fail('TASK_SUBJECT_CONTENT_HASH_INVALID', `${fieldName} must be a SHA-256 hex digest.`)
  }
  return value.toLowerCase()
}

function canonicalJson(value, fieldName = 'input', ancestors = new Set()) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('TASK_JSON_INVALID', `${fieldName} contains a non-finite number.`)
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail('TASK_JSON_INVALID', `${fieldName} contains a circular reference.`)
    ancestors.add(value)
    const keys = Object.keys(value)
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      fail('TASK_JSON_INVALID', `${fieldName} contains an invalid array.`)
    }
    const serialized = `[${value.map((item, index) => canonicalJson(item, `${fieldName}[${index}]`, ancestors)).join(',')}]`
    ancestors.delete(value)
    return serialized
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      fail('TASK_JSON_INVALID', `${fieldName} must contain JSON values only.`)
    }
    if (ancestors.has(value)) fail('TASK_JSON_INVALID', `${fieldName} contains a circular reference.`)
    ancestors.add(value)
    const entries = Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('TASK_JSON_INVALID', `${fieldName}.${key} must be a JSON value.`)
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, `${fieldName}.${key}`, ancestors)}`
    })
    ancestors.delete(value)
    return `{${entries.join(',')}}`
  }
  fail('TASK_JSON_INVALID', `${fieldName} must contain JSON values only.`)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function hashText(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

function normalizeIdentitySource(input) {
  assertOptionsObject(input, 'identity')
  return input
}

export function normalizeTaskIdentity(input = {}) {
  const source = normalizeIdentitySource(input)
  const allowed = new Set([
    'taskType', 'processorVersion', 'subjectType', 'subjectId',
    'subjectVersionId', 'subjectContentSha256', 'subjectContentHash'
  ])
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    fail('TASK_IDENTITY_INVALID', 'identity contains unsupported fields.')
  }
  const required = ['taskType', 'processorVersion', 'subjectType', 'subjectId']
  for (const field of required) {
    if (!Object.hasOwn(source, field)) fail('TASK_IDENTITY_INVALID', `${field} is required.`)
  }
  const subjectContentHash = normalizeOptionalHash(
    source.subjectContentSha256 ?? source.subjectContentHash,
    Object.hasOwn(source, 'subjectContentHash') ? 'subjectContentHash' : 'subjectContentSha256'
  )
  if (Object.hasOwn(source, 'subjectContentSha256') && Object.hasOwn(source, 'subjectContentHash')) {
    const aliasHash = normalizeOptionalHash(source.subjectContentHash, 'subjectContentHash')
    if (subjectContentHash !== aliasHash) fail('TASK_IDENTITY_INVALID', 'Content hash aliases must match.')
  }
  return Object.freeze({
    taskType: normalizeToken(source.taskType, 'taskType'),
    processorVersion: normalizeToken(source.processorVersion, 'processorVersion'),
    subjectType: normalizeToken(source.subjectType, 'subjectType'),
    subjectId: normalizeSubjectId(source.subjectId),
    subjectVersionId: normalizeOptionalVersionId(source.subjectVersionId),
    subjectContentSha256: subjectContentHash
  })
}

export function deriveTaskIdempotencyKey(identityInput) {
  const identity = normalizeTaskIdentity(identityInput)
  return `task:${hashText(canonicalJson(identity, 'identity'))}`
}

function normalizeTimestamp(value, fieldName) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('TASK_TIMESTAMP_INVALID', `${fieldName} must be an ISO-8601 UTC timestamp.`)
  }
  return value
}

function nowTimestamp(now) {
  const value = typeof now === 'function' ? now() : now ?? new Date()
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail('TASK_TIMESTAMP_INVALID', 'Task time is invalid.')
  return date.toISOString()
}

function normalizeInteger(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER, defaultValue } = {}) {
  const resolved = value === undefined ? defaultValue : value
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    fail('TASK_NUMBER_INVALID', `${fieldName} must be an integer in the supported range.`)
  }
  return resolved
}

function normalizeProgress(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail('TASK_PROGRESS_INVALID', 'progress must be a finite number between 0 and 100.')
  }
  return Object.is(value, -0) ? 0 : value
}

function normalizeDuration(value, fieldName = 'leaseDurationMs') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LEASE_DURATION_MS) {
    fail('TASK_DURATION_INVALID', `${fieldName} must be a positive duration in milliseconds.`)
  }
  return value
}

function resolveAlias(source, primaryName, aliasName, fieldName, normalize) {
  const hasPrimary = Object.hasOwn(source, primaryName) && source[primaryName] !== undefined
  const hasAlias = Object.hasOwn(source, aliasName) && source[aliasName] !== undefined
  if (!hasPrimary && !hasAlias) return undefined
  const primary = hasPrimary ? normalize(source[primaryName], fieldName) : undefined
  const alias = hasAlias ? normalize(source[aliasName], fieldName) : undefined
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    fail('TASK_INPUT_INVALID', `${fieldName} aliases must match.`)
  }
  return primary ?? alias
}

function normalizeLeaseCredentialToken(value, fieldName, errorCode = 'TASK_LEASE_CREDENTIALS_INVALID') {
  if (typeof value !== 'string') fail(errorCode, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || !TOKEN_PATTERN.test(normalized)) {
    fail(errorCode, `${fieldName} is invalid.`)
  }
  return normalized
}

function normalizeLeaseCredentials(source, { required = true, tokenRequired = required } = {}) {
  assertOptionsObject(source, 'lease credentials')
  const owner = resolveAlias(
    source,
    'owner',
    'leaseOwner',
    'owner',
    normalizeLeaseCredentialToken
  )
  const token = resolveAlias(
    source,
    'token',
    'leaseToken',
    'leaseToken',
    normalizeLeaseCredentialToken
  )
  if (required && !owner) {
    fail('TASK_LEASE_CREDENTIALS_INVALID', 'Lease owner is required.')
  }
  if (tokenRequired && !token) {
    fail('TASK_LEASE_CREDENTIALS_INVALID', 'Lease token is required.')
  }
  return Object.freeze({ owner: owner ?? null, token: token ?? null })
}

function normalizeErrorCode(value) {
  if (typeof value !== 'string') fail('TASK_ERROR_INVALID', 'errorCode is invalid.')
  const normalized = value.normalize('NFKC').trim()
  if (!ERROR_CODE_PATTERN.test(normalized)) fail('TASK_ERROR_INVALID', 'errorCode is invalid.')
  return normalized
}

function normalizeErrorSummary(value) {
  if (typeof value !== 'string') fail('TASK_ERROR_INVALID', 'errorSummary is invalid.')
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > MAX_ERROR_SUMMARY_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('TASK_ERROR_INVALID', 'errorSummary is invalid.')
  }
  return normalized
}

function timestampAfter(timestamp, duration, fieldName = 'leaseExpiresAt') {
  const milliseconds = Date.parse(timestamp) + duration
  if (!Number.isSafeInteger(milliseconds)) {
    fail('TASK_TIMESTAMP_INVALID', `${fieldName} is outside the supported range.`)
  }
  const result = new Date(milliseconds)
  if (Number.isNaN(result.getTime())) fail('TASK_TIMESTAMP_INVALID', `${fieldName} is invalid.`)
  return result.toISOString()
}

function normalizeExecutionClassFilter(source) {
  const hasSingular = Object.hasOwn(source, 'executionClass') && source.executionClass !== undefined
  const hasPlural = Object.hasOwn(source, 'executionClasses') && source.executionClasses !== undefined
  if (!hasSingular && !hasPlural) return null
  const raw = hasPlural ? source.executionClasses : source.executionClass
  const values = Array.isArray(raw) ? raw : [raw]
  if (values.length === 0) fail('TASK_EXECUTION_CLASS_INVALID', 'executionClass filter is invalid.')
  const normalized = values.map((value) => normalizeExecutionClass(value))
  if (hasSingular && hasPlural) {
    const singularValues = Array.isArray(source.executionClass)
      ? source.executionClass.map((value) => normalizeExecutionClass(value))
      : [normalizeExecutionClass(source.executionClass)]
    const singular = [...new Set(singularValues)]
    if (singular.length !== [...new Set(normalized)].length || singular.some((value) => !normalized.includes(value))) {
      fail('TASK_INPUT_INVALID', 'executionClass aliases must match.')
    }
  }
  return [...new Set(normalized)]
}

function normalizeExecutionClass(value) {
  const resolved = value === undefined ? 'cpu' : value
  if (typeof resolved !== 'string' || !EXECUTION_CLASS_SET.has(resolved)) {
    fail('TASK_EXECUTION_CLASS_INVALID', 'executionClass is invalid.')
  }
  return resolved
}

function normalizeSupportedProcessorIdentity(value, fieldName = 'supported processor') {
  const source = isPlainObject(value) && Object.hasOwn(value, 'handler') && typeof value.handler === 'function'
    ? {
        taskType: value.taskType,
        processorVersion: value.processorVersion,
        executionClass: value.executionClass
      }
    : value
  assertOptionsObject(source, fieldName)
  const allowed = new Set(['taskType', 'processorVersion', 'executionClass'])
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName} contains unsupported fields.`)
  }
  if (!Object.hasOwn(source, 'executionClass')) {
    fail('TASK_PROCESSOR_IDENTITY_INVALID', `${fieldName}.executionClass is required.`)
  }
  return Object.freeze({
    taskType: normalizeToken(source.taskType, `${fieldName}.taskType`),
    processorVersion: normalizeToken(source.processorVersion, `${fieldName}.processorVersion`),
    executionClass: normalizeExecutionClass(source.executionClass)
  })
}

function supportedProcessorIdentityKey(identity) {
  return `${identity.taskType}\u001f${identity.processorVersion}\u001f${identity.executionClass}`
}

function resolveSupportedProcessorSource(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value.getSupportedProcessorIdentities === 'function') {
    return value.getSupportedProcessorIdentities()
  }
  if (value && typeof value.getProcessorIdentities === 'function') {
    return value.getProcessorIdentities()
  }
  if (value && typeof value.list === 'function') {
    return value.list()
  }
  fail('TASK_PROCESSOR_IDENTITY_INVALID', 'Supported processors must be an array or registry.')
}

function normalizeSupportedProcessorIdentities(options) {
  const names = ['supportedProcessors', 'supportedProcessorIdentities', 'processorIdentities']
    .filter((key) => Object.hasOwn(options, key) && options[key] !== undefined)
  if (names.length === 0) return null
  const normalizedByName = names.map((name) => {
    const source = resolveSupportedProcessorSource(options[name])
    if (!Array.isArray(source)) fail('TASK_PROCESSOR_IDENTITY_INVALID', `${name} must be an array.`)
    if (source.length > MAX_SUPPORTED_PROCESSOR_IDENTITIES) {
      fail('TASK_PROCESSOR_IDENTITY_INVALID', `${name} exceeds the supported processor limit.`)
    }
    const seen = new Set()
    const identities = []
    for (const value of source) {
      const identity = normalizeSupportedProcessorIdentity(value, `${name} entry`)
      const key = supportedProcessorIdentityKey(identity)
      if (!seen.has(key)) {
        seen.add(key)
        identities.push(identity)
      }
    }
    return identities
  })
  const firstKeys = new Set(normalizedByName[0].map(supportedProcessorIdentityKey))
  if (normalizedByName.some((identities) => {
    const keys = new Set(identities.map(supportedProcessorIdentityKey))
    return keys.size !== firstKeys.size || [...keys].some((key) => !firstKeys.has(key))
  })) {
    fail('TASK_INPUT_INVALID', 'Supported processor aliases must match.')
  }
  return Object.freeze(normalizedByName[0])
}

function normalizeEnqueueInput(input, now) {
  assertOptionsObject(input, 'task input')
  const allowed = new Set([
    'identity', 'taskType', 'processorVersion', 'subjectType', 'subjectId',
    'subjectVersionId', 'subjectContentSha256', 'subjectContentHash', 'input',
    'executionClass', 'priority', 'availableAt', 'maxAttempts'
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    fail('TASK_INPUT_INVALID', 'Task input contains unsupported fields.')
  }
  if (input.identity !== undefined && Object.keys(input).some((key) =>
    ['taskType', 'processorVersion', 'subjectType', 'subjectId', 'subjectVersionId', 'subjectContentSha256', 'subjectContentHash'].includes(key))) {
    fail('TASK_IDENTITY_INVALID', 'Identity fields must be supplied either directly or under identity, not both.')
  }
  const identitySource = input.identity ?? Object.fromEntries(
    ['taskType', 'processorVersion', 'subjectType', 'subjectId', 'subjectVersionId', 'subjectContentSha256', 'subjectContentHash']
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]])
  )
  const identity = normalizeTaskIdentity(identitySource)
  const payload = Object.hasOwn(input, 'input') ? input.input : null
  const inputJson = canonicalJson(payload, 'input')
  const timestamp = nowTimestamp(now)
  const availableAt = input.availableAt === undefined
    ? timestamp
    : normalizeTimestamp(input.availableAt, 'availableAt')
  const executionClass = normalizeExecutionClass(input.executionClass)
  const maxAttempts = normalizeInteger(input.maxAttempts, 'maxAttempts', { min: 1, max: 1_000_000, defaultValue: DEFAULT_MAX_ATTEMPTS })
  return Object.freeze({
    ...identity,
    idempotencyKey: deriveTaskIdempotencyKey(identity),
    inputFingerprint: hashText(canonicalJson({ identity, executionClass, maxAttempts, input: payload }, 'task semantics')),
    inputJson,
    status: TASK_STATUS_PENDING,
    executionClass,
    priority: normalizeInteger(input.priority, 'priority', { min: 0, max: 1_000_000, defaultValue: 0 }),
    availableAt,
    maxAttempts,
    createdAt: timestamp,
    updatedAt: timestamp
  })
}

const EXCLUSIVE_TASK_TYPE_OPTION_NAMES = Object.freeze([
  'taskTypes',
  'exclusiveTaskTypes',
  'mutuallyExclusiveTaskTypes',
  'mutexTaskTypes'
])

function normalizeExclusiveTaskTypes(value, fieldName) {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0 || values.length > MAX_EXCLUSIVE_TASK_TYPES) {
    fail('TASK_EXCLUSIVE_TASK_TYPES_INVALID', `${fieldName} must contain between one and ${MAX_EXCLUSIVE_TASK_TYPES} task types.`)
  }
  const normalized = [...new Set(values.map((taskType) => normalizeToken(taskType, `${fieldName} entry`)))].sort()
  if (normalized.length === 0) {
    fail('TASK_EXCLUSIVE_TASK_TYPES_INVALID', `${fieldName} must contain at least one task type.`)
  }
  return normalized
}

function sameStringSet(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index])
}

function resolveExclusiveTaskTypes(source, fieldName) {
  const names = EXCLUSIVE_TASK_TYPE_OPTION_NAMES
    .filter((name) => Object.hasOwn(source, name) && source[name] !== undefined)
  if (names.length === 0) return null
  const normalized = names.map((name) => normalizeExclusiveTaskTypes(source[name], `${fieldName}.${name}`))
  if (normalized.some((value) => !sameStringSet(value, normalized[0]))) {
    fail('TASK_INPUT_INVALID', 'Exclusive task type aliases must match.')
  }
  return normalized[0]
}

function normalizeExclusiveRunInput(input, options) {
  assertOptionsObject(input, 'task input')
  assertOptionsObject(options, 'exclusive enqueue options')
  const allowedOptions = new Set(['now', ...EXCLUSIVE_TASK_TYPE_OPTION_NAMES])
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
    fail('TASK_INPUT_INVALID', 'Exclusive enqueue options contain unsupported fields.')
  }

  const taskInput = { ...input }
  const inputTaskTypes = resolveExclusiveTaskTypes(taskInput, 'task input')
  for (const name of EXCLUSIVE_TASK_TYPE_OPTION_NAMES) delete taskInput[name]
  if (!Object.hasOwn(taskInput, 'input')) {
    fail('TASK_INPUT_INVALID', 'Exclusive run input must include the complete task input payload.')
  }

  const normalized = normalizeEnqueueInput(taskInput, options.now)
  if (normalized.subjectVersionId === null) {
    fail('TASK_SUBJECT_VERSION_INVALID', 'subjectVersionId is required for an exclusive run.')
  }
  const optionTaskTypes = resolveExclusiveTaskTypes(options, 'exclusive enqueue options')
  if (inputTaskTypes && optionTaskTypes && !sameStringSet(inputTaskTypes, optionTaskTypes)) {
    fail('TASK_INPUT_INVALID', 'Exclusive task type declarations must match.')
  }
  const taskTypes = optionTaskTypes ?? inputTaskTypes ?? [normalized.taskType]
  if (!taskTypes.includes(normalized.taskType)) {
    fail('TASK_EXCLUSIVE_TASK_TYPES_INVALID', 'Exclusive task types must include the requested task type.')
  }
  return Object.freeze({ normalized, taskTypes: Object.freeze([...taskTypes]) })
}

const SELECT_COLUMNS = `
  id, idempotency_key, input_fingerprint, task_type, processor_version,
  subject_type, subject_id, subject_version_id, subject_content_sha256, input_json,
  status, execution_class, priority, available_at, lease_token, lease_owner, lease_expires_at,
  heartbeat_at, attempt_count, max_attempts, progress, result_json, error_code, error_summary,
  started_at, finished_at, created_at, updated_at`

function parseJson(value, fieldName) {
  try { return JSON.parse(value) } catch (error) {
    fail('TASK_STORE_DATA_INVALID', `${fieldName} contains invalid JSON.`, {}, error)
  }
}

function publicTask(row) {
  if (!row) return null
  return deepFreeze({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    inputFingerprint: row.input_fingerprint,
    taskType: row.task_type,
    processorVersion: row.processor_version,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectVersionId: row.subject_version_id,
    subjectContentHash: row.subject_content_sha256,
    input: parseJson(row.input_json, 'input'),
    status: row.status,
    executionClass: row.execution_class,
    priority: row.priority,
    availableAt: row.available_at,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    result: row.result_json === null ? null : parseJson(row.result_json, 'result'),
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

function readById(database, id) {
  return database.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TASK_TABLE} WHERE id = ?`).get(id)
}

function readByIdempotencyKey(database, idempotencyKey) {
  return database.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TASK_TABLE} WHERE idempotency_key = ?`)
    .get(idempotencyKey)
}

function normalizeTaskId(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value <= 0) fail('TASK_ID_INVALID', 'Task id must be a positive safe integer.')
  return value
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !GENERATED_KEY_PATTERN.test(value)) {
    fail('TASK_IDEMPOTENCY_KEY_INVALID', 'Task idempotency key is invalid.')
  }
  return value
}

function normalizeTaskActionOptions(taskOrOptions, rawOptions, allowed, fieldName) {
  let source
  if (rawOptions === undefined && isPlainObject(taskOrOptions)) {
    source = { ...taskOrOptions }
  } else {
    const id = normalizeTaskId(taskOrOptions)
    if (rawOptions === undefined) {
      source = { id }
    } else {
      assertOptionsObject(rawOptions, `${fieldName} options`)
      for (const alias of ['id', 'taskId']) {
        if (Object.hasOwn(rawOptions, alias) && normalizeTaskId(rawOptions[alias]) !== id) {
          fail('TASK_ID_INVALID', 'Task id aliases must match.')
        }
      }
      source = { ...rawOptions, id }
    }
  }
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    fail('TASK_INPUT_INVALID', `${fieldName} options contain unsupported fields.`)
  }
  const hasId = Object.hasOwn(source, 'id')
  const hasTaskId = Object.hasOwn(source, 'taskId')
  if (!hasId && !hasTaskId) fail('TASK_ID_INVALID', 'Task id is required.')
  const id = normalizeTaskId(hasId ? source.id : source.taskId)
  if (hasId && hasTaskId && normalizeTaskId(source.taskId) !== id) {
    fail('TASK_ID_INVALID', 'Task id aliases must match.')
  }
  source.id = id
  delete source.taskId
  return source
}

function runImmediateTransaction(database, callback) {
  const transaction = database.transaction(callback)
  return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction()
}

function operationNow(now) {
  return nowTimestamp(now)
}

function operationError(error, fallbackCode = 'TASK_STORE_WRITE_FAILED', fallbackMessage = 'Task operation failed.') {
  if (error instanceof TaskStoreError) throw error
  fail(fallbackCode, fallbackMessage)
}

function taskNotFound() {
  fail('TASK_NOT_FOUND', 'Task was not found.')
}

function invalidState() {
  fail('TASK_INVALID_STATE', 'Task is not in a valid state for this operation.')
}

function assertUsableLease(row, expectedStatuses, credentials, timestamp) {
  if (!row) taskNotFound()
  if (!expectedStatuses.includes(row.status)) invalidState()
  if (!credentials.owner || !credentials.token ||
    row.lease_owner !== credentials.owner || row.lease_token !== credentials.token) {
    fail('TASK_LEASE_MISMATCH', 'Lease credentials do not match.')
  }
  if (!row.lease_expires_at || row.lease_expires_at <= timestamp) {
    fail(TASK_ERROR_LEASE_EXPIRED, 'Task lease has expired.')
  }
}

function clearLeaseSql() {
  return `
    lease_token = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    heartbeat_at = NULL`
}

function normalizeLeaseNextOptions(options = {}) {
  assertOptionsObject(options, 'lease options')
  const allowed = new Set([
    'owner', 'leaseOwner', 'leaseDurationMs', 'leaseDuration', 'durationMs',
    'executionClass', 'executionClasses', 'supportedProcessors',
    'supportedProcessorIdentities', 'processorIdentities', 'now', 'tokenFactory',
    'leaseTokenFactory'
  ])
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    fail('TASK_INPUT_INVALID', 'Lease options contain unsupported fields.')
  }
  const credentials = normalizeLeaseCredentials(options, { tokenRequired: false })
  const durations = ['leaseDurationMs', 'leaseDuration', 'durationMs']
    .filter((key) => Object.hasOwn(options, key) && options[key] !== undefined)
    .map((key) => normalizeDuration(options[key], 'leaseDurationMs'))
  if (new Set(durations).size > 1) fail('TASK_DURATION_INVALID', 'Lease duration aliases must match.')
  const leaseDurationMs = durations[0] ?? DEFAULT_LEASE_DURATION_MS
  const executionClasses = normalizeExecutionClassFilter(options)
  const tokenFactories = ['tokenFactory', 'leaseTokenFactory']
    .filter((key) => Object.hasOwn(options, key) && options[key] !== undefined)
    .map((key) => options[key])
  if (tokenFactories.some((factory) => typeof factory !== 'function')) {
    fail('TASK_TOKEN_INVALID', 'Lease token factory is invalid.')
  }
  if (tokenFactories.length === 2 && tokenFactories[0] !== tokenFactories[1]) {
    fail('TASK_TOKEN_INVALID', 'Lease token factory aliases must match.')
  }
  return Object.freeze({
    owner: credentials.owner,
    leaseDurationMs,
    executionClasses,
    supportedProcessorIdentities: normalizeSupportedProcessorIdentities(options),
    now: options.now,
    tokenFactory: tokenFactories[0]
  })
}

function normalizeHeartbeatOptions(taskOrOptions, rawOptions) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken',
    'leaseDurationMs', 'leaseDuration', 'durationMs', 'now'
  ]), 'heartbeat')
  const credentials = normalizeLeaseCredentials(source)
  const durations = ['leaseDurationMs', 'leaseDuration', 'durationMs']
    .filter((key) => Object.hasOwn(source, key) && source[key] !== undefined)
    .map((key) => normalizeDuration(source[key], 'leaseDurationMs'))
  if (new Set(durations).size > 1) fail('TASK_DURATION_INVALID', 'Lease duration aliases must match.')
  return Object.freeze({
    id: source.id,
    owner: credentials.owner,
    token: credentials.token,
    leaseDurationMs: durations[0] ?? DEFAULT_LEASE_DURATION_MS,
    now: source.now
  })
}

function normalizeCredentialActionOptions(taskOrOptions, rawOptions, fieldName) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken', 'now'
  ]), fieldName)
  const credentials = normalizeLeaseCredentials(source)
  return Object.freeze({ id: source.id, owner: credentials.owner, token: credentials.token, now: source.now })
}

function normalizeProgressOptions(taskOrOptions, rawOptions) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken', 'progress', 'now'
  ]), 'updateProgress')
  const credentials = normalizeLeaseCredentials(source)
  if (!Object.hasOwn(source, 'progress')) fail('TASK_PROGRESS_INVALID', 'progress is required.')
  return Object.freeze({
    id: source.id,
    owner: credentials.owner,
    token: credentials.token,
    progress: normalizeProgress(source.progress),
    now: source.now
  })
}

function normalizeSucceedOptions(taskOrOptions, rawOptions) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken', 'result', 'now'
  ]), 'succeed')
  const credentials = normalizeLeaseCredentials(source)
  const result = Object.hasOwn(source, 'result') ? source.result : null
  return Object.freeze({
    id: source.id,
    owner: credentials.owner,
    token: credentials.token,
    resultJson: canonicalJson(result, 'result'),
    now: source.now
  })
}

function normalizeFailOptions(taskOrOptions, rawOptions) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken',
    'errorCode', 'errorSummary', 'retryAt', 'now'
  ]), 'fail')
  const credentials = normalizeLeaseCredentials(source)
  if (!Object.hasOwn(source, 'errorCode') || !Object.hasOwn(source, 'errorSummary')) {
    fail('TASK_ERROR_INVALID', 'errorCode and errorSummary are required.')
  }
  const retryAt = source.retryAt === undefined || source.retryAt === null
    ? null
    : normalizeTimestamp(source.retryAt, 'retryAt')
  return Object.freeze({
    id: source.id,
    owner: credentials.owner,
    token: credentials.token,
    errorCode: normalizeErrorCode(source.errorCode),
    errorSummary: normalizeErrorSummary(source.errorSummary),
    retryAt,
    now: source.now
  })
}

function normalizeCancelOptions(taskOrOptions, rawOptions) {
  const source = normalizeTaskActionOptions(taskOrOptions, rawOptions, new Set([
    'id', 'taskId', 'owner', 'leaseOwner', 'token', 'leaseToken', 'now'
  ]), 'cancel')
  const credentials = normalizeLeaseCredentials(source, { required: false })
  return Object.freeze({ id: source.id, owner: credentials.owner, token: credentials.token, now: source.now })
}

export function getTaskById(database, value) {
  assertDatabase(database)
  const id = normalizeTaskId(value)
  try { return publicTask(readById(database, id)) } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Task could not be read.', {}, error)
  }
}

export function getTaskByIdempotencyKey(database, value) {
  assertDatabase(database)
  const key = normalizeIdempotencyKey(value)
  try {
    const row = readByIdempotencyKey(database, key)
    return publicTask(row)
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Task could not be read.', {}, error)
  }
}

function normalizeListOptions(options = {}) {
  assertOptionsObject(options, 'list options')
  const allowed = new Set([
    'status', 'executionClass', 'taskType', 'taskTypes', 'subjectType', 'subjectId',
    'limit', 'offset', 'order'
  ])
  if (Object.keys(options).some((key) => !allowed.has(key))) fail('TASK_LIST_INPUT_INVALID', 'List options contain unsupported fields.')
  let statuses = null
  if (options.status !== undefined) {
    const rawStatuses = Array.isArray(options.status) ? options.status : [options.status]
    if (rawStatuses.length === 0 || rawStatuses.some((status) => typeof status !== 'string' || !TASK_STATUS_SET.has(status))) {
      fail('TASK_LIST_INPUT_INVALID', 'status filter is invalid.')
    }
    statuses = [...new Set(rawStatuses)]
  }
  const executionClass = options.executionClass === undefined ? null : normalizeExecutionClass(options.executionClass)
  const taskType = options.taskType === undefined ? null : normalizeToken(options.taskType, 'taskType')
  let taskTypes = null
  if (options.taskTypes !== undefined) {
    if (!Array.isArray(options.taskTypes) || options.taskTypes.length === 0 ||
      options.taskTypes.some((value) => typeof value !== 'string')) {
      fail('TASK_LIST_INPUT_INVALID', 'taskTypes filter is invalid.')
    }
    taskTypes = [...new Set(options.taskTypes.map((value) => normalizeToken(value, 'taskTypes')))]
    if (taskType !== null) fail('TASK_LIST_INPUT_INVALID', 'taskType filters cannot be combined.')
  }
  const subjectType = options.subjectType === undefined ? null : normalizeToken(options.subjectType, 'subjectType')
  const subjectId = options.subjectId === undefined ? null : normalizeSubjectId(options.subjectId)
  const limit = normalizeInteger(options.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT, defaultValue: DEFAULT_LIST_LIMIT })
  const offset = normalizeInteger(options.offset, 'offset', { min: 0, max: 1_000_000_000, defaultValue: 0 })
  const order = options.order === undefined ? 'asc' : options.order
  if (typeof order !== 'string' || !TASK_ORDER_SET.has(order)) {
    fail('TASK_LIST_INPUT_INVALID', 'order must be asc or desc.')
  }
  return { statuses, executionClass, taskType, taskTypes, subjectType, subjectId, limit, offset, order }
}

function buildListFilter(normalized) {
  const clauses = []
  const parameters = []
  if (normalized.statuses) {
    clauses.push(`status IN (${normalized.statuses.map(() => '?').join(', ')})`)
    parameters.push(...normalized.statuses)
  }
  if (normalized.executionClass !== null) { clauses.push('execution_class = ?'); parameters.push(normalized.executionClass) }
  if (normalized.taskTypes !== null) {
    clauses.push(`task_type IN (${normalized.taskTypes.map(() => '?').join(', ')})`)
    parameters.push(...normalized.taskTypes)
  } else if (normalized.taskType !== null) {
    clauses.push('task_type = ?')
    parameters.push(normalized.taskType)
  }
  if (normalized.subjectType !== null) { clauses.push('subject_type = ?'); parameters.push(normalized.subjectType) }
  if (normalized.subjectId !== null) { clauses.push('subject_id = ?'); parameters.push(normalized.subjectId) }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, parameters }
}

export function listTasks(database, options = {}) {
  assertDatabase(database)
  const normalized = normalizeListOptions(options)
  const { where, parameters } = buildListFilter(normalized)
  try {
    const rows = database.prepare(`
      SELECT ${SELECT_COLUMNS}
        FROM ${TASK_TABLE}
        ${where}
       ORDER BY id ${normalized.order.toUpperCase()}
       LIMIT ? OFFSET ?
    `).all(...parameters, normalized.limit, normalized.offset)
    return Object.freeze(rows.map(publicTask))
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Tasks could not be listed.', {}, error)
  }
}

export function countTasks(database, options = {}) {
  assertDatabase(database)
  const normalized = normalizeListOptions(options)
  const { where, parameters } = buildListFilter(normalized)
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS total
        FROM ${TASK_TABLE}
        ${where}
    `).get(...parameters)
    return Number(row?.total ?? 0)
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Task count could not be read.', {}, error)
  }
}

function cleanupCutoffAt(previewedAt, retentionDays, fieldName) {
  const milliseconds = Date.parse(previewedAt) - retentionDays * TASK_CLEANUP_DAY_MS
  if (!Number.isSafeInteger(milliseconds)) {
    fail('TASK_CLEANUP_INPUT_INVALID', `${fieldName} is outside the supported range.`)
  }
  const cutoff = new Date(milliseconds)
  if (Number.isNaN(cutoff.getTime())) {
    fail('TASK_CLEANUP_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return cutoff.toISOString()
}

function cleanupPolicy(previewedAt) {
  const cutoffAt = Object.fromEntries(
    Object.entries(TASK_CLEANUP_RETENTION_DAYS)
      .map(([status, retentionDays]) => [
        status,
        cleanupCutoffAt(previewedAt, retentionDays, `${status} cutoff`)
      ])
  )
  return deepFreeze({
    retentionDays: { ...TASK_CLEANUP_RETENTION_DAYS },
    cutoffAt,
    batchLimit: TASK_CLEANUP_BATCH_LIMIT
  })
}

function cleanupEligibilityClause(policy) {
  return {
    sql: `(
      (status = 'succeeded' AND finished_at IS NOT NULL AND finished_at <= ?)
      OR (status = 'failed' AND finished_at IS NOT NULL AND finished_at <= ?)
      OR (status = 'cancelled' AND finished_at IS NOT NULL AND finished_at <= ?)
    )`,
    parameters: [
      policy.cutoffAt.succeeded,
      policy.cutoffAt.failed,
      policy.cutoffAt.cancelled
    ]
  }
}

function countEligibleTasks(database, policy) {
  const clause = cleanupEligibilityClause(policy)
  const row = database.prepare(`
    SELECT COUNT(*) AS total
      FROM ${TASK_TABLE}
     WHERE ${clause.sql}
  `).get(...clause.parameters)
  const total = Number(row?.total ?? 0)
  if (!Number.isSafeInteger(total) || total < 0) {
    fail('TASK_CLEANUP_DATA_INVALID', 'Task cleanup count is invalid.')
  }
  return total
}

function selectEligibleTaskIds(database, policy, limit) {
  const clause = cleanupEligibilityClause(policy)
  return database.prepare(`
    SELECT id
      FROM ${TASK_TABLE}
     WHERE ${clause.sql}
     ORDER BY finished_at ASC, id ASC
     LIMIT ?
  `).all(...clause.parameters, limit).map(({ id }) => id)
}

function normalizeTaskCleanupPreviewOptions(options = {}) {
  assertOptionsObject(options, 'task cleanup preview options')
  if (Object.keys(options).some((key) => key !== 'now')) {
    fail('TASK_CLEANUP_INPUT_INVALID', 'Task cleanup preview options contain unsupported fields.')
  }
  return Object.freeze({ now: options.now })
}

function normalizeTaskCleanupExecuteOptions(options = {}) {
  assertOptionsObject(options, 'task cleanup execute options')
  const allowed = new Set(['previewedAt', 'expectedCount', 'now'])
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    fail('TASK_CLEANUP_INPUT_INVALID', 'Task cleanup execute options contain unsupported fields.')
  }
  if (!Object.hasOwn(options, 'previewedAt')) {
    fail('TASK_CLEANUP_INPUT_INVALID', 'previewedAt is required.')
  }
  if (!Object.hasOwn(options, 'expectedCount')) {
    fail('TASK_CLEANUP_INPUT_INVALID', 'expectedCount is required.')
  }
  let expectedCount
  try {
    expectedCount = normalizeInteger(options.expectedCount, 'expectedCount', { min: 0 })
  } catch (error) {
    if (error instanceof TaskStoreError && error.code === 'TASK_NUMBER_INVALID') {
      fail('TASK_CLEANUP_INPUT_INVALID', 'expectedCount is invalid.')
    }
    throw error
  }
  return Object.freeze({
    previewedAt: normalizeTimestamp(options.previewedAt, 'previewedAt'),
    expectedCount,
    now: options.now
  })
}

export function previewTaskCleanup(database, options = {}, dependencies = {}) {
  assertDatabase(database)
  const normalized = normalizeTaskCleanupPreviewOptions(options)
  const previewedAt = operationTimestamp(normalized.now, dependencies.now)
  const policy = cleanupPolicy(previewedAt)
  try {
    const eligibleCount = countEligibleTasks(database, policy)
    return deepFreeze({
      previewedAt,
      eligibleCount,
      selectedCount: Math.min(eligibleCount, TASK_CLEANUP_BATCH_LIMIT),
      policy
    })
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_CLEANUP_READ_FAILED', 'Task cleanup preview could not be read.', {}, error)
  }
}

export function executeTaskCleanup(database, options = {}, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeTaskCleanupExecuteOptions(options)
  const executedAt = operationTimestamp(normalized.now, dependencies.now)
  if (Date.parse(normalized.previewedAt) > Date.parse(executedAt)) {
    fail('TASK_CLEANUP_INPUT_INVALID', 'previewedAt cannot be in the future.')
  }
  const policy = cleanupPolicy(normalized.previewedAt)
  try {
    const outcome = runImmediateTransaction(database, () => {
      const eligibleCount = countEligibleTasks(database, policy)
      if (eligibleCount !== normalized.expectedCount) {
        fail('TASK_CLEANUP_CONFLICT', 'Task cleanup preview no longer matches current history.')
      }

      const selectedCount = Math.min(eligibleCount, TASK_CLEANUP_BATCH_LIMIT)
      if (selectedCount === 0) {
        return { eligibleCount, selectedCount, deletedCount: 0 }
      }

      const ids = selectEligibleTaskIds(database, policy, selectedCount)
      if (ids.length !== selectedCount) {
        fail('TASK_CLEANUP_CONFLICT', 'Task cleanup selection no longer matches current history.')
      }
      const clause = cleanupEligibilityClause(policy)
      const placeholders = ids.map(() => '?').join(', ')
      const deleted = database.prepare(`
        DELETE FROM ${TASK_TABLE}
         WHERE id IN (${placeholders})
           AND ${clause.sql}
      `).run(...ids, ...clause.parameters)
      if (deleted.changes !== selectedCount) {
        fail('TASK_CLEANUP_CONFLICT', 'Task cleanup deletion no longer matches current history.')
      }
      return { eligibleCount, selectedCount, deletedCount: deleted.changes }
    })
    return deepFreeze({
      previewedAt: normalized.previewedAt,
      executedAt,
      eligibleCount: outcome.eligibleCount,
      selectedCount: outcome.selectedCount,
      deletedCount: outcome.deletedCount,
      policy
    })
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_CLEANUP_WRITE_FAILED', 'Task cleanup could not be executed.', {}, error)
  }
}

function verifyIdempotentTaskInput(existing, normalized) {
  if (!existing) fail('TASK_STORE_WRITE_FAILED', 'Task could not be enqueued.')
  if (existing.input_fingerprint !== normalized.inputFingerprint) {
    fail('TASK_IDEMPOTENCY_CONFLICT', 'Idempotency key is bound to different task input.', {
      idempotencyKey: normalized.idempotencyKey,
      existingInputFingerprint: existing.input_fingerprint,
      requestedInputFingerprint: normalized.inputFingerprint
    })
  }
}

function insertNormalizedTask(database, normalized) {
  const insert = database.prepare(`
    INSERT INTO ${TASK_TABLE} (
      idempotency_key, input_fingerprint, task_type, processor_version,
      subject_type, subject_id, subject_version_id, subject_content_sha256,
      input_json, status, execution_class, priority, available_at, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(
    normalized.idempotencyKey,
    normalized.inputFingerprint,
    normalized.taskType,
    normalized.processorVersion,
    normalized.subjectType,
    normalized.subjectId,
    normalized.subjectVersionId,
    normalized.subjectContentSha256,
    normalized.inputJson,
    normalized.status,
    normalized.executionClass,
    normalized.priority,
    normalized.availableAt,
    normalized.maxAttempts,
    normalized.createdAt,
    normalized.updatedAt
  )
  const existing = readByIdempotencyKey(database, normalized.idempotencyKey)
  verifyIdempotentTaskInput(existing, normalized)
  return { row: existing, created: insert.changes === 1 }
}

function enqueueNormalizedTask(database, normalized) {
  return insertNormalizedTask(database, normalized)
}

export function enqueueTask(database, input, options = {}) {
  assertDatabase(database, true)
  assertOptionsObject(options, 'enqueue options')
  const allowedOptions = new Set(['now'])
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) fail('TASK_INPUT_INVALID', 'Enqueue options contain unsupported fields.')
  const normalized = normalizeEnqueueInput(input, options.now)
  try {
    const outcome = database.transaction(() => enqueueNormalizedTask(database, normalized))()
    return Object.freeze({ task: publicTask(outcome.row), created: outcome.created })
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_WRITE_FAILED', 'Task could not be enqueued.', {}, error)
  }
}

export function enqueueExclusiveRun(database, input, options = {}) {
  assertDatabase(database, true)
  const { normalized, taskTypes } = normalizeExclusiveRunInput(input, options)
  try {
    const outcome = runImmediateTransaction(database, () => {
      const existing = readByIdempotencyKey(database, normalized.idempotencyKey)
      if (existing) {
        verifyIdempotentTaskInput(existing, normalized)
        return { row: existing, created: false, outcome: 'idempotent' }
      }

      const active = database.prepare(`
        SELECT ${SELECT_COLUMNS}
          FROM ${TASK_TABLE}
         WHERE subject_type = ?
           AND subject_id = ?
           AND task_type IN (${taskTypes.map(() => '?').join(', ')})
           AND status IN ('pending', 'leased', 'running')
         ORDER BY id ASC
         LIMIT 1
      `).get(normalized.subjectType, normalized.subjectId, ...taskTypes)
      if (active) return { row: active, created: false, outcome: 'active-conflict' }

      return { ...enqueueNormalizedTask(database, normalized), outcome: 'created' }
    })
    return Object.freeze({
      task: publicTask(outcome.row),
      created: outcome.created,
      outcome: outcome.outcome,
      activeConflict: outcome.outcome === 'active-conflict'
    })
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_WRITE_FAILED', 'Exclusive task could not be enqueued.', {}, error)
  }
}

const defaultLeaseTokenFactory = () => randomBytes(32).toString('base64url')
const LEASE_EXPIRED_SUMMARY = 'Task lease expired before completion.'

function supportedProcessorClause(identities) {
  if (identities === null) return { sql: '', parameters: [] }
  if (identities.length === 0) return { sql: ' AND 0 = 1', parameters: [] }
  const clauses = identities.map(() => '(task_type = ? AND processor_version = ? AND execution_class = ?)')
  return {
    sql: ` AND (${clauses.join(' OR ')})`,
    parameters: identities.flatMap(({ taskType, processorVersion, executionClass }) => [
      taskType,
      processorVersion,
      executionClass
    ])
  }
}

function operationTimestamp(rawNow, fallbackNow) {
  return operationNow(rawNow === undefined ? fallbackNow : rawNow)
}

function protectedUpdate(database, sql, parameters, failureMessage = 'Task operation could not be applied.') {
  const outcome = database.prepare(sql).run(...parameters)
  if (outcome.changes !== 1) fail('TASK_STATE_CONFLICT', failureMessage)
}

function generatedLeaseToken(tokenFactory) {
  let value
  try {
    value = tokenFactory()
  } catch {
    fail('TASK_TOKEN_INVALID', 'Lease token generation failed.')
  }
  return normalizeLeaseCredentialToken(value, 'leaseToken', 'TASK_TOKEN_INVALID')
}

export function leaseNext(database, options = {}, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeLeaseNextOptions(options)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  const tokenFactory = normalized.tokenFactory ?? dependencies.tokenFactory ?? defaultLeaseTokenFactory
  if (typeof tokenFactory !== 'function') fail('TASK_TOKEN_INVALID', 'Lease token factory is invalid.')
  try {
    const row = runImmediateTransaction(database, () => {
      const classClause = normalized.executionClasses
        ? ` AND execution_class IN (${normalized.executionClasses.map(() => '?').join(', ')})`
        : ''
      const processorClause = supportedProcessorClause(normalized.supportedProcessorIdentities)
      const selectionParameters = [
        timestamp,
        ...normalized.executionClasses ?? [],
        ...processorClause.parameters
      ]
      const candidate = database.prepare(`
        SELECT id
          FROM ${TASK_TABLE}
         WHERE status = 'pending'
           AND available_at <= ?
           AND attempt_count < max_attempts
           ${classClause}
           ${processorClause.sql}
         ORDER BY priority DESC, available_at ASC, id ASC
         LIMIT 1
      `).get(...selectionParameters)
      if (!candidate) return null

      const leaseToken = generatedLeaseToken(tokenFactory)
      const leaseExpiresAt = timestampAfter(timestamp, normalized.leaseDurationMs)
      const update = database.prepare(`
        UPDATE ${TASK_TABLE}
           SET status = 'leased',
               lease_token = ?,
               lease_owner = ?,
               lease_expires_at = ?,
               heartbeat_at = ?,
               attempt_count = attempt_count + 1,
               progress = 0,
               result_json = NULL,
               started_at = NULL,
               finished_at = NULL,
               updated_at = ?
         WHERE id = ?
           AND status = 'pending'
           AND available_at <= ?
           AND attempt_count < max_attempts
           ${classClause}
           ${processorClause.sql}
      `).run(
        leaseToken,
        normalized.owner,
        leaseExpiresAt,
        timestamp,
        timestamp,
        candidate.id,
        timestamp,
        ...normalized.executionClasses ?? [],
        ...processorClause.parameters
      )
      if (update.changes !== 1) return null
      return readById(database, candidate.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function markRunning(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeCredentialActionOptions(taskOrOptions, rawOptions, 'markRunning')
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const row = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      assertUsableLease(current, [TASK_STATUS_LEASED], normalized, timestamp)
      protectedUpdate(database, `
        UPDATE ${TASK_TABLE}
           SET status = 'running',
               started_at = ?,
               heartbeat_at = ?,
               updated_at = ?
         WHERE id = ?
           AND status = 'leased'
           AND lease_owner = ?
           AND lease_token = ?
           AND lease_expires_at > ?
      `, [
        timestamp, timestamp, timestamp, normalized.id,
        normalized.owner, normalized.token, timestamp
      ])
      return readById(database, normalized.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function heartbeat(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeHeartbeatOptions(taskOrOptions, rawOptions)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const row = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      assertUsableLease(current, [TASK_STATUS_LEASED, TASK_STATUS_RUNNING], normalized, timestamp)
      const requestedExpiry = timestampAfter(timestamp, normalized.leaseDurationMs)
      const leaseExpiresAt = current.lease_expires_at > requestedExpiry
        ? current.lease_expires_at
        : requestedExpiry
      protectedUpdate(database, `
        UPDATE ${TASK_TABLE}
           SET lease_expires_at = ?,
               heartbeat_at = ?,
               updated_at = ?
         WHERE id = ?
           AND status IN ('leased', 'running')
           AND lease_owner = ?
           AND lease_token = ?
           AND lease_expires_at > ?
      `, [
        leaseExpiresAt, timestamp, timestamp, normalized.id,
        normalized.owner, normalized.token, timestamp
      ])
      return readById(database, normalized.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function updateProgress(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeProgressOptions(taskOrOptions, rawOptions)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const row = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      assertUsableLease(current, [TASK_STATUS_RUNNING], normalized, timestamp)
      protectedUpdate(database, `
        UPDATE ${TASK_TABLE}
           SET progress = ?,
               updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_token = ?
           AND lease_expires_at > ?
      `, [
        normalized.progress, timestamp, normalized.id,
        normalized.owner, normalized.token, timestamp
      ])
      return readById(database, normalized.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function succeed(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeSucceedOptions(taskOrOptions, rawOptions)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const row = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      assertUsableLease(current, [TASK_STATUS_RUNNING], normalized, timestamp)
      protectedUpdate(database, `
        UPDATE ${TASK_TABLE}
           SET status = 'succeeded',
               result_json = ?,
               progress = 100,
               error_code = NULL,
               error_summary = NULL,
               finished_at = ?,
               ${clearLeaseSql()},
               updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_token = ?
           AND lease_expires_at > ?
      `, [
        normalized.resultJson, timestamp, timestamp, normalized.id,
        normalized.owner, normalized.token, timestamp
      ])
      return readById(database, normalized.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function failTask(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeFailOptions(taskOrOptions, rawOptions)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const outcome = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      assertUsableLease(current, [TASK_STATUS_LEASED, TASK_STATUS_RUNNING], normalized, timestamp)
      const retryScheduled = current.attempt_count < current.max_attempts && normalized.retryAt !== null
      const status = retryScheduled ? TASK_STATUS_PENDING : TASK_STATUS_FAILED
      const finishedAt = retryScheduled ? null : timestamp
      const availableAt = retryScheduled ? normalized.retryAt : current.available_at
      protectedUpdate(database, `
        UPDATE ${TASK_TABLE}
           SET status = ?,
               available_at = ?,
               progress = 0,
               error_code = ?,
               error_summary = ?,
               started_at = CASE WHEN ? = 'pending' THEN NULL ELSE started_at END,
               finished_at = ?,
               ${clearLeaseSql()},
               updated_at = ?
         WHERE id = ?
           AND status IN ('leased', 'running')
           AND lease_owner = ?
           AND lease_token = ?
           AND lease_expires_at > ?
      `, [
        status, availableAt, normalized.errorCode, normalized.errorSummary,
        status, finishedAt, timestamp, normalized.id,
        normalized.owner, normalized.token, timestamp
      ])
      return { row: readById(database, normalized.id), retryScheduled }
    })
    return Object.freeze({ task: publicTask(outcome.row), retryScheduled: outcome.retryScheduled })
  } catch (error) {
    operationError(error)
  }
}

export function cancel(database, taskOrOptions, rawOptions, dependencies = {}) {
  assertDatabase(database, true)
  const normalized = normalizeCancelOptions(taskOrOptions, rawOptions)
  const timestamp = operationTimestamp(normalized.now, dependencies.now)
  try {
    const row = runImmediateTransaction(database, () => {
      const current = readById(database, normalized.id)
      if (!current) taskNotFound()
      if (current.status === TASK_STATUS_PENDING) {
        protectedUpdate(database, `
          UPDATE ${TASK_TABLE}
             SET status = 'cancelled',
                 finished_at = ?,
                 ${clearLeaseSql()},
                 updated_at = ?
           WHERE id = ?
             AND status = 'pending'
        `, [timestamp, timestamp, normalized.id])
      } else {
        assertUsableLease(current, [TASK_STATUS_LEASED, TASK_STATUS_RUNNING], normalized, timestamp)
        protectedUpdate(database, `
          UPDATE ${TASK_TABLE}
             SET status = 'cancelled',
                 finished_at = ?,
                 ${clearLeaseSql()},
                 updated_at = ?
           WHERE id = ?
             AND status IN ('leased', 'running')
             AND lease_owner = ?
             AND lease_token = ?
             AND lease_expires_at > ?
        `, [
          timestamp, timestamp, normalized.id,
          normalized.owner, normalized.token, timestamp
        ])
      }
      return readById(database, normalized.id)
    })
    return publicTask(row)
  } catch (error) {
    operationError(error)
  }
}

export function recoverExpiredLeases(database, options = {}, dependencies = {}) {
  assertDatabase(database, true)
  assertOptionsObject(options, 'recover options')
  if (Object.keys(options).some((key) => key !== 'now')) {
    fail('TASK_INPUT_INVALID', 'Recover options contain unsupported fields.')
  }
  const timestamp = operationTimestamp(options.now, dependencies.now)
  try {
    const outcome = runImmediateTransaction(database, () => {
      const expiredRows = database.prepare(`
        SELECT id, attempt_count, max_attempts
          FROM ${TASK_TABLE}
         WHERE status IN ('leased', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
         ORDER BY id ASC
      `).all(timestamp)
      const recoveredIds = []
      const failedIds = []
      const recover = database.prepare(`
        UPDATE ${TASK_TABLE}
           SET status = 'pending',
               available_at = ?,
               progress = 0,
               error_code = ?,
               error_summary = ?,
               started_at = NULL,
               finished_at = NULL,
               ${clearLeaseSql()},
               updated_at = ?
         WHERE id = ?
           AND status IN ('leased', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
      `)
      const terminate = database.prepare(`
        UPDATE ${TASK_TABLE}
           SET status = 'failed',
               progress = 0,
               error_code = ?,
               error_summary = ?,
               finished_at = ?,
               ${clearLeaseSql()},
               updated_at = ?
         WHERE id = ?
           AND status IN ('leased', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
      `)
      for (const row of expiredRows) {
        const parameters = row.attempt_count < row.max_attempts
          ? [timestamp, TASK_ERROR_LEASE_EXPIRED, LEASE_EXPIRED_SUMMARY, timestamp, row.id, timestamp]
          : [TASK_ERROR_LEASE_EXPIRED, LEASE_EXPIRED_SUMMARY, timestamp, timestamp, row.id, timestamp]
        const result = row.attempt_count < row.max_attempts
          ? recover.run(...parameters)
          : terminate.run(...parameters)
        if (result.changes !== 1) fail('TASK_STATE_CONFLICT', 'Expired task lease could not be recovered.')
        if (row.attempt_count < row.max_attempts) recoveredIds.push(row.id)
        else failedIds.push(row.id)
      }
      return { recoveredIds, failedIds }
    })
    return deepFreeze({
      recoveredCount: outcome.recoveredIds.length,
      recoveredIds: [...outcome.recoveredIds],
      failedCount: outcome.failedIds.length,
      failedIds: [...outcome.failedIds]
    })
  } catch (error) {
    operationError(error)
  }
}

export const leaseNextTask = leaseNext
export const markTaskRunning = markRunning
export const heartbeatTask = heartbeat
export const succeedTask = succeed
export const cancelTask = cancel

export class TaskStore {
  #database

  constructor(options = {}) {
    if (options && typeof options.prepare === 'function') options = { database: options }
    assertOptionsObject(options, 'TaskStore options')
    const allowed = new Set(['database', 'now', 'tokenFactory', 'leaseTokenFactory'])
    if (Object.keys(options).some((key) => !allowed.has(key))) {
      fail('TASK_STORE_INPUT_INVALID', 'TaskStore options contain unsupported fields.')
    }
    assertDatabase(options.database, true)
    if (options.now !== undefined && typeof options.now !== 'function' && !(options.now instanceof Date) && typeof options.now !== 'string') {
      fail('TASK_TIMESTAMP_INVALID', 'TaskStore now must be a Date, ISO text, or function.')
    }
    const hasTokenFactory = options.tokenFactory !== undefined
    const hasLeaseTokenFactory = options.leaseTokenFactory !== undefined
    if (hasTokenFactory && typeof options.tokenFactory !== 'function') {
      fail('TASK_TOKEN_INVALID', 'Lease token factory is invalid.')
    }
    if (hasLeaseTokenFactory && typeof options.leaseTokenFactory !== 'function') {
      fail('TASK_TOKEN_INVALID', 'Lease token factory is invalid.')
    }
    if (hasTokenFactory && hasLeaseTokenFactory && options.tokenFactory !== options.leaseTokenFactory) {
      fail('TASK_TOKEN_INVALID', 'Lease token factory aliases must match.')
    }
    this.#database = options.database
    this.now = options.now
    this.tokenFactory = options.tokenFactory ?? options.leaseTokenFactory ?? defaultLeaseTokenFactory
  }

  enqueue(input) { return enqueueTask(this.#database, input, { now: this.now }) }
  enqueueExclusiveRun(input, options = {}) {
    return enqueueExclusiveRun(this.#database, input, { ...options, now: this.now })
  }
  getById(id) { return getTaskById(this.#database, id) }
  getByIdempotencyKey(key) { return getTaskByIdempotencyKey(this.#database, key) }
  list(options) { return listTasks(this.#database, options) }
  count(options) { return countTasks(this.#database, options) }
  previewTaskCleanup(options = {}) {
    return previewTaskCleanup(this.#database, options, { now: this.now })
  }
  executeTaskCleanup(options = {}) {
    return executeTaskCleanup(this.#database, options, { now: this.now })
  }
  leaseNext(options = {}) { return leaseNext(this.#database, options, { now: this.now, tokenFactory: this.tokenFactory }) }
  markRunning(taskOrOptions, rawOptions, rawToken) {
    const options = typeof rawOptions === 'string'
      ? { owner: rawOptions, token: rawToken }
      : rawOptions
    return markRunning(this.#database, taskOrOptions, options, { now: this.now })
  }
  heartbeat(taskOrOptions, rawOptions, rawToken, rawDuration) {
    const options = typeof rawOptions === 'string'
      ? {
          owner: rawOptions,
          token: rawToken,
          ...(rawDuration === undefined ? {} : { leaseDurationMs: rawDuration })
        }
      : rawOptions
    return heartbeat(this.#database, taskOrOptions, options, { now: this.now })
  }
  updateProgress(taskOrOptions, rawOptions, rawToken, rawProgress) {
    const options = typeof rawOptions === 'string'
      ? { owner: rawOptions, token: rawToken, progress: rawProgress }
      : rawProgress === undefined || !isPlainObject(rawOptions)
        ? rawOptions
        : { ...rawOptions, progress: rawToken }
    return updateProgress(this.#database, taskOrOptions, options, { now: this.now })
  }
  succeed(taskOrOptions, rawOptions, rawTokenOrResult, rawResult) {
    const options = typeof rawOptions === 'string'
      ? { owner: rawOptions, token: rawTokenOrResult, result: rawResult }
      : rawTokenOrResult === undefined || !isPlainObject(rawOptions)
        ? rawOptions
        : { ...rawOptions, result: rawTokenOrResult }
    return succeed(this.#database, taskOrOptions, options, { now: this.now })
  }
  fail(taskOrOptions, rawOptions, rawTokenOrFailure, rawFailure) {
    const options = typeof rawOptions === 'string'
      ? { owner: rawOptions, token: rawTokenOrFailure, ...(isPlainObject(rawFailure) ? rawFailure : {}) }
      : (rawTokenOrFailure === undefined && rawFailure === undefined) || !isPlainObject(rawOptions)
        ? rawOptions
        : { ...rawOptions, ...(isPlainObject(rawFailure) ? rawFailure : rawTokenOrFailure) }
    return failTask(this.#database, taskOrOptions, options, { now: this.now })
  }
  cancel(taskOrOptions, rawOptions, rawToken) {
    const options = typeof rawOptions === 'string'
      ? { owner: rawOptions, token: rawToken }
      : rawOptions
    return cancel(this.#database, taskOrOptions, options, { now: this.now })
  }
  recoverExpiredLeases(options = {}) {
    return recoverExpiredLeases(this.#database, options, { now: this.now })
  }
}

export function createTaskStore(options) {
  return new TaskStore(options)
}
