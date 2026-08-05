const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9][a-z0-9._-]*$/
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SAFE_ERROR_SUMMARY_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,127}$/

export const MIGRATION_ATTEMPT_STARTED = 'started'
export const MIGRATION_ATTEMPT_APPLIED = 'applied'
export const MIGRATION_ATTEMPT_FAILED = 'failed'
export const MIGRATION_ATTEMPT_INTERRUPTED = 'interrupted'

export const MIGRATION_ERROR_CATEGORIES = Object.freeze([
  'checksum',
  'database',
  'interrupted',
  'lock',
  'migration',
  'startup',
  'timeout',
  'validation'
])

const MIGRATION_ATTEMPT_STATUSES = new Set([
  MIGRATION_ATTEMPT_STARTED,
  MIGRATION_ATTEMPT_APPLIED,
  MIGRATION_ATTEMPT_FAILED,
  MIGRATION_ATTEMPT_INTERRUPTED
])
const MIGRATION_ERROR_CATEGORY_SET = new Set(MIGRATION_ERROR_CATEGORIES)

const CONTROL_TABLES = Object.freeze({
  migrations: 'prm_schema_migrations',
  attempts: 'prm_migration_attempts'
})

const MIGRATION_TABLE_COLUMNS = Object.freeze([
  { name: 'migration_id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'checksum', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0 }
])

const ATTEMPT_TABLE_COLUMNS = Object.freeze([
  { name: 'attempt_id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'migration_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'checksum', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'started_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'finished_at', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'error_category', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'error_summary', type: 'TEXT', notnull: 0, pk: 0 }
])

const CREATE_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS prm_schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    checksum TEXT NOT NULL
      CHECK (length(checksum) = 64)
      CHECK (checksum NOT GLOB '*[^0-9a-f]*'),
    applied_at TEXT NOT NULL
  )
`

const CREATE_ATTEMPTS_SQL = `
  CREATE TABLE IF NOT EXISTS prm_migration_attempts (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_id TEXT NOT NULL,
    checksum TEXT NOT NULL
      CHECK (length(checksum) = 64)
      CHECK (checksum NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL
      CHECK (status IN ('started', 'applied', 'failed', 'interrupted')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_category TEXT,
    error_summary TEXT,
    CHECK (
      (status = 'started' AND finished_at IS NULL
        AND error_category IS NULL AND error_summary IS NULL)
      OR
      (status = 'applied' AND finished_at IS NOT NULL
        AND error_category IS NULL AND error_summary IS NULL)
      OR
      (status IN ('failed', 'interrupted') AND finished_at IS NOT NULL
        AND error_category IS NOT NULL AND error_summary IS NOT NULL)
    )
  )
`

export class MigrationControlStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MigrationControlStoreError'
    this.code = code
  }
}

function fail(code, message) {
  throw new MigrationControlStoreError(code, message)
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== 'function' ||
    typeof database.exec !== 'function' ||
    typeof database.transaction !== 'function'
  ) {
    fail('MIGRATION_CONTROL_DATABASE_INVALID', 'A better-sqlite3 database connection is required.')
  }
}

function assertObject(value, message = 'Input must be an object.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('MIGRATION_CONTROL_INPUT_INVALID', message)
  }
}

function assertMigrationId(migrationId) {
  if (typeof migrationId !== 'string' || !MIGRATION_ID_PATTERN.test(migrationId)) {
    fail('MIGRATION_ID_INVALID', 'Migration id has an invalid format.')
  }
}

function assertChecksum(checksum) {
  if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    fail('MIGRATION_CHECKSUM_INVALID', 'Migration checksum must be a lowercase SHA-256 digest.')
  }
}

function assertTimestamp(timestamp, fieldName) {
  if (
    typeof timestamp !== 'string' ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    fail('MIGRATION_TIMESTAMP_INVALID', `${fieldName} must be an ISO-8601 UTC timestamp.`)
  }
}

function timestampOrNow(timestamp, fieldName) {
  const resolved = timestamp ?? new Date().toISOString()
  assertTimestamp(resolved, fieldName)
  return resolved
}

function assertAttemptStatus(status) {
  if (!MIGRATION_ATTEMPT_STATUSES.has(status)) {
    fail('MIGRATION_ATTEMPT_STATUS_INVALID', 'Migration attempt status is not supported.')
  }
}

function assertTerminalStatus(status) {
  assertAttemptStatus(status)
  if (status === MIGRATION_ATTEMPT_STARTED) {
    fail('MIGRATION_ATTEMPT_TRANSITION_INVALID', 'An attempt can only finish as applied, failed or interrupted.')
  }
}

function assertErrorCategory(errorCategory) {
  if (!MIGRATION_ERROR_CATEGORY_SET.has(errorCategory)) {
    fail('MIGRATION_ERROR_CATEGORY_INVALID', 'Migration error category is not supported.')
  }
}

/**
 * Only a bounded machine-readable code is accepted as an error summary.
 * Callers must map raw exceptions to a safe code before calling this module.
 */
function assertSafeErrorSummary(safeErrorSummary) {
  if (
    typeof safeErrorSummary !== 'string' ||
    !SAFE_ERROR_SUMMARY_PATTERN.test(safeErrorSummary)
  ) {
    fail(
      'MIGRATION_ERROR_SUMMARY_INVALID',
      'Migration error summary must be a bounded machine-readable code.'
    )
  }
}

function publicMigrationRecord(row) {
  return Object.freeze({
    migrationId: row.migration_id,
    checksum: row.checksum,
    appliedAt: row.applied_at
  })
}

function publicAttemptRecord(row) {
  return Object.freeze({
    attemptId: row.attempt_id,
    migrationId: row.migration_id,
    checksum: row.checksum,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCategory: row.error_category,
    errorSummary: row.error_summary
  })
}

function matchesTerminalAttempt(record, input, finishedAt) {
  return record &&
    record.status === input.status &&
    record.finishedAt === finishedAt &&
    record.errorCategory === (input.errorCategory ?? null) &&
    record.errorSummary === (input.safeErrorSummary ?? null)
}

function tableInfo(database, tableName) {
  return database.pragma(`table_info(${tableName})`)
}

function normalizedTableSql(database, tableName) {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName)
  return String(row?.sql ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function assertColumns(database, tableName, expectedColumns) {
  const actual = tableInfo(database, tableName).map(({ name, type, notnull, pk }) => ({
    name,
    type: String(type).toUpperCase(),
    notnull,
    pk
  }))

  if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
    fail('MIGRATION_CONTROL_SCHEMA_INVALID', `Control table ${tableName} has an incompatible schema.`)
  }
}

function assertSchema(database, tableName, expectedColumns, requiredMarkers) {
  assertColumns(database, tableName, expectedColumns)
  const sql = normalizedTableSql(database, tableName)
  if (!sql || requiredMarkers.some((marker) => !sql.includes(marker))) {
    fail('MIGRATION_CONTROL_SCHEMA_INVALID', `Control table ${tableName} has incompatible constraints.`)
  }
}

function assertControlTables(database) {
  assertSchema(database, CONTROL_TABLES.migrations, MIGRATION_TABLE_COLUMNS, [
    'primary key',
    'check (length(checksum) = 64)',
    "check (checksum not glob '*[^0-9a-f]*')"
  ])
  assertSchema(database, CONTROL_TABLES.attempts, ATTEMPT_TABLE_COLUMNS, [
    'primary key autoincrement',
    "check (status in ('started', 'applied', 'failed', 'interrupted'))",
    'status = \'started\' and finished_at is null',
    'status = \'applied\' and finished_at is not null',
    "status in ('failed', 'interrupted') and finished_at is not null"
  ])
}

/**
 * Create and validate only the new control tables. Existing legacy
 * `schema_migrations` is intentionally neither inspected nor changed here.
 */
export function ensureMigrationControlTables(database) {
  assertDatabase(database)
  database.transaction(() => {
    database.exec(CREATE_MIGRATIONS_SQL)
    database.exec(CREATE_ATTEMPTS_SQL)
    assertControlTables(database)
  })()
  return database
}

export function getAppliedMigration(database, migrationId) {
  assertMigrationId(migrationId)
  assertDatabase(database)
  const row = database.prepare(
    `SELECT migration_id, checksum, applied_at
       FROM ${CONTROL_TABLES.migrations}
      WHERE migration_id = ?`
  ).get(migrationId)
  return row ? publicMigrationRecord(row) : null
}

export function listAppliedMigrations(database) {
  assertDatabase(database)
  return Object.freeze(database.prepare(`
    SELECT migration_id, checksum, applied_at
      FROM ${CONTROL_TABLES.migrations}
     ORDER BY migration_id ASC
  `).all().map(publicMigrationRecord))
}

/**
 * Insert a committed migration record. The caller owns the transaction; when
 * called inside one, the INSERT participates in that transaction.
 */
export function recordSuccessfulMigration(database, input) {
  assertObject(input, 'Migration success input must be an object.')
  const { migrationId, checksum } = input
  assertMigrationId(migrationId)
  assertChecksum(checksum)
  const appliedAt = timestampOrNow(input.appliedAt, 'appliedAt')
  assertDatabase(database)

  database.prepare(`
    INSERT INTO ${CONTROL_TABLES.migrations} (migration_id, checksum, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(migration_id) DO NOTHING
  `).run(migrationId, checksum, appliedAt)

  const record = getAppliedMigration(database, migrationId)
  if (!record) {
    fail('MIGRATION_CONTROL_WRITE_FAILED', 'Migration success record could not be confirmed.')
  }
  if (record.checksum !== checksum) {
    fail('MIGRATION_CHECKSUM_CONFLICT', 'Recorded migration checksum differs from the requested checksum.')
  }
  return record
}

export function startMigrationAttempt(database, input) {
  assertObject(input, 'Migration attempt input must be an object.')
  const { migrationId, checksum } = input
  assertMigrationId(migrationId)
  assertChecksum(checksum)
  const startedAt = timestampOrNow(input.startedAt, 'startedAt')
  assertDatabase(database)

  const result = database.prepare(`
    INSERT INTO ${CONTROL_TABLES.attempts}
      (migration_id, checksum, status, started_at)
    VALUES (?, ?, ?, ?)
  `).run(migrationId, checksum, MIGRATION_ATTEMPT_STARTED, startedAt)

  const row = database.prepare(`
    SELECT attempt_id, migration_id, checksum, status, started_at,
           finished_at, error_category, error_summary
      FROM ${CONTROL_TABLES.attempts}
     WHERE attempt_id = ?
  `).get(result.lastInsertRowid)
  if (!row) {
    fail('MIGRATION_CONTROL_WRITE_FAILED', 'Migration attempt could not be confirmed.')
  }
  return publicAttemptRecord(row)
}

export function getMigrationAttempt(database, attemptId) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    fail('MIGRATION_ATTEMPT_ID_INVALID', 'Migration attempt id must be a positive integer.')
  }
  assertDatabase(database)
  const row = database.prepare(`
    SELECT attempt_id, migration_id, checksum, status, started_at,
           finished_at, error_category, error_summary
      FROM ${CONTROL_TABLES.attempts}
     WHERE attempt_id = ?
  `).get(attemptId)
  return row ? publicAttemptRecord(row) : null
}

/**
 * Finish an attempt outside the migration transaction. For failures, the
 * summary must be a safe machine-readable code, never an Error.message.
 * Terminal rows are idempotent only when the requested final values match.
 */
export function finishMigrationAttempt(database, attemptId, input) {
  assertTerminalStatus(input?.status)
  assertObject(input, 'Migration attempt completion input must be an object.')
  const finishedAt = timestampOrNow(input.finishedAt, 'finishedAt')
  if (
    input.status === MIGRATION_ATTEMPT_FAILED ||
    input.status === MIGRATION_ATTEMPT_INTERRUPTED
  ) {
    assertErrorCategory(input.errorCategory)
    assertSafeErrorSummary(input.safeErrorSummary)
  } else if (input.errorCategory !== undefined || input.safeErrorSummary !== undefined) {
    fail('MIGRATION_ATTEMPT_INPUT_INVALID', 'Applied attempts cannot contain error details.')
  }

  const existing = getMigrationAttempt(database, attemptId)
  if (!existing) {
    fail('MIGRATION_ATTEMPT_NOT_FOUND', 'Migration attempt does not exist.')
  }
  if (Date.parse(finishedAt) < Date.parse(existing.startedAt)) {
    fail('MIGRATION_TIMESTAMP_ORDER_INVALID', 'Attempt finishedAt must not precede startedAt.')
  }

  if (existing.status !== MIGRATION_ATTEMPT_STARTED) {
    if (matchesTerminalAttempt(existing, input, finishedAt)) return existing
    fail('MIGRATION_ATTEMPT_TRANSITION_INVALID', 'Migration attempt is already finished.')
  }

  const updateResult = database.prepare(`
    UPDATE ${CONTROL_TABLES.attempts}
       SET status = ?, finished_at = ?, error_category = ?, error_summary = ?
     WHERE attempt_id = ? AND status = ?
  `).run(
    input.status,
    finishedAt,
    input.errorCategory ?? null,
    input.safeErrorSummary ?? null,
    attemptId,
    MIGRATION_ATTEMPT_STARTED
  )

  const completed = getMigrationAttempt(database, attemptId)
  if (updateResult.changes !== 1) {
    if (matchesTerminalAttempt(completed, input, finishedAt)) return completed
    fail('MIGRATION_ATTEMPT_TRANSITION_INVALID', 'Migration attempt was changed by another caller.')
  }
  if (!matchesTerminalAttempt(completed, input, finishedAt)) {
    fail('MIGRATION_ATTEMPT_TRANSITION_INVALID', 'Migration attempt could not be transitioned safely.')
  }
  return completed
}

export function listMigrationAttempts(database, options = {}) {
  assertObject(options, 'Migration attempt list options must be an object.')
  if (options.status !== undefined) assertAttemptStatus(options.status)
  assertDatabase(database)
  const rows = options.status === undefined
    ? database.prepare(`
        SELECT attempt_id, migration_id, checksum, status, started_at,
               finished_at, error_category, error_summary
          FROM ${CONTROL_TABLES.attempts}
         ORDER BY attempt_id ASC
      `).all()
    : database.prepare(`
        SELECT attempt_id, migration_id, checksum, status, started_at,
               finished_at, error_category, error_summary
          FROM ${CONTROL_TABLES.attempts}
         WHERE status = ?
         ORDER BY attempt_id ASC
      `).all(options.status)
  return Object.freeze(rows.map(publicAttemptRecord))
}

export const migrationControlTables = CONTROL_TABLES
