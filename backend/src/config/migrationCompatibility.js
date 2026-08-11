const COMPATIBILITY_KIND = 'column'
const TABLE_TRANSITION_COMPATIBILITY_KIND = 'table-transition'
const COMPATIBILITY_KEYS = ['kind', 'table', 'column']
const COLUMN_KEYS = ['name', 'type', 'notNull', 'defaultValue']
const TABLE_TRANSITION_KEYS = ['kind', 'table', 'target', 'legacy']
const TABLE_SHAPE_KEYS = ['strict', 'withoutRowid', 'columns', 'foreignKeys']
const TABLE_COLUMN_KEYS = ['name', 'type', 'notNull', 'defaultValue', 'primaryKeyPosition']
const TABLE_FOREIGN_KEY_KEYS = [
  'columns',
  'referencedTable',
  'referencedColumns',
  'onUpdate',
  'onDelete'
]
const SQLITE_FOREIGN_KEY_ACTIONS = new Set([
  'NO ACTION',
  'RESTRICT',
  'SET NULL',
  'SET DEFAULT',
  'CASCADE'
])

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

function normalizeColumnShape(column, fieldName, includePrimaryKeyPosition) {
  assertPlainObject(column, fieldName)
  assertExactKeys(
    column,
    includePrimaryKeyPosition ? TABLE_COLUMN_KEYS : COLUMN_KEYS,
    fieldName
  )

  const name = normalizeRequiredText(column.name, `${fieldName}.name`)
  const type = normalizeSQLiteType(column.type, `${fieldName}.type`)
  if (typeof column.notNull !== 'boolean') {
    fail(`${fieldName}.notNull must be boolean.`)
  }
  const defaultValue = normalizeSQLiteDefaultValue(
    column.defaultValue,
    `${fieldName}.defaultValue`
  )

  const normalized = {
    name,
    type,
    notNull: column.notNull,
    defaultValue
  }
  if (includePrimaryKeyPosition) {
    if (!Number.isSafeInteger(column.primaryKeyPosition) || column.primaryKeyPosition < 0) {
      fail(`${fieldName}.primaryKeyPosition must be a non-negative safe integer.`)
    }
    normalized.primaryKeyPosition = column.primaryKeyPosition
  }
  return Object.freeze(normalized)
}

function normalizeSQLiteForeignKeyAction(value, fieldName) {
  const normalized = normalizeRequiredText(value, fieldName)
    .replace(/\s+/g, ' ')
    .toUpperCase()
  if (!SQLITE_FOREIGN_KEY_ACTIONS.has(normalized)) {
    fail(`${fieldName} must be a supported SQLite foreign key action.`)
  }
  return normalized
}

function normalizeForeignKey(foreignKey, fieldName, localColumnNames) {
  assertPlainObject(foreignKey, fieldName)
  assertExactKeys(foreignKey, TABLE_FOREIGN_KEY_KEYS, fieldName)
  if (!Array.isArray(foreignKey.columns) || foreignKey.columns.length === 0) {
    fail(`${fieldName}.columns must be a non-empty array.`)
  }
  if (
    !Array.isArray(foreignKey.referencedColumns) ||
    foreignKey.referencedColumns.length !== foreignKey.columns.length
  ) {
    fail(`${fieldName}.referencedColumns must be a non-empty array with the same length as columns.`)
  }

  const columns = foreignKey.columns.map((column, index) => {
    const normalized = normalizeRequiredText(column, `${fieldName}.columns[${index}]`)
    if (localColumnNames && !localColumnNames.has(normalized)) {
      fail(`${fieldName}.columns[${index}] must name a declared table column.`)
    }
    return normalized
  })
  if (new Set(columns).size !== columns.length) {
    fail(`${fieldName}.columns must not contain duplicates.`)
  }

  const referencedColumns = foreignKey.referencedColumns.map((column, index) =>
    column === null
      ? null
      : normalizeRequiredText(column, `${fieldName}.referencedColumns[${index}]`)
  )
  const normalized = {
    columns,
    referencedTable: normalizeRequiredText(foreignKey.referencedTable, `${fieldName}.referencedTable`),
    referencedColumns,
    onUpdate: normalizeSQLiteForeignKeyAction(foreignKey.onUpdate, `${fieldName}.onUpdate`),
    onDelete: normalizeSQLiteForeignKeyAction(foreignKey.onDelete, `${fieldName}.onDelete`)
  }
  return Object.freeze({
    ...normalized,
    columns: Object.freeze(columns),
    referencedColumns: Object.freeze(referencedColumns)
  })
}

function foreignKeyCanonicalKey(foreignKey) {
  return JSON.stringify(foreignKey)
}

