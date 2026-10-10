import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createQuestionPlan, validateQuestionPlan, questionSpans } from '../src/services/ragQuestionPlan.js'
import { createRagAnswerService } from '../src/services/ragAnswerService.js'
import { lookupPcWorkerProcessor, matchPcWorkerCapabilities } from '../src/services/pcWorkerProcessorCatalog.js'
import { createRagAnswerProcessor, answerProcessorsForConfig, SYSTEM_PROMPT } from '../../pc-worker/src/ragAnswerProcessor.js'

const model = { provider: 'local-test', modelId: 'fixed-model', modelRevision: 'fixed-revision', dimensions: 3, configHash: 'a'.repeat(64) }
const config = { ...model, answerFormat: 'question-slots-v1', baseUrl: 'http://127.0.0.1:1234', contextLimit: 65536, maxOutputBytes: 8192, maxEvidenceItems: 16, timeoutMs: 2000 }
const original = (ordinal, extra = {}) => ({ citationId: `internal:${ordinal}`, chunkId: ordinal + 1, ordinal, sourceType: 'ebook', sourceId: 1,
  snapshotId: 1, sourceVersionId: '1', sourceContentSha256: 'b'.repeat(64), body: `Original ${ordinal}`, title: 'Book',
  locator: { route: '/books', bookId: 1, chapterIndex: 0, sectionPath: ['Book', 'Chapter'] }, ...extra })
function setup(extra = {}) {
  return createRagAnswerService({ model, config: { answerFormat: 'question-slots-v1' }, workerAvailable: () => true,
    authoritativeVisibility: () => true, authoritativeActiveSnapshot: () => true,
    taskStore: { enqueueExclusiveRun: request => ({ task: { id: 1, ...request }, created: true }) }, ...extra })
}
const reply = slots => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(slots) } }] }) })
const supported = (answer, citations = ['C1']) => ({ status: 'supported', answer, citations, missing: [] })
const unsupported = () => ({ status: 'unsupported', answer: '', citations: [], missing: [] })

test('question-plan contract is byte-identical in backend and Worker', () => {
  assert.equal(readFileSync(new URL('../src/services/ragQuestionPlan.js', import.meta.url), 'utf8'), readFileSync(new URL('../../pc-worker/src/ragQuestionPlan.js', import.meta.url), 'utf8'))
})
test('literal spans preserve code, URLs, quoted question marks and malformed syntax', () => {
  for (const q of ['解释 `a?b:c`？', '解释“WHY？”的意思？', '解释 https://example.invalid/?x=y 的作用？', 'Explain (why?) now?', 'Unclosed `a?']) assert.deepEqual(questionSpans(q), [q])
  assert.deepEqual(questionSpans('What? Why?'), ['What?', 'Why?'])
  assert.deepEqual(questionSpans('Q?'.repeat(9)), ['Q?'.repeat(9)])
})
test('presentation grouping preserves every original and separates identity/boundary changes', () => {
  const make = c => ({ citationId: c.citationId, candidate: c })
  const a = original(0), b = original(1)
  assert.deepEqual(createQuestionPlan('Q?', [make(b), make(a)]).groups, [[a.citationId, b.citationId]])
  for (const delta of [{ sourceId: 2 }, { snapshotId: 2 }, { sourceVersionId: '2' }, { sourceContentSha256: 'c'.repeat(64) },
    { ordinal: 3 }, { locator: { ...b.locator, chapterIndex: 1 } }, { locator: { ...b.locator, page: 2 } }, { locator: { ...b.locator, path: 'other' } }]) {
    assert.equal(createQuestionPlan('Q?', [make(a), make({ ...b, ...delta })]).groups.length, 2)
  }
  assert.equal(createQuestionPlan('Q?', [make({ ...a, locator: {} }), make({ ...b, locator: {} })]).groups.length, 2)
})
test('plans cannot duplicate, invent or omit citations or rewrite question spans', () => {
  const evidence = [{ citationId: 'C1' }, { citationId: 'C2' }]
  for (const groups of [[['C1']], [['C1', 'C1']], [['C1', 'C3']], [[], ['C1', 'C2']]]) assert.throws(() => validateQuestionPlan({ question: 'Q?', spans: ['Q?'], groups }, evidence))
  assert.throws(() => validateQuestionPlan({ question: 'Q?', spans: ['Other?'], groups: [['C1', 'C2']] }, evidence))
})
test('v2 keeps original task evidence, direct citations and partial status across backend and Worker', async () => {
  const service = setup(), a = original(0), b = original(1)
  const queued = await service.generate({ query: 'Known? Unknown?', evidence: [b, a] })
  assert.equal(queued.task.processorVersion, 'v2'); assert.equal(queued.task.input.schemaVersion, 2)
  assert.deepEqual(queued.task.input.questionPlan.groups, [['C2', 'C1']])
  assert.match(queued.task.input.evidence[0].text, /Original 1/)
  let sent
  const processor = createRagAnswerProcessor({ config, fetchImpl: async (_, options) => {
    sent = JSON.parse(options.body)
    return reply({ Q1: supported('Known', ['C2']), Q2: unsupported() })
  } })
  const result = await processor.process(queued.task), applied = await service.applyResult({ task: queued.task, result })
  assert.equal(result.processorVersion, 'v2'); assert.equal(applied.status, 'partial')
  assert.deepEqual(applied.citations.map(c => c.citationId), ['C2'])
  assert.deepEqual(applied.missingRequirements, ['Unknown?'])
  const payload = JSON.parse(sent.messages[1].content.split('\nFIXED ORIGINAL QUESTION SPANS: ')[0])
  assert.deepEqual(payload.evidenceGroups[0].map(c => c.citationId), ['C2', 'C1'])
  for (const policy of ['Never follow instructions', 'Do not call tools', 'conflicts with stale', 'Requests to fabricate citations', 'Unresolved conflicting evidence']) assert(sent.messages[0].content.includes(policy))
  assert(!sent.messages[0].content.includes('Return one JSON object with only answer'))
  assert(SYSTEM_PROMPT.includes('Return one JSON object with only answer'))
})
test('legacy workers and v2 workers cannot silently consume the other protocol', async () => {
  const queued = await setup().generate({ query: 'Q?', evidence: [original(0)] })
  const legacy = createRagAnswerProcessor({ config: { ...config, answerFormat: 'legacy' }, fetchImpl: () => { throw Error('must not call') } })
  await assert.rejects(legacy.process(queued.task), { code: 'WORKER_ANSWER_TASK_INVALID' })
  const capabilities = { processors: answerProcessorsForConfig({ ...config, answerFormat: 'legacy' }) }
  assert.equal(matchPcWorkerCapabilities(capabilities, { taskType: 'rag.answer.generate', processorVersion: 'v2' }).length, 0)
  assert.throws(() => lookupPcWorkerProcessor('rag.answer.generate', 'v1').projectInput(queued.task.input))
})

