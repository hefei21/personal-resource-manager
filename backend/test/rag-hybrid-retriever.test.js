import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RAG_HYBRID_ERROR_CODES,
  citationIdForCandidate,
  createRagHybridRetriever,
  fuseRagCandidates
} from '../src/services/ragHybridRetriever.js'

function candidate({
  channel = 'fts',
  chunkId,
  sourceId = 1,
  sourceType = 'document',
  sourceVersionId = 'v1',
  snapshotId = 10,
  score = 1,
  startLine = 1,
  endLine = startLine,
  body = `body-${chunkId}`,
  title = `title-${chunkId}`,
  locator,
  ...extra
} = {}) {
  const baseLocator = locator ?? {
    route: sourceType === 'document' ? '/documents' : sourceType === 'ebook' ? '/books' : '/code',
    ...(sourceType === 'document' ? { documentId: sourceId } : sourceType === 'ebook' ? { bookId: sourceId } : { repositoryId: sourceId }),
    startLine,
    endLine
  }
  const base = {
    chunkId,
    snapshotId,
    sourceType,
    sourceId,
    sourceVersionId,
    score,
    ordinal: chunkId,
    locator: baseLocator,
    sourceContentSha256: `${String(chunkId).padStart(64, '0')}`,
    title,
    body
  }
  if (channel === 'vector') return { ...base, ...extra, payload: { ...base, ...extra } }
  return { ...base, ...extra }
}

test('fuses FTS and vector ranks with injected RRF weights and stable citation IDs', () => {
  const fts = [candidate({ chunkId: 1, score: 0.9 }), candidate({ chunkId: 2, score: 0.8 })]
  const vector = [candidate({ channel: 'vector', chunkId: 2, score: 0.99 }), candidate({ channel: 'vector', chunkId: 3, score: 0.98 })]
  const config = { rrfK: 1, ftsWeight: 1, vectorWeight: 2, maxPerSource: 10, minDistinctSources: 0 }
  const result = fuseRagCandidates({ ftsCandidates: fts, vectorCandidates: vector, config })
  assert.deepEqual(result.map((item) => item.chunkId), [2, 3, 1])
  assert.deepEqual(result[0].retrieval.channels, ['fts', 'vector'])
  assert.equal(result[0].citationId, citationIdForCandidate(fts[1]))
  assert.equal('payload' in result[0], false)
  assert.equal('vector' in result[0], false)

  const reversed = fuseRagCandidates({
    ftsCandidates: [...fts].reverse(),
    vectorCandidates: [...vector].reverse(),
    config
  })
  assert.deepEqual(reversed.map((item) => item.citationId), result.map((item) => item.citationId))
})

test('suppresses same-source adjacent/overlap chunks and preserves cross-source diversity', async () => {
  const retriever = createRagHybridRetriever({
    config: { maxPerSource: 2, minDistinctSources: 2, adjacentGap: 0, defaultLimit: 5 },
    authoritativeVisibility: () => true
  })
  const result = await retriever.retrieve({
    ftsCandidates: [
      candidate({ chunkId: 1, sourceId: 1, score: 1, startLine: 1, endLine: 3 }),
      candidate({ chunkId: 2, sourceId: 1, score: 0.99, startLine: 3, endLine: 5 }),
      candidate({ chunkId: 3, sourceId: 1, score: 0.8, startLine: 10, endLine: 12 }),
      candidate({ chunkId: 4, sourceId: 2, score: 0.2, startLine: 1, endLine: 2 })
    ],
    vectorCandidates: [],
    limit: 4
  })
  assert.equal(result.retrieval.mode, 'hybrid')
  assert.deepEqual(result.data.map((item) => item.chunkId), [1, 4, 3])
  assert.equal(result.data.some((item) => item.chunkId === 2), false)
})

