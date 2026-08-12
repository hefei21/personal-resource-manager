import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'

const require = createRequire(import.meta.url)
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const backendDirectory = path.resolve(testDirectory, '..')
const databaseSourcePath = path.join(backendDirectory, 'src', 'config', 'database.js')
const databaseMigrationsSourcePath = path.join(backendDirectory, 'src', 'config', 'databaseMigrations.js')
const retiredReadingProgressScriptPath = path.join(backendDirectory, 'migrations', 'remove_old_progress_fields.js')
const indexSourcePath = path.join(backendDirectory, 'src', 'index.js')
const childPath = path.join(testDirectory, 'fixtures', 'database-startup-child.js')

function isKnownNativeBindingMissingError(error) {
  const message = String(error?.message ?? '')
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(message)
}

let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Node 22 CI must run this test' }

const PLACEHOLDER_PASSWORD = 'ci-only-placeholder-password'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-database-startup-'))
}

function removeTemporaryDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function runChild(directory, password = PLACEHOLDER_PASSWORD, { diagnostics = false } = {}) {
  const databasePath = path.join(directory, 'app.db')
  const result = spawnSync(process.execPath, [childPath], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PR_DATABASE_STARTUP_CHILD: '1',
      DATA_PATH: directory,
      DB_PATH: databasePath,
      DEFAULT_USERNAME: 'ci-owner',
      DEFAULT_PASSWORD: password,
      PR_DATABASE_STARTUP_DIAGNOSTICS: diagnostics ? '1' : '0',
      NODE_ENV: 'test'
    },
    encoding: 'utf8',
    timeout: 30000
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.doesNotMatch(output, new RegExp(PLACEHOLDER_PASSWORD, 'u'))
  assert.doesNotMatch(output, new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  assert.equal(result.error, undefined, result.error?.message)
  return { databasePath, output, result }
}

function readChildResult(output) {
  const json = output.trim()
  assert.notEqual(json, '', 'child produced no structured result')
  return JSON.parse(json)
}

function readColumn(database, table, column) {
  return database.prepare(
    'SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, hidden FROM pragma_table_xinfo(?) WHERE name = ?'
  ).get(table, column)
}

function assertRegisteredColumn(database, table, column, type, notNull, defaultValue) {
  assert.deepEqual(readColumn(database, table, column), {
    name: column,
    type,
    not_null: notNull,
    default_value: defaultValue,
    hidden: 0
  })
}

function assertApplicationMigrationLedger(database, expectedAttemptCount) {
  assert.deepEqual(
    database.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
    applicationMigrationRegistry.migrations.map(({ id }) => ({ migration_id: id }))
  )
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count, expectedAttemptCount)
}

const legacyCodeRepositories6Ddl = `CREATE TABLE code_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`

const legacyCodeRepositories9Ddl = `CREATE TABLE "code_repositories" (
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

function createLegacyCodeRepositories(database, variant) {
  if (variant === 'legacy-6-columns') {
    database.exec(legacyCodeRepositories6Ddl)
    return
  }
  database.exec(legacyCodeRepositories9Ddl.replace('"code_repositories"', 'code_repositories_new'))
  database.exec('ALTER TABLE code_repositories_new RENAME TO code_repositories')
  if (variant === 'legacy-10-double-quoted-languages') {
    database.exec('ALTER TABLE code_repositories ADD COLUMN languages TEXT DEFAULT "{}"')
  }
}

function codeRepositorySnapshot(database) {
  return {
    sql: database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'code_repositories'"
    ).get().sql,
    rows: database.prepare('SELECT * FROM code_repositories ORDER BY id').all(),
    sequence: database.prepare(
      "SELECT rowid, name, seq, typeof(seq) AS storage_type FROM sqlite_sequence WHERE name = 'code_repositories' ORDER BY rowid"
    ).all()
  }
}

function assertNoCodeRepositoryMigrationHelpers(database) {
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE name LIKE 'prm_code_repositories_v0037_%' OR name = 'code_repositories_migration_0037'
  `).get().count, 0)
}

function assertCodeRepositoryMigrationNotApplied(database) {
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM prm_schema_migrations
    WHERE migration_id = '0037_code_repositories_shape'
  `).get().count, 0)
}

const legacyReadingProgressDdl = `CREATE TABLE reading_progress (
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

const targetReadingProgressDdl = `CREATE TABLE reading_progress (
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

function createLegacyReadingProgressSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `)
  database.exec(legacyReadingProgressDdl)
}

function createTargetReadingProgressSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `)
  database.exec(targetReadingProgressDdl)
}

function readingProgressSnapshot(database) {
  return {
    sql: database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'reading_progress'"
    ).get().sql,
    columns: database.prepare('PRAGMA table_info(reading_progress)').all(),
    rows: database.prepare('SELECT * FROM reading_progress ORDER BY id').all(),
    sequence: database.prepare(
      "SELECT rowid, name, seq, typeof(seq) AS storage_type FROM sqlite_sequence WHERE name = 'reading_progress' ORDER BY rowid"
    ).all()
  }
}

function assertNoReadingProgressMigrationHelpers(database) {
  const helperQuery = `
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE name LIKE 'prm_reading_progress_v0038_%' OR name = 'reading_progress_migration_0038'
  `
  const tempHelperQuery = `
    SELECT COUNT(*) AS count FROM sqlite_temp_schema
    WHERE name LIKE 'prm_reading_progress_v0038_%' OR name = 'reading_progress_migration_0038'
  `
  assert.equal(database.prepare(helperQuery).get().count, 0)
  assert.equal(database.prepare(tempHelperQuery).get().count, 0)
}

function assertReadingProgressMigrationNotApplied(database) {
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM prm_schema_migrations
    WHERE migration_id = '0038_reading_progress_shape'
  `).get().count, 0)
}

