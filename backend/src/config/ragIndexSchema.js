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

const uniqueColumns = (...names) => ({
  columns: names.map((name) => ({ name, collation: 'BINARY', descending: false }))
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

const SOURCE_TYPE_CHECK = "source_type IN ('document', 'ebook', 'code_repository')"
const HASH_CHECK = (columnName) => `length(${columnName}) = 64
    AND ${columnName} = lower(${columnName})
    AND ${columnName} NOT GLOB '*[^0-9a-f]*'`

export const RAG_SOURCE_SNAPSHOT_TABLE = 'rag_source_snapshots'
export const RAG_SOURCE_STATE_TABLE = 'rag_source_state'
export const RAG_CHUNK_TABLE = 'rag_chunks'
export const RAG_CHUNK_FTS_TABLE = 'rag_chunks_fts'
export const RAG_CHUNK_FTS_META_TABLE = 'rag_chunks_fts_meta'
export const RAG_INDEX_SCHEMA_VERSION = 1

export const CREATE_RAG_SOURCE_SNAPSHOTS_SQL = `CREATE TABLE rag_source_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (${SOURCE_TYPE_CHECK}),
  source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id > 0),
  source_version_id TEXT NOT NULL CHECK (length(trim(source_version_id)) > 0),
  source_content_sha256 TEXT NOT NULL CHECK (
    ${HASH_CHECK('source_content_sha256')}
  ),
  extractor_version TEXT NOT NULL CHECK (length(trim(extractor_version)) > 0),
  chunker_version TEXT NOT NULL CHECK (length(trim(chunker_version)) > 0),
  chunker_config_hash TEXT NOT NULL CHECK (
    ${HASH_CHECK('chunker_config_hash')}
  ),
  status TEXT NOT NULL CHECK (
    status IN ('building', 'text_ready', 'embedding_pending', 'ready', 'partial', 'stale', 'failed')
  ),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(chunk_count) = 'integer' AND chunk_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(error_count) = 'integer' AND error_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE (
    source_type,
    source_id,
    source_version_id,
    source_content_sha256,
    extractor_version,
    chunker_version,
    chunker_config_hash
  )
)`.trim()

export const RAG_SOURCE_SNAPSHOT_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('source_type', 'TEXT', true),
  column('source_id', 'INTEGER', true),
  column('source_version_id', 'TEXT', true),
  column('source_content_sha256', 'TEXT', true),
  column('extractor_version', 'TEXT', true),
  column('chunker_version', 'TEXT', true),
  column('chunker_config_hash', 'TEXT', true),
  column('status', 'TEXT', true),
  column('chunk_count', 'INTEGER', true, '0'),
  column('error_count', 'INTEGER', true, '0'),
  column('last_error_code', 'TEXT'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP'),
  column('completed_at', 'TEXT')
], [], [uniqueColumns(
  'source_type',
  'source_id',
  'source_version_id',
  'source_content_sha256',
  'extractor_version',
  'chunker_version',
  'chunker_config_hash'
)])

export const RAG_SOURCE_SNAPSHOT_INDEXES_SQL = `
CREATE INDEX idx_rag_snapshots_source
  ON rag_source_snapshots(source_type, source_id, created_at);
CREATE INDEX idx_rag_snapshots_content
  ON rag_source_snapshots(source_content_sha256, extractor_version, chunker_version, chunker_config_hash)
`.trim()

export const CREATE_RAG_SOURCE_STATE_SQL = `CREATE TABLE rag_source_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (${SOURCE_TYPE_CHECK}),
  source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id > 0),
  active_snapshot_id INTEGER,
  last_attempt_snapshot_id INTEGER,
  status TEXT NOT NULL DEFAULT 'empty'
    CHECK (status IN ('empty', 'building', 'indexing', 'active', 'partial', 'stale', 'failed')),
  last_error_code TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id),
  FOREIGN KEY (active_snapshot_id) REFERENCES rag_source_snapshots(id) ON DELETE SET NULL,
  FOREIGN KEY (last_attempt_snapshot_id) REFERENCES rag_source_snapshots(id) ON DELETE SET NULL
)`.trim()

export const RAG_SOURCE_STATE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('source_type', 'TEXT', true),
  column('source_id', 'INTEGER', true),
  column('active_snapshot_id', 'INTEGER'),
  column('last_attempt_snapshot_id', 'INTEGER'),
  column('status', 'TEXT', true, "'empty'"),
  column('last_error_code', 'TEXT'),
  column('last_started_at', 'TEXT'),
  column('last_completed_at', 'TEXT'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['active_snapshot_id'],
    referencedTable: RAG_SOURCE_SNAPSHOT_TABLE,
    referencedColumns: ['id'],
    onDelete: 'SET NULL'
  }),
  foreignKey({
    columns: ['last_attempt_snapshot_id'],
    referencedTable: RAG_SOURCE_SNAPSHOT_TABLE,
    referencedColumns: ['id'],
    onDelete: 'SET NULL'
  })
], [uniqueColumns('source_type', 'source_id')])

