import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import { adoptMigrationPrefix } from '../src/config/migrationAdoption.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import {
  createTaskRetrySpec,
  KNOWN_TASK_TYPES,
  projectTask,
  TASK_TYPE_CATALOG
} from '../src/services/taskTypeCatalog.js'

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

const EXPECTED_METADATA_MIGRATIONS = Object.freeze([
  {
    id: '0055_books_metadata_status',
    table: 'books',
    name: 'metadata_status',
    notNull: true,
    defaultValue: "'ready'",
    source: "ALTER TABLE books ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'ready';"
  },
  {
    id: '0056_books_metadata_error_code',
    table: 'books',
    name: 'metadata_error_code',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE books ADD COLUMN metadata_error_code TEXT;'
  },
  {
    id: '0057_books_metadata_parser_version',
    table: 'books',
    name: 'metadata_parser_version',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE books ADD COLUMN metadata_parser_version TEXT;'
  },
  {
    id: '0058_books_metadata_updated_at',
    table: 'books',
    name: 'metadata_updated_at',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE books ADD COLUMN metadata_updated_at TEXT;'
  },
  {
    id: '0059_music_metadata_status',
    table: 'music',
    name: 'metadata_status',
    notNull: true,
    defaultValue: "'ready'",
    source: "ALTER TABLE music ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'ready';"
  },
  {
    id: '0060_music_metadata_error_code',
    table: 'music',
    name: 'metadata_error_code',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE music ADD COLUMN metadata_error_code TEXT;'
  },
  {
    id: '0061_music_metadata_parser_version',
    table: 'music',
    name: 'metadata_parser_version',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE music ADD COLUMN metadata_parser_version TEXT;'
  },
  {
    id: '0062_music_metadata_updated_at',
    table: 'music',
    name: 'metadata_updated_at',
    notNull: false,
    defaultValue: null,
    source: 'ALTER TABLE music ADD COLUMN metadata_updated_at TEXT;'
  }
])

const metadataMigrations = applicationMigrationRegistry.migrations.filter(({ id }) =>
  EXPECTED_METADATA_MIGRATIONS.some((expected) => expected.id === id)
)
const metadataRegistry = createMigrationRegistry(metadataMigrations)

function createBaseResourceDatabase() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE music (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO books (id, title) VALUES (11, '旧书');
    INSERT INTO music (id, title) VALUES (17, '旧歌');
  `)
  ensureMigrationControlTables(database)
  return database
}

function createAdoptionDatabase({ invalidBookStatus = false } = {}) {
  const database = new Database(':memory:')
  const bookStatusDefault = invalidBookStatus ? "DEFAULT 'pending'" : "DEFAULT 'ready'"
  database.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      metadata_status TEXT NOT NULL ${bookStatusDefault},
      metadata_error_code TEXT,
      metadata_parser_version TEXT,
      metadata_updated_at TEXT
    );
    CREATE TABLE music (
      id INTEGER PRIMARY KEY,
      metadata_status TEXT NOT NULL DEFAULT 'ready',
      metadata_error_code TEXT,
      metadata_parser_version TEXT,
      metadata_updated_at TEXT
    );
    INSERT INTO books
      (id, metadata_status, metadata_error_code, metadata_parser_version, metadata_updated_at)
      VALUES (11, 'partial', 'EPUB_PARSE_FAILED', 'epub-parser-v3', '2026-08-20T01:02:03.000Z');
    INSERT INTO music
      (id, metadata_status, metadata_error_code, metadata_parser_version, metadata_updated_at)
      VALUES (17, 'failed', 'AUDIO_TAG_READ_FAILED', 'music-parser-v2', '2026-08-20T02:03:04.000Z');
  `)
  ensureMigrationControlTables(database)
  return database
}

function metadataColumnInfo(database, table) {
  return database.pragma(`table_xinfo(${table})`)
    .filter(({ name }) => name.startsWith('metadata_'))
    .map(({ name, type, notnull, dflt_value, hidden }) => ({
      name,
      type,
      notnull,
      dflt_value,
      hidden
    }))
}

