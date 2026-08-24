import {
  RAG_CHUNK_TABLE,
  RAG_SOURCE_SNAPSHOT_TABLE
} from './ragIndexSchema.js'

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

const HASH_CHECK = (columnName) => `length(${columnName}) = 64
    AND ${columnName} = lower(${columnName})
    AND ${columnName} NOT GLOB '*[^0-9a-f]*'`

const MODEL_PROVIDER_CHECK = 'length(trim(provider)) > 0'
const MODEL_ID_CHECK = 'length(trim(model_id)) > 0'
const MODEL_REVISION_CHECK = 'length(trim(model_revision)) > 0'

export const RAG_EMBEDDING_MODEL_TABLE = 'rag_embedding_models'
export const RAG_CHUNK_EMBEDDING_TABLE = 'rag_chunk_embeddings'
export const RAG_SNAPSHOT_EMBEDDING_STATE_TABLE = 'rag_snapshot_embedding_state'
export const RAG_EMBEDDING_SCHEMA_VERSION = 1

export const CREATE_RAG_EMBEDDING_MODELS_SQL = `CREATE TABLE rag_embedding_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (${MODEL_PROVIDER_CHECK}),
  model_id TEXT NOT NULL CHECK (${MODEL_ID_CHECK}),
  model_revision TEXT NOT NULL CHECK (${MODEL_REVISION_CHECK}),
  dimensions INTEGER NOT NULL CHECK (typeof(dimensions) = 'integer' AND dimensions >= 32 AND dimensions <= 65536),
  distance TEXT NOT NULL CHECK (distance IN ('cosine', 'dot', 'euclid')),
  normalization TEXT NOT NULL CHECK (normalization IN ('none', 'l2')),
  input_limit INTEGER NOT NULL CHECK (typeof(input_limit) = 'integer' AND input_limit >= 128 AND input_limit <= 1048576),
  config_hash TEXT NOT NULL CHECK (${HASH_CHECK('config_hash')}),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'retired', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    provider,
    model_id,
    model_revision,
    dimensions,
    distance,
    normalization,
    input_limit,
    config_hash
  )
)`.trim()

export const RAG_EMBEDDING_MODEL_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('provider', 'TEXT', true),
  column('model_id', 'TEXT', true),
  column('model_revision', 'TEXT', true),
  column('dimensions', 'INTEGER', true),
  column('distance', 'TEXT', true),
  column('normalization', 'TEXT', true),
  column('input_limit', 'INTEGER', true),
  column('config_hash', 'TEXT', true),
  column('status', 'TEXT', true, "'candidate'"),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [], [uniqueColumns(
  'provider',
  'model_id',
  'model_revision',
  'dimensions',
  'distance',
  'normalization',
  'input_limit',
  'config_hash'
)])

export const RAG_EMBEDDING_MODEL_INDEXES_SQL = `
CREATE INDEX idx_rag_embedding_models_status
  ON rag_embedding_models(status);
CREATE INDEX idx_rag_embedding_models_lookup
  ON rag_embedding_models(provider, model_id, model_revision, config_hash)
`.trim()

export const CREATE_RAG_CHUNK_EMBEDDINGS_SQL = `CREATE TABLE rag_chunk_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER NOT NULL CHECK (typeof(chunk_id) = 'integer' AND chunk_id > 0),
  chunk_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('chunk_sha256')}),
  embedding_model_id INTEGER NOT NULL CHECK (typeof(embedding_model_id) = 'integer' AND embedding_model_id > 0),
  vector_id TEXT NOT NULL CHECK (length(trim(vector_id)) > 0),
  vector_sha256 TEXT NOT NULL CHECK (${HASH_CHECK('vector_sha256')}),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'stale', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chunk_id, chunk_sha256) REFERENCES rag_chunks(id, chunk_sha256) ON DELETE CASCADE,
  FOREIGN KEY (embedding_model_id) REFERENCES rag_embedding_models(id) ON DELETE RESTRICT,
  UNIQUE (chunk_id, embedding_model_id),
  UNIQUE (embedding_model_id, vector_id)
)`.trim()

export const RAG_CHUNK_EMBEDDING_FK_INDEX_SQL = `
CREATE UNIQUE INDEX idx_rag_chunks_id_sha256_embedding
  ON rag_chunks(id, chunk_sha256)
`.trim()

