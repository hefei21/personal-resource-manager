import { createHash } from 'node:crypto'

const sha256 = (value) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

const column = (name, type, notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
  name,
  type,
  notNull,
  defaultValue,
  primaryKeyPosition
})

const shape = (columns, foreignKeys = []) => ({
  strict: false,
  withoutRowid: false,
  columns,
  foreignKeys,
  uniqueConstraints: []
})

export const BOOKS_STORAGE_LEGACY_DDL = `CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  year TEXT,
  publisher TEXT,
  isbn TEXT,
  description TEXT,
  cover_image TEXT,
  category_id INTEGER,
  file_path TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at DATETIME,
  content_cache TEXT,
  FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
)`

export const BOOKS_STORAGE_LEGACY_DDL_DATABASE_BASE = `CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      year TEXT,
      publisher TEXT,
      isbn TEXT,
      description TEXT,
      cover_image TEXT,
      category_id INTEGER,
      file_path TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER DEFAULT 0,
      total_pages INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_read_at DATETIME,
      content_cache TEXT,
      FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
    )`

export const BOOKS_STORAGE_TARGET_DDL = `CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  year TEXT,
  publisher TEXT,
  isbn TEXT,
  description TEXT,
  cover_image TEXT,
  category_id INTEGER,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  file_type TEXT,
  file_size INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at DATETIME,
  content_cache TEXT,
  FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
)`

const booksStorageForeignKey = {
  columns: ['category_id'],
  referencedTable: 'book_categories',
  referencedColumns: ['id'],
  onUpdate: 'NO ACTION',
  onDelete: 'SET NULL'
}

export const BOOKS_STORAGE_LEGACY_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('author', 'TEXT'),
  column('year', 'TEXT'),
  column('publisher', 'TEXT'),
  column('isbn', 'TEXT'),
  column('description', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('category_id', 'INTEGER'),
  column('file_path', 'TEXT', true),
  column('file_type', 'TEXT'),
  column('file_size', 'INTEGER', false, '0'),
  column('total_pages', 'INTEGER', false, '0'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('last_read_at', 'DATETIME'),
  column('content_cache', 'TEXT')
], [booksStorageForeignKey])

export const BOOKS_STORAGE_TARGET_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('author', 'TEXT'),
  column('year', 'TEXT'),
  column('publisher', 'TEXT'),
  column('isbn', 'TEXT'),
  column('description', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('category_id', 'INTEGER'),
  column('file_path', 'TEXT'),
  column('storage_key', 'TEXT'),
  column('content_sha256', 'TEXT'),
  column('content_bytes', 'INTEGER'),
  column('original_name', 'TEXT'),
  column('file_type', 'TEXT'),
  column('file_size', 'INTEGER', false, '0'),
  column('total_pages', 'INTEGER', false, '0'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('last_read_at', 'DATETIME'),
  column('content_cache', 'TEXT')
], [booksStorageForeignKey])

export const BOOKS_STORAGE_KNOWN_INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_books_created_at',
    createIndexSqlSha256: sha256('CREATE INDEX idx_books_created_at ON books(created_at)')
  }),
  Object.freeze({
    name: 'idx_books_title',
    createIndexSqlSha256: sha256('CREATE INDEX idx_books_title ON books(title)')
  })
])

const BOOKS_STORAGE_COPY_COLUMNS = `
  id, title, author, year, publisher, isbn, description, cover_image, category_id,
  file_path, storage_key, content_sha256, content_bytes, original_name, file_type,
  file_size, total_pages, created_at, updated_at, last_read_at, content_cache`

const BOOKS_STORAGE_MIGRATION_COMMON = `
CREATE TABLE prm_books_v0052_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_books_v0052_guard (valid)
SELECT CASE WHEN
  (
    SELECT COUNT(*)
    FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'books' AND fk."table" = 'books'
  ) = 2
  AND EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('reading_progress')
    WHERE "table" = 'books' AND "from" = 'book_id' AND "to" = 'id'
      AND on_update = 'NO ACTION' AND on_delete = 'CASCADE'
  )
  AND EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('book_chapters')
    WHERE "table" = 'books' AND "from" = 'book_id' AND "to" = 'id'
      AND on_update = 'NO ACTION' AND on_delete = 'CASCADE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN ('reading_progress', 'book_chapters')
  )
  AND (
    SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'books'
  ) IN (0, 1)
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_sequence
    WHERE name = 'books' AND (
      typeof(seq) != 'integer' OR seq < COALESCE((SELECT MAX(id) FROM books), 0)
    )
  )
THEN 1 ELSE 0 END;
CREATE TABLE prm_books_v0052_sequence (seq INTEGER);
INSERT INTO prm_books_v0052_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'books';
CREATE TABLE prm_books_v0052_child_sequences (name TEXT NOT NULL, seq INTEGER);
INSERT INTO prm_books_v0052_child_sequences (name, seq)
SELECT name, seq FROM sqlite_sequence
WHERE name IN ('reading_progress', 'book_chapters');
CREATE TABLE prm_books_v0052_reading_progress AS SELECT * FROM reading_progress;
CREATE TABLE prm_books_v0052_book_chapters AS SELECT * FROM book_chapters;
CREATE TABLE books_migration_0052 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  year TEXT,
  publisher TEXT,
  isbn TEXT,
  description TEXT,
  cover_image TEXT,
  category_id INTEGER,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  file_type TEXT,
  file_size INTEGER DEFAULT 0,
  total_pages INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_read_at DATETIME,
  content_cache TEXT,
  FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
);
INSERT INTO books_migration_0052 (${BOOKS_STORAGE_COPY_COLUMNS})
SELECT id, title, author, year, publisher, isbn, description, cover_image, category_id,
  file_path, NULL, NULL, NULL, NULL, file_type, file_size, total_pages,
  created_at, updated_at, last_read_at, content_cache
FROM books;
DROP TABLE books;
ALTER TABLE books_migration_0052 RENAME TO books;
INSERT INTO reading_progress SELECT * FROM prm_books_v0052_reading_progress;
INSERT INTO book_chapters SELECT * FROM prm_books_v0052_book_chapters;
DELETE FROM sqlite_sequence WHERE name IN ('books', 'reading_progress', 'book_chapters');
INSERT INTO sqlite_sequence (name, seq)
SELECT 'books', seq FROM prm_books_v0052_sequence;
INSERT INTO sqlite_sequence (name, seq)
SELECT name, seq FROM prm_books_v0052_child_sequences;
`

export const BOOKS_STORAGE_MIGRATION_SOURCE_NO_INDEXES = `${BOOKS_STORAGE_MIGRATION_COMMON}
DROP TABLE prm_books_v0052_book_chapters;
DROP TABLE prm_books_v0052_reading_progress;
DROP TABLE prm_books_v0052_child_sequences;
DROP TABLE prm_books_v0052_sequence;
DROP TABLE prm_books_v0052_guard;`.trim()

export const BOOKS_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES = `${BOOKS_STORAGE_MIGRATION_COMMON}
CREATE INDEX idx_books_title ON books(title);
CREATE INDEX idx_books_created_at ON books(created_at);
DROP TABLE prm_books_v0052_book_chapters;
DROP TABLE prm_books_v0052_reading_progress;
DROP TABLE prm_books_v0052_child_sequences;
DROP TABLE prm_books_v0052_sequence;
DROP TABLE prm_books_v0052_guard;`.trim()

export const BOOKS_STORAGE_MIGRATION_SOURCE = BOOKS_STORAGE_MIGRATION_SOURCE_NO_INDEXES