export const RAG_SOURCE_STATE_INDEXES_SQL = `
CREATE INDEX idx_rag_source_state_active
  ON rag_source_state(active_snapshot_id);
CREATE INDEX idx_rag_source_state_status
  ON rag_source_state(status)
`.trim()

export const CREATE_RAG_CHUNKS_SQL = `CREATE TABLE rag_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  chunk_sha256 TEXT NOT NULL CHECK (
    ${HASH_CHECK('chunk_sha256')}
  ),
  body TEXT NOT NULL CHECK (length(body) > 0),
  token_count INTEGER CHECK (
    token_count IS NULL OR (typeof(token_count) = 'integer' AND token_count >= 0)
  ),
  token_count_mode TEXT NOT NULL DEFAULT 'deferred'
    CHECK (token_count_mode IN ('actual', 'deferred')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  section_path_json TEXT NOT NULL CHECK (json_valid(section_path_json)),
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  previous_chunk_id INTEGER,
  next_chunk_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (snapshot_id, ordinal, chunk_sha256),
  FOREIGN KEY (snapshot_id) REFERENCES rag_source_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (previous_chunk_id) REFERENCES rag_chunks(id) ON DELETE SET NULL,
  FOREIGN KEY (next_chunk_id) REFERENCES rag_chunks(id) ON DELETE SET NULL
)`.trim()

export const RAG_CHUNK_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('snapshot_id', 'INTEGER', true),
  column('ordinal', 'INTEGER', true),
  column('chunk_sha256', 'TEXT', true),
  column('body', 'TEXT', true),
  column('token_count', 'INTEGER'),
  column('token_count_mode', 'TEXT', true, "'deferred'"),
  column('title', 'TEXT', true),
  column('section_path_json', 'TEXT', true),
  column('locator_json', 'TEXT', true),
  column('previous_chunk_id', 'INTEGER'),
  column('next_chunk_id', 'INTEGER'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['snapshot_id'],
    referencedTable: RAG_SOURCE_SNAPSHOT_TABLE,
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['previous_chunk_id'],
    referencedTable: RAG_CHUNK_TABLE,
    referencedColumns: ['id'],
    onDelete: 'SET NULL'
  }),
  foreignKey({
    columns: ['next_chunk_id'],
    referencedTable: RAG_CHUNK_TABLE,
    referencedColumns: ['id'],
    onDelete: 'SET NULL'
  })
], [uniqueColumns('snapshot_id', 'ordinal', 'chunk_sha256')])

export const RAG_CHUNK_INDEXES_SQL = `
CREATE INDEX idx_rag_chunks_snapshot_ordinal
  ON rag_chunks(snapshot_id, ordinal);
CREATE INDEX idx_rag_chunks_sha256
  ON rag_chunks(chunk_sha256)
`.trim()

export const CREATE_RAG_CHUNK_FTS_META_SQL = `CREATE TABLE rag_chunks_fts_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version >= 1),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const RAG_CHUNK_FTS_META_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('schema_version', 'INTEGER', true),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
])

export const CREATE_RAG_CHUNK_FTS_SQL = `
CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
  title,
  section_path_json,
  body,
  content='rag_chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO rag_chunks_fts_meta (id, schema_version) VALUES (1, ${RAG_INDEX_SCHEMA_VERSION})
`.trim()

export const RAG_INDEX_MIGRATIONS = Object.freeze([
  {
    id: '0079_rag_source_snapshots',
    source: `${CREATE_RAG_SOURCE_SNAPSHOTS_SQL};\n${RAG_SOURCE_SNAPSHOT_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_SOURCE_SNAPSHOT_TABLE,
      target: RAG_SOURCE_SNAPSHOT_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0080_rag_source_state',
    source: `${CREATE_RAG_SOURCE_STATE_SQL};\n${RAG_SOURCE_STATE_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_SOURCE_STATE_TABLE,
      target: RAG_SOURCE_STATE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0081_rag_chunks',
    source: `${CREATE_RAG_CHUNKS_SQL};\n${RAG_CHUNK_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_CHUNK_TABLE,
      target: RAG_CHUNK_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0082_rag_chunks_fts',
    source: `${CREATE_RAG_CHUNK_FTS_META_SQL};\n${CREATE_RAG_CHUNK_FTS_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_CHUNK_FTS_META_TABLE,
      target: RAG_CHUNK_FTS_META_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
