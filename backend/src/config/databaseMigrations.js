import { createHash } from 'node:crypto'
import { createMigrationRegistry } from './migrationPlan.js'
import {
  CREATE_STORAGE_COMMIT_OPERATIONS_SQL,
  STORAGE_COMMIT_OPERATION_SHAPE
} from './storageCommitSchema.js'
import {
  DOCUMENTS_STORAGE_MIGRATION_SOURCE,
  DOCUMENTS_STORAGE_TARGET_SHAPE,
  DOCUMENT_VERSIONS_STORAGE_MIGRATION_SOURCE,
  DOCUMENT_VERSIONS_STORAGE_TARGET_SHAPE
} from './documentStorageSchema.js'
import { CREATE_RESOURCE_TRASH_SQL, RESOURCE_TRASH_SHAPE } from './resourceTrashSchema.js'
import {
  BOOKS_STORAGE_KNOWN_INDEXES,
  BOOKS_STORAGE_LEGACY_DDL,
  BOOKS_STORAGE_LEGACY_DDL_DATABASE_BASE,
  BOOKS_STORAGE_LEGACY_SHAPE,
  BOOKS_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES,
  BOOKS_STORAGE_MIGRATION_SOURCE_NO_INDEXES,
  BOOKS_STORAGE_TARGET_SHAPE
} from './ebookStorageSchema.js'
import {
  MUSIC_STORAGE_KNOWN_INDEXES,
  MUSIC_STORAGE_LEGACY_DDL,
  MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE,
  MUSIC_STORAGE_LEGACY_SHAPE,
  MUSIC_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES,
  MUSIC_STORAGE_MIGRATION_SOURCE_NO_INDEXES,
  MUSIC_STORAGE_TARGET_SHAPE
} from './musicStorageSchema.js'

const sha256 = (value) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

export const PRIVATE_DOCUMENT_MIGRATION_TABLE = 'private_document_migration_map'

export const CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL = `CREATE TABLE ${PRIVATE_DOCUMENT_MIGRATION_TABLE} (
  legacy_private_document_id INTEGER PRIMARY KEY,
  document_id INTEGER,
  version_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('migrated', 'skipped', 'failed')),
  source_sha256 TEXT,
  source_bytes INTEGER,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  issue_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`.trim()

export const PRIVATE_DOCUMENT_MIGRATION_SHAPE = Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze([
    { name: 'legacy_private_document_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 1 },
    { name: 'document_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'version_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'status', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'source_sha256', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'source_bytes', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'storage_key', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'content_sha256', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'content_bytes', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'issue_code', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'created_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP', primaryKeyPosition: 0 },
    { name: 'updated_at', type: 'TEXT', notNull: true, defaultValue: 'CURRENT_TIMESTAMP', primaryKeyPosition: 0 }
  ].map(Object.freeze)),
  foreignKeys: Object.freeze([]),
  uniqueConstraints: Object.freeze([])
})