function normalizeForeignKeys(foreignKeys, fieldName, localColumnNames) {
  if (!Array.isArray(foreignKeys)) {
    fail(`${fieldName} must be an array.`)
  }
  const normalized = foreignKeys.map((foreignKey, index) =>
    normalizeForeignKey(foreignKey, `${fieldName}[${index}]`, localColumnNames)
  )
  normalized.sort((left, right) => {
    const leftKey = foreignKeyCanonicalKey(left)
    const rightKey = foreignKeyCanonicalKey(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  for (let index = 1; index < normalized.length; index += 1) {
    if (foreignKeyCanonicalKey(normalized[index - 1]) === foreignKeyCanonicalKey(normalized[index])) {
      fail(`${fieldName} contains a duplicate foreign key.`)
    }
  }
  return Object.freeze(normalized)
}

function normalizeTableShape(shape, fieldName) {
  assertPlainObject(shape, fieldName)
  assertExactKeys(shape, TABLE_SHAPE_KEYS, fieldName)
  if (typeof shape.strict !== 'boolean') fail(`${fieldName}.strict must be boolean.`)
  if (typeof shape.withoutRowid !== 'boolean') {
    fail(`${fieldName}.withoutRowid must be boolean.`)
  }
  if (!Array.isArray(shape.columns) || shape.columns.length === 0) {
    fail(`${fieldName}.columns must be a non-empty array.`)
  }

  const names = new Set()
  const primaryKeyPositions = new Set()
  const columns = Array.from(shape.columns, (column, index) => {
    const normalized = normalizeColumnShape(column, `${fieldName}.columns[${index}]`, true)
    if (names.has(normalized.name)) {
      fail(`${fieldName}.columns contains a duplicate column name.`)
    }
    names.add(normalized.name)
    if (normalized.primaryKeyPosition !== 0) {
      if (primaryKeyPositions.has(normalized.primaryKeyPosition)) {
        fail(`${fieldName}.columns contains a duplicate primary key position.`)
      }
      primaryKeyPositions.add(normalized.primaryKeyPosition)
    }
    return normalized
  })

  const sortedPrimaryKeyPositions = [...primaryKeyPositions].sort((left, right) => left - right)
  if (sortedPrimaryKeyPositions.some((position, index) => position !== index + 1)) {
    fail(`${fieldName}.columns primary key positions must be continuous from 1.`)
  }

  const foreignKeys = normalizeForeignKeys(
    shape.foreignKeys,
    `${fieldName}.foreignKeys`,
    names
  )

  return Object.freeze({
    strict: shape.strict,
    withoutRowid: shape.withoutRowid,
    columns: Object.freeze(columns),
    foreignKeys
  })
}

function normalizeTableTransitionCompatibility(compatibility) {
  assertExactKeys(compatibility, TABLE_TRANSITION_KEYS, 'compatibility')
  if (compatibility.kind !== TABLE_TRANSITION_COMPATIBILITY_KIND) {
    fail(`compatibility kind must be ${TABLE_TRANSITION_COMPATIBILITY_KIND}.`)
  }
  const table = normalizeRequiredText(compatibility.table, 'compatibility.table')
  const target = normalizeTableShape(compatibility.target, 'compatibility.target')
  if (!Array.isArray(compatibility.legacy) || compatibility.legacy.length === 0) {
    fail('compatibility.legacy must be a non-empty array.')
  }

  const legacy = Array.from(compatibility.legacy, (shape, index) =>
    normalizeTableShape(shape, `compatibility.legacy[${index}]`)
  )
  const targetKey = JSON.stringify(target)
  const legacyKeys = new Set()
  for (const shape of legacy) {
    const key = JSON.stringify(shape)
    if (key === targetKey) fail('compatibility.target must differ from every legacy shape.')
    if (legacyKeys.has(key)) fail('compatibility.legacy contains a duplicate shape.')
    legacyKeys.add(key)
  }

  return Object.freeze({
    kind: TABLE_TRANSITION_COMPATIBILITY_KIND,
    table,
    target,
    legacy: Object.freeze(legacy)
  })
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
  if (compatibility.kind === TABLE_TRANSITION_COMPATIBILITY_KIND) {
    return normalizeTableTransitionCompatibility(compatibility)
  }

  assertExactKeys(compatibility, COMPATIBILITY_KEYS, 'compatibility')
  if (compatibility.kind !== COMPATIBILITY_KIND) {
    fail(`compatibility kind must be ${COMPATIBILITY_KIND}.`)
  }

  const table = normalizeRequiredText(compatibility.table, 'compatibility.table')
  return Object.freeze({
    kind: COMPATIBILITY_KIND,
    table,
    column: normalizeColumnShape(compatibility.column, 'compatibility.column', false)
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

function tableTransitionSummary(status, compatibility, reason) {
  return Object.freeze({
    status,
    kind: compatibility.kind,
    table: compatibility.table,
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
    Number(actual.not_null) === (expected.notNull ? 1 : 0) &&
    Number(actual.hidden) === 0 &&
    actualDefault === expected.defaultValue
  )
}

function tableFlagsMatch(actual, expected) {
  if (
    !actual ||
    (actual.wr !== 0 && actual.wr !== 1) ||
    (actual.strict !== 0 && actual.strict !== 1)
  ) {
    return false
  }
  return (
    actual.strict === (expected.strict ? 1 : 0) &&
    actual.wr === (expected.withoutRowid ? 1 : 0)
  )
}

function tableColumnMatches(actual, expected, index) {
  if (!actual || actual.cid !== index) return false
  if (!columnMatches(actual, expected)) return false
  return Number(actual.pk) === expected.primaryKeyPosition
}

function tableShapeMatches(tableInfo, columns, foreignKeys, expected) {
  if (!tableFlagsMatch(tableInfo, expected)) return false
  if (!Array.isArray(columns) || columns.length !== expected.columns.length) return false
  if (!Array.isArray(foreignKeys)) return false
  if (!expected.columns.every((column, index) =>
    tableColumnMatches(columns[index], column, index)
  )) return false
  return JSON.stringify(foreignKeys) === JSON.stringify(expected.foreignKeys)
}

function readTableForeignKeys(database, table) {
  const rows = database
    .prepare(
      'SELECT id, seq, "table" AS referenced_table, "from" AS local_column, "to" AS referenced_column, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq'
    )
    .all(table)
  if (!Array.isArray(rows)) return null

  const groups = new Map()
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 0 || !Number.isSafeInteger(row.seq) || row.seq < 0) {
      return null
    }
    if (!groups.has(row.id)) groups.set(row.id, [])
    groups.get(row.id).push(row)
  }

  const foreignKeys = []
  try {
    for (const [id, group] of groups) {
      const ordered = [...group].sort((left, right) => left.seq - right.seq)
      if (ordered.some((row, index) => row.seq !== index)) return null

      const first = ordered[0]
      const normalizedRows = ordered.map((row, index) => normalizeForeignKey({
        columns: [row.local_column],
        referencedTable: row.referenced_table,
        referencedColumns: [row.referenced_column],
        onUpdate: row.on_update,
        onDelete: row.on_delete
      }, `SQLite foreign key ${id} row ${index}`))
      const metadata = normalizedRows[0]
      if (normalizedRows.some((row) => (
        row.referencedTable !== metadata.referencedTable ||
        row.onUpdate !== metadata.onUpdate ||
        row.onDelete !== metadata.onDelete
      ))) return null

      foreignKeys.push(normalizeForeignKey({
        columns: normalizedRows.map((row) => row.columns[0]),
        referencedTable: first.referenced_table,
        referencedColumns: normalizedRows.map((row) => row.referencedColumns[0]),
        onUpdate: first.on_update,
        onDelete: first.on_delete
      }, `SQLite foreign key ${id}`))
    }
  } catch {
    return null
  }

  foreignKeys.sort((left, right) => {
    const leftKey = foreignKeyCanonicalKey(left)
    const rightKey = foreignKeyCanonicalKey(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  for (let index = 1; index < foreignKeys.length; index += 1) {
    if (foreignKeyCanonicalKey(foreignKeys[index - 1]) === foreignKeyCanonicalKey(foreignKeys[index])) {
      return null
    }
  }
  return foreignKeys
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
      return normalized.kind === TABLE_TRANSITION_COMPATIBILITY_KIND
        ? tableTransitionSummary(COMPATIBILITY_STATUSES.INCOMPATIBLE, normalized, 'table-missing')
        : summary(COMPATIBILITY_STATUSES.INCOMPATIBLE, normalized, 'table-missing')
    }

    if (normalized.kind === TABLE_TRANSITION_COMPATIBILITY_KIND) {
      const tableInfo = database
        .prepare(
          "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ?"
        )
        .get(normalized.table)
      const columns = database
        .prepare(
          'SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid'
        )
        .all(normalized.table)
      const foreignKeys = readTableForeignKeys(database, normalized.table)

      if (tableShapeMatches(tableInfo, columns, foreignKeys, normalized.target)) {
        return tableTransitionSummary(COMPATIBILITY_STATUSES.SATISFIED, normalized, 'matched')
      }
      if (normalized.legacy.some((shape) => tableShapeMatches(tableInfo, columns, foreignKeys, shape))) {
        return tableTransitionSummary(COMPATIBILITY_STATUSES.MISSING, normalized, 'legacy-matched')
      }
      return tableTransitionSummary(
        COMPATIBILITY_STATUSES.INCOMPATIBLE,
        normalized,
        'table-shape-incompatible'
      )
    }

    const column = database
      .prepare(
        'SELECT name, type, "notnull" AS not_null, dflt_value, hidden FROM pragma_table_xinfo(?) WHERE name = ?'
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

export {
  COMPATIBILITY_KIND,
  TABLE_TRANSITION_COMPATIBILITY_KIND,
  COMPATIBILITY_STATUSES
}
