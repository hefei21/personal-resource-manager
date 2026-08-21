import { createHash } from 'node:crypto'

export const TASK_TABLE = 'tasks'

export const TASK_STATUSES = Object.freeze([
  'pending',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled'
])

export const CREATE_TASK_TABLE_SQL = `CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) = 69)
    CHECK (substr(idempotency_key, 1, 5) = 'task:')
    CHECK (substr(idempotency_key, 6) NOT GLOB '*[^0-9a-f]*'),
  input_fingerprint TEXT NOT NULL
    CHECK (length(input_fingerprint) = 64)
    CHECK (input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  task_type TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_version_id TEXT,
  subject_content_sha256 TEXT
    CHECK (subject_content_sha256 IS NULL OR (
      length(subject_content_sha256) = 64
      AND subject_content_sha256 NOT GLOB '*[^0-9a-f]*'
    )),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  execution_class TEXT NOT NULL DEFAULT 'cpu'
    CHECK (execution_class IN ('cpu', 'disk', 'network', 'gpu')),
  priority INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(priority) = 'integer' AND priority >= 0),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3
    CHECK (typeof(max_attempts) = 'integer' AND max_attempts >= 1),
  progress REAL NOT NULL DEFAULT 0
    CHECK (typeof(progress) IN ('integer', 'real') AND progress >= 0 AND progress <= 100),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`.trim()

export const CREATE_TASK_INDEXES_SQL = `
CREATE UNIQUE INDEX idx_tasks_idempotency_key ON tasks(idempotency_key);
CREATE INDEX idx_tasks_claim ON tasks(status, execution_class, available_at, priority DESC, id ASC);
CREATE INDEX idx_tasks_subject ON tasks(subject_type, subject_id, task_type);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC, id DESC);`.trim()

export const CREATE_TASK_SCHEMA_SQL = `${CREATE_TASK_TABLE_SQL};\n${CREATE_TASK_INDEXES_SQL}`

const sha256 = (value) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

export const TASK_KNOWN_INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_tasks_created_at',
    createIndexSqlSha256: sha256('CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC, id DESC)')
  }),
  Object.freeze({
    name: 'idx_tasks_idempotency_key',
    createIndexSqlSha256: sha256('CREATE UNIQUE INDEX idx_tasks_idempotency_key ON tasks(idempotency_key)')
  }),
  Object.freeze({
    name: 'idx_tasks_claim',
    createIndexSqlSha256: sha256('CREATE INDEX idx_tasks_claim ON tasks(status, execution_class, available_at, priority DESC, id ASC)')
  }),
  Object.freeze({
    name: 'idx_tasks_subject',
    createIndexSqlSha256: sha256('CREATE INDEX idx_tasks_subject ON tasks(subject_type, subject_id, task_type)')
  })
])

const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

export const TASK_SHAPE = Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze([
    column('id', 'INTEGER', false, null, 1),
    column('idempotency_key', 'TEXT', true),
    column('input_fingerprint', 'TEXT', true),
    column('task_type', 'TEXT', true),
    column('processor_version', 'TEXT', true),
    column('subject_type', 'TEXT', true),
    column('subject_id', 'TEXT', true),
    column('subject_version_id', 'TEXT'),
    column('subject_content_sha256', 'TEXT'),
    column('input_json', 'TEXT', true),
    column('status', 'TEXT', true, "'pending'"),
    column('execution_class', 'TEXT', true, "'cpu'"),
    column('priority', 'INTEGER', true, '0'),
    column('available_at', 'TEXT', true),
    column('lease_token', 'TEXT'),
    column('lease_owner', 'TEXT'),
    column('lease_expires_at', 'TEXT'),
    column('heartbeat_at', 'TEXT'),
    column('attempt_count', 'INTEGER', true, '0'),
    column('max_attempts', 'INTEGER', true, '3'),
    column('progress', 'REAL', true, '0'),
    column('result_json', 'TEXT'),
    column('error_code', 'TEXT'),
    column('error_summary', 'TEXT'),
    column('started_at', 'TEXT'),
    column('finished_at', 'TEXT'),
    column('created_at', 'TEXT', true),
    column('updated_at', 'TEXT', true)
  ].map(Object.freeze)),
  foreignKeys: Object.freeze([]),
  uniqueConstraints: Object.freeze([])
})

export const TASK_TARGET_SHAPE = TASK_SHAPE