const documentColumns = (versionType, subcategoryPosition = 'canonical', versionDefault = '1.0') => {
  const columns = [
    { name: 'id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 1 },
    { name: 'title', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'category', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
  ]
  if (subcategoryPosition === 'canonical') {
    columns.push({ name: 'subcategory', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 })
  }
  columns.push(
    { name: 'tags', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'file_path', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'version', type: versionType, notNull: false, defaultValue: versionDefault, primaryKeyPosition: 0 },
    { name: 'created_at', type: 'DATETIME', notNull: false, defaultValue: 'CURRENT_TIMESTAMP', primaryKeyPosition: 0 },
    { name: 'updated_at', type: 'DATETIME', notNull: false, defaultValue: 'CURRENT_TIMESTAMP', primaryKeyPosition: 0 }
  )
  if (subcategoryPosition === 'appended') {
    columns.push({ name: 'subcategory', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 })
  }
  return columns
}

const documentShape = (versionType, subcategoryPosition = 'canonical', versionDefault = '1.0') => ({
  strict: false,
  withoutRowid: false,
  columns: documentColumns(versionType, subcategoryPosition, versionDefault),
  foreignKeys: [],
  uniqueConstraints: []
})

const knownDocumentIndexes = [
  {
    name: 'idx_documents_category',
    createIndexSqlSha256: sha256('CREATE INDEX idx_documents_category ON documents(category)')
  },
  {
    name: 'idx_documents_created_at',
    createIndexSqlSha256: sha256('CREATE INDEX idx_documents_created_at ON documents(created_at)')
  },
  {
    name: 'idx_documents_title',
    createIndexSqlSha256: sha256('CREATE INDEX idx_documents_title ON documents(title)')
  }
]

const knownDocumentLegacyDdls = [
  {
    shape: documentShape('INTEGER'),
    sql: `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version INTEGER DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`
  },
  {
    shape: documentShape('INTEGER', 'canonical', '1'),
    sql: `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`
  },
  {
    shape: documentShape('INTEGER', 'appended'),
    sql: `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version INTEGER DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, subcategory TEXT)`
  },
  {
    shape: documentShape('INTEGER', 'appended', '1'),
    sql: `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, subcategory TEXT)`
  },
  {
    shape: documentShape('INTEGER', 'appended'),
    sql: `CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version INTEGER DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , subcategory TEXT)`
  },
  {
    shape: documentShape('INTEGER', 'appended', '1'),
    sql: `CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , subcategory TEXT)`
  },
  {
    shape: documentShape('REAL', 'appended'),
    sql: `CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version REAL DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , subcategory TEXT)`
  },
  {
    shape: documentShape('REAL', 'appended', '1'),
    sql: `CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version REAL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , subcategory TEXT)`
  }
]

const documentLegacyProofs = knownDocumentLegacyDdls.flatMap(({ shape, sql }) => (
  [[], knownDocumentIndexes].map((indexes) => ({
    shape,
    createTableSqlSha256: sha256(sql),
    indexes,
    triggers: []
  }))
))

const documentVersionMigrationSource = `
CREATE TABLE prm_documents_v0036_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_documents_v0036_guard (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM documents
    WHERE version IS NOT NULL AND (
      typeof(version) NOT IN ('integer', 'real') OR
      CAST(version AS REAL) != version OR
      abs(CAST(version AS REAL)) > 1.7976931348623157e308
    )
  )
  AND (
    SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || COALESCE(dflt_value, '<null>') || ':' || pk || ':' || hidden, '|')
    FROM (SELECT * FROM pragma_table_xinfo('document_versions') ORDER BY cid)
  ) = 'id:INTEGER:0:<null>:1:0|document_id:INTEGER:1:<null>:0:0|version:INTEGER:1:<null>:0:0|file_path:TEXT:1:<null>:0:0|note:TEXT:0:<null>:0:0|created_at:DATETIME:0:CURRENT_TIMESTAMP:0:0'
  AND (
    SELECT COUNT(*)
    FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND fk."table" = 'documents'
  ) = 1
  AND EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('document_versions')
    WHERE "table" = 'documents' AND "from" = 'document_id' AND "to" = 'id'
      AND on_update = 'NO ACTION' AND on_delete = 'CASCADE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN ('documents', 'document_versions')
  )
THEN 1 ELSE 0 END;
CREATE TABLE prm_documents_v0036_sequence (seq INTEGER);
INSERT INTO prm_documents_v0036_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'documents';
CREATE TABLE prm_documents_v0036_versions AS
SELECT id, document_id, version, file_path, note, created_at FROM document_versions;
CREATE TABLE documents_migration_0036 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO documents_migration_0036
  (id, title, category, subcategory, tags, file_path, version, created_at, updated_at)
SELECT id, title, category, subcategory, tags, file_path, CAST(version AS REAL), created_at, updated_at
FROM documents;
DROP TABLE documents;
ALTER TABLE documents_migration_0036 RENAME TO documents;
INSERT INTO document_versions (id, document_id, version, file_path, note, created_at)
SELECT id, document_id, version, file_path, note, created_at FROM prm_documents_v0036_versions;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'documents', seq FROM prm_documents_v0036_sequence
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'documents');
UPDATE sqlite_sequence
SET seq = CASE
  WHEN seq < (SELECT seq FROM prm_documents_v0036_sequence)
    THEN (SELECT seq FROM prm_documents_v0036_sequence)
  ELSE seq
END
WHERE name = 'documents' AND EXISTS (SELECT 1 FROM prm_documents_v0036_sequence);
DROP TABLE prm_documents_v0036_versions;
DROP TABLE prm_documents_v0036_sequence;
DROP TABLE prm_documents_v0036_guard;
`.trim()

const expandedDocumentColumn = (name, type) => ({
  name, type, notNull: false, defaultValue: null, primaryKeyPosition: 0
})

const documentsExpandedAppendedLegacyShape = {
  ...documentShape('REAL'),
  columns: [
    ...documentShape('REAL').columns,
    expandedDocumentColumn('category_id', 'INTEGER'),
    expandedDocumentColumn('storage_key', 'TEXT'),
    expandedDocumentColumn('content_sha256', 'TEXT'),
    expandedDocumentColumn('content_bytes', 'INTEGER'),
    expandedDocumentColumn('original_name', 'TEXT')
  ]
}

const documentsExpandedAppendedLegacyDdl = `CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      tags TEXT,
      file_path TEXT NOT NULL,
      version REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , category_id INTEGER, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, original_name TEXT)`

const documentsV0036ExpandedAppendedLegacyDdl = `CREATE TABLE "documents" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
, category_id INTEGER, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, original_name TEXT)`

const documentVersionsExpandedAppendedLegacyDdl = `CREATE TABLE document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )`

const documentVersionsExpandedAppendedLegacyShape = {
  strict: false,
  withoutRowid: false,
  columns: [
    { name: 'id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 1 },
    { name: 'document_id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'version', type: 'INTEGER', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'file_path', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'note', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'created_at', type: 'DATETIME', notNull: false, defaultValue: 'CURRENT_TIMESTAMP', primaryKeyPosition: 0 },
    { name: 'storage_key', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'content_sha256', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'content_bytes', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
  ],
  foreignKeys: [{
    columns: ['document_id'], referencedTable: 'documents', referencedColumns: ['id'],
    onUpdate: 'NO ACTION', onDelete: 'CASCADE'
  }],
  uniqueConstraints: []
}


const codeRepositoryColumn = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const codeRepositoryShape = (columns) => ({
  strict: false,
  withoutRowid: false,
  columns,
  foreignKeys: [],
  uniqueConstraints: []
})

const codeRepositoryLegacy6Shape = codeRepositoryShape([
  codeRepositoryColumn('id', 'INTEGER', false, null, 1),
  codeRepositoryColumn('name', 'TEXT', true),
  codeRepositoryColumn('url', 'TEXT', true),
  codeRepositoryColumn('description', 'TEXT'),
  codeRepositoryColumn('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  codeRepositoryColumn('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
])

const codeRepositoryLegacy9Shape = codeRepositoryShape([
  codeRepositoryColumn('id', 'INTEGER', false, null, 1),
  codeRepositoryColumn('name', 'TEXT', true),
  codeRepositoryColumn('url', 'TEXT', true),
  codeRepositoryColumn('description', 'TEXT'),
  codeRepositoryColumn('local_path', 'TEXT', true, "''"),
  codeRepositoryColumn('type', 'TEXT', false, "'git'"),
  codeRepositoryColumn('last_sync', 'TEXT'),
  codeRepositoryColumn('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  codeRepositoryColumn('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
])

const codeRepositoryLegacy10Shape = codeRepositoryShape([
  ...codeRepositoryLegacy9Shape.columns,
  codeRepositoryColumn('languages', 'TEXT', false, '"{}"')
])

const codeRepositoryTargetShape = codeRepositoryShape([
  codeRepositoryColumn('id', 'INTEGER', false, null, 1),
  codeRepositoryColumn('name', 'TEXT', true),
  codeRepositoryColumn('url', 'TEXT', true),
  codeRepositoryColumn('description', 'TEXT'),
  codeRepositoryColumn('local_path', 'TEXT', true, "''"),
  codeRepositoryColumn('type', 'TEXT', false, "'git'"),
  codeRepositoryColumn('last_sync', 'TEXT'),
  codeRepositoryColumn('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  codeRepositoryColumn('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  codeRepositoryColumn('languages', 'TEXT', false, "'{}'")
])

const codeRepositoryLegacy6Ddl = `CREATE TABLE code_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

const codeRepositoryLegacy9Ddl = `CREATE TABLE "code_repositories" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          description TEXT,
          local_path TEXT NOT NULL DEFAULT '',
          type TEXT DEFAULT 'git',
          last_sync TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`

const codeRepositoryLegacy10Ddl = `${codeRepositoryLegacy9Ddl.slice(0, -1)}, languages TEXT DEFAULT "{}")`

const codeRepositoryTargetDdl = `CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    )`

const codeRepositoryMigrationLegacy6Source = `
CREATE TABLE prm_code_repositories_v0037_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_guard (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'code_repositories'
      AND fk."table" = 'code_repositories'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type IN ('trigger', 'view') AND tbl_name != 'code_repositories'
      AND instr(lower(sql), 'code_repositories') > 0
  )
  AND (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') >= COALESCE((SELECT MAX(id) FROM code_repositories), 0)
THEN 1 ELSE 0 END;
CREATE TABLE prm_code_repositories_v0037_sequence (seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0));
INSERT INTO prm_code_repositories_v0037_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories';
CREATE TABLE code_repositories_migration_0037 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  local_path TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'git',
  last_sync TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  languages TEXT DEFAULT '{}'
);
INSERT INTO code_repositories_migration_0037
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, '', 'git', NULL, created_at, updated_at, '{}'
FROM code_repositories;
CREATE TABLE prm_code_repositories_v0037_equality (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_equality (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT id, name, url, description, '', 'git', NULL, created_at, updated_at, '{}' FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, '', 'git', NULL, created_at, updated_at, '{}' FROM code_repositories
  )
THEN 1 ELSE 0 END;
DROP TABLE code_repositories;
CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    );
INSERT INTO code_repositories
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages
FROM code_repositories_migration_0037;
DELETE FROM sqlite_sequence WHERE name = 'code_repositories';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'code_repositories', seq FROM prm_code_repositories_v0037_sequence;
CREATE TABLE prm_code_repositories_v0037_post (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_post (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') = (SELECT seq FROM prm_code_repositories_v0037_sequence)
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
  )
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE prm_code_repositories_v0037_post;
DROP TABLE code_repositories_migration_0037;
DROP TABLE prm_code_repositories_v0037_equality;
DROP TABLE prm_code_repositories_v0037_sequence;
DROP TABLE prm_code_repositories_v0037_guard;
`.trim()

const codeRepositoryMigrationLegacy9Source = `
CREATE TABLE prm_code_repositories_v0037_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_guard (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'code_repositories'
      AND fk."table" = 'code_repositories'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type IN ('trigger', 'view') AND tbl_name != 'code_repositories'
      AND instr(lower(sql), 'code_repositories') > 0
  )
  AND (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') >= COALESCE((SELECT MAX(id) FROM code_repositories), 0)
THEN 1 ELSE 0 END;
CREATE TABLE prm_code_repositories_v0037_sequence (seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0));
INSERT INTO prm_code_repositories_v0037_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories';
CREATE TABLE code_repositories_migration_0037 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  local_path TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'git',
  last_sync TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  languages TEXT DEFAULT '{}'
);
INSERT INTO code_repositories_migration_0037
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, '{}'
FROM code_repositories;
CREATE TABLE prm_code_repositories_v0037_equality (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_equality (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, '{}' FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, '{}' FROM code_repositories
  )
THEN 1 ELSE 0 END;
DROP TABLE code_repositories;
CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    );
INSERT INTO code_repositories
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages
FROM code_repositories_migration_0037;
DELETE FROM sqlite_sequence WHERE name = 'code_repositories';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'code_repositories', seq FROM prm_code_repositories_v0037_sequence;
CREATE TABLE prm_code_repositories_v0037_post (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_post (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') = (SELECT seq FROM prm_code_repositories_v0037_sequence)
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
  )
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE prm_code_repositories_v0037_post;
DROP TABLE code_repositories_migration_0037;
DROP TABLE prm_code_repositories_v0037_equality;
DROP TABLE prm_code_repositories_v0037_sequence;
DROP TABLE prm_code_repositories_v0037_guard;
`.trim()

const codeRepositoryMigrationLegacy10Source = `
CREATE TABLE prm_code_repositories_v0037_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_guard (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'code_repositories'
      AND fk."table" = 'code_repositories'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type IN ('trigger', 'view') AND tbl_name != 'code_repositories'
      AND instr(lower(sql), 'code_repositories') > 0
  )
  AND (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') >= COALESCE((SELECT MAX(id) FROM code_repositories), 0)
THEN 1 ELSE 0 END;
CREATE TABLE prm_code_repositories_v0037_sequence (seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0));
INSERT INTO prm_code_repositories_v0037_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories';
CREATE TABLE code_repositories_migration_0037 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  local_path TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'git',
  last_sync TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  languages TEXT DEFAULT '{}'
);
INSERT INTO code_repositories_migration_0037
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages
FROM code_repositories;
CREATE TABLE prm_code_repositories_v0037_equality (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_equality (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
  )
THEN 1 ELSE 0 END;
DROP TABLE code_repositories;
CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    );
INSERT INTO code_repositories
  (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages
FROM code_repositories_migration_0037;
DELETE FROM sqlite_sequence WHERE name = 'code_repositories';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'code_repositories', seq FROM prm_code_repositories_v0037_sequence;
CREATE TABLE prm_code_repositories_v0037_post (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_code_repositories_v0037_post (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'code_repositories') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'code_repositories') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories') = (SELECT seq FROM prm_code_repositories_v0037_sequence)
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
  )
  AND NOT EXISTS (
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories_migration_0037
    EXCEPT
    SELECT id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages FROM code_repositories
  )
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE prm_code_repositories_v0037_post;
DROP TABLE code_repositories_migration_0037;
DROP TABLE prm_code_repositories_v0037_equality;
DROP TABLE prm_code_repositories_v0037_sequence;
DROP TABLE prm_code_repositories_v0037_guard;
`.trim()

const readingProgressColumn = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const readingProgressShape = (columns, foreignKeys, uniqueConstraints) => ({
  strict: false,
  withoutRowid: false,
  columns,
  foreignKeys,
  uniqueConstraints
})

const readingProgressTargetShape = readingProgressShape([
  readingProgressColumn('id', 'INTEGER', false, null, 1),
  readingProgressColumn('book_id', 'INTEGER', true),
  readingProgressColumn('user_id', 'INTEGER'),
  readingProgressColumn('current_page', 'INTEGER', false, '0'),
  readingProgressColumn('cfi', 'TEXT'),
  readingProgressColumn('progress', 'REAL', false, '0'),
  readingProgressColumn('font_size', 'INTEGER', false, '16'),
  readingProgressColumn('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  readingProgressColumn('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
], [
  {
    columns: ['book_id'],
    referencedTable: 'books',
    referencedColumns: ['id'],
    onUpdate: 'NO ACTION',
    onDelete: 'CASCADE'
  },
  {
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onUpdate: 'NO ACTION',
    onDelete: 'CASCADE'
  }
], [
  {
    columns: [
      { name: 'book_id', collation: 'BINARY', descending: false },
      { name: 'user_id', collation: 'BINARY', descending: false }
    ]
  }
])

const readingProgressLegacyShape = readingProgressShape([
  readingProgressColumn('id', 'INTEGER', false, null, 1),
  readingProgressColumn('book_id', 'INTEGER', true),
  readingProgressColumn('current_page', 'INTEGER', false, '0'),
  readingProgressColumn('current_chapter', 'TEXT'),
  readingProgressColumn('progress', 'REAL', false, '0'),
  readingProgressColumn('font_size', 'INTEGER', false, '16'),
  readingProgressColumn('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  readingProgressColumn('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
], [{
  columns: ['book_id'],
  referencedTable: 'books',
  referencedColumns: ['id'],
  onUpdate: 'NO ACTION',
  onDelete: 'CASCADE'
}], [{
  columns: [{ name: 'book_id', collation: 'BINARY', descending: false }]
}])

const readingProgressTargetDdl = `CREATE TABLE reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        user_id INTEGER,
        current_page INTEGER DEFAULT 0,
        cfi TEXT,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(book_id, user_id)
      )`

// Historical inline startup cleanup created a temporary table, renamed it,
// then added these two indexes. SQLite persists the quoted renamed-table DDL.
const readingProgressInlineTargetDdl = `CREATE TABLE "reading_progress" (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          user_id INTEGER,
          current_page INTEGER DEFAULT 0,
          cfi TEXT,
          progress REAL DEFAULT 0,
          font_size INTEGER DEFAULT 16,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(book_id, user_id)
        )`
const readingProgressBookIndexDdl =
  'CREATE INDEX idx_reading_progress_book_id ON reading_progress(book_id)'
const readingProgressUserIndexDdl =
  'CREATE INDEX idx_reading_progress_user_id ON reading_progress(user_id)'

const readingProgressLegacyDdl = `CREATE TABLE reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL UNIQUE,
        current_page INTEGER DEFAULT 0,
        current_chapter TEXT,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )`

const readingProgressMigrationLegacySource = `
CREATE TABLE prm_reading_progress_v0038_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_reading_progress_v0038_guard (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM users) = 1
  AND (SELECT COUNT(*) FROM users WHERE typeof(id) = 'integer') = 1
  AND NOT EXISTS (
    SELECT 1 FROM reading_progress
    WHERE current_chapter IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM reading_progress
    WHERE id IS NULL OR typeof(id) <> 'integer'
      OR book_id IS NULL OR typeof(book_id) <> 'integer'
  )
  AND NOT EXISTS (
    SELECT id FROM reading_progress GROUP BY id HAVING COUNT(*) <> 1
  )
  AND NOT EXISTS (
    SELECT book_id FROM reading_progress GROUP BY book_id HAVING COUNT(*) <> 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM reading_progress AS progress
    LEFT JOIN books AS book ON book.id = progress.book_id
    WHERE book.id IS NULL
  )
  AND (SELECT COUNT(*) FROM pragma_foreign_key_list('reading_progress')) = 1
  AND EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('reading_progress')
    WHERE "table" = 'books' AND "from" = 'book_id' AND "to" = 'id'
      AND on_update = 'NO ACTION' AND on_delete = 'CASCADE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pragma_foreign_key_check
    WHERE "table" = 'reading_progress'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type = 'index' AND tbl_name = 'reading_progress' AND sql IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'reading_progress'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'reading_progress'
      AND fk."table" = 'reading_progress'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type IN ('trigger', 'view')
      AND (type = 'view' OR tbl_name != 'reading_progress')
      AND instr(lower(sql), 'reading_progress') > 0
  )
  AND (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'reading_progress') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'reading_progress') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'reading_progress') >= 0
  AND (
    (SELECT COUNT(*) FROM reading_progress) = 0
    OR (SELECT seq FROM sqlite_sequence WHERE name = 'reading_progress') >= (SELECT MAX(id) FROM reading_progress)
  )
