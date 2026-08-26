import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RERANKER_EVALUATION_CONTRACT,
  createHttpReranker,
  createStdinReranker,
  normalizeRagRerankerEvaluationConfig,
  runRagRerankerEvaluation
} from '../scripts/rag-reranker-evaluation.js'

const querySet = [
  {
    id: 'q-exact',
    q: 'private query text must not be reported',
    category: 'exact_fact',
    expected: [{ targetId: 'target', locator: { documentId: 1 } }],
    forbidden: [],
    sourceTypes: ['document']
  }
]

function candidate(id, index, { target = false } = {}) {
  const text = target ? 'sensitive target passage must not appear in the report' : `distractor body ${index}`
  return {
    id,
    text,
    locator: { documentId: target ? 1 : index + 10 },
    hybridScore: 10 - index
  }
}

function candidateSets() {
  return [{
    queryId: 'q-exact',
    baselineLatencyMs: 10,
    candidates: [
      candidate('d-0', 0),
      candidate('d-1', 1),
      candidate('d-2', 2),
      candidate('d-3', 3),
      candidate('d-4', 4),
      candidate('target', 5, { target: true }),
      candidate('d-6', 6),
      candidate('d-7', 7),
      candidate('d-8', 8),
      candidate('d-9', 9)
    ]
  }]
}

test('evaluates the fixed top10 to top5 contract without reporting query or chunk text', async () => {
  const report = await runRagRerankerEvaluation({
    querySet,
    candidateSets: candidateSets(),
    reranker: async ({ candidates }) => ({
      model: RERANKER_EVALUATION_CONTRACT.modelId,
      revision: RERANKER_EVALUATION_CONTRACT.revision,
      scoreType: RERANKER_EVALUATION_CONTRACT.scoreType,
      scores: candidates.map((item, index) => ({ id: item.id, score: item.id === 'target' ? 100 : -index }))
    })
  })

  assert.equal(report.configuration.candidateLimit, 10)
  assert.equal(report.configuration.finalLimit, 5)
  assert.equal(report.configuration.maxLength, 512)
  assert.equal(report.configuration.scoreType, 'raw_logit')
  assert.match(report.configuration.modelIdentityHash, /^[a-f0-9]{64}$/u)
  assert.equal(report.input.candidateSetPreserved, true)
  assert.equal(report.baseline.recallAt5, 0)
  assert.equal(report.reranked.recallAt5, 1)
  assert.equal(report.comparison.gate.decision, 'continue_reranker')
  assert.ok(report.comparison.mrrGain >= 0.05)
  assert.equal(Array.isArray(report.details.baseline), true)
  assert.deepEqual(report.details.reranked[0].topIds.slice(0, 1), ['target'])
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /private query text/u)
  assert.doesNotMatch(serialized, /sensitive target passage/u)
  assert.doesNotMatch(serialized, /distractor body/u)
})

test('rejects a reranker response that drops or invents a candidate', async () => {
  await assert.rejects(
    runRagRerankerEvaluation({
      querySet,
      candidateSets: candidateSets(),
      baselineP95Ms: 10,
      reranker: async () => ({ scores: [{ id: 'unknown', score: 1 }] })
    }),
    (error) => error.code === 'RAG_RERANK_RESPONSE_INVALID'
  )
})

test('pins the model identity and HTTP request contract', async () => {
  const calls = []
  const reranker = createHttpReranker({
    baseUrl: 'http://127.0.0.1:19090',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({
          model: RERANKER_EVALUATION_CONTRACT.modelId,
          revision: RERANKER_EVALUATION_CONTRACT.revision,
          scoreType: RERANKER_EVALUATION_CONTRACT.scoreType,
          scores: candidateSets()[0].candidates.map((item, index) => ({ id: item.id, score: -index }))
        })
      }
    }
  })
  const report = await runRagRerankerEvaluation({
    querySet,
    candidateSets: candidateSets(),
    baselineP95Ms: 10,
    reranker
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:19090/rerank')
  assert.equal(calls[0].body.model, RERANKER_EVALUATION_CONTRACT.modelId)
  assert.equal(calls[0].body.revision, RERANKER_EVALUATION_CONTRACT.revision)
  assert.equal(calls[0].body.max_length, 512)
  assert.equal(calls[0].body.score_type, 'raw_logit')
  assert.equal(calls[0].body.return_documents, false)
  assert.equal(calls[0].body.documents[0].text, 'distractor body 0')
  assert.match(report.configuration.modelIdentityHash, /^[a-f0-9]{64}$/u)
})

test('supports a persistent stdin runner with one JSON request per line', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stage6c-reranker-runner-'))
  const runnerPath = path.join(directory, 'runner.mjs')
  await fs.writeFile(runnerPath, [
    "import { createInterface } from 'node:readline'",
    "const input = createInterface({ input: process.stdin })",
    "input.on('line', (line) => {",
    "  const request = JSON.parse(line)",
    "  const scores = request.documents.map((document, index) => ({ id: document.id, score: document.id === 'target' ? 100 : -index }))",
    "  process.stdout.write(`${JSON.stringify({ model: request.model, revision: request.revision, scoreType: request.score_type, scores })}\\n`)",
    '})'
  ].join('\n'), { mode: 0o600 })
  try {
    const reranker = createStdinReranker({ command: process.execPath, args: [runnerPath], timeoutMs: 5_000 })
    const report = await runRagRerankerEvaluation({
      querySet,
      candidateSets: candidateSets(),
      baselineP95Ms: 10,
      reranker
    })
    assert.equal(report.input.candidateSetPreserved, true)
    assert.deepEqual(report.details.reranked[0].topIds.slice(0, 1), ['target'])
    await reranker.close()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('rejects non-loopback HTTP endpoints and non-pinned configuration', () => {
  assert.throws(
    () => createHttpReranker({ baseUrl: 'http://example.com' }),
    (error) => error.code === 'RAG_RERANK_CONFIG_INVALID'
  )
  assert.throws(
    () => normalizeRagRerankerEvaluationConfig({
      modelId: 'other-model',
      querySet,
      candidateSets: candidateSets(),
      reranker: async () => []
    }),
    (error) => error.code === 'RAG_RERANK_CONFIG_INVALID'
  )
})

test('candidate text hashes are deterministic and bound to the payload', () => {
  const text = 'distractor body 0'
  assert.equal(crypto.createHash('sha256').update(text, 'utf8').digest('hex').length, 64)
  assert.throws(
    () => normalizeRagRerankerEvaluationConfig({
      querySet,
      candidateSets: [{ ...candidateSets()[0], candidates: [{ ...candidate('bad', 0), textHash: '0'.repeat(64) }] }],
      reranker: async () => []
    }),
    (error) => error.code === 'RAG_RERANK_INPUT_INVALID'
  )
})
