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
import { ragQueryTerms, boundRagIdentifier, boundRagComparisonIdentifiers } from '../src/services/ragLexicalText.js'
import { expandRagEvidenceContext } from '../src/services/ragEvidenceContext.js'
import { completeRagDeclarationContext } from '../src/services/ragDeclarationContext.js'
import { readRagChapterScope, normalizeRagChunkScope } from '../src/services/ragChapterScope.js'
import { createTranslatedCandidateProvider } from '../src/services/ragTranslatedCandidateProvider.js'
import { attachRagSourceTitles } from '../src/services/ragSourceTitles.js'
import { createRagAnswerService } from '../src/services/ragAnswerService.js'
import { createRagHybridRetriever, selectGlobalRerankedEvidence } from '../src/services/ragHybridRetriever.js'

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

test('persisted declaration tails preserve original chunks and fail closed on identity, scope and budget', nativeTestOptions, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-tail-'))
  const filename = path.join(dir, 'index.sqlite')
  let database = new Database(filename)
  try {
    migrate(database)
    const text = '.. module:: alpha\n\n.. function:: wait(value)\n\n' +
      Array.from({ length: 9 }, (_, i) => `   Clause ${i}: ` + 'condition applies to this object only. '.repeat(4)).join('\n\n') +
      '\n\n.. function:: other(value)\n\n   Outside declaration.\n\n' + '   Other only. '.repeat(100)
    const item = source({ text }); item.sections[0].format = 'txt'
    const service = createService(database, { chunkerOptions: { maxChunkBytes: 256 } })
    await service.index({ sources: [item], errors: [] })
    const seed = service.queryBoundDeclarationFallback({ q: 'wait条件是什么？', sourceType: 'document', sourceId: 1, limit: 10 }).data[0]
    database.close(); database = new Database(filename)
    const checks = { authoritativeVisibility: () => true, authoritativeActiveSnapshot: () => true }
    const baseline = await expandRagEvidenceContext({ database, evidence: [seed], checks })
    const args = { database, evidence: baseline, query: 'wait条件是什么？', source: { sourceType: 'document', sourceId: 1 }, checks }
    const expanded = await completeRagDeclarationContext(args)
    assert.ok(expanded.length > baseline.length)
    assert.deepEqual(expanded.slice(0, baseline.length), baseline)
    assert.ok(expanded.some(e => e.body.includes('Clause 8')))
    const firstAdded = expanded[baseline.length]
    assert.deepEqual(await completeRagDeclarationContext({ ...args,
      checks: { ...checks, authoritativeVisibility: e => e.chunkId !== firstAdded.chunkId } }), baseline,
    'a denied intermediate chunk must not be skipped to reach later clauses')
    assert.ok(expanded.length <= 16)
    assert.ok(expanded.reduce((n, e) => n + Buffer.byteLength(e.body), 0) <= 24576)
    for (const e of expanded) assert.equal(e.body, database.prepare('SELECT body FROM rag_chunks WHERE id=?').get(e.chunkId).body)
    const { default: express } = await import('express'), { default: http } = await import('node:http')
    process.env.DATA_PATH ??= os.tmpdir()
    const { createRagRouter, normalizeQueryBody } = await import('../src/routes/rag.js')
    assert.throws(() => normalizeQueryBody({ query: args.query, boundDeclarationContext: true }))
    for (const enabled of [false, true]) {
      let delivered
      const app = express()
      app.use(express.json(), (req, _res, next) => { req.user = { principal: 'owner', username: 'fixture' }; next() })
      app.use('/api/rag', createRagRouter({ databaseProvider: () => database, taskStoreProvider: () => null,
        boundDeclarationFallback: true, boundDeclarationContext: enabled,
        authoritativeChecksFactory: () => checks, structuredAnswerProvider: () => null,
        sourceStatusProvider: () => ({ sourceState: { status: 'ready' }, chunks: { count: expanded.length } }),
        textIndexServiceFactory: () => createService(database),
        queryRuntimeFactory: () => ({ query: () => ({ vectorCandidates: [] }) }),
        answerServiceFactory: () => ({ generate: async ({ evidence }) => { delivered = evidence; return { status: 'abstained', citations: [] } } }) }))
      const server = http.createServer(app)
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rag/queries`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: args.query, source: { type: 'document', id: 1 } }) })
        assert.equal(response.status, 200)
        assert.deepEqual(delivered.map(e => e.body), (enabled ? expanded : baseline).map(e => e.body))
        assert.ok(delivered.every(e => !('api_declarations_json' in e)))
      } finally { await new Promise(resolve => server.close(resolve)) }
    }
    for (const override of [
      { source: null }, { source: { sourceType: 'document', sourceId: 2 } }, { query: 'wait和other条件？' },
      { checks: { ...checks, authoritativeVisibility: () => false } },
      { checks: { ...checks, authoritativeActiveSnapshot: () => false } }
    ]) assert.deepEqual(await completeRagDeclarationContext({ ...args, ...override }), baseline)
    const row = database.prepare('SELECT api_declarations_json FROM rag_chunks WHERE id=?').get(seed.chunkId)
    for (const field of ['boundsVersion', 'snapshotId', 'sourceHash', 'chunkHash', 'chunkerVersion', 'chunkerConfigHash']) {
      const bad = JSON.parse(row.api_declarations_json); bad[field] = 'invalid'
      database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(JSON.stringify(bad), seed.chunkId)
      assert.deepEqual(await completeRagDeclarationContext(args), baseline, field)
    }
    for (const value of [null, '{}', '{broken']) {
      database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(value, seed.chunkId)
      assert.deepEqual(await completeRagDeclarationContext(args), baseline)
    }
    database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(row.api_declarations_json, seed.chunkId)
    const full = [...baseline, ...Array.from({ length: 16 - baseline.length }, (_, i) => ({ ...seed, chunkId: -i - 1, body: 'reserved' }))]
    assert.deepEqual(await completeRagDeclarationContext({ ...args, evidence: full }), full)
    const large = [...baseline, { ...seed, chunkId: -1, body: 'x'.repeat(24576) }]
    assert.deepEqual(await completeRagDeclarationContext({ ...args, evidence: large }), large)
    await createService(database).index({ sources: [source({ version: 2, text: 'Replacement has no declaration.' })], errors: [] })
    assert.deepEqual(await completeRagDeclarationContext(args), baseline, 'SQL active snapshot must reject even if callback permits')
  } finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('declaration provenance persists, rejects examples and binds snapshot and chunk configuration', nativeTestOptions, async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-declarations-'))
  const filename = path.join(dir, 'index.sqlite')
  let database = new Database(filename)
  let allowed = true
  const make = (id, text) => { const item = source({ id, text }); item.sections[0].format = 'txt'; return item }
  const real = '.. module:: alpha\n\n.. function:: wait(delay)\n\n   Returns elapsed time.'
  let sources = [make(1, real), make(2, real.replace('alpha', 'beta').replace('elapsed time', 'an event')),
    make(3, '.. module:: examples\n\nExample::\n\n   .. function:: wait(delay)\n\n      Not a real API.'),
    make(4, real + '\n\n.. module:: beta\n\n.. function:: wait(delay)\n\n   Other module.')]
  const service = () => createService(database, { authoritativeVisibility: () => allowed, collectSources: async () => ({ sources, errors: [] }) })
  const query = { q: 'wait返回什么？', sourceType: 'document', sourceId: 1, limit: 10 }
  try {
    migrate(database)
    await service().refresh()
    const expected = service().queryBoundDeclarationFallback(query)
    assert.equal(expected.data.length, 1)
    const { default: express } = await import('express')
    const { default: http } = await import('node:http')
    process.env.DATA_PATH ??= os.tmpdir()
    const { createRagRouter } = await import('../src/routes/rag.js')
    for (const enabled of [false, true]) {
      let delivered
      const app = express()
      app.use(express.json(), (req, _res, next) => { req.user = { principal: 'owner', username: 'fixture' }; next() })
      app.use('/api/rag', createRagRouter({ databaseProvider: () => database, taskStoreProvider: () => null,
        boundDeclarationFallback: enabled, authoritativeChecksFactory: () => ({
          authoritativeVisibility: () => allowed, authoritativeActiveSnapshot: () => true }),
        sourceStatusProvider: () => ({ sourceState: { status: 'ready' }, chunks: { count: 1 } }),
        structuredAnswerProvider: () => null, textIndexServiceFactory: service,
        queryRuntimeFactory: () => ({ query: () => ({ vectorCandidates: [] }) }),
        answerServiceFactory: () => ({ generate: async ({ evidence }) => { delivered = evidence; return { status: 'abstained', citations: [] } } }) }))
      const server = http.createServer(app)
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rag/queries`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: query.q, source: { type: 'document', id: 1 } }) })
        assert.equal(response.status, 200)
        assert.equal(delivered?.length ?? 0, enabled ? 1 : 0)
        if (enabled) { assert.equal(delivered[0].body, expected.data[0].body); assert.equal('api_declarations_json' in delivered[0], false) }
      } finally { await new Promise(resolve => server.close(resolve)) }
    }
    assert.equal(service().queryBoundDeclarationFallback({ ...query, sourceId: 2 }).data[0].sourceId, 2)
    for (const sourceId of [3, 4]) assert.equal(service().queryBoundDeclarationFallback({ ...query, sourceId }), null)
    database.close(); database = new Database(filename)
    assert.deepEqual(service().queryBoundDeclarationFallback(query), expected)
    const row = database.prepare('SELECT id, api_declarations_json FROM rag_chunks WHERE id=?').get(expected.data[0].chunkId)
    for (const field of ['version', 'snapshotId', 'sourceHash', 'chunkHash', 'chunkerVersion', 'chunkerConfigHash']) {
      const bad = JSON.parse(row.api_declarations_json); bad[field] = 'invalid'
      database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(JSON.stringify(bad), row.id)
      assert.equal(service().queryBoundDeclarationFallback(query), null, field)
    }
    for (const value of [null, '{broken']) {
      database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(value, row.id)
      assert.equal(service().queryBoundDeclarationFallback(query), null)
    }
    database.prepare('UPDATE rag_chunks SET api_declarations_json=NULL WHERE id=?').run(row.id)
    await service().refresh()
    assert.equal(service().queryBoundDeclarationFallback(query), null, 'legacy metadata is not guessed or silently backfilled')
    database.prepare('UPDATE rag_chunks SET api_declarations_json=? WHERE id=?').run(row.api_declarations_json, row.id)
    for (const extra of [{ chunkIds: [999999] }, { offset: 1 }, { limit: 51 }, { sourceId: undefined }, { q: 'wait和poll返回什么？' }]) {
      assert.equal(service().queryBoundDeclarationFallback({ ...query, ...extra }), null)
    }
    allowed = false; assert.equal(service().queryBoundDeclarationFallback(query), null); allowed = true
    sources = [make(1, '.. module:: alpha\n\nNo declaration in the replacement.')]
    await service().refresh()
    assert.equal(service().queryBoundDeclarationFallback(query), null)
    assert.notEqual(database.prepare('SELECT active_snapshot_id AS id FROM rag_source_state WHERE source_id=1').get().id, expected.data[0].snapshotId)
  } finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('comparison identifiers require two or three exact technical objects in the whole question', () => {
  assert.deepEqual(boundRagComparisonIdentifiers('S_IMODE和S_IFMT有什么不同？'), ['S_IMODE', 'S_IFMT'])
  assert.deepEqual(boundRagComparisonIdentifiers('FirstObject和SecondObject与ThirdObject？'), ['FirstObject', 'SecondObject', 'ThirdObject'])
  for (const q of ['S_IMODE如何？', 'S_IMODE and S_IFMT', 'S_IMODE和S_IFMT等待20秒？',
    'S_IMODE和plain比较？', 'Ｓ_IMODE和S_IFMT？', 'FirstObject和SecondObject与ThirdObject' + '中文'.repeat(80) + 'FourthObject']) {
    assert.equal(boundRagComparisonIdentifiers(q), null)
  }
})

