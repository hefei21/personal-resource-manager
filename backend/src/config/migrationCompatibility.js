const COMPATIBILITY_KIND = 'column'
const COMPATIBILITY_KEYS = ['kind', 'table', 'column']
const COLUMN_KEYS = ['name', 'type', 'notNull', 'defaultValue']

const COMPATIBILITY_STATUSES = Object.freeze({
  SATISFIED: 'satisfied',
  MISSING: 'missing',
  INCOMPATIBLE: 'incompatible'
})

function fail(message, details = {}) {
  throw new MigrationCompatibilityError('MIGRATION_COMPATIBILITY_INVALID', message, details)
}

function assertPlainObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${fieldName} must be an object.`)
  }
}

function assertExactKeys(value, expectedKeys, fieldName) {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    fail(`${fieldName} contains unsupported or missing fields.`)
  }
}

function normalizeRequiredText(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${fieldName} must be non-empty text.`)
  }
  return value.trim()
}

/**
 * Normalize a SQLite type declaration without changing its declared type.
 * Only case and formatting whitespace around punctuation are normalized;
 * declarations such as INT and INTEGER remain distinct.
 */
export function normalizeSQLiteType(value, fieldName = 'type') {
  const text = normalizeRequiredText(value, fieldName)
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .toUpperCase()
}

/**
 * Keep default expressions conservative: SQLite supplies the stored SQL
 * expression text, so only surrounding whitespace is proven irrelevant.
 */
export function normalizeSQLiteDefaultValue(value, fieldName = 'defaultValue') {
  if (value === null) return null
  if (typeof value !== 'string') {
    fail(`${fieldName} must be null or text.`)
  }
  return value.trim()
}

/**
 * Validate and normalize the deliberately narrow, single-column condition.
 * The returned value is detached from the caller's input and deeply frozen.
 */
export function normalizeMigrationCompatibility(compatibility) {
  assertPlainObject(compatibility, 'compatibility')
  assertExactKeys(compatibility, COMPATIBILITY_KEYS, 'compatibility')
  if (compatibility.kind !== COMPATIBILITY_KIND) {
    fail(`compatibility kind must be ${COMPATIBILITY_KIND}.`)
  }

  const table = normalizeRequiredText(compatibility.table, 'compatibility.table')
  assertPlainObject(compatibility.column, 'compatibility.column')
  assertExactKeys(compatibility.column, COLUMN_KEYS, 'compatibility.column')

  const name = normalizeRequiredText(compatibility.column.name, 'compatibility.column.name')
  const type = normalizeSQLiteType(compatibility.column.type, 'compatibility.column.type')
  if (typeof compatibility.column.notNull !== 'boolean') {
    fail('compatibility.column.notNull must be boolean.')
  }
  const defaultValue = normalizeSQLiteDefaultValue(
    compatibility.column.defaultValue,
    'compatibility.column.defaultValue'
  )

  return Object.freeze({
    kind: COMPATIBILITY_KIND,
    table,
    column: Object.freeze({
      name,
      type,
      notNull: compatibility.column.notNull,
      defaultValue
    })
  })
}

function summary(status, compatibility, reason) {
  return Object.freeze({
    status,
    kind: compatibility.kind,
    table: compatibility.table,
    column: compatibility.column.name,
    reason
  })
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new MigrationCompatibilityError(
      'MIGRATION_COMPATIBILITY_DATABASE_INVALID',
      'SQLite schema compatibility requires a database connection.'
    )
  }
}

function columnMatches(actual, expected) {
  if (typeof actual.name !== 'string' || typeof actual.type !== 'string') return false
  const actualType = actual.type.trim().length === 0
    ? ''
    : normalizeSQLiteType(actual.type, 'SQLite column type')
  const actualDefault = actual.dflt_value === null || typeof actual.dflt_value === 'string'
    ? normalizeSQLiteDefaultValue(actual.dflt_value, 'SQLite column default')
    : undefined

  return (
    actual.name === expected.name &&
    actualType === expected.type &&
    Number(actual.notnull) === (expected.notNull ? 1 : 0) &&
    Number(actual.hidden) === 0 &&
    actualDefault === expected.defaultValue
  )
}

/**
 * Read-only proof of one migration's schema postcondition.
 *
 * The fixed SQL statements use bound values for identifiers. No migration
 * source, schema-writing pragma, callback, or application row is involved.
 */
export function checkMigrationCompatibility(database, compatibility) {
  assertDatabase(database)
  const normalized = normalizeMigrationCompatibility(compatibility)

  try {
    const table = database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(normalized.table)
    if (!table) {
      return summary(COMPATIBILITY_STATUSES.INCOMPATIBLE, normalized, 'table-missing')
    }

    const column = database
      .prepare(
        'SELECT name, type, notnull, dflt_value, hidden FROM pragma_table_xinfo(?) WHERE name = ?'
      )
      .get(normalized.table, normalized.column.name)
    if (!column) {
      return summary(COMPATIBILITY_STATUSES.MISSING, normalized, 'column-missing')
    }

    if (!columnMatches(column, normalized.column)) {
      return summary(COMPATIBILITY_STATUSES.INCOMPATIBLE, normalized, 'column-incompatible')
    }

    return summary(COMPATIBILITY_STATUSES.SATISFIED, normalized, 'matched')
  } catch {
    throw new MigrationCompatibilityError(
      'MIGRATION_COMPATIBILITY_CHECK_FAILED',
      'SQLite schema compatibility check failed.'
    )
  }
}

export class MigrationCompatibilityError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MigrationCompatibilityError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export { COMPATIBILITY_KIND, COMPATIBILITY_STATUSES }