THEN 1 ELSE 0 END;
CREATE TABLE prm_reading_progress_v0038_owner (
  user_id INTEGER NOT NULL PRIMARY KEY
);
INSERT INTO prm_reading_progress_v0038_owner (user_id)
SELECT id FROM users;
CREATE TABLE prm_reading_progress_v0038_sequence (
  seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0)
);
INSERT INTO prm_reading_progress_v0038_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'reading_progress';
CREATE TABLE reading_progress_migration_0038 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  user_id INTEGER,
  current_page INTEGER DEFAULT 0,
  cfi TEXT,
  progress REAL DEFAULT 0,
  font_size INTEGER DEFAULT 16,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(book_id, user_id)
);
INSERT INTO reading_progress_migration_0038
  (id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at)
SELECT progress.id, progress.book_id, owner.user_id, progress.current_page, NULL,
  progress.progress, progress.font_size, progress.created_at, progress.updated_at
FROM reading_progress AS progress
CROSS JOIN prm_reading_progress_v0038_owner AS owner;
CREATE TABLE prm_reading_progress_v0038_equality (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_reading_progress_v0038_equality (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress_migration_0038
    EXCEPT
    SELECT progress.id, progress.book_id, owner.user_id, progress.current_page, NULL,
      progress.progress, progress.font_size, progress.created_at, progress.updated_at
    FROM reading_progress AS progress
    CROSS JOIN prm_reading_progress_v0038_owner AS owner
  )
  AND NOT EXISTS (
    SELECT progress.id, progress.book_id, owner.user_id, progress.current_page, NULL,
      progress.progress, progress.font_size, progress.created_at, progress.updated_at
    FROM reading_progress AS progress
    CROSS JOIN prm_reading_progress_v0038_owner AS owner
    EXCEPT
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress_migration_0038
  )
THEN 1 ELSE 0 END;
DROP TABLE reading_progress;
CREATE TABLE reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        user_id INTEGER,
        current_page INTEGER DEFAULT 0,
        cfi TEXT,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(book_id, user_id)
      );
