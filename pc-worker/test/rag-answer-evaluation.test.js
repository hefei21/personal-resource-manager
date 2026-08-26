import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatRagAnswerEvaluationHelp,
  loadRagAnswerEvaluationFixtures,
  normalizeRagAnswerEvaluationConfig,
  parseRagAnswerEvaluationArgs,
  runRagAnswerEvaluation
} from '../scripts/rag-answer-evaluation.js'

function response(output) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] })
  }
}

test('answer ground truth covers the fixed 64-query category contract', async () => {
  const fixtures = await loadRagAnswerEvaluationFixtures({ modelId: 'test-model', modelRevision: 'test-revision' })
  assert.equal(fixtures.queries.length, 64)
  assert.equal(Object.keys(fixtures.groundTruth.cases).length, 64)
  assert.deepEqual(
    Object.fromEntries(Object.entries(fixtures.queries.reduce((counts, query) => {
      counts[query.category] = (counts[query.category] ?? 0) + 1
      return counts
    }, {})).sort()),
    {
      cross_source_synthesis: 8,
      exact_fact: 24,
      no_answer: 6,
      same_source_synthesis: 10,
      security: 10,
      version_conflict: 6
    }
  )
  const cases = fixtures.groundTruth.cases
  assert.deepEqual(cases['exact-http-stateless'].keyPoints.map((point) => point.id), ['protocol'])
  assert.deepEqual(cases['exact-alice-watch'].keyPoints.map((point) => point.id), ['waistcoat_pocket'])
  assert.deepEqual(cases['exact-pride-netherfield'].keyPoints.map((point) => point.id), ['tenant'])
  assert.deepEqual(cases['exact-vue-progressive'].keyPoints.map((point) => point.id), ['project'])
  assert.deepEqual(cases['exact-express-minimal'].keyPoints.map((point) => point.id), ['project'])
  assert.deepEqual(cases['exact-qdrant-engine'].keyPoints.map((point) => point.id), ['project'])
  assert.equal(cases['exact-alice-watch'].keyPoints[0].anyOf.includes('watch'), false)
  assert.equal(cases['exact-http-stateless'].keyPoints[0].anyOf.includes('stateless'), false)
  assert.equal(cases['security-trash-phrase'].mustAbstain, true)
  assert.equal(cases['no-answer-password'].mustAbstain, true)
})

test('evaluation scores a fake grounded answer, conflict answer, security answer, and no-answer without exposing text', async () => {
  const calls = []
  const report = await runRagAnswerEvaluation({
    ids: ['exact-http-stateless', 'version-active-schedule', 'security-injection-visible', 'no-answer-kubernetes'],
    modelId: 'test-answer-model',
    modelRevision: 'test-revision',
    timeoutMs: 1_000,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      const user = JSON.parse(body.messages[1].content)
      calls.push({ url, body, user })
      if (user.query.includes('Kubernetes')) return response({ abstained: true, reasonCode: 'NO_EVIDENCE', citations: [] })
      if (user.query.includes('Orchid')) return response({ answer: 'Backups run every day at 03:30.', abstained: false, citations: ['C1'] })
      if (user.query.includes('marigold')) return response({ answer: 'The harmless verification word is marigold.', abstained: false, citations: ['C1'] })
      return response({ answer: 'HTTP is a stateless application-level protocol.', abstained: false, citations: ['C1'] })
    }
  })
  assert.equal(calls.length, 4)
  assert.equal(report.dataset.queryCount, 4)
  assert.equal(report.metrics.errors.total, 0)
  assert.equal(report.metrics.groundedClaimRate.rate, 1)
  assert.equal(report.metrics.noAnswerAbstention.rate, 1)
  assert.equal(report.metrics.conflictPass.rate, 1)
  assert.equal(report.metrics.securityPass.rate, 1)
  assert.equal(report.metrics.citationPrecision.rate, 1)
  assert.equal(report.metrics.citationRecall.rate, 1)
  assert.doesNotMatch(JSON.stringify(report), /HTTP is a stateless|Kubernetes|marigold|Orchid/u)
  assert.ok(calls.every((call) => call.url.endsWith('/v1/chat/completions')))
})

test('CLI parsing and configuration keep model identity explicit', () => {
  const parsed = parseRagAnswerEvaluationArgs(['--model-id', 'qwen-test', '--revision', 'q6', '--ids', 'a,b', '--limit', '2'])
  assert.deepEqual(parsed, { modelId: 'qwen-test', modelRevision: 'q6', ids: 'a,b', limit: '2' })
  assert.deepEqual(parseRagAnswerEvaluationArgs(['--help']), { help: true })
  assert.match(formatRagAnswerEvaluationHelp(), /--model-id/u)
  const config = normalizeRagAnswerEvaluationConfig({ ...parsed, modelId: 'qwen-test', modelRevision: 'q6' })
  assert.equal(config.modelId, 'qwen-test')
  assert.equal(config.modelRevision, 'q6')
  assert.equal(config.ids.length, 2)
})
