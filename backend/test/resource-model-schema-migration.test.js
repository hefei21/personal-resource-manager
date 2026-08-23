import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { applicationMigrationRegistry } from '../src/config/databaseMigrations.js'
import {
  CONTENT_OBJECT_TABLE,
  NAS_SCAN_ENTRY_TABLE,
  NAS_SCAN_ROOT_TABLE,
  RESOURCE_CONFLICT_CANDIDATE_TABLE,
  RESOURCE_DOMAIN_LINK_TABLE,
  RESOURCE_MODEL_TABLES,
  RESOURCE_SOURCE_TABLE,
  RESOURCE_TABLE,
  RESOURCE_VERSION_TABLE,
  RESOURCE_MODEL_MIGRATIONS
} from '../src/config/resourceModelSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
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

const resourceMigrationIds = new Set(RESOURCE_MODEL_MIGRATIONS.map(({ id }) => id))
const resourceMigrations = applicationMigrationRegistry.migrations.filter(({ id }) => resourceMigrationIds.has(id))
const resourceRegistry = createMigrationRegistry(resourceMigrations)

function openDatabase() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  return database
}

function runAllMigrations(database, registry = resourceRegistry) {
  return executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-21T00:00:00.000Z'
  })
}

function assertSchemaTables(database) {
  const actual = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${RESOURCE_MODEL_TABLES.map(() => '?').join(', ')})
    ORDER BY name
  `).all(...RESOURCE_MODEL_TABLES).map(({ name }) => name)
  assert.deepEqual(actual, [...RESOURCE_MODEL_TABLES].sort())
}

function insertResource(database, title = '同名资源') {
  const result = database.prepare(`
    INSERT INTO ${RESOURCE_TABLE} (resource_type, title) VALUES (?, ?)
  `).run('document', title)
  return Number(result.lastInsertRowid)
}

test('creates all eight resource-model tables and passes repeated compatibility checks', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    assert.deepEqual(checkMigrationCompatibility(database, resourceMigrations[0].compatibility), {
      status: 'missing',
      kind: 'table-transition',
      table: RESOURCE_TABLE,
      reason: 'table-missing'
    })

    const first = runAllMigrations(database)
    assert.equal(first.executedCount, 8)
    assert.equal(first.skippedCount, 0)
    assertSchemaTables(database)
    assert.deepEqual(database.pragma('foreign_key_check'), [])

    for (const migration of resourceMigrations) {
      assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
        status: 'satisfied',
        kind: 'table-transition',
        table: migration.compatibility.table,
        reason: 'matched'
      })
    }

    const second = runAllMigrations(database)
    assert.equal(second.executedCount, 0)
    assert.equal(second.skippedCount, 8)
  } finally {
    database.close()
  }
})

test('keeps pre-existing legacy domain tables and rows untouched', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE music (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE code_repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE legacy_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO documents (id, title) VALUES (11, '旧文档');
      INSERT INTO books (id, title) VALUES (12, '旧书');
      INSERT INTO music (id, title) VALUES (13, '旧音乐');
      INSERT INTO code_repositories (id, name) VALUES (14, '旧代码');
      INSERT INTO legacy_sentinel (id, marker) VALUES (15, 'preserve-me');
    `)

    runAllMigrations(database)

    assert.deepEqual(database.prepare('SELECT id, title FROM documents').all(), [{ id: 11, title: '旧文档' }])
    assert.deepEqual(database.prepare('SELECT id, title FROM books').all(), [{ id: 12, title: '旧书' }])
    assert.deepEqual(database.prepare('SELECT id, title FROM music').all(), [{ id: 13, title: '旧音乐' }])
    assert.deepEqual(database.prepare('SELECT id, name FROM code_repositories').all(), [{ id: 14, name: '旧代码' }])
    assert.deepEqual(database.prepare('SELECT id, marker FROM legacy_sentinel').all(), [{ id: 15, marker: 'preserve-me' }])
  } finally {
    database.close()
  }
})

