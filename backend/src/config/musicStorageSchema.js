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

export const MUSIC_STORAGE_LEGACY_DDL = `CREATE TABLE music (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration INTEGER DEFAULT 0,
  file_path TEXT,
  file_size INTEGER DEFAULT 0,
  file_type TEXT,
  cover_image TEXT,
  lyrics TEXT,
  lyrics_source TEXT,
  has_lyrics INTEGER DEFAULT 0,
  lyrics_updated_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

export const MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE = `CREATE TABLE music (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER DEFAULT 0,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      file_type TEXT,
      cover_image TEXT,
      lyrics TEXT,
      lyrics_source TEXT,
      has_lyrics INTEGER DEFAULT 0,
      lyrics_updated_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`

// Historical installs created the five-column table first and then received
// migrations 0026-0035 through ALTER TABLE. SQLite persists appended columns
// in this exact canonical form, so it must be proven separately from base DDL.
export const MUSIC_STORAGE_LEGACY_DDL_APPENDED = `CREATE TABLE music (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , artist TEXT, album TEXT, duration INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0, file_type TEXT, cover_image TEXT, lyrics TEXT, lyrics_source TEXT, has_lyrics INTEGER DEFAULT 0, lyrics_updated_at TEXT)`

// Another historical base table already contained the metadata columns through
// cover_image. Migrations 0032-0035 then appended only the lyrics columns.
export const MUSIC_STORAGE_LEGACY_DDL_PARTIAL_APPENDED = `CREATE TABLE music (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        duration INTEGER DEFAULT 0,
        file_path TEXT,
        file_size INTEGER DEFAULT 0,
        file_type TEXT,
        cover_image TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , lyrics TEXT, lyrics_source TEXT, has_lyrics INTEGER DEFAULT 0, lyrics_updated_at TEXT)`

// A verified production lineage included legacy category/tags metadata before
// the storage and lyrics columns were appended. Keep the exact sqlite_schema
// text as a proof boundary; do not normalize whitespace or column order.
export const MUSIC_STORAGE_LEGACY_DDL_CATEGORY_TAGS_APPENDED = `CREATE TABLE music (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      category TEXT,
      tags TEXT,
      file_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , duration INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0, file_type TEXT, cover_image TEXT, lyrics TEXT, lyrics_source TEXT, has_lyrics INTEGER DEFAULT 0, lyrics_updated_at TEXT)`

export const MUSIC_STORAGE_TARGET_DDL = `CREATE TABLE music (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  category TEXT,
  tags TEXT,
  duration INTEGER DEFAULT 0,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  file_size INTEGER DEFAULT 0,
  file_type TEXT,
  cover_image TEXT,
  lyrics TEXT,
  lyrics_source TEXT,
  has_lyrics INTEGER DEFAULT 0,
  lyrics_updated_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

export const MUSIC_STORAGE_LEGACY_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('artist', 'TEXT'),
  column('album', 'TEXT'),
  column('duration', 'INTEGER', false, '0'),
  column('file_path', 'TEXT'),
  column('file_size', 'INTEGER', false, '0'),
  column('file_type', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('lyrics', 'TEXT'),
  column('lyrics_source', 'TEXT'),
  column('has_lyrics', 'INTEGER', false, '0'),
  column('lyrics_updated_at', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
])

export const MUSIC_STORAGE_LEGACY_APPENDED_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('file_path', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('artist', 'TEXT'),
  column('album', 'TEXT'),
  column('duration', 'INTEGER', false, '0'),
  column('file_size', 'INTEGER', false, '0'),
  column('file_type', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('lyrics', 'TEXT'),
  column('lyrics_source', 'TEXT'),
  column('has_lyrics', 'INTEGER', false, '0'),
  column('lyrics_updated_at', 'TEXT')
])

export const MUSIC_STORAGE_LEGACY_PARTIAL_APPENDED_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('artist', 'TEXT'),
  column('album', 'TEXT'),
  column('duration', 'INTEGER', false, '0'),
  column('file_path', 'TEXT'),
  column('file_size', 'INTEGER', false, '0'),
  column('file_type', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('lyrics', 'TEXT'),
  column('lyrics_source', 'TEXT'),
  column('has_lyrics', 'INTEGER', false, '0'),
  column('lyrics_updated_at', 'TEXT')
])

export const MUSIC_STORAGE_LEGACY_CATEGORY_TAGS_APPENDED_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('artist', 'TEXT'),
  column('album', 'TEXT'),
  column('category', 'TEXT'),
  column('tags', 'TEXT'),
  column('file_path', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('duration', 'INTEGER', false, '0'),
  column('file_size', 'INTEGER', false, '0'),
  column('file_type', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('lyrics', 'TEXT'),
  column('lyrics_source', 'TEXT'),
  column('has_lyrics', 'INTEGER', false, '0'),
  column('lyrics_updated_at', 'TEXT')
])

export const MUSIC_STORAGE_TARGET_SHAPE = shape([
  column('id', 'INTEGER', false, null, 1),
  column('title', 'TEXT', true),
  column('artist', 'TEXT'),
  column('album', 'TEXT'),
  column('category', 'TEXT'),
  column('tags', 'TEXT'),
  column('duration', 'INTEGER', false, '0'),
  column('file_path', 'TEXT'),
  column('storage_key', 'TEXT'),
  column('content_sha256', 'TEXT'),
  column('content_bytes', 'INTEGER'),
  column('original_name', 'TEXT'),
  column('file_size', 'INTEGER', false, '0'),
  column('file_type', 'TEXT'),
  column('cover_image', 'TEXT'),
  column('lyrics', 'TEXT'),
  column('lyrics_source', 'TEXT'),
  column('has_lyrics', 'INTEGER', false, '0'),
  column('lyrics_updated_at', 'TEXT'),
  column('created_at', 'DATETIME', false, 'CURRENT_TIMESTAMP'),
  column('updated_at', 'DATETIME', false, 'CURRENT_TIMESTAMP')
])

export const MUSIC_STORAGE_KNOWN_INDEXES = Object.freeze([
  Object.freeze({
    name: 'idx_music_artist',
    createIndexSqlSha256: sha256('CREATE INDEX idx_music_artist ON music(artist)')
  }),
  Object.freeze({
    name: 'idx_music_album',
    createIndexSqlSha256: sha256('CREATE INDEX idx_music_album ON music(album)')
  }),
  Object.freeze({
    name: 'idx_music_title',
    createIndexSqlSha256: sha256('CREATE INDEX idx_music_title ON music(title)')
  }),
  Object.freeze({
    name: 'idx_music_created_at',
    createIndexSqlSha256: sha256('CREATE INDEX idx_music_created_at ON music(created_at)')
  }),
  Object.freeze({
    name: 'idx_music_has_lyrics',
    createIndexSqlSha256: sha256('CREATE INDEX idx_music_has_lyrics ON music(has_lyrics)')
  })
])

const MUSIC_STORAGE_COPY_COLUMNS = `
  id, title, artist, album, category, tags, duration, file_path, storage_key, content_sha256,
  content_bytes, original_name, file_size, file_type, cover_image, lyrics,
  lyrics_source, has_lyrics, lyrics_updated_at, created_at, updated_at`

const createMusicStorageMigrationCommon = ({ categoryExpression, tagsExpression }) => `
CREATE TABLE prm_music_v0053_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO prm_music_v0053_guard (valid)
SELECT CASE WHEN
  (
    SELECT COUNT(*)
    FROM main.sqlite_schema AS tables, pragma_foreign_key_list(tables.name) AS fk
    WHERE tables.type = 'table' AND tables.name != 'music' AND fk."table" = 'music'
  ) = 1
  AND EXISTS (
    SELECT 1 FROM pragma_foreign_key_list('playlist_songs')
    WHERE "table" = 'music' AND "from" = 'music_id' AND "to" = 'id'
      AND on_update = 'NO ACTION' AND on_delete = 'CASCADE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM main.sqlite_schema
    WHERE type = 'trigger' AND tbl_name = 'playlist_songs'
  )
  AND (
    SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'music'
  ) IN (0, 1)
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_sequence
    WHERE name = 'music' AND (
      typeof(seq) != 'integer' OR seq < COALESCE((SELECT MAX(id) FROM music), 0)
    )
  )
  AND (
    SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'playlist_songs'
  ) IN (0, 1)
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_sequence
    WHERE name = 'playlist_songs' AND (
      typeof(seq) != 'integer' OR seq < COALESCE((SELECT MAX(id) FROM playlist_songs), 0)
    )
  )
THEN 1 ELSE 0 END;
CREATE TABLE prm_music_v0053_sequence (seq INTEGER);
INSERT INTO prm_music_v0053_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'music';
CREATE TABLE prm_music_v0053_child_sequence (seq INTEGER);
INSERT INTO prm_music_v0053_child_sequence (seq)
SELECT seq FROM sqlite_sequence WHERE name = 'playlist_songs';
CREATE TABLE prm_music_v0053_playlist_songs AS SELECT * FROM playlist_songs;
CREATE TABLE music_migration_0053 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  category TEXT,
  tags TEXT,
  duration INTEGER DEFAULT 0,
  file_path TEXT,
  storage_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER,
  original_name TEXT,
  file_size INTEGER DEFAULT 0,
  file_type TEXT,
  cover_image TEXT,
  lyrics TEXT,
  lyrics_source TEXT,
  has_lyrics INTEGER DEFAULT 0,
  lyrics_updated_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO music_migration_0053 (${MUSIC_STORAGE_COPY_COLUMNS})
SELECT id, title, artist, album, ${categoryExpression}, ${tagsExpression}, duration,
  file_path, NULL, NULL, NULL, NULL,
  file_size, file_type, cover_image, lyrics, lyrics_source, has_lyrics,
  lyrics_updated_at, created_at, updated_at
FROM music;
DROP TABLE music;
ALTER TABLE music_migration_0053 RENAME TO music;
INSERT INTO playlist_songs SELECT * FROM prm_music_v0053_playlist_songs;
DELETE FROM sqlite_sequence WHERE name IN ('music', 'playlist_songs');
INSERT INTO sqlite_sequence (name, seq)
SELECT 'music', seq FROM prm_music_v0053_sequence;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'playlist_songs', seq FROM prm_music_v0053_child_sequence;
`

const MUSIC_STORAGE_MIGRATION_COMMON = createMusicStorageMigrationCommon({
  categoryExpression: 'NULL',
  tagsExpression: 'NULL'
})

const MUSIC_STORAGE_MIGRATION_COMMON_WITH_CATEGORY_TAGS = createMusicStorageMigrationCommon({
  categoryExpression: 'category',
  tagsExpression: 'tags'
})

export const MUSIC_STORAGE_MIGRATION_SOURCE_NO_INDEXES = `${MUSIC_STORAGE_MIGRATION_COMMON}
DROP TABLE prm_music_v0053_playlist_songs;
DROP TABLE prm_music_v0053_child_sequence;
DROP TABLE prm_music_v0053_sequence;
DROP TABLE prm_music_v0053_guard;`.trim()

export const MUSIC_STORAGE_MIGRATION_SOURCE_KNOWN_INDEXES = `${MUSIC_STORAGE_MIGRATION_COMMON}
CREATE INDEX idx_music_artist ON music(artist);
CREATE INDEX idx_music_album ON music(album);
CREATE INDEX idx_music_title ON music(title);
CREATE INDEX idx_music_created_at ON music(created_at);
CREATE INDEX idx_music_has_lyrics ON music(has_lyrics);
DROP TABLE prm_music_v0053_playlist_songs;
DROP TABLE prm_music_v0053_child_sequence;
DROP TABLE prm_music_v0053_sequence;
DROP TABLE prm_music_v0053_guard;`.trim()

export const MUSIC_STORAGE_MIGRATION_SOURCE_CATEGORY_TAGS_NO_INDEXES = `${MUSIC_STORAGE_MIGRATION_COMMON_WITH_CATEGORY_TAGS}
DROP TABLE prm_music_v0053_playlist_songs;
DROP TABLE prm_music_v0053_child_sequence;
DROP TABLE prm_music_v0053_sequence;
DROP TABLE prm_music_v0053_guard;`.trim()

export const MUSIC_STORAGE_MIGRATION_SOURCE_CATEGORY_TAGS_KNOWN_INDEXES = `${MUSIC_STORAGE_MIGRATION_COMMON_WITH_CATEGORY_TAGS}
CREATE INDEX idx_music_artist ON music(artist);
CREATE INDEX idx_music_album ON music(album);
CREATE INDEX idx_music_title ON music(title);
CREATE INDEX idx_music_created_at ON music(created_at);
CREATE INDEX idx_music_has_lyrics ON music(has_lyrics);
DROP TABLE prm_music_v0053_playlist_songs;
DROP TABLE prm_music_v0053_child_sequence;
DROP TABLE prm_music_v0053_sequence;
DROP TABLE prm_music_v0053_guard;`.trim()

export const MUSIC_STORAGE_MIGRATION_SOURCE = MUSIC_STORAGE_MIGRATION_SOURCE_NO_INDEXES
