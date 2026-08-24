const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const foreignKey = ({ columns, referencedTable, referencedColumns, onDelete }) => ({
  columns,
  referencedTable,
  referencedColumns,
  onUpdate: 'NO ACTION',
  onDelete
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
  uniqueConstraints: Object.freeze(uniqueConstraints.map((item) => Object.freeze({
    columns: Object.freeze(item.columns.map(Object.freeze))
  })))
})

export const RAG_QUERY_RUN_TABLE = 'rag_query_runs'
export const RAG_QUERY_RUN_SCHEMA_VERSION = 1
export const RAG_QUERY_RUN_CONTEXT_MAX_BYTES = 1_048_576
export const RAG_QUERY_RUN_MAX_ROWS = 256
export const RAG_QUERY_RUN_TTL_SECONDS = 15 * 60

const OPAQUE_RUN_ID_CHECK = `length(run_id) BETWEEN 3 AND 128
    AND run_id GLOB '*[A-Za-z]*'
    AND run_id NOT GLOB '*[^A-Za-z0-9._~-]*'`
const OWNER_SCOPE_CHECK = `length(owner_scope) = 64
    AND owner_scope = lower(owner_scope)
    AND owner_scope NOT GLOB '*[^0-9a-f]*'`
const CONTEXT_CHECK = `length(CAST(context_json AS BLOB)) BETWEEN 2 AND ${RAG_QUERY_RUN_CONTEXT_MAX_BYTES}
    AND json_valid(context_json)`

export const CREATE_RAG_QUERY_RUNS_SQL = `CREATE TABLE ${RAG_QUERY_RUN_TABLE} (
  run_id TEXT PRIMARY KEY CHECK (${OPAQUE_RUN_ID_CHECK}),
  owner_scope TEXT NOT NULL CHECK (${OWNER_SCOPE_CHECK}),
  task_id INTEGER,
  task_idempotency_key TEXT CHECK (
    task_idempotency_key IS NULL OR length(task_idempotency_key) BETWEEN 1 AND 256
  ),
  task_type TEXT NOT NULL CHECK (task_type = 'rag.answer.generate'),
  processor_version TEXT NOT NULL CHECK (processor_version = 'v1'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  context_json TEXT NOT NULL CHECK (${CONTEXT_CHECK}),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (task_id IS NOT NULL OR task_idempotency_key IS NOT NULL),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
)`.trim()

export const RAG_QUERY_RUN_SHAPE = shape([
  column('run_id', 'TEXT', false, null, 1),
  column('owner_scope', 'TEXT', true),
  column('task_id', 'INTEGER'),
  column('task_idempotency_key', 'TEXT'),
  column('task_type', 'TEXT', true),
  column('processor_version', 'TEXT', true),
  column('status', 'TEXT', true, "'pending'"),
  column('context_json', 'TEXT', true),
  column('created_at', 'TEXT', true),
  column('updated_at', 'TEXT', true),
  column('expires_at', 'TEXT', true)
], [
  foreignKey({
    columns: ['task_id'],
    referencedTable: 'tasks',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  })
])

export const RAG_QUERY_RUN_INDEXES_SQL = `
CREATE UNIQUE INDEX idx_rag_query_runs_task_id
  ON ${RAG_QUERY_RUN_TABLE}(task_id)
 WHERE task_id IS NOT NULL;
CREATE INDEX idx_rag_query_runs_owner_expiry
  ON ${RAG_QUERY_RUN_TABLE}(owner_scope, expires_at);
CREATE INDEX idx_rag_query_runs_expiry
  ON ${RAG_QUERY_RUN_TABLE}(expires_at)
`.trim()

export const RAG_QUERY_RUN_MIGRATIONS = Object.freeze([
  {
    id: '0086_rag_query_runs',
    source: `${CREATE_RAG_QUERY_RUNS_SQL};\n${RAG_QUERY_RUN_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_QUERY_RUN_TABLE,
      target: RAG_QUERY_RUN_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
