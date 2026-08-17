import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  MUSIC_STORAGE_KNOWN_INDEXES,
  MUSIC_STORAGE_LEGACY_DDL_APPENDED,
  MUSIC_STORAGE_LEGACY_DDL,
  MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE,
  MUSIC_STORAGE_LEGACY_DDL_PARTIAL_APPENDED,
  MUSIC_STORAGE_TARGET_DDL,
  MUSIC_STORAGE_TARGET_SHAPE
} from '../src/config/musicStorageSchema.js'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

const migration = applicationMigrationRegistry.migrations.find(({ id }) => id === '0053_music_storage_shape')
const registry = createMigrationRegistry([migration])

const playlistsDdl = `CREATE TABLE playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  cover_image TEXT,
  song_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

const playlistSongsDdl = (onDelete = 'CASCADE') => `CREATE TABLE playlist_songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  music_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(playlist_id, music_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (music_id) REFERENCES music(id) ON DELETE ${onDelete}
)`

function createLegacyDatabase({
  ddl = MUSIC_STORAGE_LEGACY_DDL,
  indexes = true,
  unknownColumn = false,
  unknownIndex = false,
  musicTrigger = false,
  childTrigger = false,
  foreignKeyDelete = 'CASCADE',
  extraInboundForeignKey = false
} = {}) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    ${playlistsDdl};
    ${ddl};
    ${playlistSongsDdl(foreignKeyDelete)};
    INSERT INTO playlists (id, name) VALUES (2, '收藏');
  `)
  if (indexes) {
    database.exec(`
      CREATE INDEX idx_music_artist ON music(artist);
      CREATE INDEX idx_music_album ON music(album);
      CREATE INDEX idx_music_title ON music(title);
      CREATE INDEX idx_music_created_at ON music(created_at);
      CREATE INDEX idx_music_has_lyrics ON music(has_lyrics);
    `)
  }
  if (unknownColumn) database.exec('ALTER TABLE music ADD COLUMN unexpected TEXT;')
  if (unknownIndex) database.exec('CREATE INDEX idx_music_unexpected ON music(artist);')
  if (musicTrigger) {
    database.exec(`CREATE TRIGGER music_unexpected_update
      AFTER UPDATE ON music BEGIN
        UPDATE music SET title = NEW.title WHERE id = NEW.id;
      END`)
  }
  if (extraInboundForeignKey) {
    database.exec(`CREATE TABLE music_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      music_id INTEGER NOT NULL,
      FOREIGN KEY (music_id) REFERENCES music(id) ON DELETE CASCADE
    )`)
  }
  database.prepare(`INSERT INTO music
    (id, title, artist, album, duration, file_path, file_size, file_type, cover_image,
     lyrics, lyrics_source, has_lyrics, lyrics_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    17, '旧歌', '歌手', '专辑', 245, '/legacy/music.mp3', 1234, 'mp3', '/legacy/cover.jpg',
    '歌词', 'manual', 1, '2026-08-01T00:00:00.000Z', '2026-01-01', '2026-02-01'
  )
  database.prepare(`INSERT INTO playlist_songs
    (id, playlist_id, music_id, sort_order, added_at) VALUES (?, ?, ?, ?, ?)`).run(
    29, 2, 17, 4, '2026-03-01'
  )
  if (childTrigger) {
    database.exec(`CREATE TRIGGER playlist_songs_unexpected_delete
      AFTER DELETE ON playlist_songs BEGIN
        UPDATE playlists SET song_count = song_count + 1 WHERE id = OLD.playlist_id;
      END`)
  }
  database.prepare("UPDATE sqlite_sequence SET seq = 41 WHERE name = 'music'").run()
  database.prepare("UPDATE sqlite_sequence SET seq = 43 WHERE name = 'playlist_songs'").run()
  ensureMigrationControlTables(database)
  return database
}

function runMigration(database) {
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-17T00:00:00.000Z'
  })
}

test('registers music storage migration and keeps empty target DDL aligned', nativeTestOptions, () => {
  assert.ok(migration)
  assert.deepEqual(migration.compatibility.target, MUSIC_STORAGE_TARGET_SHAPE)
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    database.exec(playlistsDdl)
    database.exec(MUSIC_STORAGE_TARGET_DDL)
    assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
      status: 'satisfied', kind: 'table-transition', table: 'music', reason: 'matched'
    })
    assert.equal(database.pragma('table_xinfo(music)').find(({ name }) => name === 'file_path').notnull, 0)
    assert.deepEqual(
      database.pragma('table_xinfo(music)').map(({ name }) => name),
      MUSIC_STORAGE_TARGET_SHAPE.columns.map(({ name }) => name)
    )
  } finally {
    database.close()
  }
})

for (const variant of [
  { name: 'legacy-no-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL, indexes: false },
  { name: 'legacy-known-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL, indexes: true },
  { name: 'legacy-database-base-no-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE, indexes: false },
  { name: 'legacy-database-base-known-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_DATABASE_BASE, indexes: true },
  { name: 'legacy-upgraded-appended-no-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_APPENDED, indexes: false },
  { name: 'legacy-upgraded-appended-known-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_APPENDED, indexes: true },
  { name: 'legacy-partial-appended-no-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_PARTIAL_APPENDED, indexes: false },
  { name: 'legacy-partial-appended-known-indexes', ddl: MUSIC_STORAGE_LEGACY_DDL_PARTIAL_APPENDED, indexes: true }
]) {
  test(`migrates ${variant.name} without losing music rows, identities, sequences, indexes, or inbound foreign keys`, nativeTestOptions, () => {
    const database = createLegacyDatabase(variant)
    try {
      assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
        status: 'missing', kind: 'table-transition', table: 'music', reason: 'legacy-matched',
        proofKey: variant.name
      })
      const summary = runMigration(database)
      assert.equal(summary.executedCount, 1)
      assert.deepEqual(database.prepare('SELECT * FROM music WHERE id = 17').get(), {
        id: 17,
        title: '旧歌',
        artist: '歌手',
        album: '专辑',
        duration: 245,
        file_path: '/legacy/music.mp3',
        storage_key: null,
        content_sha256: null,
        content_bytes: null,
        original_name: null,
        file_size: 1234,
        file_type: 'mp3',
        cover_image: '/legacy/cover.jpg',
        lyrics: '歌词',
        lyrics_source: 'manual',
        has_lyrics: 1,
        lyrics_updated_at: '2026-08-01T00:00:00.000Z',
        created_at: '2026-01-01',
        updated_at: '2026-02-01'
      })
      assert.deepEqual(database.prepare('SELECT id, playlist_id, music_id, sort_order, added_at FROM playlist_songs').get(), {
        id: 29, playlist_id: 2, music_id: 17, sort_order: 4, added_at: '2026-03-01'
      })
      assert.deepEqual(
        database.prepare(`
          SELECT "table" AS referenced_table, "from" AS local_column, "to" AS referenced_column,
                 on_update, on_delete
          FROM pragma_foreign_key_list('playlist_songs')
          WHERE "table" = 'music'
        `).all(),
        [{
          referenced_table: 'music',
          local_column: 'music_id',
          referenced_column: 'id',
          on_update: 'NO ACTION',
          on_delete: 'CASCADE'
        }]
      )
      assert.equal(database.pragma('table_xinfo(music)').find(({ name }) => name === 'file_path').notnull, 0)
      assert.deepEqual(database.pragma('foreign_key_check'), [])
      assert.deepEqual(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'music' ORDER BY name").all(),
        (variant.indexes ? MUSIC_STORAGE_KNOWN_INDEXES : []).map(({ name }) => ({ name })).sort((left, right) => left.name.localeCompare(right.name))
      )
      assert.deepEqual(
        database.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('music', 'playlist_songs') ORDER BY name").all(),
        [
          { name: 'music', seq: 41 },
          { name: 'playlist_songs', seq: 43 }
        ]
      )
      const second = executeMigrationBatch({
        database,
        registry,
        plan: createMigrationPlan(registry, []),
        lock: { state: 'active' },
        now: () => '2026-08-17T00:01:00.000Z'
      })
      assert.deepEqual(second, {
        executed: [],
        skipped: [{ id: '0053_music_storage_shape', status: 'skipped' }],
        executedCount: 0,
        skippedCount: 1,
        total: 1
      })
    } finally {
      database.close()
    }
  })
}

test('rejects unknown music schema and rolls back all transition artifacts', nativeTestOptions, () => {
  for (const options of [
    { unknownColumn: true },
    { unknownIndex: true },
    { musicTrigger: true }
  ]) {
    const database = createLegacyDatabase({ indexes: false, ...options })
    try {
      assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'incompatible')
      assert.throws(() => runMigration(database))
      assert.equal(database.prepare('SELECT file_path FROM music WHERE id = 17').get().file_path, '/legacy/music.mp3')
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 1)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'prm_music_v0053_%'").get().count, 0)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'music_migration_0053'").get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
    } finally {
      database.close()
    }
  }
})

test('rejects child triggers and incompatible or unknown inbound foreign keys before rebuilding music', nativeTestOptions, () => {
  for (const options of [
    { childTrigger: true },
    { foreignKeyDelete: 'SET NULL' },
    { extraInboundForeignKey: true }
  ]) {
    const database = createLegacyDatabase(options)
    try {
      assert.equal(checkMigrationCompatibility(database, migration.compatibility).status, 'missing')
      assert.throws(() => runMigration(database))
      assert.equal(database.prepare('SELECT title FROM music WHERE id = 17').get().title, '旧歌')
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM playlist_songs').get().count, 1)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'prm_music_v0053_%'").get().count, 0)
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'music_migration_0053'").get().count, 0)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
    } finally {
      database.close()
    }
  }
})
