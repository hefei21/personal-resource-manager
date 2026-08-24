import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runRagVectorHybridEvaluation } from '../scripts/rag-vector-hybrid-evaluation.js'

const corpus = JSON.parse(await fs.readFile(new URL('./fixtures/rag-evaluation-corpus.json', import.meta.url), 'utf8'))

function tokenizer() {
  return {
    encode(text) { return [...text].map((character) => character.codePointAt(0)) },
    decode(tokens) { return String.fromCodePoint(...tokens) }
  }
}

async function makeCorpusDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-vector-hybrid-'))
  const sources = []
  for (const source of corpus.publicSources) {
    const file = `${source.id}.txt`
    const body = Buffer.from(source.entry.body, 'utf8')
    await fs.writeFile(path.join(directory, file), body, { mode: 0o600 })
    sources.push({ id: source.id, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), file })
  }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sources }), { mode: 0o600 })
  return directory
}

function fakeFetchFactory() {
  const calls = []
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    calls.push({ url, body })
    const data = inputs.map((text, index) => {
      const digest = crypto.createHash('sha256').update(String(text), 'utf8').digest()
      return {
        object: 'embedding',
        index,
        embedding: [digest[0] / 255, digest[1] / 255, digest[2] / 255]
      }
    })
    return { ok: true, headers: new Headers(), json: async () => ({ model: body.model, data }) }
  }
  return { calls, fetchImpl }
}

function options(corpusDirectory, cachePath, fetchImpl, configHash = 'a'.repeat(64)) {
  return {
    corpusDirectory,
    cachePath,
    baseUrl: 'http://127.0.0.1:1234',
    modelId: 'test-embedding-model',
    revision: 'test-revision-1',
    dimensions: 3,
    batch: 4,
    docPrefix: 'doc: ',
    queryPrefix: 'query: ',
    configHash,
    tokenizer: tokenizer(),
    fetchImpl
  }
}

test('runs reproducible vector and RRF/weight evaluation with hash-bound cache', async () => {
  const directory = await makeCorpusDirectory()
  const cachePath = path.join(directory, 'vectors.json')
  try {
    const firstFetch = fakeFetchFactory()
    const first = await runRagVectorHybridEvaluation(options(directory, cachePath, firstFetch.fetchImpl))
    assert.equal(first.configuration.chunker.maxTokens, 768)
    assert.equal(first.configuration.chunker.overlapTokens, 96)
    assert.equal(first.configuration.modelId, 'test-embedding-model')
    assert.equal(first.configuration.revision, 'test-revision-1')
    assert.equal(first.configuration.docPrefix, 'doc: ')
    assert.equal(first.configuration.queryPrefix, 'query: ')
    assert.equal(first.modes.vector.answerableQueryCount, 51)
    assert.equal(first.modes.fts.answerableQueryCount, 51)
    assert.equal(first.modes.hybrid.length, 5)
    assert.ok(first.modes.vector.recallAt5 >= 0 && first.modes.vector.recallAt5 <= 1)
    assert.ok(first.modes.vector.p95Ms >= first.modes.vector.p50Ms)
    assert.ok(Object.hasOwn(first.modes.vector.byLanguage, 'en'))
    assert.ok(Object.hasOwn(first.modes.vector.byLanguage, 'zh'))
    assert.ok(Object.hasOwn(first.modes.vector.byCategory, 'cross_source_synthesis'))
    assert.ok(Object.hasOwn(first.modes.vector.byCategory, 'no_answer'))
    assert.ok(Number.isSafeInteger(first.modes.vector.forbiddenHits))
    assert.ok(first.cache.documentCalls > 0)
    assert.ok(first.cache.queryCalls > 0)
    assert.ok(firstFetch.calls.every((call) => call.url === 'http://127.0.0.1:1234/v1/embeddings'))
    assert.ok(firstFetch.calls.some((call) => (Array.isArray(call.body.input) ? call.body.input : [call.body.input]).some((text) => text.startsWith('doc: '))))
    assert.doesNotMatch(JSON.stringify(first), /HTTP is a stateless application/u)
    assert.doesNotMatch(JSON.stringify(first), /如何恢复索引/u)

    const secondFetch = fakeFetchFactory()
    const second = await runRagVectorHybridEvaluation(options(directory, cachePath, secondFetch.fetchImpl))
    assert.equal(second.cache.documentCalls, 0)
    assert.equal(second.cache.queryCalls, 0)
    assert.equal(second.cache.hits, first.corpus.chunkCount + 64)
    assert.equal(secondFetch.calls.length, 0)

    const staleFetch = fakeFetchFactory()
    const stale = await runRagVectorHybridEvaluation(options(directory, cachePath, staleFetch.fetchImpl, 'b'.repeat(64)))
    assert.ok(stale.cache.stale > 0)
    assert.ok(stale.cache.documentCalls > 0)
    assert.ok(stale.cache.queryCalls > 0)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('requires explicit model, dimensions, batch, and tokenizer configuration', async () => {
  const directory = await makeCorpusDirectory()
  try {
    await assert.rejects(
      runRagVectorHybridEvaluation({
        corpusDirectory: directory,
        baseUrl: 'http://127.0.0.1:1234',
        modelId: 'test-model',
        revision: 'revision',
        dimensions: 3,
        batch: 2
      }),
      (error) => error.code === 'RAG_EVAL_TOKENIZER_REQUIRED'
    )
    await fs.rm(path.join(directory, 'manifest.json'))
    await assert.rejects(
      runRagVectorHybridEvaluation({
        corpusDirectory: directory,
        baseUrl: 'http://127.0.0.1:1234',
        modelId: 'test-model',
        revision: 'revision',
        dimensions: 3,
        batch: 2,
        tokenizer: tokenizer(),
        fetchImpl: async () => { throw new Error('must not call') }
      }),
      (error) => error.code === 'RAG_EVAL_MANIFEST_INVALID'
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
