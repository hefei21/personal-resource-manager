const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const uniqueColumns = (...names) => ({
  columns: names.map((name) => ({ name, collation: 'BINARY', descending: false }))
})

const shape = (columns, uniqueConstraints = []) => Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze(columns.map(Object.freeze)),
  foreignKeys: Object.freeze([]),
  uniqueConstraints: Object.freeze(uniqueConstraints.map((item) => Object.freeze({
    columns: Object.freeze(item.columns.map(Object.freeze))
  })))
})

export const CODE_SYMBOL_SNAPSHOT_TABLE = 'code_symbol_snapshots'
export const CODE_SYMBOL_ENTRY_TABLE = 'code_symbol_entries'
export const CODE_SYMBOL_STATE_TABLE = 'code_symbol_repository_state'
export const CODE_SYMBOL_SCHEMA_VERSION = 1

export const CREATE_CODE_SYMBOL_SNAPSHOTS_SQL = `CREATE TABLE code_symbol_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL CHECK (typeof(repository_id) = 'integer' AND repository_id > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('managed_git', 'git_nas')),
  branch TEXT,
  commit_hash TEXT NOT NULL CHECK (
    length(commit_hash) IN (40, 64)
    AND commit_hash = lower(commit_hash)
    AND commit_hash NOT GLOB '*[^0-9a-f]*'
  ),
  extractor_version TEXT NOT NULL CHECK (length(trim(extractor_version)) > 0),
  strategy_version TEXT NOT NULL CHECK (length(trim(strategy_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('ready', 'partial')),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(file_count) = 'integer' AND file_count >= 0),
  symbol_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(symbol_count) = 'integer' AND symbol_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(error_count) = 'integer' AND error_count >= 0),
  indexed_at TEXT NOT NULL,
  UNIQUE (repository_id, commit_hash, extractor_version, strategy_version)
)`.trim()

export const CODE_SYMBOL_SNAPSHOT_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('repository_id', 'INTEGER', true),
  column('source_kind', 'TEXT', true),
  column('branch', 'TEXT'),
  column('commit_hash', 'TEXT', true),
  column('extractor_version', 'TEXT', true),
  column('strategy_version', 'TEXT', true),
  column('status', 'TEXT', true),
  column('file_count', 'INTEGER', true, '0'),
  column('symbol_count', 'INTEGER', true, '0'),
  column('error_count', 'INTEGER', true, '0'),
  column('indexed_at', 'TEXT', true)
], [uniqueColumns('repository_id', 'commit_hash', 'extractor_version', 'strategy_version')])

export const CREATE_CODE_SYMBOL_ENTRIES_SQL = `CREATE TABLE code_symbol_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL CHECK (typeof(snapshot_id) = 'integer' AND snapshot_id > 0),
  repository_id INTEGER NOT NULL CHECK (typeof(repository_id) = 'integer' AND repository_id > 0),
  commit_hash TEXT NOT NULL CHECK (
    length(commit_hash) IN (40, 64)
    AND commit_hash = lower(commit_hash)
    AND commit_hash NOT GLOB '*[^0-9a-f]*'
  ),
  relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) > 0),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  language TEXT NOT NULL CHECK (language IN ('javascript', 'typescript', 'python')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  qualified_name TEXT NOT NULL CHECK (length(trim(qualified_name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('class', 'function', 'method', 'constructor', 'constant')),
  signature TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (typeof(start_line) = 'integer' AND start_line > 0),
  end_line INTEGER NOT NULL CHECK (typeof(end_line) = 'integer' AND end_line >= start_line),
  source_fingerprint TEXT NOT NULL CHECK (
    length(source_fingerprint) = 64
    AND source_fingerprint = lower(source_fingerprint)
    AND source_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (snapshot_id, relative_path, qualified_name, kind, start_line)
)`.trim()