test('comparison fallback requires every body object within authorized active scope', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    let allowed = true
    const index = createService(database, { authoritativeVisibility: () => allowed,
      collectSources: async () => ({ sources: [
        source({ id: 1, title: 'MissingObject', text:
          '# First section\n\nFirstObject uses seconds.\n\n# Second section\n\nSecondObject requires supported systems.\n\n# Third section\n\nThirdObject is optional.' }),
        source({ id: 2, text: 'FirstObject_EXTRA and SecondObject are unrelated names.' })
      ], errors: [] }) })
    await index.refresh()
    const input = { q: 'FirstObject与SecondObject有何条件？', sourceType: 'document', sourceId: 1, limit: 10 }
    assert.equal(index.query(input).data.length, 0)
    assert.equal(index.queryBoundIdentifierFallback(input), null)
    const result = index.queryBoundComparisonFallback(input)
    assert.equal(result.data.length, 2)
    assert.ok(result.data.every(entry => entry.sourceId === 1))
    assert.ok(result.data.some(entry => /requires supported systems/.test(entry.body)))
    assert.equal(index.queryBoundComparisonFallback({ ...input, q: 'FirstObject与SecondObject及ThirdObject？' }).data.length, 3)
    // Actual HTTP -> SQLite -> selection -> expansion delivery, not a pool stub.
    const { default: express } = await import('express')
    const { default: http } = await import('node:http')
    process.env.DATA_PATH ??= (await import('node:os')).tmpdir()
    const { createRagRouter } = await import('../src/routes/rag.js')
    for (const enabled of [false, true]) {
      let delivered
      const app = express()
      app.use(express.json(), (req, _res, next) => { req.user = { principal: 'owner', username: 'fixture' }; next() })
      app.use('/api/rag', createRagRouter({ databaseProvider: () => database, taskStoreProvider: () => null,
        boundComparisonFallback: enabled, boundIdentifierFallback: true,
        authoritativeChecksFactory: () => ({ authoritativeVisibility: () => allowed, authoritativeActiveSnapshot: () => true }),
        sourceStatusProvider: () => ({ sourceState: { status: 'ready' }, chunks: { count: 3 } }),
        structuredAnswerProvider: () => null, textIndexServiceFactory: () => index,
        queryRuntimeFactory: () => ({ query: () => ({ vectorCandidates: [] }) }),
        answerServiceFactory: () => ({ generate: async ({ evidence }) => {
          delivered = evidence; return { status: 'abstained', citations: [] }
        } }) }))
      const server = http.createServer(app)
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rag/queries`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: input.q, source: { type: 'document', id: 1 } })
        })
        assert.equal(response.status, 200)
        assert.equal(delivered?.length ?? 0, enabled ? 2 : 0, JSON.stringify({ enabled, delivered, pool: result.data }))
        if (enabled) assert.deepEqual(delivered.map(entry => entry.body).sort(), result.data.map(entry => entry.body).sort())
      } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    }
    for (const overrides of [{ sourceId: 2 }, { chunkIds: [999999] }, { q: 'FirstObject与MissingObject？' },
      { sourceId: undefined, sourceType: undefined }, { offset: 1 }, { limit: 51 }]) {
      assert.equal(index.queryBoundComparisonFallback({ ...input, ...overrides }), null)
    }
    allowed = false
    assert.equal(index.queryBoundComparisonFallback(input), null)
    allowed = true
    assert.deepEqual(index.queryBoundComparisonFallback(input), result)
    database.prepare('UPDATE rag_source_state SET active_snapshot_id = NULL WHERE source_id = 1').run()
    assert.equal(index.queryBoundComparisonFallback(input), null)
  } finally { database.close() }
})

test('bound identifier fallback is narrow and inspects objects beyond the FTS term budget', () => {
  for (const value of ['S_IMODE返回哪些位？', 'QuantumWidget有什么条件？']) assert.ok(boundRagIdentifier(value))
  for (const value of ['plain有什么条件？', 'S_IMODE S_IFMT有什么区别？', 'S_IMODE', 'S_IMODE保证20毫秒？',
    'Ｓ_IMODE有什么条件？', 'S_IMODE' + '中文条件'.repeat(80) + 'OtherObject']) assert.equal(boundRagIdentifier(value), null)
})

test('bound identifier retry preserves body support, source, chapter and visibility boundaries', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    let allowed = true
    const index = createService(database, { authoritativeVisibility: () => allowed,
      collectSources: async () => ({ sources: [
        source({ id: 1, title: 'OtherObject', text: 'S_IMODE returns permission bits on supported systems.' }),
        source({ id: 2, text: 'OtherObject belongs only to the second source.' })
      ], errors: [] }) })
    await index.refresh()
    const input = { q: 'S_IMODE返回哪些位？', sourceType: 'document', sourceId: 1, limit: 10 }
    assert.equal(index.query(input).data.length, 0)
    const hits = index.queryBoundIdentifierFallback(input).data
    assert.equal(hits.length, 1); assert.equal(hits[0].sourceId, 1)
    assert.match(hits[0].body, /supported systems/)
    assert.equal(index.queryBoundIdentifierFallback({ ...input, q: 'OtherObject有什么条件？' }).data.length, 0)
    assert.equal(index.queryBoundIdentifierFallback({ ...input, sourceId: 2 }).data.length, 0)
    assert.equal(index.queryBoundIdentifierFallback({ ...input, chunkIds: [999999] }).data.length, 0)
    assert.equal(index.queryBoundIdentifierFallback({ q: input.q, limit: 10 }), null)
    assert.equal(index.queryBoundIdentifierFallback({ ...input, q: 'ordinary有什么条件？' }), null)
    allowed = false
    assert.equal(index.queryBoundIdentifierFallback(input).data.length, 0)
    allowed = true
    database.prepare('UPDATE rag_source_state SET active_snapshot_id = NULL WHERE source_id = 1').run()
    assert.equal(index.queryBoundIdentifierFallback(input).data.length, 0)
  } finally { database.close() }
})

test('actual chunk line numbers in separate ebook chapters survive both evidence selectors', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const book = { ...source({ id: 1 }), sourceType: 'ebook',
      baseLocator: { route: '/books', bookId: 1 },
      sections: [0, 1].map(chapterIndex => ({ format: 'ebook', sectionPath: ['Rules'],
        locator: { route: '/books', bookId: 1, chapterIndex },
        text: chapterIndex === 0 ? 'Admissionpolicy: adults may enter with a ticket.'
          : 'Admissionpolicy: children must be accompanied by an adult.' })) }
    const index = createService(database, { collectSources: async () => ({ sources: [book], errors: [] }) })
    await index.refresh()
    const pool = index.query({ q: 'Admissionpolicy', limit: 10 }).data
    assert.equal(pool.length, 2)
    assert.deepEqual(pool.map(c => c.locator.startLine), [1, 1])
    const checks = { authoritativeActiveSnapshot: () => true, authoritativeVisibility: () => true }
    const selected = (await createRagHybridRetriever({ ...checks }).retrieve({ ftsCandidates: pool,
      vectorCandidates: [], limit: 10 })).data
    assert.equal(selected.length, 2)
    const reranked = selectGlobalRerankedEvidence({ pool: selected, ranked: [...selected].reverse() })
    assert.equal(reranked.length, 2)
    const expanded = await expandRagEvidenceContext({ database, evidence: reranked, checks })
    assert.equal(expanded.length, 2)
    const service = createRagAnswerService({ ...checks,
      model: { provider: 'local-test', modelId: 'answer-model', modelRevision: 'revision-1', dimensions: 32,
        configHash: 'a'.repeat(64) }, taskStore: { enqueue: task => ({ ...task, id: 1, status: 'queued' }) } })
    const queued = await service.generate({ query: 'What is the admissionpolicy for adults and children?', evidence: expanded })
    assert.equal(queued.task.input.evidence.length, 2)
    assert.match(JSON.stringify(queued.task.input.evidence), /accompanied by an adult/)
    assert.deepEqual(new Set(expanded.map(c => c.locator.chapterIndex)), new Set([0, 1]))
  } finally { database.close() }
})

test('actual FTS and neighbor evidence retain distinct book identity for equal chapter titles', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    database.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO books VALUES (1, 'Garden Handbook'), (2, 'Library Handbook')")
    const sources = [1, 2].map(id => ({ ...source({ id }), sourceType: 'ebook',
      title: id === 1 ? 'Garden Handbook' : 'Library Handbook',
      baseLocator: { route: '/books', bookId: id },
      sections: [{ format: 'ebook', title: 'Introduction', sectionPath: ['Introduction'],
        locator: { route: '/books', bookId: id, chapterIndex: 0 }, text: `sharedkeyword rules for source ${id}` }] }))
    const index = createService(database, { collectSources: async () => ({ sources, errors: [] }) })
    await index.refresh()
    const hits = index.query({ q: 'sharedkeyword', limit: 10 }).data
    assert.equal(hits.length, 2)
    assert.deepEqual(hits.map(hit => hit.title), ['Introduction', 'Introduction'])
    const checks = { authoritativeActiveSnapshot: () => true, authoritativeVisibility: () => true }
    const expanded = await expandRagEvidenceContext({ database, evidence: hits, checks })
    const labeled = await attachRagSourceTitles({ database, evidence: expanded, checks })
    assert.deepEqual(labeled.map(item => item.title), ['Garden Handbook', 'Library Handbook'])
    assert.deepEqual(labeled.map(({ title, ...item }) => item), expanded.map(({ title, ...item }) => item))
    const service = createRagAnswerService({ ...checks, config: { includeSourceTitles: true },
      model: { provider: 'local-test', modelId: 'answer-model', modelRevision: 'revision-1', dimensions: 32,
        inputLimit: 4096, distance: 'cosine', normalization: 'l2', instruction: 'answer from evidence', configHash: 'a'.repeat(64) },
      workerAvailable: () => true, taskStore: { enqueue: async task => ({ ...task, id: 1, status: 'queued' }) } })
    const result = await service.generate({ query: 'What are the rules?', evidence: labeled })
    const payload = JSON.stringify(result.task)
    assert.match(payload, /Garden Handbook/)
    assert.match(payload, /Library Handbook/)
    assert.doesNotMatch(payload, /Source title[^\n]*Introduction/)
  } finally { database.close() }
})

test('translated FTS accepts the complete protocol length without losing source scope', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database, { collectSources: async () => ({
      sources: [source({ id: 1, text: 'alpha beta' }), source({ id: 2, text: 'alpha beta' })], errors: []
    }) })
    await service.refresh()
    for (const length of [256, 257, 310, 1024]) {
      const translated = `alpha beta ${'x'.repeat(length - 11)}`
      assert.equal(translated.length, length)
      const provider = createTranslatedCandidateProvider({
        translationService: { translate: async () => ({ status: 'enhanced', queries: ['原问题', translated] }) },
        candidateProvider: async ({ query, source }) => ({ ftsCandidates: service.query({ q: query, ...source, limit: 50 }).data })
      })
      const result = await provider({ query: '原问题', source: { sourceType: 'document', sourceId: 1 } })
      assert.equal(result.ftsCandidates.length, 1, `translation length ${length} must not silently fail open`)
      assert.equal(result.ftsCandidates[0].sourceId, 1)
      assert.equal(result.ftsCandidates[0].body, 'alpha beta')
    }
    for (const q of ['x'.repeat(1025), 'ﬃ'.repeat(342)]) {
      assert.throws(() => service.query({ q }), { code: RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID })
    }
    assert.equal(ragQueryTerms(Array.from({ length: 100 }, (_, i) => `term${i}`).join(' ')).length, 64)
  } finally { database.close() }
})

test('FTS finds a word spanning the former deferred byte cut without changing scope or evidence', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const body = `${'alpha '.repeat(255)}improving distinct_identifier`
    const service = createService(database, { collectSources: async () => ({ sources: [source({ text: body })], errors: [] }) })
    await service.refresh()
    const hits = service.query({ q: 'improving', sourceType: 'document', sourceId: 1 }).data
    assert.equal(hits.length, 1)
    assert.match(hits[0].body, /improving distinct_identifier/u)
    assert.ok(body.includes(hits[0].body))
    assert.equal(service.query({ q: 'improving', sourceType: 'document', sourceId: 2 }).data.length, 0)
    assert.equal(service.query({ q: 'notpresentlexeme' }).data.length, 0)
  } finally { database.close() }
})

test('chapter scope never accepts empty or client-shaped chunk filters', () => {
  assert.equal(normalizeRagChunkScope(undefined), undefined)
  assert.deepEqual(normalizeRagChunkScope([2, 2, 3]), [2, 3])
  for (const value of [null, [], ['2'], [0], {}, [-1]]) assert.throws(() => normalizeRagChunkScope(value))
})

test('indexed ebook chapters scope FTS before limit, isolate books and expire with snapshots', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    database.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, file_type TEXT); INSERT INTO books VALUES (1, 'epub'), (2, 'txt')")
    const ebook = id => ({ ...source({ id }), sourceType: 'ebook', sourceVersionId: 'book-v1',
      baseLocator: { route: '/books', bookId: id },
      sections: [0, 1].map(index => ({ format: 'ebook', title: `Chapter ${index + 1}`,
        sectionPath: [`Chapter ${index + 1}`],
        locator: { route: '/books', bookId: id, chapterIndex: id === 1 ? index : 0 },
        text: `# Detail\n\nshared keyword ${index === 0 ? 'shared keyword shared keyword' : 'target'}` })) })
    const sources = [ebook(1), ebook(2)]
    const service = createService(database, { collectSources: async () => ({ sources, errors: [] }) })
    await service.refresh()
    const catalog = readRagChapterScope({ database, sourceId: 1 }).sections
    assert.equal(catalog.length, 2)
    assert.deepEqual(catalog.map(item => item.chapterIndex), [0, 1])
    assert.ok(catalog.every(item => /^[a-f0-9]{64}$/u.test(item.key) && !('chunkIds' in item)))
    const scope = readRagChapterScope({ database, sourceId: 1, section: catalog[1].key })
    const result = service.query({ q: 'shared keyword', sourceType: 'ebook', sourceId: 1, limit: 1, ...scope })
    assert.equal(result.data.length, 1)
    assert.match(result.data[0].body, /target/u)
    assert.equal(result.data[0].locator.chapterIndex, 1)
    assert.throws(() => readRagChapterScope({ database, sourceId: 2, section: catalog[1].key }), { code: 'RAG_SECTION_STALE' })
    const txt = readRagChapterScope({ database, sourceId: 2 }).sections
    assert.equal(txt.length, 2)
    assert.ok(txt.every(item => item.chapterIndex === null))
    sources[0].sourceContentSha256 = sha256('updated immutable input')
    sources[0].sourceVersionId = 'book-v2'
    await service.refresh()
    assert.throws(() => readRagChapterScope({ database, sourceId: 1, section: catalog[1].key }), { code: 'RAG_SECTION_STALE' })
    assert.notEqual(readRagChapterScope({ database, sourceId: 1 }).sections[1].key, catalog[1].key)
  } finally { database.close() }
})

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