INSERT INTO reading_progress
  (id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at)
SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
FROM reading_progress_migration_0038;
DELETE FROM sqlite_sequence WHERE name = 'reading_progress';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'reading_progress', seq FROM prm_reading_progress_v0038_sequence;
CREATE TABLE prm_reading_progress_v0038_post (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_reading_progress_v0038_post (valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'reading_progress') = 1
  AND (SELECT typeof(seq) FROM sqlite_sequence WHERE name = 'reading_progress') = 'integer'
  AND (SELECT seq FROM sqlite_sequence WHERE name = 'reading_progress') = (SELECT seq FROM prm_reading_progress_v0038_sequence)
  AND NOT EXISTS (
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress
    EXCEPT
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress_migration_0038
  )
  AND NOT EXISTS (
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress_migration_0038
    EXCEPT
    SELECT id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
    FROM reading_progress
  )
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE 0 END;
DROP TABLE prm_reading_progress_v0038_post;
DROP TABLE reading_progress_migration_0038;
DROP TABLE prm_reading_progress_v0038_equality;
DROP TABLE prm_reading_progress_v0038_sequence;
DROP TABLE prm_reading_progress_v0038_owner;
DROP TABLE prm_reading_progress_v0038_guard;
`.trim()

export const applicationMigrationRegistry = createMigrationRegistry([
  {
    id: '0001_documents_subcategory',
    source: 'ALTER TABLE documents ADD COLUMN subcategory TEXT;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: {
        name: 'subcategory',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0002_categories_sort_order',
    source: 'ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'categories',
      column: {
        name: 'sort_order',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0003_todos_confirmed',
    source: 'ALTER TABLE todos ADD COLUMN confirmed INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'todos',
      column: {
        name: 'confirmed',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0004_books_content_cache',
    source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;',
    compatibility: {
      kind: 'column',
      table: 'books',
      column: {
        name: 'content_cache',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0005_bookmarks_icon',
    source: 'ALTER TABLE bookmarks ADD COLUMN icon TEXT;',
    compatibility: {
      kind: 'column',
      table: 'bookmarks',
      column: {
        name: 'icon',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0006_bookmarks_icon_data',
    source: 'ALTER TABLE bookmarks ADD COLUMN icon_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'bookmarks',
      column: {
        name: 'icon_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0007_anime_name_cn',
    source: 'ALTER TABLE anime ADD COLUMN name_cn TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'name_cn',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0008_anime_name_original',
    source: 'ALTER TABLE anime ADD COLUMN name_original TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'name_original',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0009_anime_rating_count',
    source: 'ALTER TABLE anime ADD COLUMN rating_count INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'rating_count',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0010_anime_air_date',
    source: 'ALTER TABLE anime ADD COLUMN air_date TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'air_date',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0011_anime_eps',
    source: 'ALTER TABLE anime ADD COLUMN eps INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'eps',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0012_anime_eps_total',
    source: 'ALTER TABLE anime ADD COLUMN eps_total INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'eps_total',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0013_anime_author',
    source: 'ALTER TABLE anime ADD COLUMN author TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'author',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0014_anime_director',
    source: 'ALTER TABLE anime ADD COLUMN director TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'director',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0015_anime_studio',
    source: 'ALTER TABLE anime ADD COLUMN studio TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'studio',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0016_anime_infobox',
    source: 'ALTER TABLE anime ADD COLUMN infobox TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'infobox',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0017_anime_characters',
    source: 'ALTER TABLE anime ADD COLUMN characters TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'characters',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0018_anime_staff',
    source: 'ALTER TABLE anime ADD COLUMN staff TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'staff',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0019_anime_user_rating',
    source: 'ALTER TABLE anime ADD COLUMN user_rating INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'user_rating',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0020_anime_is_hidden',
    source: 'ALTER TABLE anime ADD COLUMN is_hidden INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'is_hidden',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0021_anime_cover_image_data',
    source: 'ALTER TABLE anime ADD COLUMN cover_image_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'cover_image_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0022_games_achievements_total',
    source: 'ALTER TABLE games ADD COLUMN achievements_total INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'achievements_total',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0023_games_achievements_completed',
    source: 'ALTER TABLE games ADD COLUMN achievements_completed INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'achievements_completed',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0024_games_header_cover_image',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image TEXT;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'header_cover_image',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0025_games_header_cover_image_data',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'header_cover_image_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0026_music_artist',
    source: 'ALTER TABLE music ADD COLUMN artist TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'artist',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0027_music_album',
    source: 'ALTER TABLE music ADD COLUMN album TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'album',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0028_music_duration',
    source: 'ALTER TABLE music ADD COLUMN duration INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'duration',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0029_music_file_size',
    source: 'ALTER TABLE music ADD COLUMN file_size INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'file_size',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0030_music_file_type',
    source: 'ALTER TABLE music ADD COLUMN file_type TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'file_type',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0031_music_cover_image',
    source: 'ALTER TABLE music ADD COLUMN cover_image TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'cover_image',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0032_music_lyrics',
    source: 'ALTER TABLE music ADD COLUMN lyrics TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0033_music_lyrics_source',
    source: 'ALTER TABLE music ADD COLUMN lyrics_source TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics_source',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0034_music_has_lyrics',
    source: 'ALTER TABLE music ADD COLUMN has_lyrics INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'has_lyrics',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0035_music_lyrics_updated_at',
    source: 'ALTER TABLE music ADD COLUMN lyrics_updated_at TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics_updated_at',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0036_documents_version_real',
    source: documentVersionMigrationSource,
    compatibility: {
      kind: 'table-transition',
      table: 'documents',
      target: documentShape('REAL'),
      legacy: documentLegacyProofs
    }
  },
  {
    id: '0037_code_repositories_shape',
    sourceVariants: [
      { proofKey: 'legacy-6-columns', source: codeRepositoryMigrationLegacy6Source },
      { proofKey: 'legacy-9-columns', source: codeRepositoryMigrationLegacy9Source },
      { proofKey: 'legacy-10-double-quoted-languages', source: codeRepositoryMigrationLegacy10Source }
    ],
    compatibility: {
      kind: 'table-transition',
      table: 'code_repositories',
      target: codeRepositoryTargetShape,
      targetProof: {
        createTableSqlSha256: sha256(codeRepositoryTargetDdl),
        indexes: [],
        triggers: [],
        externalDependencies: {
          inboundForeignKeys: 'none',
          schemaSqlReferences: 'none'
        }
      },
      legacy: [
        {
          proofKey: 'legacy-6-columns',
          shape: codeRepositoryLegacy6Shape,
          createTableSqlSha256: sha256(codeRepositoryLegacy6Ddl),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-9-columns',
          shape: codeRepositoryLegacy9Shape,
          createTableSqlSha256: sha256(codeRepositoryLegacy9Ddl),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-10-double-quoted-languages',
          shape: codeRepositoryLegacy10Shape,
          createTableSqlSha256: sha256(codeRepositoryLegacy10Ddl),
          indexes: [],
          triggers: []
        }
      ]
    }
  },
  {
    id: '0038_reading_progress_shape',
    sourceVariants: [
      { proofKey: 'legacy-8-columns', source: readingProgressMigrationLegacySource }
    ],
    compatibility: {
      kind: 'table-transition',
      table: 'reading_progress',
      target: readingProgressTargetShape,
      targetProofVariants: [
        {
          createTableSqlSha256: sha256(readingProgressTargetDdl),
          indexes: [],
          triggers: [],
          externalDependencies: {
            inboundForeignKeys: 'none',
            schemaSqlReferences: 'none'
          }
        },
        {
          createTableSqlSha256: sha256(readingProgressInlineTargetDdl),
          indexes: [
            {
              name: 'idx_reading_progress_book_id',
              createIndexSqlSha256: sha256(readingProgressBookIndexDdl)
            },
            {
              name: 'idx_reading_progress_user_id',
              createIndexSqlSha256: sha256(readingProgressUserIndexDdl)
            }
          ],
          triggers: [],
          externalDependencies: {
            inboundForeignKeys: 'none',
            schemaSqlReferences: 'none'
          }
        }
      ],
      legacy: [
        {
          proofKey: 'legacy-8-columns',
          shape: readingProgressLegacyShape,
          createTableSqlSha256: sha256(readingProgressLegacyDdl),
          indexes: [],
          triggers: []
        }
      ]
    }
  },
  {
    id: '0039_storage_commit_operations',
    source: CREATE_STORAGE_COMMIT_OPERATIONS_SQL,
    compatibility: {
      kind: 'table-transition',
      table: 'storage_commit_operations',
      target: STORAGE_COMMIT_OPERATION_SHAPE,
      targetProof: {
        createTableSqlSha256: sha256(CREATE_STORAGE_COMMIT_OPERATIONS_SQL),
        indexes: [],
        triggers: [],
        externalDependencies: {
          inboundForeignKeys: 'none',
          schemaSqlReferences: 'none'
        }
      },
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0040_documents_category_id',
    source: 'ALTER TABLE documents ADD COLUMN category_id INTEGER;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: { name: 'category_id', type: 'INTEGER', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0041_documents_storage_key',
    source: 'ALTER TABLE documents ADD COLUMN storage_key TEXT;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: { name: 'storage_key', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0042_documents_content_sha256',
    source: 'ALTER TABLE documents ADD COLUMN content_sha256 TEXT;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: { name: 'content_sha256', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0043_documents_content_bytes',
    source: 'ALTER TABLE documents ADD COLUMN content_bytes INTEGER;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: { name: 'content_bytes', type: 'INTEGER', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0044_documents_original_name',
    source: 'ALTER TABLE documents ADD COLUMN original_name TEXT;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: { name: 'original_name', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0045_document_versions_storage_key',
    source: 'ALTER TABLE document_versions ADD COLUMN storage_key TEXT;',
    compatibility: {
      kind: 'column',
      table: 'document_versions',
      column: { name: 'storage_key', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0046_document_versions_content_sha256',
    source: 'ALTER TABLE document_versions ADD COLUMN content_sha256 TEXT;',
    compatibility: {
      kind: 'column',
      table: 'document_versions',
      column: { name: 'content_sha256', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0047_document_versions_content_bytes',
    source: 'ALTER TABLE document_versions ADD COLUMN content_bytes INTEGER;',
    compatibility: {
      kind: 'column',
      table: 'document_versions',
      column: { name: 'content_bytes', type: 'INTEGER', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0048_document_versions_storage_shape',
    sourceVariants: [{ proofKey: 'expanded-appended', source: DOCUMENT_VERSIONS_STORAGE_MIGRATION_SOURCE }],
    compatibility: {
      kind: 'table-transition',
      table: 'document_versions',
      target: DOCUMENT_VERSIONS_STORAGE_TARGET_SHAPE,
      legacy: [
        {
          proofKey: 'expanded-appended',
          shape: documentVersionsExpandedAppendedLegacyShape,
          createTableSqlSha256: sha256(documentVersionsExpandedAppendedLegacyDdl),
          indexes: [],
          triggers: []
        }
      ]
    }
  },
  {
    id: '0049_documents_storage_shape',
    sourceVariants: [
      { proofKey: 'expanded-appended-no-indexes', source: DOCUMENTS_STORAGE_MIGRATION_SOURCE },
      { proofKey: 'expanded-appended-known-indexes', source: DOCUMENTS_STORAGE_MIGRATION_SOURCE },
      { proofKey: 'v0036-expanded-appended-no-indexes', source: DOCUMENTS_STORAGE_MIGRATION_SOURCE },
      { proofKey: 'v0036-expanded-appended-known-indexes', source: DOCUMENTS_STORAGE_MIGRATION_SOURCE }
    ],
    compatibility: {
      kind: 'table-transition',
      table: 'documents',
      target: DOCUMENTS_STORAGE_TARGET_SHAPE,
      legacy: [
        ...[
          { prefix: 'expanded-appended', ddl: documentsExpandedAppendedLegacyDdl },
          { prefix: 'v0036-expanded-appended', ddl: documentsV0036ExpandedAppendedLegacyDdl }
        ].flatMap(({ prefix, ddl }) => [[], knownDocumentIndexes].map((indexes) => ({
            proofKey: `${prefix}-${indexes.length === 0 ? 'no-indexes' : 'known-indexes'}`,
            shape: documentsExpandedAppendedLegacyShape,
            createTableSqlSha256: sha256(ddl),
            indexes,
            triggers: []
          })))
      ]
    }
  },
  {
    id: '0050_resource_trash_entries',
    source: CREATE_RESOURCE_TRASH_SQL,
    compatibility: {
      kind: 'table-transition',
      table: 'resource_trash_entries',
      target: RESOURCE_TRASH_SHAPE,
      targetProof: {
        createTableSqlSha256: sha256(CREATE_RESOURCE_TRASH_SQL),
        indexes: [],
        triggers: [],
        externalDependencies: { inboundForeignKeys: 'none', schemaSqlReferences: 'none' }
      },
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0051_private_document_migration_map',
    source: CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL,
    compatibility: {
      kind: 'table-transition',
      table: PRIVATE_DOCUMENT_MIGRATION_TABLE,
      target: PRIVATE_DOCUMENT_MIGRATION_SHAPE,
      targetProof: {
        createTableSqlSha256: sha256(CREATE_PRIVATE_DOCUMENT_MIGRATION_SQL),
        indexes: [],
        triggers: [],
        externalDependencies: { inboundForeignKeys: 'none', schemaSqlReferences: 'none' }
      },
      missingTable: 'create',
      legacy: []
    }
  },
  {
    id: '0052_books_storage_shape',
    sourceVariants: [
      { proofKey: 'legacy-no-indexes', source: BOOKS_STORAGE_MIGRATION_SOURCE_NO_INDEXES },
      { proofKey: 'legacy-known-indexes', source: BOOKS_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES },
      { proofKey: 'legacy-database-base-no-indexes', source: BOOKS_STORAGE_MIGRATION_SOURCE_NO_INDEXES },
      { proofKey: 'legacy-database-base-known-indexes', source: BOOKS_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES }
    ],
    compatibility: {
      kind: 'table-transition',
      table: 'books',
      target: BOOKS_STORAGE_TARGET_SHAPE,
      legacy: [
        {
          proofKey: 'legacy-no-indexes',
          shape: BOOKS_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(BOOKS_STORAGE_LEGACY_DDL),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-known-indexes',
          shape: BOOKS_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(BOOKS_STORAGE_LEGACY_DDL),
          indexes: BOOKS_STORAGE_KNOWN_INDEXES,
          triggers: []
        },
        {
          proofKey: 'legacy-database-base-no-indexes',
          shape: BOOKS_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(BOOKS_STORAGE_LEGACY_DDL_DATABASE_BASE),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-database-base-known-indexes',
          shape: BOOKS_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(BOOKS_STORAGE_LEGACY_DDL_DATABASE_BASE),
          indexes: BOOKS_STORAGE_KNOWN_INDEXES,
          triggers: []
        }
      ]
    }
  },
  {
    id: '0053_music_storage_shape',
    sourceVariants: [
      { proofKey: 'legacy-no-indexes', source: MUSIC_STORAGE_MIGRATION_SOURCE_NO_INDEXES },
      { proofKey: 'legacy-known-indexes', source: MUSIC_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES },
      { proofKey: 'legacy-database-base-no-indexes', source: MUSIC_STORAGE_MIGRATION_SOURCE_NO_INDEXES },
      { proofKey: 'legacy-database-base-known-indexes', source: MUSIC_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES }
    ],
    compatibility: {
      kind: 'table-transition',
      table: 'music',
      target: MUSIC_STORAGE_TARGET_SHAPE,
      legacy: [
        {
          proofKey: 'legacy-no-indexes',
          shape: MUSIC_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(MUSIC_STORAGE_LEGACY_DDL),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-known-indexes',
          shape: MUSIC_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(MUSIC_STORAGE_LEGACY_DDL),
          indexes: MUSIC_STORAGE_KNOWN_INDEXES,
          triggers: []
        },
        {
          proofKey: 'legacy-database-base-no-indexes',
          shape: MUSIC_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE),
          indexes: [],
          triggers: []
        },
        {
          proofKey: 'legacy-database-base-known-indexes',
          shape: MUSIC_STORAGE_LEGACY_SHAPE,
          createTableSqlSha256: sha256(MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE),
          indexes: MUSIC_STORAGE_KNOWN_INDEXES,
          triggers: []
        }
      ]
    }
  }
])