test('enforces foreign keys, content reuse, current-version uniqueness, and source constraints', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    runAllMigrations(database)

    const rootId = Number(database.prepare(`
      INSERT INTO ${NAS_SCAN_ROOT_TABLE} (name, root_path, rules_json)
      VALUES (?, ?, ?)
    `).run('资料根', '/srv/nas/library', '{}').lastInsertRowid)
    const firstResourceId = insertResource(database)
    const secondResourceId = insertResource(database)

    const contentId = Number(database.prepare(`
      INSERT INTO ${CONTENT_OBJECT_TABLE} (sha256, bytes) VALUES (?, ?)
    `).run('a'.repeat(64), 7).lastInsertRowid)
    assert.throws(() => database.prepare(`
      INSERT INTO ${CONTENT_OBJECT_TABLE} (sha256, bytes) VALUES (?, ?)
    `).run('a'.repeat(64), 7))
    assert.throws(() => database.prepare(`
      INSERT INTO ${CONTENT_OBJECT_TABLE} (sha256, bytes) VALUES (?, ?)
    `).run('A'.repeat(64), 7))

    database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (?, ?, 1, 1)
    `).run(firstResourceId, contentId)
    database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (?, ?, 1, 1)
    `).run(secondResourceId, contentId)
    database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (?, ?, 2, 0)
    `).run(firstResourceId, contentId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (?, ?, 3, 1)
    `).run(firstResourceId, contentId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (?, ?, 1, 0)
    `).run(firstResourceId, contentId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_VERSION_TABLE}
        (resource_id, content_object_id, version_number, is_current)
      VALUES (9999, ?, 9, 0)
    `).run(contentId))

    database.prepare(`
      INSERT INTO ${RESOURCE_DOMAIN_LINK_TABLE} (resource_id, domain_type, domain_id)
      VALUES (?, 'document', 21)
    `).run(firstResourceId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_DOMAIN_LINK_TABLE} (resource_id, domain_type, domain_id)
      VALUES (?, 'ebook', 22)
    `).run(firstResourceId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_DOMAIN_LINK_TABLE} (resource_id, domain_type, domain_id)
      VALUES (?, 'document', 21)
    `).run(secondResourceId))

    database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, scan_root_id, relative_path, state)
      VALUES (?, 'nas_path', ?, 'folder/item.txt', 'active')
    `).run(firstResourceId, rootId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, scan_root_id, relative_path, state)
      VALUES (?, 'nas_path', ?, 'folder/item.txt', 'active')
    `).run(secondResourceId, rootId))
    database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, external_id, state)
      VALUES (?, 'domain_record', 'same-external-id', 'active')
    `).run(secondResourceId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, scan_root_id, relative_path, storage_key)
      VALUES (?, 'nas_path', ?, 'invalid.txt', 'not-allowed')
    `).run(secondResourceId, rootId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, storage_key)
      VALUES (?, 'managed_storage', NULL)
    `).run(firstResourceId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, external_id)
      VALUES (?, 'domain_record', NULL)
    `).run(firstResourceId))
    database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, storage_key)
      VALUES (?, 'managed_storage', 'objects/aa')
    `).run(firstResourceId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, storage_key)
      VALUES (?, 'managed_storage', 'objects/aa')
    `).run(secondResourceId))

    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('stores observations and conflict candidates outside task JSON with their own constraints', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    runAllMigrations(database)
    const rootId = Number(database.prepare(`
      INSERT INTO ${NAS_SCAN_ROOT_TABLE} (name, root_path, rules_json) VALUES ('根', '/srv/nas', '{}')
    `).run().lastInsertRowid)
    const leftResourceId = insertResource(database, '同标题')
    const rightResourceId = insertResource(database, '同标题')
    const sourceId = Number(database.prepare(`
      INSERT INTO ${RESOURCE_SOURCE_TABLE}
        (resource_id, source_kind, scan_root_id, relative_path)
      VALUES (?, 'nas_path', ?, 'same.txt')
    `).run(leftResourceId, rootId).lastInsertRowid)

    database.prepare(`
      INSERT INTO ${NAS_SCAN_ENTRY_TABLE}
        (scan_root_id, relative_path, resource_source_id, size, mtime_ns, content_sha256,
         observation_status, last_seen_generation)
      VALUES (?, 'same.txt', ?, 8, 99, ?, 'discovered', 1)
    `).run(rootId, sourceId, 'b'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO ${NAS_SCAN_ENTRY_TABLE}
        (scan_root_id, relative_path, observation_status, last_seen_generation)
      VALUES (?, 'same.txt', 'discovered', 1)
    `).run(rootId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${NAS_SCAN_ENTRY_TABLE}
        (scan_root_id, relative_path, observation_status, last_seen_generation)
      VALUES (?, 'other.txt', 'discovered', 0)
    `).run(rootId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${NAS_SCAN_ENTRY_TABLE}
        (scan_root_id, relative_path, content_sha256, observation_status, last_seen_generation)
      VALUES (?, 'invalid.txt', ?, 'discovered', 1)
    `).run(rootId, 'C'.repeat(64)))

    database.prepare(`
      INSERT INTO ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
        (candidate_type, left_resource_id, right_resource_id, signal_json)
      VALUES ('title', ?, ?, ?)
    `).run(leftResourceId, rightResourceId, '{"title":"同标题"}')
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
        (candidate_type, left_resource_id, right_resource_id, signal_json)
      VALUES ('title', ?, ?, ?)
    `).run(leftResourceId, rightResourceId, '{}'))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
        (candidate_type, left_resource_id, right_resource_id, signal_json)
      VALUES ('title', ?, ?, ?)
    `).run(rightResourceId, leftResourceId, '{}'))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RESOURCE_CONFLICT_CANDIDATE_TABLE}
        (candidate_type, left_resource_id, right_resource_id, signal_json)
      VALUES ('title', ?, ?, ?)
    `).run(leftResourceId, rightResourceId, 'not-json'))

    assert.deepEqual(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'tasks\'').all(), [])
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('rolls back one migration when a later index statement conflicts', nativeTestOptions, () => {
  const database = openDatabase()
  try {
    database.exec(`
      CREATE TABLE index_name_conflict (id INTEGER PRIMARY KEY);
      CREATE UNIQUE INDEX idx_resource_versions_current ON index_name_conflict(id);
    `)
    const migration = RESOURCE_MODEL_MIGRATIONS.find(({ id }) => id === '0066_resource_versions')
    const registry = createMigrationRegistry([migration])

    assert.throws(() => runAllMigrations(database, registry))
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(RESOURCE_VERSION_TABLE).count, 0)
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get('idx_resource_versions_current').count, 1)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