test('internal rerank lexical fallback requires body support without changing ordinary search', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const item = source({ title: 'alpha beta', text: 'fixture' })
    item.sections = ['unrelated flowers', 'rare meaningful evidence', 'rare hidden evidence'].map((text, index) => ({
      ...item.sections[0], text, locator: { ...item.baseLocator, startLine: index * 10 + 1 }
    }))
    const service = createService(database, { collectSources: async () => ({ sources: [item, source({id:2,title:'alpha beta',text:'rare other source'})], errors: [] }),
      authoritativeVisibility: c => !c.body.includes('hidden') })
    await service.refresh()
    const query = { q: 'alpha beta rare missing', sourceType: 'document', sourceId: 1, limit: 50 }
    const before = service.query(query)
    assert.ok(before.data.some(c => c.body.includes('flowers')))
    const result = service.queryRerankPool(query)
    assert.equal(result.data.length, 1)
    assert.equal(result.data[0].body, 'rare meaningful evidence')
    assert.deepEqual(service.query({...query,bodyOnly:true,expandedRerankPool:true}), before)
    assert.equal(service.queryRerankPool({...query,chunkIds:[result.data[0].chunkId]}).total, 1)
    for (const patch of [{sourceId:undefined},{limit:51},{offset:1}]) assert.throws(() => service.queryRerankPool({...query,...patch}))
    assert.deepEqual(service.queryRerankPool({...query,q:'rare meaningful'}).data, service.query({...query,q:'rare meaningful'}).data)
  } finally { database.close() }
})

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