export const CODE_SYMBOL_ENTRY_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('snapshot_id', 'INTEGER', true),
  column('repository_id', 'INTEGER', true),
  column('commit_hash', 'TEXT', true),
  column('relative_path', 'TEXT', true),
  column('content_hash', 'TEXT', true),
  column('language', 'TEXT', true),
  column('name', 'TEXT', true),
  column('qualified_name', 'TEXT', true),
  column('kind', 'TEXT', true),
  column('signature', 'TEXT', true),
  column('start_line', 'INTEGER', true),
  column('end_line', 'INTEGER', true),
  column('source_fingerprint', 'TEXT', true)
], [uniqueColumns('snapshot_id', 'relative_path', 'qualified_name', 'kind', 'start_line')])

export const CREATE_CODE_SYMBOL_STATE_SQL = `CREATE TABLE code_symbol_repository_state (
  repository_id INTEGER PRIMARY KEY CHECK (typeof(repository_id) = 'integer' AND repository_id > 0),
  schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version >= 1),
  active_snapshot_id INTEGER CHECK (
    active_snapshot_id IS NULL OR (typeof(active_snapshot_id) = 'integer' AND active_snapshot_id > 0)
  ),
  status TEXT NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'indexing', 'ready', 'partial', 'failed')),
  last_started_at TEXT,
  last_completed_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const CODE_SYMBOL_STATE_SHAPE = shape([
  column('repository_id', 'INTEGER', false, null, 1),
  column('schema_version', 'INTEGER', true),
  column('active_snapshot_id', 'INTEGER'),
  column('status', 'TEXT', true, "'empty'"),
  column('last_started_at', 'TEXT'),
  column('last_completed_at', 'TEXT'),
  column('last_error_code', 'TEXT'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
])

export const CODE_SYMBOL_INDEXES_SQL = `
CREATE INDEX idx_code_symbol_snapshots_repository ON code_symbol_snapshots(repository_id, indexed_at);
CREATE INDEX idx_code_symbol_entries_snapshot ON code_symbol_entries(snapshot_id, relative_path, start_line);
CREATE INDEX idx_code_symbol_entries_name ON code_symbol_entries(name, qualified_name);
CREATE INDEX idx_code_symbol_entries_repository ON code_symbol_entries(repository_id, commit_hash);
CREATE INDEX idx_code_symbol_state_active ON code_symbol_repository_state(active_snapshot_id);
`.trim()

export const CODE_SYMBOL_INDEX_MIGRATIONS = Object.freeze([
  {
    id: '0076_code_symbol_snapshots',
    source: `${CREATE_CODE_SYMBOL_SNAPSHOTS_SQL};\nCREATE INDEX idx_code_symbol_snapshots_repository ON code_symbol_snapshots(repository_id, indexed_at)`,
    compatibility: {
      kind: 'table-transition',
      table: CODE_SYMBOL_SNAPSHOT_TABLE,
      target: CODE_SYMBOL_SNAPSHOT_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0077_code_symbol_entries',
    source: `${CREATE_CODE_SYMBOL_ENTRIES_SQL};
CREATE INDEX idx_code_symbol_entries_snapshot ON code_symbol_entries(snapshot_id, relative_path, start_line);
CREATE INDEX idx_code_symbol_entries_name ON code_symbol_entries(name, qualified_name);
CREATE INDEX idx_code_symbol_entries_repository ON code_symbol_entries(repository_id, commit_hash)`,
    compatibility: {
      kind: 'table-transition',
      table: CODE_SYMBOL_ENTRY_TABLE,
      target: CODE_SYMBOL_ENTRY_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0078_code_symbol_repository_state',
    source: `${CREATE_CODE_SYMBOL_STATE_SQL};\nCREATE INDEX idx_code_symbol_state_active ON code_symbol_repository_state(active_snapshot_id)`,
    compatibility: {
      kind: 'table-transition',
      table: CODE_SYMBOL_STATE_TABLE,
      target: CODE_SYMBOL_STATE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
