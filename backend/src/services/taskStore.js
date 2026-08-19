import { createHash } from 'node:crypto'

import { TASK_TABLE } from '../config/taskSchema.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const GENERATED_KEY_PATTERN = /^task:[a-f0-9]{64}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SUBJECT_ID_MAX_LENGTH = 512
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const TASK_STATUS_SET = new Set(['pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled'])
const EXECUTION_CLASS_SET = new Set(['cpu', 'disk', 'network', 'gpu'])

export const TASK_STATUS_PENDING = 'pending'
export const TASK_STATUS_LEASED = 'leased'
export const TASK_STATUS_RUNNING = 'running'
export const TASK_STATUS_SUCCEEDED = 'succeeded'
export const TASK_STATUS_FAILED = 'failed'
export const TASK_STATUS_CANCELLED = 'cancelled'

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

function normalizeExecutionClass(value) {
  const resolved = value === undefined ? 'cpu' : value
  if (typeof resolved !== 'string' || !EXECUTION_CLASS_SET.has(resolved)) {
    fail('TASK_EXECUTION_CLASS_INVALID', 'executionClass is invalid.')
  }
  return resolved
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
    const row = database.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TASK_TABLE} WHERE idempotency_key = ?`).get(key)
    return publicTask(row)
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Task could not be read.', {}, error)
  }
}

function normalizeListOptions(options = {}) {
  assertOptionsObject(options, 'list options')
  const allowed = new Set(['status', 'executionClass', 'taskType', 'subjectType', 'subjectId', 'limit', 'offset'])
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
  const subjectType = options.subjectType === undefined ? null : normalizeToken(options.subjectType, 'subjectType')
  const subjectId = options.subjectId === undefined ? null : normalizeSubjectId(options.subjectId)
  const limit = normalizeInteger(options.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT, defaultValue: DEFAULT_LIST_LIMIT })
  const offset = normalizeInteger(options.offset, 'offset', { min: 0, max: 1_000_000_000, defaultValue: 0 })
  return { statuses, executionClass, taskType, subjectType, subjectId, limit, offset }
}

export function listTasks(database, options = {}) {
  assertDatabase(database)
  const normalized = normalizeListOptions(options)
  const clauses = []
  const parameters = []
  if (normalized.statuses) {
    clauses.push(`status IN (${normalized.statuses.map(() => '?').join(', ')})`)
    parameters.push(...normalized.statuses)
  }
  if (normalized.executionClass !== null) { clauses.push('execution_class = ?'); parameters.push(normalized.executionClass) }
  if (normalized.taskType !== null) { clauses.push('task_type = ?'); parameters.push(normalized.taskType) }
  if (normalized.subjectType !== null) { clauses.push('subject_type = ?'); parameters.push(normalized.subjectType) }
  if (normalized.subjectId !== null) { clauses.push('subject_id = ?'); parameters.push(normalized.subjectId) }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  try {
    const rows = database.prepare(`
      SELECT ${SELECT_COLUMNS}
        FROM ${TASK_TABLE}
        ${where}
       ORDER BY id ASC
       LIMIT ? OFFSET ?
    `).all(...parameters, normalized.limit, normalized.offset)
    return Object.freeze(rows.map(publicTask))
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_READ_FAILED', 'Tasks could not be listed.', {}, error)
  }
}

export function enqueueTask(database, input, options = {}) {
  assertDatabase(database, true)
  assertOptionsObject(options, 'enqueue options')
  const allowedOptions = new Set(['now'])
  if (Object.keys(options).some((key) => !allowedOptions.has(key))) fail('TASK_INPUT_INVALID', 'Enqueue options contain unsupported fields.')
  const normalized = normalizeEnqueueInput(input, options.now)
  try {
    const outcome = database.transaction(() => {
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
      const existing = database.prepare(`SELECT ${SELECT_COLUMNS} FROM ${TASK_TABLE} WHERE idempotency_key = ?`)
        .get(normalized.idempotencyKey)
      if (!existing) fail('TASK_STORE_WRITE_FAILED', 'Task could not be enqueued.')
      if (existing.input_fingerprint !== normalized.inputFingerprint) {
        fail('TASK_IDEMPOTENCY_CONFLICT', 'Idempotency key is bound to different task input.', {
          idempotencyKey: normalized.idempotencyKey,
          existingInputFingerprint: existing.input_fingerprint,
          requestedInputFingerprint: normalized.inputFingerprint
        })
      }
      return { row: existing, created: insert.changes === 1 }
    })()
    return Object.freeze({ task: publicTask(outcome.row), created: outcome.created })
  } catch (error) {
    if (error instanceof TaskStoreError) throw error
    fail('TASK_STORE_WRITE_FAILED', 'Task could not be enqueued.', {}, error)
  }
}

export class TaskStore {
  constructor(options = {}) {
    if (options && typeof options.prepare === 'function') options = { database: options }
    assertOptionsObject(options, 'TaskStore options')
    assertDatabase(options.database, true)
    if (options.now !== undefined && typeof options.now !== 'function' && !(options.now instanceof Date) && typeof options.now !== 'string') {
      fail('TASK_TIMESTAMP_INVALID', 'TaskStore now must be a Date, ISO text, or function.')
    }
    this.database = options.database
    this.now = options.now
  }

  enqueue(input) { return enqueueTask(this.database, input, { now: this.now }) }
  getById(id) { return getTaskById(this.database, id) }
  getByIdempotencyKey(key) { return getTaskByIdempotencyKey(this.database, key) }
  list(options) { return listTasks(this.database, options) }
}

export function createTaskStore(options) {
  return new TaskStore(options)
}