test('CJK projection finds mid-sentence words without leaking tokens into evidence or corrupting rebuilds', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database)
    const body = '我们需要先完成设备巡检再准备交接工作。Redis的TLS配置保持独立。'
    await service.index({ sources: [source({ text: body })], errors: [] })
    assert.equal(service.query({ q: '设备巡检' }).data[0].body, body)
    assert.equal(service.query({ q: 'Redis的TLS配置' }).data[0].body, body)
    assert.deepEqual(ragQueryTerms('设备巡检'), ['设备', '备巡', '巡检'])
    assert.deepEqual(ragQueryTerms('Redis的TLS配置'), ['Redis', '的', 'TLS', '配置'])
    assert.deepEqual(ragQueryTerms('Москва Αθήνα'), ['Москва', 'Αθήνα'])
    database.prepare("INSERT INTO rag_chunks_fts(rag_chunks_fts, rank) VALUES ('integrity-check', 1)").run()
    database.prepare("INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES ('rebuild')").run()
    assert.equal(service.query({ q: '设备巡检' }).total, 1)
    await service.refresh({ collected: { sources: [source({ text: body })], errors: [] }, rebuild: true })
    database.prepare("INSERT INTO rag_chunks_fts(rag_chunks_fts, rank) VALUES ('integrity-check', 1)").run()
    assert.equal(service.query({ q: '设备巡检' }).total, 1)
  } finally { database.close() }
})