function assertNoReadingProgressSuccessLedger(database) {
  assertReadingProgressMigrationNotApplied(database)
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM prm_migration_attempts
    WHERE migration_id = '0038_reading_progress_shape' AND status = 'applied'
  `).get().count, 0)
}

const expectedAnimeMigrations = [
  {
    id: '0007_anime_name_cn',
    source: 'ALTER TABLE anime ADD COLUMN name_cn TEXT;',
    checksum: '088e0ecbef572542ce6fc9548fe5f3fba045939360b0b681a324f6786b6a43ae',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'name_cn', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0008_anime_name_original',
    source: 'ALTER TABLE anime ADD COLUMN name_original TEXT;',
    checksum: '2974a03a539ec520d7f545d029448d4b186ed9b6f18ba31f7f09fb4d506a81b9',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'name_original', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0009_anime_rating_count',
    source: 'ALTER TABLE anime ADD COLUMN rating_count INTEGER DEFAULT 0;',
    checksum: 'c0995b24557ea7aa8ed3121194d5f96dd79ae46a7c713d8b211b46a14b08a8ea',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'rating_count', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0010_anime_air_date',
    source: 'ALTER TABLE anime ADD COLUMN air_date TEXT;',
    checksum: 'e5b50fc3b645753e376dcde6a28ec68abaded269b96924503e98f37effd7a746',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'air_date', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0011_anime_eps',
    source: 'ALTER TABLE anime ADD COLUMN eps INTEGER DEFAULT 0;',
    checksum: 'fa3621ce113d45f650829e05586a309fe4a660456b48f8c6294cb312dec78e19',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'eps', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0012_anime_eps_total',
    source: 'ALTER TABLE anime ADD COLUMN eps_total INTEGER DEFAULT 0;',
    checksum: 'f4a9058f0588cfd74652b0ae87bdf645e6ce81494fc6f1d6df724b9283da14a3',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'eps_total', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0013_anime_author',
    source: 'ALTER TABLE anime ADD COLUMN author TEXT;',
    checksum: 'a4ef413698dd242d951f67a1ae3e311960acdc6ca01ed5a6ec4b09f629ce4bf7',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'author', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0014_anime_director',
    source: 'ALTER TABLE anime ADD COLUMN director TEXT;',
    checksum: '8924d3b53915537c9c376f7fbb844e5c5b441025096eb9d49114270bfa382829',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'director', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0015_anime_studio',
    source: 'ALTER TABLE anime ADD COLUMN studio TEXT;',
    checksum: '92ce7d8830ce6cf86ef08afac9bb88d4c284c87fc01d59b321dbe072590dc3c4',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'studio', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0016_anime_infobox',
    source: 'ALTER TABLE anime ADD COLUMN infobox TEXT;',
    checksum: 'e92bd7729a7382ef5e5cdd089ea6a794b82c34c503b4e0db7ddfd072d75b5b00',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'infobox', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0017_anime_characters',
    source: 'ALTER TABLE anime ADD COLUMN characters TEXT;',
    checksum: '46a7a9426134f664ce425fab91c664cc6a9461937fa1bf9fab8f792281fd1903',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'characters', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0018_anime_staff',
    source: 'ALTER TABLE anime ADD COLUMN staff TEXT;',
    checksum: 'aabcaf4981ecdf98a3e0d8697fd78769d03a306f14e672d526ce34d7372c6af9',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'staff', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0019_anime_user_rating',
    source: 'ALTER TABLE anime ADD COLUMN user_rating INTEGER DEFAULT 0;',
    checksum: '01b8df79de27dc7f17df601b9041e2e3abb496f7e4635ffe0b1dc2598d92222b',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'user_rating', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0020_anime_is_hidden',
    source: 'ALTER TABLE anime ADD COLUMN is_hidden INTEGER DEFAULT 0;',
    checksum: 'ec6f38b1deadd148c945d050d852bffd5de49edf4c03ddad27b8dbe3204896c8',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'is_hidden', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0021_anime_cover_image_data',
    source: 'ALTER TABLE anime ADD COLUMN cover_image_data TEXT;',
    checksum: '934ba7d8a59bbd9576fde3c2ee52134ac2422d661f261e8b22c125b07fc4a203',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: { name: 'cover_image_data', type: 'TEXT', notNull: false, defaultValue: null }
    }
  }
]

const expectedGamesMigrations = [
  {
    id: '0022_games_achievements_total',
    source: 'ALTER TABLE games ADD COLUMN achievements_total INTEGER DEFAULT 0;',
    checksum: 'd4f81027f3ce90dc323216db9bc9ab85280e6509726c93ef0158f5c3862dd201',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: { name: 'achievements_total', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0023_games_achievements_completed',
    source: 'ALTER TABLE games ADD COLUMN achievements_completed INTEGER DEFAULT 0;',
    checksum: '6ffd948cc9379723232f041b69a48115b642c7ca64c5e4549fcc9606bd179424',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: { name: 'achievements_completed', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0024_games_header_cover_image',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image TEXT;',
    checksum: '8f404920018e9d44c137960df21a3225aa5e745936ca2148b70612c764295ce4',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: { name: 'header_cover_image', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0025_games_header_cover_image_data',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image_data TEXT;',
    checksum: '8e8d124c6726134aea35c08c4729ce6654ed836d7a829f7d62d1f97952f1b037',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: { name: 'header_cover_image_data', type: 'TEXT', notNull: false, defaultValue: null }
    }
  }
]

const expectedMusicMigrations = [
  {
    id: '0026_music_artist',
    source: 'ALTER TABLE music ADD COLUMN artist TEXT;',
    checksum: 'c2557c2b70533cabfd915d4222f66062606acba8adce8fb49321db56e075b547',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'artist', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0027_music_album',
    source: 'ALTER TABLE music ADD COLUMN album TEXT;',
    checksum: 'a077b2e3935fda667528c6aeb8a3857864937c526b54f7b6ff571f40b9455b01',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'album', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0028_music_duration',
    source: 'ALTER TABLE music ADD COLUMN duration INTEGER DEFAULT 0;',
    checksum: '9daecdb79ccbc3d5d4edcdd1b7228fa34ff7f2ac99b2038a7d880416b5629686',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'duration', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0029_music_file_size',
    source: 'ALTER TABLE music ADD COLUMN file_size INTEGER DEFAULT 0;',
    checksum: 'ea38efbf459c3d2302404060a7fa23dc98ecca0c1663224667da8a35952d6279',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'file_size', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0030_music_file_type',
    source: 'ALTER TABLE music ADD COLUMN file_type TEXT;',
    checksum: 'fd01511b5daee2093b2839f182191abc7c4044f9ea2488e6c7269d0ba8b6c7d2',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'file_type', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0031_music_cover_image',
    source: 'ALTER TABLE music ADD COLUMN cover_image TEXT;',
    checksum: 'fdf65f6536b6720bafef0ac3e959e9196067dc45607469924c5e9b4d8ad4d35a',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'cover_image', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0032_music_lyrics',
    source: 'ALTER TABLE music ADD COLUMN lyrics TEXT;',
    checksum: '03a2f87293a4110b28a80b816d2ffa9797412460598239af371294e074fde780',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'lyrics', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0033_music_lyrics_source',
    source: 'ALTER TABLE music ADD COLUMN lyrics_source TEXT;',
    checksum: '8a65dfa65a99124614385190b8d3506f6e47f75fa02d6a384627ae36746d7174',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'lyrics_source', type: 'TEXT', notNull: false, defaultValue: null }
    }
  },
  {
    id: '0034_music_has_lyrics',
    source: 'ALTER TABLE music ADD COLUMN has_lyrics INTEGER DEFAULT 0;',
    checksum: '52b6a0c2383a86cf1cad0f2bdc610c1bcd36f9dc18d46b734117f69f9362d0b5',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'has_lyrics', type: 'INTEGER', notNull: false, defaultValue: '0' }
    }
  },
  {
    id: '0035_music_lyrics_updated_at',
    source: 'ALTER TABLE music ADD COLUMN lyrics_updated_at TEXT;',
    checksum: '9f385b9c05124817c611b4c9977aeeea407714dde72ef9062242370e50a5cd2c',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: { name: 'lyrics_updated_at', type: 'TEXT', notNull: false, defaultValue: null }
    }
  }
]

test('application registry freezes 43 column migrations and six registered table transitions', () => {
  assert.ok(Object.isFrozen(applicationMigrationRegistry))
  assert.ok(Object.isFrozen(applicationMigrationRegistry.migrations))
  assert.ok(applicationMigrationRegistry.migrations.every((migration) => Object.isFrozen(migration)))
  assert.equal(applicationMigrationRegistry.migrations.length, 49)
  assert.deepEqual(
    applicationMigrationRegistry.migrations.map(({ id }) => id),
    [
      '0001_documents_subcategory',
      '0002_categories_sort_order',
      '0003_todos_confirmed',
      '0004_books_content_cache',
      '0005_bookmarks_icon',
      '0006_bookmarks_icon_data',
      ...expectedAnimeMigrations.map(({ id }) => id),
      ...expectedGamesMigrations.map(({ id }) => id),
      ...expectedMusicMigrations.map(({ id }) => id),
      '0036_documents_version_real',
      '0037_code_repositories_shape',
      '0038_reading_progress_shape',
      '0039_storage_commit_operations',
      '0040_documents_category_id',
      '0041_documents_storage_key',
      '0042_documents_content_sha256',
      '0043_documents_content_bytes',
      '0044_documents_original_name',
      '0045_document_versions_storage_key',
      '0046_document_versions_content_sha256',
      '0047_document_versions_content_bytes',
      '0048_document_versions_storage_shape',
      '0049_documents_storage_shape'
    ]
  )
  assert.deepEqual(applicationMigrationRegistry.migrations.slice(0, 6).map(({ id, source, checksum, compatibility }) => ({
    id,
    source,
    checksum,
    compatibility
  })), [
    {
      id: '0001_documents_subcategory',
      source: 'ALTER TABLE documents ADD COLUMN subcategory TEXT;',
      checksum: '9a05c2803d06c7ebaac7841b0d08ab5e024aa1e92b7a9494ae29f88dc18d4646',
      compatibility: {
        kind: 'column',
        table: 'documents',
        column: { name: 'subcategory', type: 'TEXT', notNull: false, defaultValue: null }
      }
    },
    {
      id: '0002_categories_sort_order',
      source: 'ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0;',
      checksum: '815d6f288d7daa7cecd94e9ea161fc6a278c9921516b95ec0ae07e2c6a4e5247',
      compatibility: {
        kind: 'column',
        table: 'categories',
        column: { name: 'sort_order', type: 'INTEGER', notNull: false, defaultValue: '0' }
      }
    },
    {
      id: '0003_todos_confirmed',
      source: 'ALTER TABLE todos ADD COLUMN confirmed INTEGER DEFAULT 0;',
      checksum: '4c15f429d72185876d7f36e8aef9c11a848a286e5c504f492034bbfa24bc63ed',
      compatibility: {
        kind: 'column',
        table: 'todos',
        column: { name: 'confirmed', type: 'INTEGER', notNull: false, defaultValue: '0' }
      }
    },
    {
      id: '0004_books_content_cache',
      source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;',
      checksum: '81d4063c0f155df031608f631b6ae5103b7cdfceb2e2dcd1eee04ea2f4468ed0',
      compatibility: {
        kind: 'column',
        table: 'books',
        column: { name: 'content_cache', type: 'TEXT', notNull: false, defaultValue: null }
      }
    },
    {
      id: '0005_bookmarks_icon',
      source: 'ALTER TABLE bookmarks ADD COLUMN icon TEXT;',
      checksum: '25da26a2261ef28419cf88fe7340b9012484ff3a8a611cd3cbb8b190a92a8248',
      compatibility: {
        kind: 'column',
        table: 'bookmarks',
        column: { name: 'icon', type: 'TEXT', notNull: false, defaultValue: null }
      }
    },
    {
      id: '0006_bookmarks_icon_data',
      source: 'ALTER TABLE bookmarks ADD COLUMN icon_data TEXT;',
      checksum: 'bea2993a676e2de164f685992a0710655e798b88f113696bbb9a7b05d5a59326',
      compatibility: {
        kind: 'column',
        table: 'bookmarks',
        column: { name: 'icon_data', type: 'TEXT', notNull: false, defaultValue: null }
      }
    }
  ])
  assert.deepEqual(applicationMigrationRegistry.migrations.slice(6, 21), expectedAnimeMigrations)
  assert.deepEqual(applicationMigrationRegistry.migrations.slice(21, 25), expectedGamesMigrations)
  assert.deepEqual(applicationMigrationRegistry.migrations.slice(25, 35), expectedMusicMigrations)
  const documentMigration = applicationMigrationRegistry.migrations[35]
  assert.equal(documentMigration.compatibility.kind, 'table-transition')
  assert.equal(documentMigration.compatibility.table, 'documents')
  assert.equal(documentMigration.compatibility.target.columns.find(({ name }) => name === 'version').type, 'REAL')
  assert.equal(documentMigration.compatibility.legacy.length, 16)
  assert.match(documentMigration.source, /prm_documents_v0036_guard/u)
  assert.match(documentMigration.source, /CAST\(version AS REAL\)/u)
  const codeRepositoryMigration = applicationMigrationRegistry.migrations[36]
  assert.equal(codeRepositoryMigration.compatibility.kind, 'table-transition')
  assert.equal(codeRepositoryMigration.compatibility.table, 'code_repositories')
  assert.deepEqual(
    codeRepositoryMigration.compatibility.target.columns.map(({ name }) => name),
    ['id', 'name', 'url', 'description', 'local_path', 'type', 'last_sync', 'created_at', 'updated_at', 'languages']
  )
  assert.deepEqual(codeRepositoryMigration.compatibility.targetProof, {
    createTableSqlSha256: '96507297d6cf66cb199e7db6f70804a1d3ff459763793ebf31f68960538a229a',
    indexes: [],
    triggers: [],
    externalDependencies: { inboundForeignKeys: 'none', schemaSqlReferences: 'none' }
  })
  assert.deepEqual(
    codeRepositoryMigration.compatibility.legacy.map(({ proofKey }) => proofKey),
    ['legacy-10-double-quoted-languages', 'legacy-6-columns', 'legacy-9-columns']
  )
  assert.deepEqual(
    codeRepositoryMigration.sourceVariants.map(({ proofKey }) => proofKey),
    ['legacy-10-double-quoted-languages', 'legacy-6-columns', 'legacy-9-columns']
  )
  assert.ok(codeRepositoryMigration.sourceVariants.every(({ source }) => (
    /prm_code_repositories_v0037_guard/u.test(source) &&
    /EXCEPT/u.test(source) &&
    /pragma_foreign_key_check/u.test(source) &&
    !/foreign_keys\s*=|writable_schema|\bPRAGMA\b/iu.test(source)
  )))
  const readingProgressMigration = applicationMigrationRegistry.migrations[37]
  assert.equal(readingProgressMigration.checksum, '6462d6ba78b6e3c492c5e65436fc18031412aac46c842676897cd15cc7ad60f4')
  assert.equal(readingProgressMigration.compatibility.kind, 'table-transition')
  assert.equal(readingProgressMigration.compatibility.table, 'reading_progress')
  assert.deepEqual(
    readingProgressMigration.compatibility.target.columns.map(({ name }) => name),
    ['id', 'book_id', 'user_id', 'current_page', 'cfi', 'progress', 'font_size', 'created_at', 'updated_at']
  )
  assert.deepEqual(
    readingProgressMigration.compatibility.legacy.map(({ proofKey }) => proofKey),
    ['legacy-8-columns']
  )
  assert.deepEqual(
    readingProgressMigration.sourceVariants.map(({ proofKey }) => proofKey),
    ['legacy-8-columns']
  )
  assert.deepEqual(readingProgressMigration.compatibility.targetProof, {
    createTableSqlSha256: 'db2701e4f38382eed59af1b43a8749a0f94d8bb1a8bfad01b83e2e5c06ba6330',
    indexes: [],
    triggers: [],
    externalDependencies: { inboundForeignKeys: 'none', schemaSqlReferences: 'none' }
  })
  assert.deepEqual(
    readingProgressMigration.compatibility.legacy.map(({ proofKey, createTableSqlSha256, indexes, triggers }) => ({
      proofKey,
      createTableSqlSha256,
      indexes,
      triggers
    })),
    [{
      proofKey: 'legacy-8-columns',
      createTableSqlSha256: 'c8ff9d212f2a85d07b7bc44ea8de3bea2563aa4da7ce97f9db512f2e39137c99',
      indexes: [],
      triggers: []
    }]
  )
  assert.ok(readingProgressMigration.sourceVariants.every(({ source }) => (
    /prm_reading_progress_v0038_guard/u.test(source) &&
    /prm_reading_progress_v0038_sequence/u.test(source) &&
    /prm_reading_progress_v0038_equality/u.test(source) &&
    /pragma_foreign_key_check/u.test(source) &&
    /CREATE TABLE reading_progress_migration_0038/u.test(source) &&
    !/foreign_keys\s*=|writable_schema|\bPRAGMA\b/iu.test(source)
  )))
  const storageCommitMigration = applicationMigrationRegistry.migrations[38]
  assert.equal(storageCommitMigration.compatibility.kind, 'table-transition')
  assert.equal(storageCommitMigration.compatibility.table, 'storage_commit_operations')
  assert.equal(storageCommitMigration.compatibility.missingTable, 'create')
  assert.deepEqual(storageCommitMigration.compatibility.legacy, [])
  assert.deepEqual(
    storageCommitMigration.compatibility.target.columns.map(({ name }) => name),
    [
      'idempotency_key', 'state', 'staging_token', 'storage_key', 'sha256',
      'bytes', 'error_code', 'created_at', 'updated_at'
    ]
  )
  assert.deepEqual(storageCommitMigration.compatibility.targetProof.indexes, [])
  assert.deepEqual(storageCommitMigration.compatibility.targetProof.triggers, [])
  assert.deepEqual(storageCommitMigration.compatibility.targetProof.externalDependencies, {
    inboundForeignKeys: 'none',
    schemaSqlReferences: 'none'
  })
  assert.match(storageCommitMigration.source, /CREATE TABLE storage_commit_operations/u)
  assert.deepEqual(
    applicationMigrationRegistry.migrations.slice(39, 47).map(({ id, compatibility }) => ({
      id,
      table: compatibility.table,
      column: compatibility.column
    })),
    [
      ['0040_documents_category_id', 'documents', 'category_id', 'INTEGER'],
      ['0041_documents_storage_key', 'documents', 'storage_key', 'TEXT'],
      ['0042_documents_content_sha256', 'documents', 'content_sha256', 'TEXT'],
      ['0043_documents_content_bytes', 'documents', 'content_bytes', 'INTEGER'],
      ['0044_documents_original_name', 'documents', 'original_name', 'TEXT'],
      ['0045_document_versions_storage_key', 'document_versions', 'storage_key', 'TEXT'],
      ['0046_document_versions_content_sha256', 'document_versions', 'content_sha256', 'TEXT'],
      ['0047_document_versions_content_bytes', 'document_versions', 'content_bytes', 'INTEGER']
    ].map(([id, table, name, type]) => ({
      id,
      table,
      column: { name, type, notNull: false, defaultValue: null }
    }))
  )
  const documentVersionsStorageMigration = applicationMigrationRegistry.migrations[47]
  assert.equal(documentVersionsStorageMigration.compatibility.table, 'document_versions')
  assert.equal(documentVersionsStorageMigration.compatibility.target.columns.find(
    ({ name }) => name === 'file_path'
  ).notNull, false)
  assert.deepEqual(
    documentVersionsStorageMigration.compatibility.legacy.map(({ proofKey }) => proofKey),
    ['expanded-appended']
  )
  const documentsStorageMigration = applicationMigrationRegistry.migrations[48]
  assert.equal(documentsStorageMigration.compatibility.table, 'documents')
  assert.equal(documentsStorageMigration.compatibility.target.columns.find(
    ({ name }) => name === 'file_path'
  ).notNull, false)
  assert.deepEqual(documentsStorageMigration.compatibility.target.foreignKeys, [{
    columns: ['category_id'], referencedTable: 'categories', referencedColumns: ['id'],
    onUpdate: 'NO ACTION', onDelete: 'SET NULL'
  }])
  const documentStorageProofKeys = [
    'expanded-appended-no-indexes',
    'expanded-appended-known-indexes',
    'v0036-expanded-appended-no-indexes',
    'v0036-expanded-appended-known-indexes'
  ]
  assert.deepEqual(
    documentsStorageMigration.compatibility.legacy.map(({ proofKey }) => proofKey),
    documentStorageProofKeys
  )
  assert.deepEqual(
    documentsStorageMigration.sourceVariants.map(({ proofKey }) => proofKey),
    documentStorageProofKeys
  )
})

test('static contract runs the startup gate once after base tables and before all later initialization', () => {
  const databaseSource = fs.readFileSync(databaseSourcePath, 'utf8')
  const databaseMigrationsSource = fs.readFileSync(databaseMigrationsSourcePath, 'utf8')
  const indexSource = fs.readFileSync(indexSourcePath, 'utf8').replace(/\r\n?/gu, '\n')

  assert.equal(fs.existsSync(retiredReadingProgressScriptPath), false)
  assert.doesNotMatch(databaseSource, /schema_migrations/u)
  assert.doesNotMatch(databaseSource, /reading_progress_add_user_id/u)
  assert.doesNotMatch(databaseSource, /anime_status_v1/u)
  assert.doesNotMatch(databaseSource, /hasSubcategory|hasSortOrder|hasConfirmed/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE documents ADD COLUMN subcategory/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE categories ADD COLUMN sort_order/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE todos ADD COLUMN confirmed/u)
  assert.doesNotMatch(databaseSource, /PRAGMA table_info\(categories\)/u)
  assert.doesNotMatch(databaseSource, /PRAGMA table_info\(todos\)/u)
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS bookmarks \([\s\S]*icon TEXT,[\s\S]*icon_data TEXT/u)
  assert.doesNotMatch(databaseSource, /bookmarkColumns|hasIcon|hasIconData|ALTER TABLE bookmarks ADD COLUMN icon/u)
  assert.doesNotMatch(databaseSource, /versionCol|documents_new|CAST\(version AS REAL\)/u)
  assert.match(databaseMigrationsSource, /id: '0036_documents_version_real'/u)
  assert.match(databaseSource, /last_read_at DATETIME,\s+content_cache TEXT/u)
  assert.doesNotMatch(databaseSource, /hasContentCache|ALTER TABLE books ADD COLUMN content_cache TEXT/u)
  assert.doesNotMatch(databaseSource, /DROP TABLE IF EXISTS code_versions/u)
  assert.doesNotMatch(databaseSource, /AS notNull|AS defaultValue/u)
  assert.match(databaseMigrationsSource, /id: '0004_books_content_cache'/u)
  assert.match(databaseMigrationsSource, /source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;'/u)
  assert.match(databaseMigrationsSource, /id: '0005_bookmarks_icon'/u)
  assert.match(databaseMigrationsSource, /source: 'ALTER TABLE bookmarks ADD COLUMN icon TEXT;'/u)
  assert.match(databaseMigrationsSource, /id: '0006_bookmarks_icon_data'/u)
  assert.match(databaseMigrationsSource, /source: 'ALTER TABLE bookmarks ADD COLUMN icon_data TEXT;'/u)
  assert.doesNotMatch(databaseMigrationsSource, /DROP TABLE(?: IF EXISTS)? code_versions/u)
  assert.ok(applicationMigrationRegistry.migrations.every(({ source }) => !/DROP TABLE(?: IF EXISTS)? code_versions/u.test(source)))
  assert.match(databaseMigrationsSource, /id: '0037_code_repositories_shape'/u)
  assert.match(databaseMigrationsSource, /id: '0038_reading_progress_shape'/u)
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS code_repositories \([\s\S]*local_path TEXT NOT NULL DEFAULT ''[\s\S]*languages TEXT DEFAULT '\{\}'/u)
  assert.doesNotMatch(databaseSource, /codeColumns|hasLocalPath|code_repositories_new|hasLanguages/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE code_repositories ADD COLUMN languages/u)
  const baseCodeRepositoryStart = databaseSource.indexOf('CREATE TABLE IF NOT EXISTS code_repositories (')
  const baseCodeRepositoryEnd = databaseSource.indexOf('    )`,', baseCodeRepositoryStart)
  assert.ok(baseCodeRepositoryStart >= 0)
  assert.ok(baseCodeRepositoryEnd > baseCodeRepositoryStart)
  const persistedBaseCodeRepositoryDdl = databaseSource
    .slice(baseCodeRepositoryStart, baseCodeRepositoryEnd + '    )'.length)
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')
  assert.equal(
    createHash('sha256').update(Buffer.from(persistedBaseCodeRepositoryDdl, 'utf8')).digest('hex'),
    applicationMigrationRegistry.migrations[36].compatibility.targetProof.createTableSqlSha256
  )
  assert.doesNotMatch(databaseSource, /animeColumns|animeNewFields|ALTER TABLE anime ADD COLUMN/u)
  const animeTableStart = databaseSource.indexOf('CREATE TABLE IF NOT EXISTS anime (')
  const animeTableEnd = databaseSource.indexOf('    )`,', animeTableStart)
  assert.ok(animeTableStart >= 0)
  assert.ok(animeTableEnd > animeTableStart)
  const baseAnimeSource = databaseSource.slice(animeTableStart, animeTableEnd)
  for (const { name, type, defaultValue } of expectedAnimeMigrations.map(({ compatibility }) => compatibility.column)) {
    const defaultClause = defaultValue === null ? '' : `\\s+DEFAULT\\s+${defaultValue}`
    assert.match(
      baseAnimeSource,
      new RegExp(`${name}\\s+${type}${defaultClause}\\s*,`, 'u')
    )
  }
  assert.doesNotMatch(databaseSource, /gameColumns|gameNewFields|ALTER TABLE games ADD COLUMN/u)
  const gamesTableStart = databaseSource.indexOf('CREATE TABLE IF NOT EXISTS games (')
  const gamesTableEnd = databaseSource.indexOf('    )`,', gamesTableStart)
  assert.ok(gamesTableStart >= 0)
  assert.ok(gamesTableEnd > gamesTableStart)
  const baseGamesSource = databaseSource.slice(gamesTableStart, gamesTableEnd)
  for (const { name, type, defaultValue } of expectedGamesMigrations.map(({ compatibility }) => compatibility.column)) {
    const defaultClause = defaultValue === null ? '' : `\\s+DEFAULT\\s+${defaultValue}`
    assert.match(
      baseGamesSource,
      new RegExp(`${name}\\s+${type}${defaultClause}\\s*,`, 'u')
    )
  }
  assert.doesNotMatch(databaseSource, /musicColumns|musicNewFields|ALTER TABLE music ADD COLUMN/u)
  const musicTableStart = databaseSource.indexOf('CREATE TABLE IF NOT EXISTS music (')
  const musicTableEnd = databaseSource.indexOf('    )`,', musicTableStart)
  assert.ok(musicTableStart >= 0)
  assert.ok(musicTableEnd > musicTableStart)
  const baseMusicSource = databaseSource.slice(musicTableStart, musicTableEnd)
  for (const { name, type, defaultValue } of expectedMusicMigrations.map(({ compatibility }) => compatibility.column)) {
    const defaultClause = defaultValue === null ? '' : `\\s+DEFAULT\\s+${defaultValue}`
    assert.match(
      baseMusicSource,
      new RegExp(`${name}\\s+${type}${defaultClause}\\s*,`, 'u')
    )
  }
  const indexesStart = databaseSource.indexOf('const indexes = [')
  const indexesEnd = databaseSource.indexOf('  ]', indexesStart)
  assert.ok(indexesStart >= 0)
  assert.ok(indexesEnd > indexesStart)
  assert.equal(databaseSource.match(/idx_music_has_lyrics/gu)?.length, 1)
  const lyricsIndex = databaseSource.indexOf('idx_music_has_lyrics')
  assert.ok(lyricsIndex > indexesStart)
  assert.ok(lyricsIndex < indexesEnd)
  assert.doesNotMatch(databaseSource, /readingProgressColumns|hasCfi|hasCharacterOffset|hasCurrentChapter/u)
  assert.doesNotMatch(databaseSource, /ALTER TABLE reading_progress ADD COLUMN cfi/u)
  assert.doesNotMatch(databaseSource, /reading_progress_new|DROP TABLE reading_progress|RENAME TO reading_progress/u)
  assert.doesNotMatch(databaseSource, /idx_reading_progress_(?:book_id|user_id)/u)
  assert.doesNotMatch(databaseSource, /所有进度已重置为0|数据库字段更新失败/u)

  const instanceCall = databaseSource.indexOf("initDatabaseInstance(mainDb, 'main', () => {")
  const gateCall = databaseSource.indexOf('runMigrationStartupGate({', instanceCall)
  const returnCall = databaseSource.indexOf('return mainDb', gateCall)
  assert.ok(instanceCall >= 0)
  assert.ok(gateCall > instanceCall)
  assert.ok(returnCall > gateCall)
  assert.equal(databaseSource.match(/runMigrationStartupGate\(\{/gu)?.length, 1)

  const instanceDefinition = databaseSource.indexOf('function initDatabaseInstance(')
  const baseTableLoop = databaseSource.indexOf('tables.forEach(sql => {', instanceDefinition)
  const schemaGateHook = databaseSource.indexOf('runBaseSchemaGate()', baseTableLoop)
  const firstIndexes = databaseSource.indexOf('const indexes = [', schemaGateHook)
  const ownerInitialization = databaseSource.indexOf('initializeOwner(database, process.env)', schemaGateHook)
  assert.ok(instanceDefinition >= 0)
  assert.ok(baseTableLoop > instanceDefinition)
  assert.ok(schemaGateHook > baseTableLoop)
  assert.equal(databaseSource.match(/runBaseSchemaGate\(\)/gu)?.length, 1)
  assert.ok(firstIndexes > schemaGateHook)
  assert.ok(ownerInitialization > schemaGateHook)

  const initializeStart = indexSource.indexOf('async function initialize()')
  const initializeTry = indexSource.indexOf('try {', initializeStart)
  const databaseCall = indexSource.indexOf('initDatabase()', initializeTry)
  const listenCall = indexSource.indexOf('app.listen(', databaseCall)
  const initializeCatch = indexSource.indexOf(
    "  } catch (error) {\n    console.error('初始化失败:',",
    initializeTry
  )
  assert.ok(initializeStart >= 0)
  assert.ok(databaseCall > initializeTry)
  assert.ok(listenCall > databaseCall)
  assert.ok(initializeCatch > listenCall)
})

test('empty database adopts all 49 registered migrations without executing schema changes', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  try {
    const { output, result } = runChild(directory, PLACEHOLDER_PASSWORD, { diagnostics: true })
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })

    const verification = new Database(databasePath)
    try {
      assertApplicationMigrationLedger(verification, 49)
      assertRegisteredColumn(verification, 'documents', 'subcategory', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'categories', 'sort_order', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'todos', 'confirmed', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'books', 'content_cache', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'bookmarks', 'icon', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'bookmarks', 'icon_data', 'TEXT', 0, null)
      for (const { name, type, notNull, defaultValue } of expectedAnimeMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'anime', name, type, notNull ? 1 : 0, defaultValue)
      }
      for (const { name, type, notNull, defaultValue } of expectedGamesMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'games', name, type, notNull ? 1 : 0, defaultValue)
      }
      for (const { name, type, notNull, defaultValue } of expectedMusicMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'music', name, type, notNull ? 1 : 0, defaultValue)
      }
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('restarting the current database does not add registered migration attempts', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  try {
    const first = runChild(directory)
    assert.equal(first.result.status, 0, first.output)
    const database = new Database(databasePath)
    let firstCounts
    try {
      firstCounts = {
        ledger: database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count,
        attempts: database.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count
      }
    } finally {
      database.close()
    }

    const second = runChild(directory)
    assert.equal(second.result.status, 0, second.output)
    const verification = new Database(databasePath)
    try {
      assert.deepEqual({
        ledger: verification.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count,
        attempts: verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count
      }, firstCounts)
      assertApplicationMigrationLedger(verification, 49)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('migrates each exact code_repositories legacy shape with values, defaults, IDs, timestamps, and sequence preserved', nativeTestOptions, () => {
  const cases = [
    {
      variant: 'legacy-6-columns',
      insert: `INSERT INTO code_repositories
        (id, name, url, description, created_at, updated_at)
        VALUES (7, 'six-a', 'https://example.invalid/six-a', NULL, '2024-01-01 01:02:03', '2024-01-02 04:05:06'),
               (11, 'six-b', 'https://example.invalid/six-b', '', NULL, '')`,
      expected: [
        { id: 7, name: 'six-a', url: 'https://example.invalid/six-a', description: null, local_path: '', type: 'git', last_sync: null, created_at: '2024-01-01 01:02:03', updated_at: '2024-01-02 04:05:06', languages: '{}' },
        { id: 11, name: 'six-b', url: 'https://example.invalid/six-b', description: '', local_path: '', type: 'git', last_sync: null, created_at: null, updated_at: '', languages: '{}' }
      ]
    },
    {
      variant: 'legacy-9-columns',
      insert: `INSERT INTO code_repositories
        (id, name, url, description, local_path, type, last_sync, created_at, updated_at)
        VALUES (7, 'nine-a', 'https://example.invalid/nine-a', NULL, '', NULL, '', '2024-02-01 01:02:03', '2024-02-02 04:05:06'),
               (11, 'nine-b', 'https://example.invalid/nine-b', '', '/synthetic/repo', 'svn-history', NULL, NULL, '')`,
      expected: [
        { id: 7, name: 'nine-a', url: 'https://example.invalid/nine-a', description: null, local_path: '', type: null, last_sync: '', created_at: '2024-02-01 01:02:03', updated_at: '2024-02-02 04:05:06', languages: '{}' },
        { id: 11, name: 'nine-b', url: 'https://example.invalid/nine-b', description: '', local_path: '/synthetic/repo', type: 'svn-history', last_sync: null, created_at: null, updated_at: '', languages: '{}' }
      ]
    },
    {
      variant: 'legacy-10-double-quoted-languages',
      insert: `INSERT INTO code_repositories
        (id, name, url, description, local_path, type, last_sync, created_at, updated_at, languages)
        VALUES (7, 'ten-a', 'https://example.invalid/ten-a', NULL, '', NULL, '', '2024-03-01 01:02:03', '2024-03-02 04:05:06', NULL),
               (11, 'ten-b', 'https://example.invalid/ten-b', '', '/synthetic/repo', '', NULL, NULL, '', 'not-json')`,
      expected: [
        { id: 7, name: 'ten-a', url: 'https://example.invalid/ten-a', description: null, local_path: '', type: null, last_sync: '', created_at: '2024-03-01 01:02:03', updated_at: '2024-03-02 04:05:06', languages: null },
        { id: 11, name: 'ten-b', url: 'https://example.invalid/ten-b', description: '', local_path: '/synthetic/repo', type: '', last_sync: null, created_at: null, updated_at: '', languages: 'not-json' }
      ]
    }
  ]

  for (const entry of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      createLegacyCodeRepositories(database, entry.variant)
      database.exec(entry.insert)
      database.prepare("UPDATE sqlite_sequence SET seq = 19 WHERE name = 'code_repositories'").run()
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.equal(result.status, 0, `${entry.variant}: ${output}`)
      const verification = new Database(databasePath)
      try {
        assert.deepEqual(
          verification.prepare('SELECT * FROM code_repositories ORDER BY id').all(),
          entry.expected,
          entry.variant
        )
        assert.equal(verification.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories'").get().seq, 19)
        const inserted = verification.prepare(
          "INSERT INTO code_repositories (name, url) VALUES ('after', 'https://example.invalid/after')"
        ).run()
        assert.equal(inserted.lastInsertRowid, 20)
        assert.deepEqual(verification.pragma('foreign_key_check'), [])
        assertNoCodeRepositoryMigrationHelpers(verification)
        assertApplicationMigrationLedger(verification, 49)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('preserves deleted code_repositories ID history when each exact legacy table is empty', nativeTestOptions, () => {
  for (const variant of [
    'legacy-6-columns',
    'legacy-9-columns',
    'legacy-10-double-quoted-languages'
  ]) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      createLegacyCodeRepositories(database, variant)
      const columns = variant === 'legacy-6-columns'
        ? '(id, name, url)'
        : '(id, name, url, local_path)'
      const values = variant === 'legacy-6-columns'
        ? "(19, 'deleted', 'https://example.invalid/deleted')"
        : "(19, 'deleted', 'https://example.invalid/deleted', '')"
      database.exec(`INSERT INTO code_repositories ${columns} VALUES ${values}; DELETE FROM code_repositories;`)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM code_repositories').get().count, 0)
      assert.equal(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories'").get().seq, 19)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.equal(result.status, 0, `${variant}: ${output}`)
      const verification = new Database(databasePath)
      try {
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM code_repositories').get().count, 0)
        assert.equal(verification.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'code_repositories'").get().seq, 19)
        const inserted = verification.prepare(
          "INSERT INTO code_repositories (name, url) VALUES ('after-delete', 'https://example.invalid/after-delete')"
        ).run()
        assert.equal(inserted.lastInsertRowid, 20)
        assertNoCodeRepositoryMigrationHelpers(verification)
        assertApplicationMigrationLedger(verification, 49)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('code_repositories unknown target schema objects and dependencies fail closed before later initialization', nativeTestOptions, () => {
  const cases = [
    { name: 'unknown column', setup: (database) => database.exec('ALTER TABLE code_repositories ADD COLUMN unexpected TEXT') },
    { name: 'unknown constraint', setup: (database) => {
      database.exec('DROP TABLE code_repositories')
      database.exec(legacyCodeRepositories9Ddl.replace('updated_at DATETIME DEFAULT CURRENT_TIMESTAMP', 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(name)'))
    } },
    { name: 'unknown index', setup: (database) => database.exec('CREATE INDEX code_repositories_name_idx ON code_repositories(name)') },
    { name: 'table trigger', setup: (database) => database.exec('CREATE TRIGGER code_repositories_hook AFTER INSERT ON code_repositories BEGIN SELECT 1; END') },
    { name: 'inbound foreign key', setup: (database) => database.exec('CREATE TABLE repo_links (repository_id INTEGER REFERENCES code_repositories(id))') },
    { name: 'referencing view', setup: (database) => database.exec('CREATE VIEW repo_view AS SELECT id FROM code_repositories') },
    { name: 'external trigger reference', setup: (database) => database.exec('CREATE TABLE audit_probe (id INTEGER); CREATE TRIGGER audit_probe_hook AFTER INSERT ON audit_probe BEGIN SELECT id FROM code_repositories; END') }
  ]

  for (const entry of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    let before
    try {
      createLegacyCodeRepositories(database, 'legacy-9-columns')
      database.prepare("INSERT INTO code_repositories (id, name, url, local_path) VALUES (5, 'keep', 'https://example.invalid/keep', '')").run()
      database.prepare("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'code_repositories'").run()
      entry.setup(database)
      before = codeRepositorySnapshot(database)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, `${entry.name}: ${output}`)
      const verification = new Database(databasePath)
      try {
        assert.deepEqual(codeRepositorySnapshot(verification), before, entry.name)
        assertCodeRepositoryMigrationNotApplied(verification)
        assertNoCodeRepositoryMigrationHelpers(verification)
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('strict code_repositories target proof rejects unknown indexes, triggers, inbound FKs, and schema references', nativeTestOptions, () => {
  const targetDdl = `CREATE TABLE code_repositories (
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
  const cases = [
    { name: 'target index', setup: (database) => database.exec('CREATE INDEX code_repositories_name_idx ON code_repositories(name)') },
    { name: 'target trigger', setup: (database) => database.exec('CREATE TRIGGER code_repositories_hook AFTER INSERT ON code_repositories BEGIN SELECT 1; END') },
    { name: 'target inbound FK', setup: (database) => database.exec('CREATE TABLE repo_links (repository_id INTEGER REFERENCES code_repositories(id))') },
    { name: 'target view reference', setup: (database) => database.exec('CREATE VIEW repo_view AS SELECT id FROM code_repositories') },
    { name: 'target external trigger reference', setup: (database) => database.exec('CREATE TABLE audit_probe (id INTEGER); CREATE TRIGGER audit_probe_hook AFTER INSERT ON audit_probe BEGIN SELECT id FROM code_repositories; END') }
  ]

  for (const entry of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    let before
    try {
      database.exec(targetDdl)
      database.prepare("INSERT INTO code_repositories (id, name, url) VALUES (5, 'keep', 'https://example.invalid/keep')").run()
      database.prepare("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'code_repositories'").run()
      entry.setup(database)
      before = codeRepositorySnapshot(database)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, `${entry.name}: ${output}`)
      const verification = new Database(databasePath)
      try {
        assert.deepEqual(codeRepositorySnapshot(verification), before, entry.name)
        assertCodeRepositoryMigrationNotApplied(verification)
        assertNoCodeRepositoryMigrationHelpers(verification)
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('code_repositories invalid sequence and target-constraint data roll back table, rows, sequence, and ledger', nativeTestOptions, () => {
  const cases = [
    { name: 'missing sequence', setup: (database) => database.prepare("DELETE FROM sqlite_sequence WHERE name = 'code_repositories'").run() },
    { name: 'duplicate sequence', setup: (database) => database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('code_repositories', 9)").run() },
    { name: 'text sequence', setup: (database) => database.prepare("UPDATE sqlite_sequence SET seq = 'invalid' WHERE name = 'code_repositories'").run() },
    { name: 'sequence below max id', setup: (database) => database.prepare("UPDATE sqlite_sequence SET seq = 4 WHERE name = 'code_repositories'").run() }
  ]

  for (const entry of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    let before
    try {
      createLegacyCodeRepositories(database, 'legacy-9-columns')
      database.prepare("INSERT INTO code_repositories (id, name, url, local_path) VALUES (5, 'keep', 'https://example.invalid/keep', '')").run()
      database.prepare("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'code_repositories'").run()
      entry.setup(database)
      before = codeRepositorySnapshot(database)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, `${entry.name}: ${output}`)
      const verification = new Database(databasePath)
      try {
        assert.deepEqual(codeRepositorySnapshot(verification), before, entry.name)
        assertCodeRepositoryMigrationNotApplied(verification)
        assertNoCodeRepositoryMigrationHelpers(verification)
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('code_repositories rows that violate the proven legacy NOT NULL contract fail before DROP and fully roll back', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  let database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE code_repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO code_repositories (id, name, url) VALUES (5, NULL, 'https://example.invalid/corrupt');
    `)
    database.unsafeMode(true)
    database.pragma('writable_schema = ON')
    database.prepare(
      "UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'code_repositories'"
    ).run(legacyCodeRepositories6Ddl)
    database.pragma('writable_schema = OFF')
    database.unsafeMode(false)
  } finally {
    database.close()
  }

  database = new Database(databasePath)
  let before
  try {
    assert.equal(readColumn(database, 'code_repositories', 'name').not_null, 1)
    before = codeRepositorySnapshot(database)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0, output)
    const verification = new Database(databasePath)
    try {
      assert.deepEqual(codeRepositorySnapshot(verification), before)
      assertCodeRepositoryMigrationNotApplied(verification)
      assertNoCodeRepositoryMigrationHelpers(verification)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('migrates the exact legacy reading_progress shape with user 41, row values, and sequence preserved', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    createLegacyReadingProgressSchema(database)
    database.exec(`
      INSERT INTO users (id, username, password) VALUES (41, 'legacy-owner', 'legacy-hash');
      INSERT INTO books (id) VALUES (7), (11);
      INSERT INTO reading_progress
        (id, book_id, current_page, current_chapter, progress, font_size, created_at, updated_at)
      VALUES
        (3, 7, 123, NULL, 0.375, 18, '2024-01-02 03:04:05', '2024-01-03 04:05:06'),
        (8, 11, 456, NULL, 0.875, 22, NULL, '2024-02-03 04:05:06');
    `)
    database.prepare("UPDATE sqlite_sequence SET seq = 17 WHERE name = 'reading_progress'").run()
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    const verification = new Database(databasePath)
    try {
      assert.equal(verification.prepare(`
        SELECT COUNT(*) AS count FROM prm_schema_migrations
        WHERE migration_id = '0038_reading_progress_shape'
      `).get().count, 1)
      assert.deepEqual(
        verification.prepare('SELECT * FROM reading_progress ORDER BY id').all(),
        [
          { id: 3, book_id: 7, user_id: 41, current_page: 123, cfi: null, progress: 0.375, font_size: 18, created_at: '2024-01-02 03:04:05', updated_at: '2024-01-03 04:05:06' },
          { id: 8, book_id: 11, user_id: 41, current_page: 456, cfi: null, progress: 0.875, font_size: 22, created_at: null, updated_at: '2024-02-03 04:05:06' }
        ]
      )
      assert.equal(verification.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'reading_progress'"
      ).get().seq, 17)
      assert.deepEqual(verification.pragma('foreign_key_check'), [])
      assertNoReadingProgressMigrationHelpers(verification)
      assertApplicationMigrationLedger(verification, 49)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('reading_progress unknown character_offset schema fails closed before DROP and fully rolls back', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let before
  try {
    createLegacyReadingProgressSchema(database)
    database.exec(`
      ALTER TABLE reading_progress ADD COLUMN character_offset INTEGER;
      INSERT INTO users (id, username, password) VALUES (41, 'legacy-owner', 'legacy-hash');
      INSERT INTO books (id) VALUES (7);
      INSERT INTO reading_progress
        (id, book_id, current_page, current_chapter, character_offset, progress, font_size, created_at, updated_at)
      VALUES
        (3, 7, 123, NULL, 456, 0.375, 18, '2024-01-02 03:04:05', '2024-01-03 04:05:06');
    `)
    database.prepare("UPDATE sqlite_sequence SET seq = 17 WHERE name = 'reading_progress'").run()
    before = readingProgressSnapshot(database)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0, output)
    assert.equal(readChildResult(output).ready, false)
    const verification = new Database(databasePath)
    try {
      assert.deepEqual(readingProgressSnapshot(verification), before)
      assertNoReadingProgressSuccessLedger(verification)
      assertNoReadingProgressMigrationHelpers(verification)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('reading_progress legacy guard rejects invalid owner, row, and sequence cases with full rollback', nativeTestOptions, () => {
  const cases = [
    {
      name: 'current_chapter is not NULL',
      setup: (database) => database.prepare(
        "UPDATE reading_progress SET current_chapter = 'Chapter 1' WHERE id = 3"
      ).run()
    },
    {
      name: 'users table has zero rows',
      setup: (database) => database.prepare('DELETE FROM users').run()
    },
    {
      name: 'users table has two rows',
      setup: (database) => database.prepare(
        "INSERT INTO users (id, username, password) VALUES (42, 'second-owner', 'second-hash')"
      ).run()
    },
    {
      name: 'reading_progress sequence is missing',
      setup: (database) => database.prepare(
        "DELETE FROM sqlite_sequence WHERE name = 'reading_progress'"
      ).run()
    },
    {
      name: 'reading_progress sequence is text',
      setup: (database) => database.prepare(
        "UPDATE sqlite_sequence SET seq = 'legacy-text' WHERE name = 'reading_progress'"
      ).run()
    },
    {
      name: 'reading_progress sequence is below the maximum ID',
      setup: (database) => database.prepare(
        "UPDATE sqlite_sequence SET seq = 1 WHERE name = 'reading_progress'"
      ).run()
    }
  ]

  for (const entry of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    let before
    try {
      createLegacyReadingProgressSchema(database)
      database.exec(`
        INSERT INTO users (id, username, password) VALUES (41, 'legacy-owner', 'legacy-hash');
        INSERT INTO books (id) VALUES (7), (11);
        INSERT INTO reading_progress
          (id, book_id, current_page, current_chapter, progress, font_size, created_at, updated_at)
        VALUES
          (3, 7, 123, NULL, 0.375, 18, '2024-01-02 03:04:05', '2024-01-03 04:05:06'),
          (8, 11, 456, NULL, 0.875, 22, NULL, '2024-02-03 04:05:06');
      `)
      database.prepare("UPDATE sqlite_sequence SET seq = 17 WHERE name = 'reading_progress'").run()
      entry.setup(database)
      before = readingProgressSnapshot(database)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, `${entry.name}: ${output}`)
      assert.equal(readChildResult(output).ready, false, entry.name)
      const verification = new Database(databasePath)
      try {
        assert.deepEqual(readingProgressSnapshot(verification), before, entry.name)
        assertNoReadingProgressSuccessLedger(verification)
        assertNoReadingProgressMigrationHelpers(verification)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('reading_progress unknown explicit index fails before DROP and fully rolls back', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const unexpectedIndexName = 'reading_progress_unexpected_idx'
  const database = new Database(databasePath)
  let before
  try {
    createLegacyReadingProgressSchema(database)
    database.exec(`
      INSERT INTO users (id, username, password) VALUES (41, 'legacy-owner', 'legacy-hash');
      INSERT INTO books (id) VALUES (7), (11);
      INSERT INTO reading_progress
        (id, book_id, current_page, current_chapter, progress, font_size, created_at, updated_at)
      VALUES
        (3, 7, 123, NULL, 0.375, 18, '2024-01-02 03:04:05', '2024-01-03 04:05:06'),
        (8, 11, 456, NULL, 0.875, 22, NULL, '2024-02-03 04:05:06');
      CREATE INDEX ${unexpectedIndexName} ON reading_progress(current_page);
    `)
    database.prepare("UPDATE sqlite_sequence SET seq = 17 WHERE name = 'reading_progress'").run()
    before = readingProgressSnapshot(database)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0, output)
    assert.equal(readChildResult(output).ready, false)
    const verification = new Database(databasePath)
    try {
      assert.deepEqual(readingProgressSnapshot(verification), before)
      assert.equal(verification.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'index' AND name = ? AND tbl_name = 'reading_progress'
      `).get(unexpectedIndexName).count, 1)
      assertNoReadingProgressSuccessLedger(verification)
      assertNoReadingProgressMigrationHelpers(verification)
      assert.deepEqual(verification.pragma('foreign_key_check'), [])
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('preserves a version-only legacy table and installs three connection-local guards', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let beforeSchema
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version TEXT NOT NULL, note TEXT);
      INSERT INTO schema_migrations (version, note) VALUES ('v1', 'preserve me');
    `)
    beforeSchema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get().sql
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: true,
      controlTablesPresent: true,
      legacyGuardCount: 3
    })

    const verification = new Database(databasePath)
    try {
      assert.equal(verification.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      ).get().sql, beforeSchema)
      assert.deepEqual(verification.prepare('SELECT * FROM schema_migrations').all(), [
        { version: 'v1', note: 'preserve me' }
      ])
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('preserves unowned historical code_versions table and rows', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let beforeSchema
  let beforeColumns
  let beforeRows
  try {
    database.exec(`
      CREATE TABLE code_versions (
        id INTEGER PRIMARY KEY,
        code_repository_id INTEGER NOT NULL,
        version_label TEXT NOT NULL,
        legacy_extra TEXT,
        historical_payload TEXT
      );
      INSERT INTO code_versions (
        id, code_repository_id, version_label, legacy_extra, historical_payload
      ) VALUES (7, 42, 'v0.9', 'unknown-history-field', '合成历史文本 / apostrophe: O''Reilly');
    `)
    beforeSchema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'code_versions'"
    ).get().sql
    beforeColumns = database.prepare('PRAGMA table_info(code_versions)').all()
    beforeRows = database.prepare('SELECT * FROM code_versions ORDER BY id').all()
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })

    const verification = new Database(databasePath)
    try {
      assertApplicationMigrationLedger(verification, 49)
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM prm_schema_migrations WHERE migration_id LIKE '%code_versions%'"
      ).get().count, 0)
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'code_versions'"
      ).get().count, 1)
      assert.equal(verification.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'code_versions'"
      ).get().sql, beforeSchema)
      assert.deepEqual(verification.prepare('PRAGMA table_info(code_versions)').all(), beforeColumns)
      assert.deepEqual(verification.prepare('SELECT * FROM code_versions ORDER BY id').all(), beforeRows)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('preserves a legacy migration_key/version/description table and its row', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  let beforeSchema
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        migration_key TEXT,
        version TEXT,
        description TEXT
      );
      INSERT INTO schema_migrations (migration_key, version, description)
      VALUES ('legacy-v1', '1.0.0', 'preserve this row');
    `)
    beforeSchema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get().sql
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: true,
      controlTablesPresent: true,
      legacyGuardCount: 3
    })

    const verification = new Database(databasePath)
    try {
      assert.equal(verification.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      ).get().sql, beforeSchema)
      assert.deepEqual(verification.prepare('SELECT * FROM schema_migrations').all(), [
        {
          migration_key: 'legacy-v1',
          version: '1.0.0',
          description: 'preserve this row'
        }
      ])
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('does not report READY when initialization fails', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  try {
    const { output, result } = runChild(directory, 'too-short')
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, /READY/u)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'BOOTSTRAP_PASSWORD_WEAK'
    })
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('does not report READY when the startup gate rejects an incompatible control table', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE prm_schema_migrations (
        migration_id TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, /READY/u)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'MIGRATION_STARTUP_GATE_FAILED'
    })
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('incompatible books.content_cache prevents indexes, inline upgrades, and Owner initialization', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_cache INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_read_at DATETIME
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.notEqual(result.status, 0)
    assert.deepEqual(readChildResult(output), {
      ready: false,
      code: 'MIGRATION_STARTUP_GATE_FAILED'
    })

    const verification = new Database(databasePath)
    try {
      const bookColumns = verification.pragma('table_info(books)')
      assert.equal(bookColumns.find(column => column.name === 'content_cache').type, 'INTEGER')
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_title'"
      ).get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count, 0)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})

test('incompatible bookmarks columns fail closed at the matching migration with only the successful prefix recorded', nativeTestOptions, () => {
  const cases = [
    { column: 'icon', type: 'INTEGER', expectedPrefixLength: 4 },
    { column: 'icon_data', type: 'INTEGER', expectedPrefixLength: 5 }
  ]

  for (const { column, type, expectedPrefixLength } of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          category TEXT,
          tags TEXT,
          file_path TEXT NOT NULL,
          version REAL DEFAULT 1.0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          parent_id INTEGER,
          path TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          date TEXT NOT NULL,
          completed INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          file_path TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_read_at DATETIME
        );
        CREATE TABLE bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          category TEXT,
          tags TEXT,
          description TEXT,
          ${column} ${type},
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0)
      assert.deepEqual(readChildResult(output), {
        ready: false,
        code: 'MIGRATION_STARTUP_GATE_FAILED'
      })

      const verification = new Database(databasePath)
      try {
        assert.deepEqual(
          verification.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
          applicationMigrationRegistry.migrations
            .slice(0, expectedPrefixLength)
            .map(({ id }) => ({ migration_id: id }))
        )
        assert.equal(
          verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count,
          expectedPrefixLength
        )
        assert.equal(verification.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_title'"
        ).get().count, 0)
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
        assertRegisteredColumn(verification, 'code_repositories', 'languages', 'TEXT', 0, "'{}'")
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('incompatible anime columns stop at early, middle, and final migration prefixes', nativeTestOptions, () => {
  const cases = [
    { column: 'name_cn', type: 'INTEGER', conflictIndex: 0, expectedPrefixLength: 0 },
    { column: 'eps', type: 'TEXT', conflictIndex: 4, expectedPrefixLength: 10 },
    { column: 'cover_image_data', type: 'INTEGER', conflictIndex: 14, expectedPrefixLength: 20 }
  ]

  for (const { column, type, conflictIndex, expectedPrefixLength } of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE anime (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bangumi_id INTEGER UNIQUE,
          title TEXT NOT NULL,
          summary TEXT,
          cover_image TEXT,
          rating REAL,
          tags TEXT,
          status TEXT DEFAULT 'none',
          is_favorite INTEGER DEFAULT 0,
          ${column} ${type},
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, output)
      assert.deepEqual(readChildResult(output), {
        ready: false,
        code: 'MIGRATION_STARTUP_GATE_FAILED'
      })

      const verification = new Database(databasePath)
      try {
        assert.deepEqual(
          verification.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
          applicationMigrationRegistry.migrations
            .slice(0, expectedPrefixLength)
            .map(({ id }) => ({ migration_id: id }))
        )
        assert.equal(
          verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count,
          expectedPrefixLength
        )

        for (const { name, type: expectedType, notNull, defaultValue } of expectedAnimeMigrations.slice(0, conflictIndex).map(({ compatibility }) => compatibility.column)) {
          assertRegisteredColumn(verification, 'anime', name, expectedType, notNull ? 1 : 0, defaultValue)
        }
        assert.equal(readColumn(verification, 'anime', column).type, type)
        for (const { name } of expectedAnimeMigrations.slice(conflictIndex + 1).map(({ compatibility }) => compatibility.column)) {
          assert.equal(
            verification.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('anime') WHERE name = ?").get(name).count,
            0
          )
        }
        assert.equal(verification.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_title'"
        ).get().count, 0)
        assertRegisteredColumn(verification, 'code_repositories', 'languages', 'TEXT', 0, "'{}'")
        assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('incompatible games columns preserve the frozen adoption and execution prefixes', nativeTestOptions, () => {
  const cases = [
    { column: 'achievements_total', type: 'TEXT', conflictIndex: 0, expectedPrefixLength: 0 },
    { column: 'achievements_completed', type: 'TEXT', conflictIndex: 1, expectedPrefixLength: 22 },
    { column: 'header_cover_image', type: 'INTEGER', conflictIndex: 2, expectedPrefixLength: 23 },
    { column: 'header_cover_image_data', type: 'INTEGER', conflictIndex: 3, expectedPrefixLength: 24 }
  ]

  for (const { column, type, conflictIndex, expectedPrefixLength } of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          steam_appid INTEGER UNIQUE,
          title TEXT NOT NULL,
          ${column} ${type}
        );
      `)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, output)
      assert.deepEqual(readChildResult(output), {
        ready: false,
        code: 'MIGRATION_STARTUP_GATE_FAILED'
      })

      const verification = new Database(databasePath)
      try {
        assert.deepEqual(
          verification.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
          applicationMigrationRegistry.migrations
            .slice(0, expectedPrefixLength)
            .map(({ id }) => ({ migration_id: id }))
        )
        assert.equal(
          verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count,
          expectedPrefixLength
        )
        for (const { name, type: expectedType, notNull, defaultValue } of expectedGamesMigrations
          .slice(0, conflictIndex)
          .map(({ compatibility }) => compatibility.column)) {
          assertRegisteredColumn(verification, 'games', name, expectedType, notNull ? 1 : 0, defaultValue)
        }
        assert.equal(readColumn(verification, 'games', column).type, type)
        for (const { name } of expectedGamesMigrations
          .slice(conflictIndex + 1)
          .map(({ compatibility }) => compatibility.column)) {
          assert.equal(
            verification.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('games') WHERE name = ?").get(name).count,
            0
          )
        }
        assertRegisteredColumn(verification, 'code_repositories', 'languages', 'TEXT', 0, "'{}'")
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('incompatible music columns execute the prefix and stop at the explicit conflict index', nativeTestOptions, () => {
  const cases = [
    { column: 'artist', type: 'INTEGER', conflictIndex: 0, expectedLedgerCount: 0 },
    { column: 'album', type: 'INTEGER', conflictIndex: 1, expectedLedgerCount: 26 },
    { column: 'cover_image', type: 'INTEGER', conflictIndex: 5, expectedLedgerCount: 30 },
    { column: 'lyrics', type: 'INTEGER', conflictIndex: 6, expectedLedgerCount: 31 },
    { column: 'has_lyrics', type: 'TEXT', conflictIndex: 8, expectedLedgerCount: 33 },
    { column: 'lyrics_updated_at', type: 'INTEGER', conflictIndex: 9, expectedLedgerCount: 34 }
  ]

  for (const { column, type, conflictIndex, expectedLedgerCount } of cases) {
    const directory = temporaryDirectory()
    const databasePath = path.join(directory, 'app.db')
    const database = new Database(databasePath)
    try {
      database.exec(`
        CREATE TABLE music (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          ${column} ${type},
          file_path TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `)
    } finally {
      database.close()
    }

    try {
      const { output, result } = runChild(directory)
      assert.notEqual(result.status, 0, output)
      assert.deepEqual(readChildResult(output), {
        ready: false,
        code: 'MIGRATION_STARTUP_GATE_FAILED'
      })

      const verification = new Database(databasePath)
      try {
        assert.deepEqual(
          verification.prepare('SELECT migration_id FROM prm_schema_migrations ORDER BY migration_id').all(),
          applicationMigrationRegistry.migrations
            .slice(0, expectedLedgerCount)
            .map(({ id }) => ({ migration_id: id }))
        )
        assert.equal(
          verification.prepare('SELECT COUNT(*) AS count FROM prm_migration_attempts').get().count,
          expectedLedgerCount
        )
        for (const { name, type: expectedType, notNull, defaultValue } of expectedMusicMigrations
          .slice(0, conflictIndex)
          .map(({ compatibility }) => compatibility.column)) {
          assertRegisteredColumn(verification, 'music', name, expectedType, notNull ? 1 : 0, defaultValue)
        }
        assert.equal(readColumn(verification, 'music', column).type, type)
        for (const { name } of expectedMusicMigrations
          .slice(conflictIndex + 1)
          .map(({ compatibility }) => compatibility.column)) {
          assert.equal(
            verification.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('music') WHERE name = ?").get(name).count,
            0
          )
        }
        assertRegisteredColumn(verification, 'code_repositories', 'languages', 'TEXT', 0, "'{}'")
      } finally {
        verification.close()
      }
    } finally {
      removeTemporaryDirectory(directory)
    }
  }
})

test('old anime, games, and music schemas execute all 49 registered migrations before remaining inline upgrades', nativeTestOptions, () => {
  const directory = temporaryDirectory()
  const databasePath = path.join(directory, 'app.db')
  const database = new Database(databasePath)
  try {
    database.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        file_path TEXT NOT NULL,
        version REAL DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER,
        path TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        date TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_read_at DATETIME
      );
      CREATE TABLE bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT,
        tags TEXT,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE anime (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bangumi_id INTEGER UNIQUE,
        title TEXT NOT NULL,
        summary TEXT,
        cover_image TEXT,
        rating REAL,
        tags TEXT,
        status TEXT DEFAULT 'none',
        is_favorite INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_appid INTEGER UNIQUE,
        title TEXT NOT NULL
      );
      CREATE TABLE music (
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
      );
    `)
  } finally {
    database.close()
  }

  try {
    const { output, result } = runChild(directory)
    assert.equal(result.status, 0, output)
    assert.deepEqual(readChildResult(output), {
      ready: true,
      legacyTablePresent: false,
      controlTablesPresent: true,
      legacyGuardCount: 0
    })

    const verification = new Database(databasePath)
    try {
      assertApplicationMigrationLedger(verification, 49)
      assertRegisteredColumn(verification, 'documents', 'subcategory', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'categories', 'sort_order', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'todos', 'confirmed', 'INTEGER', 0, '0')
      assertRegisteredColumn(verification, 'books', 'content_cache', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'bookmarks', 'icon', 'TEXT', 0, null)
      assertRegisteredColumn(verification, 'bookmarks', 'icon_data', 'TEXT', 0, null)
      for (const { name, type, notNull, defaultValue } of expectedAnimeMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'anime', name, type, notNull ? 1 : 0, defaultValue)
      }
      for (const { name, type, notNull, defaultValue } of expectedGamesMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'games', name, type, notNull ? 1 : 0, defaultValue)
      }
      for (const { name, type, notNull, defaultValue } of expectedMusicMigrations.map(({ compatibility }) => compatibility.column)) {
        assertRegisteredColumn(verification, 'music', name, type, notNull ? 1 : 0, defaultValue)
      }
      assert.equal(verification.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_categories_sort_order'"
      ).get().count, 1)
      assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1)
    } finally {
      verification.close()
    }
  } finally {
    removeTemporaryDirectory(directory)
  }
})
