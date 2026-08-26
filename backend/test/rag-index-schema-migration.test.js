import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  RAG_CHUNK_FTS_META_TABLE,
  RAG_CHUNK_FTS_TABLE,
  RAG_CHUNK_TABLE,
  RAG_INDEX_MIGRATIONS,
  RAG_SOURCE_SNAPSHOT_TABLE,
  RAG_SOURCE_STATE_TABLE
} from '../src/config/ragIndexSchema.js'
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
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

const registry = createMigrationRegistry(RAG_INDEX_MIGRATIONS)

function migrate(database, selectedRegistry = registry) {
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry: selectedRegistry,
    plan: createMigrationPlan(selectedRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function validSnapshot(database, overrides = {}) {
  const values = {
    source_type: 'document',
    source_id: 1,
    source_version_id: 'document-version:1',
    source_content_sha256: 'a'.repeat(64),
    extractor_version: 'text-native-v1',
    chunker_version: 'structural-v1',
    chunker_config_hash: 'b'.repeat(64),
    status: 'text_ready',
    ...overrides
  }
  return Number(database.prepare(`
    INSERT INTO ${RAG_SOURCE_SNAPSHOT_TABLE} (
      source_type, source_id, source_version_id, source_content_sha256,
      extractor_version, chunker_version, chunker_config_hash, status
    ) VALUES (
      @source_type, @source_id, @source_version_id, @source_content_sha256,
      @extractor_version, @chunker_version, @chunker_config_hash, @status
    )
  `).run(values).lastInsertRowid)
}

test('creates the four RAG migrations, compatibility shapes, and repeats safely', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    assert.deepEqual(RAG_INDEX_MIGRATIONS.map(({ id }) => id), [
      '0079_rag_source_snapshots',
      '0080_rag_source_state',
      '0081_rag_chunks',
      '0082_rag_chunks_fts'
    ])

    const summary = migrate(database)
    assert.deepEqual(summary.executed.map(({ id }) => id), RAG_INDEX_MIGRATIONS.map(({ id }) => id))
    assert.deepEqual(
      database.prepare(`
        SELECT name, type FROM sqlite_schema
         WHERE name IN (?, ?, ?, ?)
         ORDER BY name
      `).all(RAG_SOURCE_SNAPSHOT_TABLE, RAG_SOURCE_STATE_TABLE, RAG_CHUNK_TABLE, RAG_CHUNK_FTS_META_TABLE),
      [
        { name: RAG_CHUNK_TABLE, type: 'table' },
        { name: RAG_CHUNK_FTS_META_TABLE, type: 'table' },
        { name: RAG_SOURCE_SNAPSHOT_TABLE, type: 'table' },
        { name: RAG_SOURCE_STATE_TABLE, type: 'table' }
      ]
    )
    assert.equal(
      database.prepare("SELECT type FROM sqlite_schema WHERE name = 'rag_chunks_fts'").get()?.type,
      'table'
    )
    assert.deepEqual(database.prepare(`SELECT id, schema_version FROM ${RAG_CHUNK_FTS_META_TABLE}`).get(), {
      id: 1,
      schema_version: 1
    })

    for (const migration of RAG_INDEX_MIGRATIONS) {
      assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
        status: 'satisfied',
        kind: 'table-transition',
        table: migration.compatibility.table,
        reason: 'matched'
      })
    }

    const repeated = migrate(database)
    assert.equal(repeated.executed.length, 0)
    assert.equal(repeated.skipped.length, RAG_INDEX_MIGRATIONS.length)
  } finally {
    database.close()
  }
})

test('enforces snapshot/state/chunk identities, statuses, JSON locators, and FTS content', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const snapshotId = validSnapshot(database)
    database.prepare(`
      INSERT INTO ${RAG_SOURCE_STATE_TABLE}
        (source_type, source_id, active_snapshot_id, last_attempt_snapshot_id, status)
      VALUES ('document', 1, ?, ?, 'active')
    `).run(snapshotId, snapshotId)
    database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE} SET status = 'building' WHERE source_type = 'document' AND source_id = 1
    `).run()
    database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE} SET status = 'active' WHERE source_type = 'document' AND source_id = 1
    `).run()
    const chunk = database.prepare(`
      INSERT INTO ${RAG_CHUNK_TABLE}
        (snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
         title, section_path_json, locator_json)
      VALUES (?, 0, ?, ?, NULL, 'deferred', ?, ?, ?)
    `).run(
      snapshotId,
      'c'.repeat(64),
      'NAS FTS 正文',
      '统一检索',
      '["安装","检索"]',
      '{"route":"/documents","documentId":1,"versionId":1,"startLine":1,"endLine":2}'
    )
    database.prepare(`
      INSERT INTO ${RAG_CHUNK_FTS_TABLE}(rowid, title, section_path_json, body)
      VALUES (?, ?, ?, ?)
    `).run(chunk.lastInsertRowid, '统一检索', '["安装","检索"]', 'NAS FTS 正文')

    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
        FROM ${RAG_CHUNK_FTS_TABLE}
       WHERE ${RAG_CHUNK_FTS_TABLE} MATCH 'NAS'
    `).get().count, 1)
    assert.equal(database.prepare(`SELECT token_count, token_count_mode FROM ${RAG_CHUNK_TABLE}`).get().token_count, null)
    assert.equal(database.prepare(`SELECT token_count_mode FROM ${RAG_CHUNK_TABLE}`).get().token_count_mode, 'deferred')

    assert.throws(() => validSnapshot(database))
    assert.throws(() => validSnapshot(database, { source_type: 'note' }))
    assert.throws(() => validSnapshot(database, { source_content_sha256: 'A'.repeat(64) }))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_TABLE}
        (snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
         title, section_path_json, locator_json)
      VALUES (?, 1, ?, 'invalid', NULL, 'unknown', 'title', '[]', '{}')
    `).run(snapshotId, 'd'.repeat(64)))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_TABLE}
        (snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
         title, section_path_json, locator_json)
      VALUES (?, 2, ?, 'invalid', NULL, 'deferred', 'title', 'not-json', '{}')
    `).run(snapshotId, 'e'.repeat(64)))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_TABLE}
        (snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
         title, section_path_json, locator_json)
      VALUES (9999, 3, ?, 'invalid', 1, 'actual', 'title', '[]', '{}')
    `).run('f'.repeat(64)))
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('rolls back the snapshot migration when its index name is already occupied', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE rag_index_conflict (id INTEGER PRIMARY KEY);
      CREATE INDEX idx_rag_snapshots_source ON rag_index_conflict(id);
    `)
    const migration = RAG_INDEX_MIGRATIONS.find(({ id }) => id === '0079_rag_source_snapshots')
    const singleRegistry = createMigrationRegistry([migration])

    assert.throws(() => migrate(database, singleRegistry))
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(RAG_SOURCE_SNAPSHOT_TABLE).count, 0)
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get('idx_rag_snapshots_source').count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, 0)
  } finally {
    database.close()
  }
})