test('EPUB neighbors with equal titles stay inside the extracted spine item', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database, { chunkerOptions: { maxChunkBytes: 128 } })
    const book = { ...source({ id: 41 }), sourceType: 'ebook',
      baseLocator: { route: '/books', bookId: 41 },
      sections: [
        { format: 'ebook', sectionPath: ['Rules'], locator: { route: '/books', bookId: 41, spineIndex: 3 },
          text: 'ScopeA adults must register. '.repeat(5) + '\n\nseedword children need adult supervision.' },
        { format: 'ebook', sectionPath: ['Rules'], locator: { route: '/books', bookId: 41, spineIndex: 5 },
          text: 'ScopeB children may enter alone.' }
      ] }
    await service.index({ sources: [book], errors: [] })
    const seed = service.query({ q: 'seedword' }).data[0]
    assert.equal(seed.locator.spineIndex, 3)
    const checks = { authoritativeVisibility: () => true, authoritativeActiveSnapshot: () => true }
    const expanded = await expandRagEvidenceContext({ database, evidence: [seed], checks })
    assert.ok(expanded.length > 1, 'same-spine neighbor must still expand')
    assert.ok(expanded.every(item => item.locator.spineIndex === 3), 'other spine item must not be borrowed')
    assert.ok(expanded.some(item => item.chunkId !== seed.chunkId && item.body.includes('register')))
    assert.ok(!expanded.some(item => item.body.includes('ScopeB')))
    const revoked = await expandRagEvidenceContext({ database, evidence: [seed],
      checks: { ...checks, authoritativeVisibility: item => item.chunkId === seed.chunkId } })
    assert.deepEqual(revoked.map(item => item.chunkId), [seed.chunkId])
  } finally { database.close() }
})

