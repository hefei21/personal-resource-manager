import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import { chunkTokenizedSections } from '../src/services/ragPreflight.js'
import { evaluateRagRetrieval } from '../src/services/ragEvaluation.js'
import { createSearchIndexService } from '../src/services/searchIndexService.js'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const corpusDirectory = path.resolve(process.argv[2] || '.rag-evaluation-corpus')
const transformersModule = process.env.TRANSFORMERS_MODULE
const modelId = process.env.EMBEDDING_MODEL_ID || 'Qwen/Qwen3-Embedding-0.6B'
const revision = process.env.EMBEDDING_MODEL_REVISION || '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
const modelPath = process.env.EMBEDDING_MODEL_PATH
if (!transformersModule || !modelPath) throw new Error('TRANSFORMERS_MODULE and EMBEDDING_MODEL_PATH are required')

const fixture = JSON.parse(await fs.readFile(new URL('../test/fixtures/rag-evaluation-corpus.json', import.meta.url), 'utf8'))
const queries = JSON.parse(await fs.readFile(new URL('../test/fixtures/rag-evaluation-queries.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await fs.readFile(path.join(corpusDirectory, 'manifest.json'), 'utf8'))
const { AutoTokenizer } = await import(pathToFileURL(path.resolve(transformersModule)).href)
const tokenizer = await AutoTokenizer.from_pretrained(path.resolve(modelPath), { local_files_only: true, revision })
const adapter = {
  encode(text) {
    return tokenizer.encode(text, { add_special_tokens: false })
  },
  decode(tokens) {
    return tokenizer.decode(tokens, { skip_special_tokens: false })
  }
}
const bodies = new Map(await Promise.all(manifest.sources.map(async (source) => [
  source.id,
  await fs.readFile(path.join(corpusDirectory, source.file), 'utf8')
])))

async function evaluateConfiguration(configuration) {
  const entries = fixture.syntheticSources.map((source) => ({ ...source.entry, indexStatus: 'ready' }))
  for (const source of fixture.publicSources) {
    const chunks = chunkTokenizedSections([{
      sectionPath: [source.id],
      text: bodies.get(source.id)
    }], adapter, configuration)
    for (const chunk of chunks) {
      entries.push({
        ...source.entry,
        entryKey: `${source.entry.entryKey}:chunk:${chunk.ordinal}`,
        title: `${source.entry.title} [${chunk.ordinal + 1}/${chunks.length}]`,
        body: chunk.body,
        indexStatus: 'ready'
      })
    }
  }
  const database = new Database(':memory:')
  try {
    const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
    ensureMigrationControlTables(database)
    executeMigrationBatch({ database, registry, plan: createMigrationPlan(registry, []), lock: { state: 'active' } })
    const service = createSearchIndexService({ database, collectEntries: async () => entries })
    await service.refresh({ rebuild: true })
    const report = evaluateRagRetrieval(service, queries, { iterations: 3 })
    return {
      configuration,
      chunkCount: entries.length - fixture.syntheticSources.length,
      recallAt5: report.recallAt5,
      recallAt10: report.recallAt10,
      mrr: report.mrr,
      ndcgAt10: report.ndcgAt10,
      locatorAccuracy: report.locatorAccuracy,
      forbiddenHits: report.forbiddenHits,
      p50Ms: report.p50Ms,
      p95Ms: report.p95Ms,
      crossSource: report.byCategory.cross_source_synthesis,
      byLanguage: report.byLanguage,
      bySourceType: report.bySourceType
    }
  } finally {
    database.close()
  }
}

const configurations = [
  { maxTokens: 384, overlapTokens: 48 },
  { maxTokens: 512, overlapTokens: 64 },
  { maxTokens: 768, overlapTokens: 96 }
]
const reports = []
for (const configuration of configurations) reports.push(await evaluateConfiguration(configuration))
console.log(`RAG_FTS_CHUNK_PREFLIGHT ${JSON.stringify({ modelId, revision, reports })}`)
