import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { RAG_INDEX_MIGRATIONS } from '../src/config/ragIndexSchema.js'
import {
  RAG_CHUNK_EMBEDDING_TABLE,
  RAG_EMBEDDING_MIGRATIONS,
  RAG_EMBEDDING_MODEL_TABLE,
  RAG_SNAPSHOT_EMBEDDING_STATE_TABLE
} from '../src/config/ragEmbeddingSchema.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'

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

const allMigrations = [...RAG_INDEX_MIGRATIONS, ...RAG_EMBEDDING_MIGRATIONS]
const registry = createMigrationRegistry(allMigrations)

function migrate(database, selectedRegistry = registry) {
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  return executeMigrationBatch({
    database,
    registry: selectedRegistry,
    plan: createMigrationPlan(selectedRegistry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function createSnapshot(database, { sourceId = 1, hash = 'a'.repeat(64) } = {}) {
  return Number(database.prepare(`
    INSERT INTO rag_source_snapshots (
      source_type, source_id, source_version_id, source_content_sha256,
      extractor_version, chunker_version, chunker_config_hash, status
    ) VALUES ('document', ?, 'version-1', ?, 'extractor-v1', 'chunker-v1', ?, 'text_ready')
  `).run(sourceId, hash, 'b'.repeat(64)).lastInsertRowid)
}

function createChunk(database, snapshotId, { hash = 'c'.repeat(64), ordinal = 0 } = {}) {
  return Number(database.prepare(`
    INSERT INTO rag_chunks (
      snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
      title, section_path_json, locator_json
    ) VALUES (?, ?, ?, 'embedding body', NULL, 'deferred', 'Embedding', '[]', '{}')
  `).run(snapshotId, ordinal, hash).lastInsertRowid)
}

function createModel(database, overrides = {}) {
  const values = {
    provider: 'lmstudio',
    model_id: 'Qwen/Qwen3-Embedding-0.6B',
    model_revision: 'revision-1',
    dimensions: 768,
    distance: 'cosine',
    normalization: 'l2',
    input_limit: 32768,
    config_hash: 'd'.repeat(64),
    status: 'candidate',
    ...overrides
  }
  return Number(database.prepare(`
    INSERT INTO ${RAG_EMBEDDING_MODEL_TABLE} (
      provider, model_id, model_revision, dimensions, distance,
      normalization, input_limit, config_hash, status
    ) VALUES (
      @provider, @model_id, @model_revision, @dimensions, @distance,
      @normalization, @input_limit, @config_hash, @status
    )
  `).run(values).lastInsertRowid)
}

test('registers 0083-0085 with frozen compatibility shapes and restart-safe migrations', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    assert.deepEqual(RAG_EMBEDDING_MIGRATIONS.map(({ id }) => id), [
      '0083_rag_embedding_models',
      '0084_rag_chunk_embeddings',
      '0085_rag_snapshot_embedding_state'
    ])
    const first = migrate(database)
    assert.deepEqual(first.executed.map(({ id }) => id), allMigrations.map(({ id }) => id))
    for (const migration of RAG_EMBEDDING_MIGRATIONS) {
      assert.deepEqual(checkMigrationCompatibility(database, migration.compatibility), {
        status: 'satisfied',
        kind: 'table-transition',
        table: migration.compatibility.table,
        reason: 'matched'
      })
    }
    assert.deepEqual(
      database.prepare(`
        SELECT name, type FROM sqlite_schema
         WHERE name IN (?, ?, ?)
         ORDER BY name
      `).all(RAG_EMBEDDING_MODEL_TABLE, RAG_CHUNK_EMBEDDING_TABLE, RAG_SNAPSHOT_EMBEDDING_STATE_TABLE),
      [
        { name: RAG_CHUNK_EMBEDDING_TABLE, type: 'table' },
        { name: RAG_EMBEDDING_MODEL_TABLE, type: 'table' },
        { name: RAG_SNAPSHOT_EMBEDDING_STATE_TABLE, type: 'table' }
      ]
    )
    const repeated = migrate(database)
    assert.equal(repeated.executed.length, 0)
    assert.equal(repeated.skipped.length, allMigrations.length)
  } finally {
    database.close()
  }
})

test('isolates model/config identities and enforces dimensions, metric, normalization, hash, and status checks', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const first = createModel(database)
    const changedConfig = createModel(database, { config_hash: 'e'.repeat(64) })
    const changedRevision = createModel(database, { model_revision: 'revision-2' })
    const changedDimensions = createModel(database, { dimensions: 1024 })
    assert.equal(new Set([first, changedConfig, changedRevision, changedDimensions]).size, 4)
    assert.throws(() => createModel(database))
    for (const overrides of [
      { dimensions: 31 },
      { dimensions: 65537 },
      { input_limit: 127 },
      { input_limit: 1048577 },
      { distance: 'manhattan' },
      { normalization: 'unit' },
      { config_hash: 'A'.repeat(64) },
      { status: 'unknown' },
      { provider: '   ' }
    ]) assert.throws(() => createModel(database, overrides))
  } finally {
    database.close()
  }
})

