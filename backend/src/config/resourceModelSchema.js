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
  columns: names.map((name) => ({
    name,
    collation: 'BINARY',
    descending: false
  }))
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

export const RESOURCE_TABLE = 'resources'
export const RESOURCE_DOMAIN_LINK_TABLE = 'resource_domain_links'
export const CONTENT_OBJECT_TABLE = 'content_objects'
export const RESOURCE_VERSION_TABLE = 'resource_versions'
export const NAS_SCAN_ROOT_TABLE = 'nas_scan_roots'
export const RESOURCE_SOURCE_TABLE = 'resource_sources'
export const NAS_SCAN_ENTRY_TABLE = 'nas_scan_entries'
export const RESOURCE_CONFLICT_CANDIDATE_TABLE = 'resource_conflict_candidates'

export const CREATE_RESOURCES_SQL = `CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL CHECK (length(trim(resource_type)) > 0),
  title TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'trashed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const RESOURCE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('resource_type', 'TEXT', true),
  column('title', 'TEXT'),
  column('lifecycle_status', 'TEXT', true, "'active'"),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
])

export const CREATE_RESOURCE_DOMAIN_LINKS_SQL = `CREATE TABLE resource_domain_links (
  resource_id INTEGER NOT NULL UNIQUE,
  domain_type TEXT NOT NULL
    CHECK (domain_type IN ('document', 'ebook', 'music', 'code_repository')),
  domain_id INTEGER NOT NULL CHECK (typeof(domain_id) = 'integer' AND domain_id > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (domain_type, domain_id),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
)`.trim()

export const RESOURCE_DOMAIN_LINK_SHAPE = shape([
  column('resource_id', 'INTEGER', true, null, 0),
  column('domain_type', 'TEXT', true, null, 1),
  column('domain_id', 'INTEGER', true, null, 2),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['resource_id'],
    referencedTable: 'resources',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  })
], [uniqueColumns('resource_id')])

export const CREATE_CONTENT_OBJECTS_SQL = `CREATE TABLE content_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bytes INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes >= 0),
  managed_storage_key TEXT CHECK (
    managed_storage_key IS NULL OR length(trim(managed_storage_key)) > 0
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sha256, bytes),
  UNIQUE (managed_storage_key)
)`.trim()

export const CONTENT_OBJECT_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('sha256', 'TEXT', true),
  column('bytes', 'INTEGER', true),
  column('managed_storage_key', 'TEXT'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [], [uniqueColumns('sha256', 'bytes'), uniqueColumns('managed_storage_key')])

export const CREATE_RESOURCE_VERSIONS_SQL = `CREATE TABLE resource_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  content_object_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  is_current INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(is_current) = 'integer' AND is_current IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (resource_id, version_number),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (content_object_id) REFERENCES content_objects(id) ON DELETE RESTRICT
)`.trim()

export const RESOURCE_VERSION_CURRENT_INDEX_SQL = `CREATE UNIQUE INDEX idx_resource_versions_current
ON resource_versions(resource_id)
WHERE is_current = 1`.trim()

export const RESOURCE_VERSION_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('resource_id', 'INTEGER', true),
  column('content_object_id', 'INTEGER', true),
  column('version_number', 'INTEGER', true),
  column('is_current', 'INTEGER', true, '1'),
  column('note', 'TEXT'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['resource_id'],
    referencedTable: 'resources',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['content_object_id'],
    referencedTable: 'content_objects',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT'
  })
], [uniqueColumns('resource_id', 'version_number')])

export const CREATE_NAS_SCAN_ROOTS_SQL = `CREATE TABLE nas_scan_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  root_path TEXT NOT NULL CHECK (length(trim(root_path)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(enabled) = 'integer' AND enabled IN (0, 1)),
  rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
  rules_version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(rules_version) = 'integer' AND rules_version >= 1),
  last_successful_generation INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_successful_generation) = 'integer' AND last_successful_generation >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (root_path)
)`.trim()

export const NAS_SCAN_ROOT_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('name', 'TEXT', true),
  column('root_path', 'TEXT', true),
  column('enabled', 'INTEGER', true, '1'),
  column('rules_json', 'TEXT', true),
  column('rules_version', 'INTEGER', true, '1'),
  column('last_successful_generation', 'INTEGER', true, '0'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [], [uniqueColumns('root_path')])

export const CREATE_RESOURCE_SOURCES_SQL = `CREATE TABLE resource_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('nas_path', 'managed_storage', 'git_nas', 'domain_record')),
  scan_root_id INTEGER,
  relative_path TEXT,
  storage_key TEXT,
  external_id TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'missing', 'excluded')),
  last_seen_generation INTEGER CHECK (
    last_seen_generation IS NULL
    OR (typeof(last_seen_generation) = 'integer' AND last_seen_generation >= 0)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (
      source_kind IN ('nas_path', 'git_nas')
      AND scan_root_id IS NOT NULL
      AND relative_path IS NOT NULL
      AND length(trim(relative_path)) > 0
      AND storage_key IS NULL
    )
    OR (
      source_kind = 'managed_storage'
      AND scan_root_id IS NULL
      AND relative_path IS NULL
      AND storage_key IS NOT NULL
      AND length(trim(storage_key)) > 0
    )
    OR (
      source_kind = 'domain_record'
      AND scan_root_id IS NULL
      AND relative_path IS NULL
      AND storage_key IS NULL
      AND external_id IS NOT NULL
      AND length(trim(external_id)) > 0
    )
  ),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (scan_root_id) REFERENCES nas_scan_roots(id) ON DELETE RESTRICT,
  UNIQUE (scan_root_id, relative_path),
  UNIQUE (storage_key)
)`.trim()

export const RESOURCE_SOURCE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('resource_id', 'INTEGER', true),
  column('source_kind', 'TEXT', true),
  column('scan_root_id', 'INTEGER'),
  column('relative_path', 'TEXT'),
  column('storage_key', 'TEXT'),
  column('external_id', 'TEXT'),
  column('state', 'TEXT', true, "'active'"),
  column('last_seen_generation', 'INTEGER'),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['resource_id'],
    referencedTable: 'resources',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['scan_root_id'],
    referencedTable: 'nas_scan_roots',
    referencedColumns: ['id'],
    onDelete: 'RESTRICT'
  })
], [uniqueColumns('scan_root_id', 'relative_path'), uniqueColumns('storage_key')])

export const CREATE_NAS_SCAN_ENTRIES_SQL = `CREATE TABLE nas_scan_entries (
  scan_root_id INTEGER NOT NULL,
  relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) > 0),
  resource_source_id INTEGER,
  file_identifier TEXT,
  size INTEGER CHECK (size IS NULL OR (typeof(size) = 'integer' AND size >= 0)),
  mtime_ns INTEGER CHECK (mtime_ns IS NULL OR (typeof(mtime_ns) = 'integer' AND mtime_ns >= 0)),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL
    OR (
      length(content_sha256) = 64
      AND content_sha256 = lower(content_sha256)
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observation_status TEXT NOT NULL
    CHECK (observation_status IN ('discovered', 'excluded', 'error')),
  last_seen_generation INTEGER NOT NULL
    CHECK (typeof(last_seen_generation) = 'integer' AND last_seen_generation >= 1),
  last_error_code TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scan_root_id, relative_path),
  FOREIGN KEY (scan_root_id) REFERENCES nas_scan_roots(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_source_id) REFERENCES resource_sources(id) ON DELETE SET NULL,
  UNIQUE (resource_source_id)
)`.trim()

export const NAS_SCAN_ENTRY_SHAPE = shape([
  column('scan_root_id', 'INTEGER', true, null, 1),
  column('relative_path', 'TEXT', true, null, 2),
  column('resource_source_id', 'INTEGER'),
  column('file_identifier', 'TEXT'),
  column('size', 'INTEGER'),
  column('mtime_ns', 'INTEGER'),
  column('content_sha256', 'TEXT'),
  column('observation_status', 'TEXT', true),
  column('last_seen_generation', 'INTEGER', true),
  column('last_error_code', 'TEXT'),
  column('observed_at', 'TEXT', true, 'CURRENT_TIMESTAMP')
], [
  foreignKey({
    columns: ['scan_root_id'],
    referencedTable: 'nas_scan_roots',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['resource_source_id'],
    referencedTable: 'resource_sources',
    referencedColumns: ['id'],
    onDelete: 'SET NULL'
  })
], [uniqueColumns('resource_source_id')])

export const CREATE_RESOURCE_CONFLICT_CANDIDATES_SQL = `CREATE TABLE resource_conflict_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('content_hash', 'title', 'path', 'external_id')),
  left_resource_id INTEGER NOT NULL,
  right_resource_id INTEGER NOT NULL,
  signal_json TEXT NOT NULL CHECK (json_valid(signal_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'ignored')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  CHECK (left_resource_id < right_resource_id),
  FOREIGN KEY (left_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (right_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  UNIQUE (candidate_type, left_resource_id, right_resource_id)
)`.trim()

export const RESOURCE_CONFLICT_CANDIDATE_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('candidate_type', 'TEXT', true),
  column('left_resource_id', 'INTEGER', true),
  column('right_resource_id', 'INTEGER', true),
  column('signal_json', 'TEXT', true),
  column('status', 'TEXT', true, "'pending'"),
  column('created_at', 'TEXT', true, 'CURRENT_TIMESTAMP'),
  column('resolved_at', 'TEXT')
], [
  foreignKey({
    columns: ['left_resource_id'],
    referencedTable: 'resources',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  }),
  foreignKey({
    columns: ['right_resource_id'],
    referencedTable: 'resources',
    referencedColumns: ['id'],
    onDelete: 'CASCADE'
  })
], [uniqueColumns('candidate_type', 'left_resource_id', 'right_resource_id')])

export const RESOURCE_MODEL_TABLES = Object.freeze([
  RESOURCE_TABLE,
  RESOURCE_DOMAIN_LINK_TABLE,
  CONTENT_OBJECT_TABLE,
  RESOURCE_VERSION_TABLE,
  NAS_SCAN_ROOT_TABLE,
  RESOURCE_SOURCE_TABLE,
  NAS_SCAN_ENTRY_TABLE,
  RESOURCE_CONFLICT_CANDIDATE_TABLE
])

// Each migration creates one table.  The compatibility layer proves the full
// table shape, foreign keys, and inline unique constraints.  Strict target
// proofs are intentionally omitted: later tables reference earlier tables,
// so a proof that requires no inbound schema dependencies cannot apply here.
export const RESOURCE_MODEL_MIGRATIONS = Object.freeze([
  {
    id: '0063_resources',
    source: CREATE_RESOURCES_SQL,
    compatibility: {
      kind: 'table-transition',
      table: RESOURCE_TABLE,
      target: RESOURCE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0064_resource_domain_links',
    source: CREATE_RESOURCE_DOMAIN_LINKS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: RESOURCE_DOMAIN_LINK_TABLE,
      target: RESOURCE_DOMAIN_LINK_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0065_content_objects',
    source: CREATE_CONTENT_OBJECTS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: CONTENT_OBJECT_TABLE,
      target: CONTENT_OBJECT_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0066_resource_versions',
    source: `${CREATE_RESOURCE_VERSIONS_SQL};\n${RESOURCE_VERSION_CURRENT_INDEX_SQL}`,
    compatibility: {
      kind: 'table-transition',
      table: RESOURCE_VERSION_TABLE,
      target: RESOURCE_VERSION_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0067_nas_scan_roots',
    source: CREATE_NAS_SCAN_ROOTS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: NAS_SCAN_ROOT_TABLE,
      target: NAS_SCAN_ROOT_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0068_resource_sources',
    source: CREATE_RESOURCE_SOURCES_SQL,
    compatibility: {
      kind: 'table-transition',
      table: RESOURCE_SOURCE_TABLE,
      target: RESOURCE_SOURCE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0069_nas_scan_entries',
    source: CREATE_NAS_SCAN_ENTRIES_SQL,
    compatibility: {
      kind: 'table-transition',
      table: NAS_SCAN_ENTRY_TABLE,
      target: NAS_SCAN_ENTRY_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0070_resource_conflict_candidates',
    source: CREATE_RESOURCE_CONFLICT_CANDIDATES_SQL,
    compatibility: {
      kind: 'table-transition',
      table: RESOURCE_CONFLICT_CANDIDATE_TABLE,
      target: RESOURCE_CONFLICT_CANDIDATE_SHAPE,
      missingTable: 'create',
      legacy: []
    }
  }
])