test('evidence expansion keeps individual authorized citations within the same section and snapshot', nativeTestOptions, async () => {
  const database = new Database(':memory:')
  try {
    migrate(database)
    const service = createService(database, { chunkerOptions: { maxChunkBytes: 128 } })
    await service.index({ sources: [source({ text: '# Same\n\n'+['alpha','seedword','omega'].map(w => (w+' ').repeat(18)).join('\n\n')+'\n\n# Boundary\n\nsecret boundary' })], errors: [] })
    const seed = service.query({ q: 'seedword' }).data[0]
    const checks = { authoritativeVisibility: () => true, authoritativeActiveSnapshot: () => true }
    const expanded = await expandRagEvidenceContext({ database, evidence: [seed], checks })
    assert.equal(expanded[0].chunkId, seed.chunkId)
    assert.ok(expanded.length > 1)
    assert.equal(new Set(expanded.map(c => c.chunkId)).size, expanded.length)
    for (const item of expanded) {
      assert.equal(item.body, database.prepare('SELECT body FROM rag_chunks WHERE id=?').get(item.chunkId).body)
      assert.deepEqual(item.locator.sectionPath, seed.locator.sectionPath)
      assert.equal(item.snapshotId, seed.snapshotId)
    }
    const onlySeed = await expandRagEvidenceContext({ database, evidence: [seed], checks: { ...checks, authoritativeVisibility: c => c.chunkId === seed.chunkId } })
    assert.deepEqual(onlySeed.map(c => c.chunkId), [seed.chunkId])
    assert.deepEqual(await expandRagEvidenceContext({ database, evidence: [seed], checks: { ...checks, authoritativeActiveSnapshot: () => false } }), [])
    const large = { ...seed, body: 'X'.repeat(25 * 1024) }
    assert.deepEqual(await expandRagEvidenceContext({ database, evidence: [large], checks }), [])
  } finally { database.close() }
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
