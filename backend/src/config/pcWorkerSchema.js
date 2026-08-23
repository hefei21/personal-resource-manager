export const PC_WORKER_TABLE = 'pc_workers'
export const PC_WORKER_ENROLLMENT_TABLE = 'pc_worker_enrollments'
export const PC_WORKER_CREDENTIAL_TABLE = 'pc_worker_credentials'

const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const shape = (columns, foreignKeys = [], uniqueConstraints = []) => Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze(columns.map(Object.freeze)),
  foreignKeys: Object.freeze(foreignKeys.map((item) => Object.freeze({
    ...item,
    columns: Object.freeze([...item.columns]),
    referencedColumns: Object.freeze([...item.referencedColumns])
  }))),
  uniqueConstraints: Object.freeze(uniqueConstraints)
})

export const CREATE_PC_WORKERS_SQL = `CREATE TABLE pc_workers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  agent_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
)`.trim()

export const PC_WORKER_SHAPE = shape([
  column('id', 'TEXT', false, null, 1),
  column('display_name', 'TEXT', true),
  column('status', 'TEXT', true, "'active'"),
  column('protocol_version', 'INTEGER', true),
  column('agent_version', 'TEXT', true),
  column('platform', 'TEXT', true),
  column('architecture', 'TEXT', true),
  column('capabilities_json', 'TEXT', true),
  column('last_seen_at', 'TEXT'),
  column('created_at', 'TEXT', true),
  column('updated_at', 'TEXT', true),
  column('revoked_at', 'TEXT')
])

export const CREATE_PC_WORKER_ENROLLMENTS_SQL = `CREATE TABLE pc_worker_enrollments (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
)`.trim()

export const PC_WORKER_ENROLLMENT_SHAPE = shape([
  column('token_hash', 'TEXT', false, null, 1),
  column('expires_at', 'TEXT', true),
  column('consumed_at', 'TEXT'),
  column('created_at', 'TEXT', true)
])

export const CREATE_PC_WORKER_CREDENTIALS_SQL = `CREATE TABLE pc_worker_credentials (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64 AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES pc_workers(id) ON DELETE CASCADE
);
CREATE INDEX idx_pc_worker_credentials_worker
  ON pc_worker_credentials(worker_id, kind, expires_at)`.trim()

export const PC_WORKER_CREDENTIAL_SHAPE = shape([
  column('token_hash', 'TEXT', false, null, 1),
  column('worker_id', 'TEXT', true),
  column('kind', 'TEXT', true),
  column('generation', 'INTEGER', true),
  column('expires_at', 'TEXT', true),
  column('consumed_at', 'TEXT'),
  column('revoked_at', 'TEXT'),
  column('created_at', 'TEXT', true)
], [{
  columns: ['worker_id'],
  referencedTable: 'pc_workers',
  referencedColumns: ['id'],
  onUpdate: 'NO ACTION',
  onDelete: 'CASCADE'
}])

export const PC_WORKER_MIGRATIONS = Object.freeze([
  {
    id: '0071_pc_workers',
    source: CREATE_PC_WORKERS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: PC_WORKER_TABLE,
      target: PC_WORKER_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0072_pc_worker_enrollments',
    source: CREATE_PC_WORKER_ENROLLMENTS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: PC_WORKER_ENROLLMENT_TABLE,
      target: PC_WORKER_ENROLLMENT_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0073_pc_worker_credentials',
    source: CREATE_PC_WORKER_CREDENTIALS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: PC_WORKER_CREDENTIAL_TABLE,
      target: PC_WORKER_CREDENTIAL_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