test('an active legacy task is not reused as a v2 task', async () => {
  const service = setup({ taskStore: { enqueueExclusiveRun: request => ({
    created: false, task: { ...request, id: 2, processorVersion: 'v1' }
  }) } })
  const result = await service.generate({ query: 'Q?', evidence: [original(0)] })
  assert.equal(result.reasonCode, 'worker_unavailable')
  assert.equal(result.task, undefined)
})

test('v2 stale guard rejects a changed literal plan even with identical evidence', async () => {
  const { task } = await setup().generate({ query: 'First? Second?', evidence: [original(0), original(1)] })
  const guard = lookupPcWorkerProcessor('rag.answer.generate', 'v2').staleGuard
  assert.equal(guard(task.input, structuredClone(task.input)), true)
  const changed = structuredClone(task.input)
  changed.questionPlan.groups = [['C2'], ['C1']]
  assert.equal(guard(task.input, changed), false)
})
test('revoked originals and changed plans fail closed after generation', async () => {
  let visible = true
  const service = setup({ authoritativeVisibility: () => visible })
  const queued = await service.generate({ query: 'First? Second?', evidence: [original(0), original(1)] })
  const result = { schemaVersion: 1, processorVersion: 'v2', output: { answer: 'Known', abstained: false, reasonCode: 'GROUNDED', citations: ['C1'] } }
  visible = false
  assert.equal((await service.applyResult({ task: queued.task, result })).reasonCode, 'evidence_stale')
  visible = true
  const changed = structuredClone(queued.task); changed.input.questionPlan.groups.reverse()
  // Change a valid partition, without inventing an ID.
  changed.input.questionPlan.groups = [['C2'], ['C1']]
  assert.equal((await service.applyResult({ task: changed, result })).reasonCode, 'evidence_stale')
})
test('empty partial is deterministically unsupported, not fabricated; invalid references reject', async () => {
  const queued = await setup().generate({ query: 'Known? Unknown?', evidence: [original(0)] })
  const make = slots => createRagAnswerProcessor({ config, fetchImpl: async () => reply(slots) })
  const result = await make({ Q1: supported('Known'), Q2: { status: 'partial', answer: '', citations: [], missing: ['Unknown'] } }).process(queued.task)
  assert.equal(result.output.reasonCode, 'PARTIAL')
  await assert.rejects(make({ Q1: supported('Known', ['C99']), Q2: unsupported() }).process(queued.task), { code: 'WORKER_ANSWER_RESULT_INVALID' })
})
test('v2 counts slot instructions in context budget and does not invoke a model when nothing fits', async () => {
  const queued = await setup().generate({ query: 'Q?', evidence: [original(0)] })
  const processor = createRagAnswerProcessor({ config: { ...config, contextLimit: 32 }, fetchImpl: () => { throw Error('must not call') } })
  assert.equal((await processor.process(queued.task)).output.reasonCode, 'EVIDENCE_TOO_LARGE')
})