function runMetadataMigrations(database) {
  return executeMigrationBatch({
    database,
    registry: metadataRegistry,
    plan: createMigrationPlan(metadataRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-20T03:00:00.000Z'
  })
}

function metadataTaskFixture(taskType, overrides = {}) {
  const isMusic = taskType === 'music.metadata.reparse'
  const resourceId = isMusic ? 17 : 11
  const resourceField = isMusic ? 'musicId' : 'bookId'
  return {
    id: 1,
    taskType,
    processorVersion: 'v1',
    subjectType: isMusic ? 'music' : 'ebook',
    subjectId: String(resourceId),
    subjectVersionId: isMusic ? 'music-parser-v2' : 'epub-parser-v3',
    subjectContentHash: 'a'.repeat(64),
    status: 'succeeded',
    executionClass: 'cpu',
    progress: 100,
    attemptCount: 1,
    maxAttempts: 3,
    input: { [resourceField]: resourceId },
    result: {
      [resourceField]: resourceId,
      updatedFields: 2,
      metadataStatus: 'ready',
      metadata: { title: '不应公开' },
      path: '/private/resource'
    },
    errorCode: null,
    availableAt: '2026-08-20T03:00:00.000Z',
    startedAt: '2026-08-20T03:00:01.000Z',
    finishedAt: '2026-08-20T03:00:02.000Z',
    createdAt: '2026-08-20T03:00:00.000Z',
    updatedAt: '2026-08-20T03:00:02.000Z',
    ...overrides
  }
}

test('registers 0055-0062 as ordered expand-only single-column migrations', () => {
  assert.deepEqual(
    metadataMigrations.map(({ id }) => id),
    EXPECTED_METADATA_MIGRATIONS.map(({ id }) => id)
  )
  const allIds = applicationMigrationRegistry.migrations.map(({ id }) => id)
  assert.equal(allIds[allIds.indexOf('0054_persistent_tasks') + 1], '0055_books_metadata_status')
  assert.equal(allIds[allIds.indexOf('0055_books_metadata_status') + 7], '0062_music_metadata_updated_at')
  assert.equal(allIds[allIds.indexOf('0062_music_metadata_updated_at') + 1], '0063_resources')

  for (const expected of EXPECTED_METADATA_MIGRATIONS) {
    const migration = metadataMigrations.find(({ id }) => id === expected.id)
    assert.ok(migration)
    assert.equal(migration.source, expected.source)
    assert.deepEqual(Object.keys(migration.compatibility).sort(), ['column', 'kind', 'table'])
    assert.deepEqual(Object.keys(migration.compatibility.column).sort(), [
      'defaultValue',
      'name',
      'notNull',
      'type'
    ])
    assert.deepEqual(migration.compatibility, {
      kind: 'column',
      table: expected.table,
      column: {
        name: expected.name,
        type: 'TEXT',
        notNull: expected.notNull,
        defaultValue: expected.defaultValue
      }
    })
    assert.doesNotMatch(migration.source, /\b(CREATE|DROP|INSERT|UPDATE|DELETE)\b/iu)
  }
})

test('rejects duplicate registration of a metadata migration', () => {
  assert.throws(
    () => createMigrationRegistry([...metadataMigrations, metadataMigrations[0]]),
    (error) => error?.code === 'MIGRATION_ID_DUPLICATE'
  )
})

test('executes metadata columns in order, preserves rows, and skips exact repeats', nativeTestOptions, () => {
  const database = createBaseResourceDatabase()
  try {
    const summary = runMetadataMigrations(database)
    assert.deepEqual(summary.executed.map(({ id }) => id), EXPECTED_METADATA_MIGRATIONS.map(({ id }) => id))
    assert.equal(summary.skippedCount, 0)
    assert.deepEqual(database.prepare('SELECT * FROM books WHERE id = 11').get(), {
      id: 11,
      title: '旧书',
      metadata_status: 'ready',
      metadata_error_code: null,
      metadata_parser_version: null,
      metadata_updated_at: null
    })
    assert.deepEqual(database.prepare('SELECT * FROM music WHERE id = 17').get(), {
      id: 17,
      title: '旧歌',
      metadata_status: 'ready',
      metadata_error_code: null,
      metadata_parser_version: null,
      metadata_updated_at: null
    })
    assert.deepEqual(metadataColumnInfo(database, 'books'), [
      { name: 'metadata_status', type: 'TEXT', notnull: 1, dflt_value: "'ready'", hidden: 0 },
      { name: 'metadata_error_code', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 },
      { name: 'metadata_parser_version', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 },
      { name: 'metadata_updated_at', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 }
    ])
    assert.deepEqual(metadataColumnInfo(database, 'music'), [
      { name: 'metadata_status', type: 'TEXT', notnull: 1, dflt_value: "'ready'", hidden: 0 },
      { name: 'metadata_error_code', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 },
      { name: 'metadata_parser_version', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 },
      { name: 'metadata_updated_at', type: 'TEXT', notnull: 0, dflt_value: null, hidden: 0 }
    ])
    for (const migration of metadataMigrations) {
      assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
        status: 'satisfied',
        kind: 'column',
        table: migration.compatibility.table,
        column: migration.compatibility.column.name,
        reason: 'matched'
      })
    }

    const repeated = runMetadataMigrations(database)
    assert.deepEqual(repeated.executed, [])
    assert.deepEqual(repeated.skipped.map(({ id }) => id), EXPECTED_METADATA_MIGRATIONS.map(({ id }) => id))
  } finally {
    database.close()
  }
})

