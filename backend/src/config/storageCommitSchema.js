export const STORAGE_COMMIT_OPERATION_TABLE = 'storage_commit_operations'

export const CREATE_STORAGE_COMMIT_OPERATIONS_SQL = `
CREATE TABLE storage_commit_operations (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'object_committed', 'database_committed', 'orphaned')),
  staging_token TEXT NOT NULL,
  storage_key TEXT,
  sha256 TEXT,
  bytes INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'staged' AND storage_key IS NULL AND sha256 IS NULL AND bytes IS NULL AND error_code IS NULL)
    OR
    (state IN ('object_committed', 'database_committed') AND storage_key IS NOT NULL
      AND sha256 IS NOT NULL AND bytes IS NOT NULL AND error_code IS NULL)
    OR
    (state = 'orphaned' AND storage_key IS NOT NULL AND sha256 IS NOT NULL
      AND bytes IS NOT NULL AND error_code IS NOT NULL)
  )
)
`.trim()

export const ENSURE_STORAGE_COMMIT_OPERATIONS_SQL = CREATE_STORAGE_COMMIT_OPERATIONS_SQL.replace(
  'CREATE TABLE ',
  'CREATE TABLE IF NOT EXISTS '
)

export const STORAGE_COMMIT_OPERATION_SHAPE = Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze([
    { name: 'idempotency_key', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 1 },
    { name: 'state', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'staging_token', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'storage_key', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'sha256', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'bytes', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'error_code', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'updated_at', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 }
  ].map(Object.freeze)),
  foreignKeys: Object.freeze([]),
  uniqueConstraints: Object.freeze([])
})
