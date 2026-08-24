import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { CODE_SYMBOL_INDEX_MIGRATIONS } from '../src/config/codeSymbolIndexSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import { createCodeSymbolIndexService } from '../src/services/codeSymbolIndexService.js'
import { evaluateSearchModes } from '../src/services/searchEvaluation.js'
import { createHybridSearchService } from '../src/services/hybridSearchService.js'
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

const querySet = JSON.parse(fs.readFileSync(new URL('./fixtures/code-hybrid-evaluation.json', import.meta.url), 'utf8'))

const repositories = [
  {
    id: 1,
    name: 'javascript-service',
    commit: 'a'.repeat(40),
    files: [
      { path: 'src/search.js', content: 'export class SearchService {\n  query(input) { return input }\n}\n' },
      { path: 'src/worker.js', content: 'export class Worker {\n  start() { return true }\n}\n' },
      { path: 'src/retry.js', content: '// retry policy for network operations\nexport const RETRIES = 3\n' }
    ]
  },
  {
    id: 2,
    name: 'python-indexer',
    commit: 'b'.repeat(40),
    files: [
      { path: 'lib/indexer.py', content: 'class RepositoryIndexer:\n    def index(self):\n        return True\n' },
      { path: 'lib/worker.py', content: 'class Worker:\n    def start(self):\n        return True\n' },
      { path: 'lib/retry.py', content: '# retry policy for storage operations\nRETRIES = 3\n' }
    ]
  }
]

function migrate(database) {
  const migrations = [...SEARCH_INDEX_MIGRATIONS, ...CODE_SYMBOL_INDEX_MIGRATIONS]
  const registry = createMigrationRegistry(migrations)
  ensureMigrationControlTables(database)
  executeMigrationBatch({ database, registry, plan: createMigrationPlan(registry, []), lock: { state: 'active' } })
}

function ftsEntries() {
  return repositories.flatMap((repository) => repository.files.map((file) => ({
    entryKey: `code-file:${repository.id}:${file.path}`,
    resourceType: 'code_file',
    domainId: repository.id,
    parentDomainId: repository.id,
    title: file.path.split('/').at(-1),
    subtitle: `${repository.name} · ${file.path}`,
    body: file.content,
    sourceKind: 'managed_git',
    sourceLabel: repository.name,
    locator: { route: '/code', repositoryId: repository.id, path: file.path, line: 1 }
  })))
}

test('measures symbol and RRF improvement over the Stage 6A FTS baseline across repositories', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    database.exec(`
      CREATE TABLE code_repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO code_repositories (id, name) VALUES (1, 'javascript-service'), (2, 'python-indexer');
    `)
    migrate(database)
    const ftsService = createSearchIndexService({ database, collectEntries: async () => ftsEntries() })
    await ftsService.refresh({ rebuild: true })
    const symbolService = createCodeSymbolIndexService({ database })
    for (const repository of repositories) {
      symbolService.refreshSnapshot({
        repositoryId: repository.id,
        sourceKind: 'managed_git',
        branch: 'main',
        commit: repository.commit,
        files: repository.files
      })
    }
    const service = createHybridSearchService({ ftsService, symbolService })
    const report = evaluateSearchModes(service, querySet, { k: 3, iterations: 3 })
    if (process.env.SEARCH_EVAL_REPORT === '1') console.log(`CODE_HYBRID_EVAL_REPORT ${JSON.stringify(report)}`)
    assert.equal(report.modes.fts.queryCount, 4)
    assert.equal(report.modes.symbol.locatorAccuracy, 1)
    assert.equal(report.modes.hybrid.locatorAccuracy, 1)
    assert.ok(report.modes.hybrid.recallAtK > report.modes.fts.recallAtK)
    assert.ok(report.modes.hybrid.mrr > report.modes.fts.mrr)
    assert.ok(report.improvement.recallAtK > 0)
    assert.ok(report.improvement.mrr > 0)
  } finally {
    database.close()
  }
})