test('adopts only exact satisfied metadata column proofs without executing sources', nativeTestOptions, () => {
  const database = createAdoptionDatabase()
  try {
    const summary = adoptMigrationPrefix({
      database,
      registry: metadataRegistry,
      targetVersion: '0062_music_metadata_updated_at',
      lock: { state: 'active' },
      now: () => '2026-08-20T04:00:00.000Z'
    })
    assert.deepEqual(summary, {
      adopted: EXPECTED_METADATA_MIGRATIONS.map(({ id }) => ({ id, status: 'adopted' })),
      skipped: [],
      adoptedCount: 8,
      skippedCount: 0,
      totalAdoptable: 8
    })
    assert.deepEqual(database.prepare('SELECT * FROM books WHERE id = 11').get(), {
      id: 11,
      metadata_status: 'partial',
      metadata_error_code: 'EPUB_PARSE_FAILED',
      metadata_parser_version: 'epub-parser-v3',
      metadata_updated_at: '2026-08-20T01:02:03.000Z'
    })
    assert.deepEqual(database.prepare('SELECT * FROM music WHERE id = 17').get(), {
      id: 17,
      metadata_status: 'failed',
      metadata_error_code: 'AUDIO_TAG_READ_FAILED',
      metadata_parser_version: 'music-parser-v2',
      metadata_updated_at: '2026-08-20T02:03:04.000Z'
    })
    assert.deepEqual(
      database.prepare('SELECT migration_id, checksum FROM prm_schema_migrations ORDER BY migration_id').all(),
      metadataMigrations.map(({ id, checksum }) => ({ migration_id: id, checksum }))
    )

    const repeated = adoptMigrationPrefix({
      database,
      registry: metadataRegistry,
      targetVersion: '0062_music_metadata_updated_at',
      lock: { state: 'active' },
      now: () => '2026-08-20T04:01:00.000Z'
    })
    assert.deepEqual(repeated, {
      adopted: [],
      skipped: [],
      adoptedCount: 0,
      skippedCount: 0,
      totalAdoptable: 0
    })
  } finally {
    database.close()
  }
})

test('does not adopt a metadata column with a non-matching default', nativeTestOptions, () => {
  const database = createAdoptionDatabase({ invalidBookStatus: true })
  try {
    assert.throws(
      () => adoptMigrationPrefix({
        database,
        registry: metadataRegistry,
        lock: { state: 'active' },
        now: () => '2026-08-20T05:00:00.000Z'
      }),
      (error) => error?.code === 'MIGRATION_ADOPTION_SCHEMA_INCOMPATIBLE'
    )
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
  } finally {
    database.close()
  }
})

test('catalog exposes safe metadata reparse definitions and known-task projection is catalog-driven', () => {
  assert.deepEqual(Object.keys(TASK_TYPE_CATALOG).sort(), [...KNOWN_TASK_TYPES].sort())
  for (const [taskType, subjectType, subjectInputField, mutexTaskTypes] of [
    ['ebook.metadata.reparse', 'ebook', 'bookId', ['ebook.metadata.reparse']],
    ['music.metadata.reparse', 'music', 'musicId', ['music.metadata.reparse']]
  ]) {
    const definition = TASK_TYPE_CATALOG[taskType]
    assert.ok(definition)
    assert.equal(definition.processorVersion, 'v1')
    assert.equal(definition.executionClass, 'cpu')
    assert.equal(definition.subjectType, subjectType)
    assert.equal(definition.subjectInputField, subjectInputField)
    assert.deepEqual(definition.mutexTaskTypes, mutexTaskTypes)
    assert.deepEqual(definition.retryableFrom, ['failed'])
    assert.ok(KNOWN_TASK_TYPES.includes(taskType))
  }
  assert.deepEqual(TASK_TYPE_CATALOG['ebook.cover.generate'].mutexTaskTypes, ['ebook.cover.generate'])
})