test('binds vector identity to the immutable chunk hash, isolates model vectors, and cascades safely', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const snapshotId = createSnapshot(database)
    const chunkHash = 'c'.repeat(64)
    const chunkId = createChunk(database, snapshotId, { hash: chunkHash })
    const secondChunkId = createChunk(database, snapshotId, { hash: 'f'.repeat(64), ordinal: 1 })
    const modelId = createModel(database, { status: 'active' })
    const secondModelId = createModel(database, { config_hash: 'e'.repeat(64), status: 'active' })

    database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256, status
      ) VALUES (?, ?, ?, 'point-1', ?, 'ready')
    `).run(chunkId, chunkHash, modelId, '1'.repeat(64))
    database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256, status
      ) VALUES (?, ?, ?, 'point-1', ?, 'pending')
    `).run(chunkId, chunkHash, secondModelId, '2'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256
      ) VALUES (?, ?, ?, 'point-2', ?)
    `).run(chunkId, 'a'.repeat(64), modelId, '3'.repeat(64)))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256
      ) VALUES (?, ?, ?, 'point-3', ?)
    `).run(chunkId, chunkHash, modelId, '4'.repeat(64)))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256, status
      ) VALUES (?, ?, ?, 'point-4', ?, 'unknown')
    `).run(secondChunkId, 'f'.repeat(64), modelId, '5'.repeat(64)))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_CHUNK_EMBEDDING_TABLE} (
        chunk_id, chunk_sha256, embedding_model_id, vector_id, vector_sha256
      ) VALUES (?, ?, ?, 'point-5', ?)
    `).run(secondChunkId, 'f'.repeat(64), 9999, '6'.repeat(64)))

    database.prepare(`
      INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
        (snapshot_id, embedding_model_id, status, vector_count)
      VALUES (?, ?, 'active', 2)
    `).run(snapshotId, modelId)
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
        (snapshot_id, embedding_model_id, status)
      VALUES (?, ?, 'pending')
    `).run(snapshotId, modelId))
    assert.throws(() => database.prepare(`
      INSERT INTO ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}
        (snapshot_id, embedding_model_id, status)
      VALUES (?, ?, 'unknown')
    `).run(snapshotId, secondModelId))

    assert.throws(() => database.prepare(`DELETE FROM ${RAG_EMBEDDING_MODEL_TABLE} WHERE id = ?`).run(secondModelId))
    database.prepare('DELETE FROM rag_chunks WHERE id = ?').run(chunkId)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RAG_CHUNK_EMBEDDING_TABLE} WHERE chunk_id = ?`).get(chunkId).count, 0)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RAG_CHUNK_EMBEDDING_TABLE} WHERE embedding_model_id = ?`).get(secondModelId).count, 0)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}`).get().count, 1)
    database.prepare('DELETE FROM rag_source_snapshots WHERE id = ?').run(snapshotId)
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${RAG_SNAPSHOT_EMBEDDING_STATE_TABLE}`).get().count, 0)
    assert.deepEqual(database.pragma('foreign_key_check'), [])
  } finally {
    database.close()
  }
})

test('rolls back prerequisite indexes and embedding tables on migration conflict', nativeTestOptions, () => {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    ensureMigrationControlTables(database)
    const prior = createMigrationRegistry(RAG_INDEX_MIGRATIONS)
    migrate(database, prior)
    database.exec(`CREATE TABLE rag_embedding_conflict (id INTEGER PRIMARY KEY)`)
    database.exec('CREATE INDEX idx_rag_embedding_models_status ON rag_embedding_conflict(id)')
    const selected = createMigrationRegistry(RAG_EMBEDDING_MIGRATIONS)
    assert.throws(() => migrate(database, selected))
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'rag_embedding_models'").get().count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'rag_chunk_embeddings'").get().count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'rag_snapshot_embedding_state'").get().count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_rag_chunks_id_sha256_embedding'").get().count, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prm_schema_migrations').get().count, RAG_INDEX_MIGRATIONS.length)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_rag_embedding_models_status'").get().count, 1)
  } finally {
    database.close()
  }
})
