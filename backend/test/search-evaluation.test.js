import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import { evaluateSearchIndex } from '../src/services/searchEvaluation.js'
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

const querySet = JSON.parse(fs.readFileSync(new URL('./fixtures/search-evaluation.json', import.meta.url), 'utf8'))

function entries() {
  return [
    { entryKey: 'note:1', resourceType: 'note', domainId: 1, title: '统一搜索', body: '统一入口设计', sourceKind: 'owner_note', locator: { route: '/blog', postId: 1 } },
    { entryKey: 'code-file:2:src/search.js', resourceType: 'code_file', domainId: 2, title: 'search.js', body: 'const noop = true\nfunction buildUnifiedSearch() { return "BM25" }', sourceKind: 'git_nas', locator: { route: '/code', repositoryId: 2, path: 'src/search.js', line: 1 } },
    { entryKey: 'document:3', resourceType: 'document', domainId: 3, title: '索引设计', body: '资源变更后执行增量索引。', sourceKind: 'managed_storage', locator: { route: '/documents', documentId: 3 } },
    { entryKey: 'ebook-chapter:4:2', resourceType: 'ebook_chapter', domainId: 4, parentDomainId: 4, title: '恢复策略', body: '本章说明故障恢复与重建。', sourceKind: 'managed_storage', locator: { route: '/books', bookId: 4, chapterIndex: 2 } },
    { entryKey: 'audio:5', resourceType: 'audio', domainId: 5, title: '现场录音', author: 'Owner', sourceKind: 'managed_storage', locator: { route: '/music', musicId: 5 } }
  ]
}

test('computes reproducible Recall@K, latency, and locator accuracy', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
    ensureMigrationControlTables(database)
    executeMigrationBatch({ database, registry, plan: createMigrationPlan(registry, []), lock: { state: 'active' } })
    const service = createSearchIndexService({ database, collectEntries: async () => entries() })
    await service.refresh({ rebuild: true })
    const report = evaluateSearchIndex(service, querySet, { k: 5, iterations: 3 })
    if (process.env.SEARCH_EVAL_REPORT === '1') console.log(`SEARCH_EVAL_REPORT ${JSON.stringify(report)}`)
    assert.equal(report.queryCount, 5)
    assert.equal(report.recallAtK, 1)
    assert.equal(report.citationAccuracy, 1)
    assert.ok(report.p50Ms >= 0)
    assert.ok(report.p95Ms >= report.p50Ms)
    assert.equal(report.samples, 15)
    assert.deepEqual(report.details.map((item) => item.retrievedRelevant), [1, 1, 1, 1, 1])
  } finally {
    database.close()
  }
})
