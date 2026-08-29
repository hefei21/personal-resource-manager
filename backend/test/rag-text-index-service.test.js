import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { RAG_INDEX_MIGRATIONS } from '../src/config/ragIndexSchema.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { chunkRagSource, normalizeRagChunkerOptions, RAG_CHUNKER_VERSION } from '../src/services/ragChunker.js'
import { createRagTextIndexService, RAG_TEXT_INDEX_ERROR_CODES } from '../src/services/ragTextIndexService.js'

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

function migrate(database) {
  database.pragma('foreign_keys = ON')
  ensureMigrationControlTables(database)
  executeMigrationBatch({
    database,
    registry,
    plan: createMigrationPlan(registry, []),
    lock: { state: 'active' },
    now: () => '2026-08-25T00:00:00.000Z'
  })
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function source({ id = 1, version = 1, text = `# Source ${id}\n\nThe active body for source ${id}.`, title = `Source ${id}` } = {}) {
  const locator = { route: '/documents', documentId: id, versionId: version }
  return {
    sourceType: 'document',
    sourceId: id,
    sourceVersionId: String(version),
    sourceContentSha256: sha256(text),
    extractorVersion: 'rag-source.v1',
    title,
    baseLocator: locator,
    sections: [{
      format: 'markdown',
      text,
      title,
      sectionPath: [],
      locator
    }]
  }
}

function createService(database, overrides = {}) {
  return createRagTextIndexService({
    database,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
    ...overrides
  })
}

function rows(database, table, where = '') {
  return database.prepare(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY id`).all()
}

test('indexes collector sources in a transaction and returns exact public locators', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    let collectorCalls = 0
    const indexedSource = source({ id: 11, version: 3, text: '# Guide\n\nA precise paragraph.' })
    indexedSource.sections[0].locator = { ...indexedSource.sections[0].locator, page: 2 }
    const service = createService(database, {
      collectSources: async ({ database: receivedDatabase }) => {
        collectorCalls += 1
        assert.equal(receivedDatabase, database)
        return { sources: [indexedSource], errors: [] }
      }
    })

    const result = await service.refresh()
    assert.equal(collectorCalls, 1)
    assert.equal(result.status, 'ready')
    assert.equal(result.indexedCount, 1)
    assert.equal(result.sources[0].status, 'text_ready')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_source_snapshots').get().count, 1)
    assert.equal(database.prepare("SELECT status FROM rag_source_snapshots WHERE source_id = 11").get().status, 'text_ready')
    assert.equal(database.prepare("SELECT status FROM rag_source_state WHERE source_id = 11").get().status, 'active')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_chunks').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_chunks_fts').get().count, 1)

    const query = service.query({ q: 'precise', scope: 'client-controlled-scope' })
    assert.equal(query.total, 1)
    assert.equal(query.data[0].sourceVersionId, '3')
    assert.deepEqual(query.data[0].locator, {
      route: '/documents',
      documentId: 11,
      versionId: 3,
      page: 2,
      sectionPath: ['Guide'],
      startLine: 1,
      endLine: 3,
      paragraphIndex: 0,
      paragraphEndIndex: 1
    })
    assert.equal(query.data[0].body, 'Guide\n\nA precise paragraph.')
    assert.equal(Object.hasOwn(query, 'scope'), false)
  } finally {
    database.close()
  }
})

test('falls back to bounded OR recall when a natural-language CJK question has no strict AND hit', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database)
    await service.index({
      sources: [source({
        id: 111,
        version: 1,
        title: '北辰灯塔设备运行简报',
        text: '北辰灯塔应急无线电固定巡检周期为17天。最近一次为2026-07-24，下一次为2026-08-10。'
      })],
      errors: []
    })
    database.prepare("UPDATE rag_source_snapshots SET status = 'embedding_pending' WHERE source_id = 111").run()

    const result = service.query({
      q: '北辰灯塔应急无线电的固定巡检周期是多少天？最近一次和下一次计划日期分别是什么？',
      limit: 10
    })
    assert.equal(result.total, 1)
    assert.equal(result.data[0].sourceId, 111)
    assert.equal(service.query({ q: '" OR * NEAR(...) foo" NOT bar', limit: 10 }).total, 0)

    await service.index({
      sources: [
        source({ id: 112, text: 'alpha beta exact evidence' }),
        source({ id: 113, text: 'alpha partial evidence' })
      ],
      errors: []
    })
    const strict = service.query({ q: 'alpha beta', limit: 10 })
    assert.equal(strict.total, 1)
    assert.equal(strict.data[0].sourceId, 112)
  } finally {
    database.close()
  }
})

test('replaces active snapshot atomically and excludes stale FTS rows through the active join', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database, {
      collectSources: async () => ({ sources: [], errors: [] })
    })
    await service.index({ sources: [source({ id: 12, version: 1, text: '# Old\n\noldonly phrase.' })], errors: [] })
    const firstSnapshot = database.prepare('SELECT active_snapshot_id FROM rag_source_state WHERE source_id = 12').get().active_snapshot_id

    const result = await service.index({
      sources: [source({ id: 12, version: 2, text: '# New\n\nnewonly phrase.' })],
      errors: []
    })
    const state = database.prepare('SELECT * FROM rag_source_state WHERE source_id = 12').get()
    const snapshots = rows(database, 'rag_source_snapshots', 'source_id = 12')
    assert.equal(result.status, 'ready')
    assert.equal(snapshots.length, 2)
    assert.notEqual(state.active_snapshot_id, firstSnapshot)
    assert.equal(snapshots.find((row) => row.id === firstSnapshot).status, 'stale')
    assert.equal(snapshots.find((row) => row.id === state.active_snapshot_id).status, 'text_ready')
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rag_chunks_fts').get().count, 2)
    assert.equal(service.query({ q: 'oldonly' }).total, 0)
    assert.equal(service.query({ q: 'newonly' }).data[0].sourceVersionId, '2')
  } finally {
    database.close()
  }
})

test('forced rebuild reprocesses an unchanged source and preserves the active snapshot on failure', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const unchanged = source({ id: 121, version: 1, text: '# Stable\n\nstill searchable.' })
    let failRebuild = false
    const chunkerConfig = normalizeRagChunkerOptions()
    const controlledChunker = {
      config: { chunkerVersion: RAG_CHUNKER_VERSION, configHash: chunkerConfig.configHash },
      chunk(input) {
        if (failRebuild) throw new Error('forced rebuild failed')
        return chunkRagSource(input)
      }
    }
    const stable = createService(database, { chunker: controlledChunker })
    await stable.index({ sources: [unchanged], errors: [] })
    const skipped = await stable.index({ sources: [unchanged], errors: [] })
    assert.equal(skipped.skippedCount, 1)
    const rebuilt = await stable.index({ sources: [unchanged], errors: [] }, { rebuild: true })
    assert.equal(rebuilt.indexedCount, 1)
    assert.equal(rebuilt.skippedCount, 0)

    const before = database.prepare('SELECT active_snapshot_id FROM rag_source_state WHERE source_id = 121').get().active_snapshot_id
    failRebuild = true
    const failed = await stable.index({ sources: [unchanged], errors: [] }, { rebuild: true })
    const state = database.prepare('SELECT active_snapshot_id, status FROM rag_source_state WHERE source_id = 121').get()
    assert.equal(failed.failedCount, 1)
    assert.equal(state.active_snapshot_id, before)
    assert.equal(state.status, 'active')
    assert.equal(stable.query({ q: 'searchable' }).total, 1)
  } finally {
    database.close()
  }
})

test('failed attempt preserves old active snapshot and records failed attempt', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const stable = createService(database)
    await stable.index({ sources: [source({ id: 13, version: 1, text: '# Stable\n\nold evidence.' })], errors: [] })
    const before = database.prepare('SELECT active_snapshot_id FROM rag_source_state WHERE source_id = 13').get().active_snapshot_id

    const failing = createService(database, {
      chunker: () => { throw new Error('simulated chunk failure') }
    })
    const result = await failing.index({
      sources: [source({ id: 13, version: 2, text: '# Broken\n\nnew evidence.' })],
      errors: []
    })
    const state = database.prepare('SELECT * FROM rag_source_state WHERE source_id = 13').get()
    const failed = database.prepare("SELECT * FROM rag_source_snapshots WHERE source_id = 13 AND status = 'failed'").get()
    assert.equal(result.status, 'partial')
    assert.equal(result.failedCount, 1)
    assert.equal(state.active_snapshot_id, before)
    assert.equal(state.status, 'failed')
    assert.equal(failed.last_error_code, RAG_TEXT_INDEX_ERROR_CODES.SOURCE_FAILED)
    assert.equal(failing.query({ q: 'old evidence' }).total, 1)
    assert.equal(failing.query({ q: 'new evidence' }).total, 0)
  } finally {
    database.close()
  }
})

test('startup recovery marks orphan building/indexing attempts failed without changing active snapshot', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database)
    await service.index({ sources: [source({ id: 14, version: 1, text: '# Kept\n\nretained evidence.' })], errors: [] })
    const stateBefore = database.prepare('SELECT active_snapshot_id FROM rag_source_state WHERE source_id = 14').get()
    const orphanId = Number(database.prepare(`
      INSERT INTO rag_source_snapshots (
        source_type, source_id, source_version_id, source_content_sha256,
        extractor_version, chunker_version, chunker_config_hash, status
      ) VALUES ('document', 14, '2', ?, 'rag-source.v1', 'rag-chunker.v1', ?, 'building')
    `).run('d'.repeat(64), 'e'.repeat(64)).lastInsertRowid)
    database.prepare(`
      UPDATE rag_source_state
         SET last_attempt_snapshot_id = ?, status = 'indexing'
       WHERE source_type = 'document' AND source_id = 14
    `).run(orphanId)

    const recovered = service.recover()
    const stateAfter = database.prepare('SELECT * FROM rag_source_state WHERE source_id = 14').get()
    const orphan = database.prepare('SELECT * FROM rag_source_snapshots WHERE id = ?').get(orphanId)
    assert.equal(recovered.recovered, 1)
    assert.equal(orphan.status, 'failed')
    assert.equal(orphan.last_error_code, RAG_TEXT_INDEX_ERROR_CODES.INTERRUPTED)
    assert.equal(stateAfter.active_snapshot_id, stateBefore.active_snapshot_id)
    assert.equal(stateAfter.status, 'active')
    assert.equal(service.query({ q: 'retained evidence' }).total, 1)
  } finally {
    database.close()
  }
})

test('authoritative visibility callback filters active results after SQL and client scope is ignored', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const seenScopes = []
    const service = createService(database, {
      authoritativeVisibility: (result, context) => {
        seenScopes.push(context.query.scope)
        return result.sourceId !== 16
      }
    })
    await service.index({
      sources: [
        source({ id: 15, text: '# Visible\n\nshared phrase.' }),
        source({ id: 16, text: '# Hidden\n\nshared phrase.' })
      ],
      errors: []
    })

    const result = service.query({ q: 'shared phrase', scope: 'all', limit: 20 })
    assert.equal(result.total, 1)
    assert.equal(result.data[0].sourceId, 15)
    assert.ok(seenScopes.every((scope) => scope === undefined))
  } finally {
    database.close()
  }
})

test('query sourceId scope returns only the exact active resource', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database)
    await service.index({
      sources: [
        source({ id: 21, text: '# First\n\nshared exact phrase.' }),
        source({ id: 22, text: '# Second\n\nshared exact phrase.' })
      ],
      errors: []
    })
    const result = service.query({
      q: 'shared exact phrase',
      sourceType: 'document',
      sourceId: 22,
      limit: 20
    })
    assert.equal(result.total, 1)
    assert.equal(result.data[0].sourceId, 22)
    assert.throws(() => service.query({ q: 'shared', sourceId: 22 }))
  } finally {
    database.close()
  }
})
