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

export const SEARCH_INDEX_ENTRY_TABLE = 'search_index_entries'
export const SEARCH_INDEX_STATE_TABLE = 'search_index_state'
export const SEARCH_INDEX_FTS_TABLE = 'search_index_fts'
export const SEARCH_INDEX_SCHEMA_VERSION = 1

export const CREATE_SEARCH_INDEX_ENTRIES_SQL = `CREATE TABLE search_index_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_key TEXT NOT NULL UNIQUE CHECK (length(trim(entry_key)) > 0),
  resource_type TEXT NOT NULL CHECK (
    resource_type IN ('document', 'ebook', 'ebook_chapter', 'code_repository', 'code_file', 'note', 'audio')
  ),
  result_scope TEXT NOT NULL DEFAULT 'owned' CHECK (result_scope IN ('owned', 'external')),
  resource_id INTEGER CHECK (resource_id IS NULL OR (typeof(resource_id) = 'integer' AND resource_id > 0)),
  domain_id INTEGER NOT NULL CHECK (typeof(domain_id) = 'integer' AND domain_id > 0),
  parent_domain_id INTEGER CHECK (
    parent_domain_id IS NULL OR (typeof(parent_domain_id) = 'integer' AND parent_domain_id > 0)
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  subtitle TEXT,
  body TEXT,
  tags TEXT,
  author TEXT,
  status TEXT,
  source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  source_label TEXT,
  search_text TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  source_fingerprint TEXT NOT NULL CHECK (
    length(source_fingerprint) = 64
    AND source_fingerprint = lower(source_fingerprint)
    AND source_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  source_updated_at TEXT,
  index_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (index_status IN ('ready', 'metadata_only', 'stale')),
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const SEARCH_INDEX_ENTRY_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('entry_key', 'TEXT', true),
  column('resource_type', 'TEXT', true),
  column('result_scope', 'TEXT', true, "'owned'"),
  column('resource_id', 'INTEGER'),
  column('domain_id', 'INTEGER', true),
  column('parent_domain_id', 'INTEGER'),
  column('title', 'TEXT', true),
  column('subtitle', 'TEXT'),
  column('body', 'TEXT'),
  column('tags', 'TEXT'),
  column('author', 'TEXT'),
  column('status', 'TEXT'),
  column('source_kind', 'TEXT', true),
  column('source_label', 'TEXT'),
  column('search_text', 'TEXT', true),
  column('locator_json', 'TEXT', true),
  column('source_fingerprint', 'TEXT', true),
  column('source_updated_at', 'TEXT'),
  column('index_status', 'TEXT', true, "'ready'"),
  column('indexed_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [uniqueColumns('entry_key')])

export const SEARCH_INDEX_FILTER_INDEXES_SQL = `
CREATE INDEX idx_search_entries_type_scope ON search_index_entries(resource_type, result_scope);
CREATE INDEX idx_search_entries_status ON search_index_entries(status);
CREATE INDEX idx_search_entries_updated_at ON search_index_entries(source_updated_at);
CREATE INDEX idx_search_entries_resource ON search_index_entries(resource_id);
`.trim()

export const CREATE_SEARCH_INDEX_STATE_SQL = `CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (typeof(schema_version) = 'integer' AND schema_version >= 1),
  status TEXT NOT NULL DEFAULT 'empty'
    CHECK (status IN ('empty', 'rebuilding', 'ready', 'partial', 'failed')),
  last_started_at TEXT,
  last_completed_at TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(entry_count) = 'integer' AND entry_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(error_count) = 'integer' AND error_count >= 0),
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const SEARCH_INDEX_STATE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('schema_version', 'INTEGER', true),
  column('status', 'TEXT', true, "'empty'"),
  column('last_started_at', 'TEXT'),
  column('last_completed_at', 'TEXT'),
  column('entry_count', 'INTEGER', true, '0'),
  column('error_count', 'INTEGER', true, '0'),
  column('last_error_code', 'TEXT'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
])

export const CREATE_SEARCH_INDEX_FTS_SQL = `
CREATE VIRTUAL TABLE search_index_fts USING fts5(
  search_text,
  content='search_index_entries',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
)`.trim()

export const SEARCH_INDEX_MIGRATIONS = Object.freeze([
  {
    id: '0074_search_index_entries',
    source: `${CREATE_SEARCH_INDEX_ENTRIES_SQL};\n${SEARCH_INDEX_FILTER_INDEXES_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: SEARCH_INDEX_ENTRY_TABLE,
      target: SEARCH_INDEX_ENTRY_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0075_search_index_fts',
    source: `${CREATE_SEARCH_INDEX_STATE_SQL};
INSERT INTO search_index_state (id, schema_version) VALUES (1, ${SEARCH_INDEX_SCHEMA_VERSION});
${CREATE_SEARCH_INDEX_FTS_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: SEARCH_INDEX_STATE_TABLE,
      target: SEARCH_INDEX_STATE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
