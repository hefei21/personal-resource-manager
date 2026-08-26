import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import { evaluateRagRetrieval, normalizeRagQuerySet } from '../src/services/ragEvaluation.js'
import { createSearchIndexService } from '../src/services/searchIndexService.js'

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

const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/rag-evaluation-corpus.json', import.meta.url), 'utf8'))
const queries = JSON.parse(fs.readFileSync(new URL('./fixtures/rag-evaluation-queries.json', import.meta.url), 'utf8'))

function corpusEntries() {
  return [...corpus.publicSources, ...corpus.syntheticSources].map((source) => ({
    ...source.entry,
    indexStatus: 'ready'
  }))
}

test('pins twelve public sources, excerpt hashes, revisions, and required source mix', () => {
  assert.equal(corpus.schemaVersion, 1)
  assert.equal(corpus.publicSources.length, 12)
  assert.ok(corpus.publicSources.filter((source) => source.sourceType === 'document').length >= 5)
  assert.ok(corpus.publicSources.filter((source) => source.sourceType === 'ebook').length >= 2)
  assert.ok(corpus.publicSources.filter((source) => source.sourceType === 'repository_document').length >= 3)
  for (const source of corpus.publicSources) {
    assert.match(source.sourceUrl, /^https:\/\//u)
    assert.match(source.downloadUrl, /^https:\/\//u)
    assert.match(source.sourceSha256, /^[a-f0-9]{64}$/u)
    assert.ok(source.revision)
    assert.ok(source.license)
    assert.equal(crypto.createHash('sha256').update(source.entry.body).digest('hex'), source.excerptSha256)
  }
})

test('pins a 64-query schema with every required evaluation category', () => {
  const normalized = normalizeRagQuerySet(queries)
  assert.equal(normalized.length, 64)
  const counts = Object.groupBy(normalized, (query) => query.category)
  assert.equal(counts.exact_fact.length, 24)
  assert.equal(counts.same_source_synthesis.length, 10)
  assert.equal(counts.cross_source_synthesis.length, 8)
  assert.equal(counts.version_conflict.length, 6)
  assert.equal(counts.no_answer.length, 6)
  assert.equal(counts.security.length, 10)
  assert.equal(normalized.filter((query) => query.language === 'zh').length, 12)
  assert.ok(normalized.filter((query) => query.category === 'security').some((query) => query.forbidden.length > 0))
})

test('runs the Stage 6A file-level FTS baseline without treating thresholds as test assertions', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
    ensureMigrationControlTables(database)
    executeMigrationBatch({ database, registry, plan: createMigrationPlan(registry, []), lock: { state: 'active' } })
    const service = createSearchIndexService({ database, collectEntries: async () => corpusEntries() })
    await service.refresh({ rebuild: true })
    const report = evaluateRagRetrieval(service, queries, { iterations: 3 })
    if (process.env.RAG_EVAL_REPORT === '1') console.log(`RAG_FTS_BASELINE ${JSON.stringify(report)}`)
    assert.equal(report.queryCount, 64)
    assert.equal(report.answerableQueryCount, 51)
    assert.equal(report.samples, 192)
    assert.equal(report.locatorAccuracy, 1)
    assert.ok(report.p95Ms >= report.p50Ms)
    assert.deepEqual(Object.keys(report.byCategory).sort(), [
      'cross_source_synthesis', 'exact_fact', 'no_answer', 'same_source_synthesis', 'security', 'version_conflict'
    ])
  } finally {
    database.close()
  }
})