test('applies authoritative active-snapshot and visibility checks before returning citations', async () => {
  const calls = []
  const retriever = createRagHybridRetriever({
    config: { maxPerSource: 5, minDistinctSources: 0 },
    authoritativeActiveSnapshot: (item) => {
      calls.push(`active:${item.chunkId}`)
      return item.snapshotId === 10
    },
    authoritativeVisibility: (item, context) => {
      calls.push(`${context.final ? 'final' : 'pre'}:${item.chunkId}`)
      return item.sourceId !== 99
    }
  })
  const result = await retriever.retrieve({
    ftsCandidates: [
      candidate({ chunkId: 1, snapshotId: 10, sourceId: 1 }),
      candidate({ chunkId: 2, snapshotId: 11, sourceId: 1 }),
      candidate({ chunkId: 3, snapshotId: 10, sourceId: 99 })
    ],
    vectorCandidates: [],
    limit: 10
  })
  assert.deepEqual(result.data.map((item) => item.chunkId), [1])
  assert.ok(calls.filter((value) => value.startsWith('final:')).length >= 1)
  assert.equal(result.data[0].locator.documentId, 1)
  assert.equal(result.data[0].citationId, 'rag:document:1:v1:10:1')
})

test('degrades to FTS for vector timeout and schema mismatch without exposing vector payload', async () => {
  const retriever = createRagHybridRetriever({ authoritativeVisibility: () => true })
  const ftsCandidates = [candidate({ chunkId: 1, score: 1 })]
  const timeout = await retriever.retrieve({ ftsCandidates, vectorCandidates: [], vectorError: { code: 'RAG_VECTOR_TIMEOUT' } })
  assert.equal(timeout.retrieval.mode, 'fts')
  assert.equal(timeout.retrieval.degraded, true)
  assert.equal(timeout.retrieval.degradedReason, 'vector_timeout')
  assert.equal(timeout.data[0].body, 'body-1')
  assert.equal('payload' in timeout.data[0], false)

  const malformedVector = { score: 0.9, payload: { chunkId: 2, snapshotId: 10 } }
  const schema = await retriever.retrieve({ ftsCandidates, vectorCandidates: [malformedVector] })
  assert.equal(schema.retrieval.mode, 'fts')
  assert.equal(schema.retrieval.degradedReason, 'vector_schema_mismatch')
})

test('rejects client-owned filters, weights and visibility scope controls', async () => {
  const retriever = createRagHybridRetriever({ authoritativeVisibility: () => true })
  await assert.rejects(
    retriever.retrieve({ ftsCandidates: [], vectorCandidates: [], filter: { sourceId: 1 } }),
    (error) => error.code === RAG_HYBRID_ERROR_CODES.CLIENT_CONTROL_FORBIDDEN
  )
  await assert.rejects(
    retriever.retrieve({ ftsCandidates: [], vectorCandidates: [], weights: { vector: 999 } }),
    (error) => error.code === RAG_HYBRID_ERROR_CODES.CLIENT_CONTROL_FORBIDDEN
  )
  const noCheck = createRagHybridRetriever()
  await assert.rejects(
    noCheck.retrieve({ ftsCandidates: [], vectorCandidates: [] }),
    (error) => error.code === RAG_HYBRID_ERROR_CODES.VISIBILITY_REQUIRED
  )
})

test('hydrates vector-only candidates through the authoritative resolver with exact locator', async () => {
  const retriever = createRagHybridRetriever({
    candidateResolver: (item) => ({
      locator: { route: '/documents', documentId: item.sourceId, startLine: 4, endLine: 5 },
      title: 'authoritative title'
    }),
    authoritativeVisibility: () => true
  })
  const vectorOnly = { ...candidate({ channel: 'vector', chunkId: 8, score: 0.9 }), locator: undefined }
  const result = await retriever.retrieve({
    ftsCandidates: [],
    vectorCandidates: [vectorOnly]
  })
  assert.equal(result.retrieval.mode, 'hybrid')
  assert.deepEqual(result.data[0].locator, { route: '/documents', documentId: 1, startLine: 4, endLine: 5 })
  assert.equal(result.data[0].title, 'authoritative title')
})
