import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslatedCandidateProvider } from '../src/services/ragTranslatedCandidateProvider.js'
const query = '原问题', english = 'Original question?'
const candidate = chunkId => ({ sourceType: 'ebook', sourceId: 1, snapshotId: 4, chunkId, score: 900 - chunkId })

test('internal global pool retains original and first translation vectors without widening normal or lexical pools', async () => {
  const calls = []
  const provider = createTranslatedCandidateProvider({
    translationService: { translate: async () => ({ status: 'enhanced', queries: [query, english, 'third'] }) },
    candidateProvider: async input => {
      calls.push(input)
      const offset = input.query === query ? 0 : input.query === english ? 50 : 100
      const data = Array.from({ length: 50 }, (_, i) => candidate(offset + i))
      return { ftsCandidates: data, vectorCandidates: data }
    } })
  const regular = await provider({ query })
  assert.equal(regular.vectorCandidates.length, 50)
  calls.length = 0
  const expanded = await provider({ query, globalRerankPool: true })
  assert.deepEqual(calls.map(c => c.query), [query, english])
  assert.equal(expanded.ftsCandidates.length, 50)
  assert.equal(expanded.vectorCandidates.length, 100)
  assert.deepEqual(expanded.vectorCandidates.slice(0,4).map(c => c.chunkId), [0,50,1,51])
})
test('original-first merge is bounded per channel and preserves scope, body and resolver', async () => {
  const seen = [], resolver = () => {}, source = { sourceType: 'ebook', sourceId: 1 }, chunkIds = [1, 2, 3]
  let translations = 0
  const provider = createTranslatedCandidateProvider({ maxCandidates: 3,
    translationService: { translate: async input => { translations++; assert.deepEqual(Object.keys(input).sort(), ['query', 'signal']);
      return { status: 'enhanced', queries: [query, english] } } },
    candidateProvider: async options => {
      seen.push(options)
      const ids = options.query === query ? [1, 2, 3] : [3, 4, 5]
      return { ftsCandidates: ids.map(candidate), vectorCandidates: ids.map(candidate), candidateResolver: resolver }
    } })
  const result = await provider({ query, source, chunkIds, limit: 1 })
  assert.deepEqual(result.ftsCandidates.map(c => c.chunkId), [1, 3, 2])
  assert.equal(result.vectorCandidates.length, 3)
  assert.equal(result.candidateResolver, resolver)
  assert.deepEqual(result.ftsCandidates.map(c => c.score), [1, 0.5, 1 / 3])
  assert.ok(seen.every(input => input.source === source && input.chunkIds === chunkIds && input.limit === 3))
  await provider({ query, source, chunkIds, expandedRerankPool: true })
  assert.equal(translations, 1)
})
test('disabled or failed translation leaves original query and limits unchanged', async () => {
  const output = { ftsCandidates: [candidate(1)], vectorError: { code: 'OFFLINE' } }
  for (const translationService of [null, { translate: async () => { throw new Error('offline') } }]) {
    const provider = createTranslatedCandidateProvider({ translationService,
      candidateProvider: async input => { assert.equal(input.query, query); assert.equal(input.limit, 7); return output } })
    assert.equal(await provider({ query, limit: 7 }), output)
  }
})
test('extra recall failure fails open but original recall failure is not concealed', async () => {
  const translationService = { translate: async () => ({ status: 'enhanced', queries: [query, english] }) }
  const original = { ftsCandidates: [candidate(1)], vectorError: { code: 'OFFLINE' } }
  const provider = createTranslatedCandidateProvider({ translationService, candidateProvider: async input => {
    if (input.query === english) throw new Error('extra failed')
    return original
  } })
  assert.equal(await provider({ query }), original)
  await assert.rejects(createTranslatedCandidateProvider({ translationService,
    candidateProvider: async () => { throw new Error('original failed') } })({ query }), /original failed/)
})
test('cancellation during translation starts no original fallback search', async () => {
  const controller = new AbortController()
  const provider = createTranslatedCandidateProvider({ signal: controller.signal,
    translationService: { translate: async () => { controller.abort(); throw controller.signal.reason } },
    candidateProvider: async () => { assert.fail('must not search') } })
  await assert.rejects(provider({ query }))
})