for (const taskType of ['ebook.metadata.reparse', 'music.metadata.reparse']) {
  test(`${taskType} projects only safe input/result fields`, () => {
    const projected = projectTask(metadataTaskFixture(taskType))
    assert.ok(projected)
    const resourceField = taskType.startsWith('music.') ? 'musicId' : 'bookId'
    assert.deepEqual(projected.input, { [resourceField]: resourceField === 'musicId' ? 17 : 11 })
    assert.deepEqual(projected.result, {
      [resourceField]: resourceField === 'musicId' ? 17 : 11,
      updatedFields: 2,
      metadataStatus: 'ready'
    })
    const serialized = JSON.stringify(projected)
    assert.equal(serialized.includes('不应公开'), false)
    assert.equal(serialized.includes('/private/resource'), false)
    assert.equal(Object.hasOwn(projected.result, 'metadata'), false)
    assert.equal(Object.hasOwn(projected.result, 'path'), false)
  })
}

test('metadata projection fails closed for subject/input and subject/result mismatches', () => {
  assert.equal(
    projectTask(metadataTaskFixture('ebook.metadata.reparse', {
      input: { bookId: 12 },
      result: { bookId: 12, updatedFields: 1, metadataStatus: 'ready' }
    })),
    null
  )
  assert.equal(
    projectTask(metadataTaskFixture('music.metadata.reparse', {
      result: { musicId: 18, updatedFields: 1, metadataStatus: 'ready' }
    })),
    null
  )
  assert.equal(
    projectTask(metadataTaskFixture('ebook.metadata.reparse', {
      input: { bookId: 11, path: '/secret/path' }
    }))?.input,
    null
  )
})

test('metadata projection filters invalid status/count values and rejects malformed task status', () => {
  const projected = projectTask(metadataTaskFixture('ebook.metadata.reparse', {
    result: {
      bookId: 11,
      updatedFields: -1,
      metadataStatus: 'not-a-status',
      error: 'raw parser error',
      path: '/secret/path'
    }
  }))
  assert.ok(projected)
  assert.deepEqual(projected.result, { bookId: 11 })
  assert.equal(
    projectTask(metadataTaskFixture('music.metadata.reparse', {
      result: { musicId: 17, updatedFields: 1.5, metadataStatus: 'ready' },
      status: 'BROKEN'
    })),
    null
  )
  assert.equal(
    projectTask(metadataTaskFixture('ebook.metadata.reparse', {
      result: { path: '/secret/path', error: 'raw parser error' }
    }))?.result,
    null
  )
})

for (const taskType of ['ebook.metadata.reparse', 'music.metadata.reparse']) {
  test(`${taskType} retry clones only the resource id and failed tasks`, () => {
    const failed = metadataTaskFixture(taskType, {
      status: 'failed',
      subjectVersionId: 'old-parser-version',
      result: { metadata: 'secret body', path: '/secret/path' }
    })
    const spec = createTaskRetrySpec(failed)
    assert.ok(spec)
    const resourceField = taskType.startsWith('music.') ? 'musicId' : 'bookId'
    const resourceId = resourceField === 'musicId' ? 17 : 11
    assert.deepEqual(spec.input, { [resourceField]: resourceId })
    assert.equal(spec.identity.taskType, taskType)
    assert.equal(spec.identity.processorVersion, 'v1')
    assert.equal(spec.identity.subjectType, resourceField === 'musicId' ? 'music' : 'ebook')
    assert.equal(spec.identity.subjectId, String(resourceId))
    assert.equal(spec.executionClass, 'cpu')
    assert.deepEqual(spec.mutexTaskTypes, [taskType])
    assert.notEqual(spec.identity.subjectVersionId, 'old-parser-version')
    assert.equal(Object.hasOwn(spec.input, 'path'), false)
    assert.equal(Object.hasOwn(spec.identity, 'subjectContentHash'), false)
    assert.equal(createTaskRetrySpec({ ...failed, status: 'succeeded' }), null)
    assert.equal(createTaskRetrySpec({ ...failed, input: { [resourceField]: resourceId + 1 } }), null)
    assert.equal(createTaskRetrySpec({ ...failed, input: { [resourceField]: resourceId, path: '/secret' } }), null)
    assert.equal(createTaskRetrySpec({ ...failed, subjectVersionId: null }), null)
    assert.equal(createTaskRetrySpec({ ...failed, subjectContentHash: 'not-a-sha256' }), null)
  })
}
