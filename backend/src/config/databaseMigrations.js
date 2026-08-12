import { createHash } from 'node:crypto'
import { createMigrationRegistry } from './migrationPlan.js'

const sha256 = (value) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

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
  }
])