export const RAG_CHUNK_EMBEDDING_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('chunk_id', 'INTEGER', true),
  column('chunk_sha256', 'TEXT', true),
  column('embedding_model_id', 'INTEGER', true),
  column('vector_id', 'TEXT', true),
  column('vector_sha256', 'TEXT', true),
  column('status', 'TEXT', true, "'pending'"),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['chunk_id', 'chunk_sha256'],
    referencedTable: RAG_CHUNK_TABLE,
    referencedColumns: ['id', 'chunk_sha256'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['embedding_model_id'],
    referencedTable: RAG_EMBEDDING_MODEL_TABLE,
    referencedColumns: ['id'],
    onDelete: 'RESTRICT'
  })
], [
  uniqueColumns('chunk_id', 'embedding_model_id'),
  uniqueColumns('embedding_model_id', 'vector_id')
])

export const RAG_CHUNK_EMBEDDING_INDEXES_SQL = `
CREATE INDEX idx_rag_chunk_embeddings_status
  ON rag_chunk_embeddings(status, embedding_model_id);
CREATE INDEX idx_rag_chunk_embeddings_chunk_hash
  ON rag_chunk_embeddings(chunk_sha256)
`.trim()

export const CREATE_RAG_SNAPSHOT_EMBEDDING_STATE_SQL = `CREATE TABLE rag_snapshot_embedding_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL CHECK (typeof(snapshot_id) = 'integer' AND snapshot_id > 0),
  embedding_model_id INTEGER NOT NULL CHECK (typeof(embedding_model_id) = 'integer' AND embedding_model_id > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexing', 'active', 'partial', 'stale', 'failed')),
  vector_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(vector_count) = 'integer' AND vector_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(error_count) = 'integer' AND error_count >= 0),
  last_error_code TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES rag_source_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (embedding_model_id) REFERENCES rag_embedding_models(id) ON DELETE RESTRICT,
  UNIQUE (snapshot_id, embedding_model_id)
)`.trim()

export const RAG_SNAPSHOT_EMBEDDING_STATE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('snapshot_id', 'INTEGER', true),
  column('embedding_model_id', 'INTEGER', true),
  column('status', 'TEXT', true, "'pending'"),
  column('vector_count', 'INTEGER', true, '0'),
  column('error_count', 'INTEGER', true, '0'),
  column('last_error_code', 'TEXT'),
  column('last_started_at', 'TEXT'),
  column('last_completed_at', 'TEXT'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['snapshot_id'],
    referencedTable: RAG_SOURCE_SNAPSHOT_TABLE,
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['embedding_model_id'],
    referencedTable: RAG_EMBEDDING_MODEL_TABLE,
    referencedColumns: ['id'],
    onDelete: 'RESTRICT'
  })
], [uniqueColumns('snapshot_id', 'embedding_model_id')])

export const RAG_SNAPSHOT_EMBEDDING_STATE_INDEXES_SQL = `
CREATE INDEX idx_rag_snapshot_embedding_state_status
  ON rag_snapshot_embedding_state(status, embedding_model_id);
CREATE INDEX idx_rag_snapshot_embedding_state_snapshot
  ON rag_snapshot_embedding_state(snapshot_id, embedding_model_id)
`.trim()

export const RAG_EMBEDDING_MIGRATIONS = Object.freeze([
  {
    id: '0083_rag_embedding_models',
    source: `${CREATE_RAG_EMBEDDING_MODELS_SQL};\n${RAG_EMBEDDING_MODEL_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_EMBEDDING_MODEL_TABLE,
      target: RAG_EMBEDDING_MODEL_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0084_rag_chunk_embeddings',
    source: `${RAG_CHUNK_EMBEDDING_FK_INDEX_SQL};\n${CREATE_RAG_CHUNK_EMBEDDINGS_SQL};\n${RAG_CHUNK_EMBEDDING_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_CHUNK_EMBEDDING_TABLE,
      target: RAG_CHUNK_EMBEDDING_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0085_rag_snapshot_embedding_state',
    source: `${CREATE_RAG_SNAPSHOT_EMBEDDING_STATE_SQL};\n${RAG_SNAPSHOT_EMBEDDING_STATE_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RAG_SNAPSHOT_EMBEDDING_STATE_TABLE,
      target: RAG_SNAPSHOT_EMBEDDING_STATE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
