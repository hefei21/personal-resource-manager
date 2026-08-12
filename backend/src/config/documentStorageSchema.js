const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name, type, notNull, defaultValue, primaryKeyPosition
})

const shape = (columns, foreignKeys = []) => ({
  strict: false,
  withoutRowid: false,
  columns,
  foreignKeys,
  uniqueConstraints: []
})

export const DOCUMENTS_STORAGE_TARGET_DDL = `CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  category_id INTEGER,
  tags TEXT,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
)`

export const DOCUMENT_VERSIONS_STORAGE_TARGET_DDL = `CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
)`

export const DOCUMENTS_STORAGE_TARGET_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('category', 'TEXT'),
  column('subcategory', 'TEXT'),
  column('category_id', 'INTEGER'),
  column('tags', 'TEXT'),
  column('file_path', 'TEXT'),
  column('storage_key', 'TEXT'),
  column('content_sha256', 'TEXT'),
  column('content_bytes', 'INTEGER'),
  column('original_name', 'TEXT'),
  column('version', 'REAL', false, '1.0'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
], [{
  columns: ['category_id'], referencedTable: 'categories', referencedColumns: ['id'],
  onUpdate: 'NO ACTION', onDelete: 'SET NULL'
}])

export const DOCUMENT_VERSIONS_STORAGE_TARGET_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('document_id', 'INTEGER', true),
  column('version', 'INTEGER', true),
  column('file_path', 'TEXT'),
  column('storage_key', 'TEXT'),
  column('content_sha256', 'TEXT'),
  column('content_bytes', 'INTEGER'),
  column('note', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
], [{
  columns: ['document_id'], referencedTable: 'documents', referencedColumns: ['id'],
  onUpdate: 'NO ACTION', onDelete: 'CASCADE'
}])

export const DOCUMENT_VERSIONS_STORAGE_MIGRATION_SOURCE = `
CREATE TABLE prm_document_versions_v0048_sequence (seq INTEGER);
INSERT INTO prm_document_versions_v0048_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'document_versions';
CREATE TABLE document_versions_migration_0048 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
INSERT INTO document_versions_migration_0048
  (id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at)
SELECT id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at
FROM document_versions;
DROP TABLE document_versions;
ALTER TABLE document_versions_migration_0048 RENAME TO document_versions;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'document_versions', seq FROM prm_document_versions_v0048_sequence
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'document_versions');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM prm_document_versions_v0048_sequence))
WHERE name = 'document_versions' AND EXISTS (SELECT 1 FROM prm_document_versions_v0048_sequence);
DROP TABLE prm_document_versions_v0048_sequence;
`.trim()

export const DOCUMENTS_STORAGE_MIGRATION_SOURCE = `
CREATE TABLE prm_documents_v0049_sequence (seq INTEGER);
INSERT INTO prm_documents_v0049_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'documents';
CREATE TABLE prm_documents_v0049_versions AS SELECT * FROM document_versions;
CREATE TABLE documents_migration_0049 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  category_id INTEGER,
  tags TEXT,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);
INSERT INTO documents_migration_0049
  (id, title, category, subcategory, category_id, tags, file_path, storage_key,
   content_sha256, content_bytes, original_name, version, created_at, updated_at)
SELECT id, title, category, subcategory, category_id, tags, file_path, storage_key,
       content_sha256, content_bytes, original_name, version, created_at, updated_at
FROM documents;
DROP TABLE documents;
ALTER TABLE documents_migration_0049 RENAME TO documents;
INSERT INTO document_versions
  (id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at)
SELECT id, document_id, version, file_path, storage_key, content_sha256, content_bytes, note, created_at
FROM prm_documents_v0049_versions;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'documents', seq FROM prm_documents_v0049_sequence
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'documents');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM prm_documents_v0049_sequence))
WHERE name = 'documents' AND EXISTS (SELECT 1 FROM prm_documents_v0049_sequence);
DROP TABLE prm_documents_v0049_versions;
DROP TABLE prm_documents_v0049_sequence;
`.trim()
