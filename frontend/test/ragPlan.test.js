import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { useRagPlan, validateRagPlan, draftRagQuestions } from '../src/composables/useRagPlan.js'

const sources = [{ key: 'document:1', type: 'document', id: 1, title: 'A' }, { key: 'ebook:2', type: 'ebook', id: 2, title: 'B' }]
const rows = () => sources.map((source, i) => ({ q: `问题 ${i}`, sourceKey: source.key }))
const response = data => ({ status: 200, data: { data } })
const done = () => response({ status: 'complete', answer: '原文回答', citations: [] })
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }

test('enhancement preview stays with its child and stopping prevents subsequent children', async () => {
  const calls = []
  let finish, signal
  const { plan } = fixture({ createQuery: async (payload, options) => {
    calls.push(payload)
    if (payload.phase === 'evidence') return response({ status: 'evidence', enhancementRequired: true, evidence: [{ text: '原文' }] })
    signal = options.signal
    return new Promise(resolve => { finish = resolve })
  } })
  plan.confirm(rows(), sources); await flush()
  assert.equal(plan.items.value[0].status, 'enhancing')
  assert.deepEqual(plan.items.value[0].result.evidence, [{ text: '原文' }])
  assert.equal(plan.items.value[1].result, null)
  await plan.stop(); finish(done()); await flush()
  assert.equal(signal.aborted, true)
  assert.equal(calls.length, 2)
  assert.equal(plan.items.value[1].status, 'waiting')
  assert.deepEqual(plan.items.value[0].result.evidence, [{ text: '原文' }])
  plan.dispose()
})
test('draft only splits explicit separators, never guesses conjunctions or drops extra clauses', () => {
  assert.deepEqual(draftRagQuestions('A；B'), ['A', 'B'])
  assert.deepEqual(draftRagQuestions('A和B'), ['A和B', ''])
  assert.deepEqual(draftRagQuestions('A;B;C;D;E'), ['A;B;C;D;E', ''])
})
function fixture(overrides = {}) {
  const calls = [], timers = []
  const api = { createQuery: async payload => { calls.push(payload); return done() }, getQuery: async () => done(), cancelQuery: async () => response({ status: 'cancelled' }), ...overrides }
  const plan = useRagPlan({ api, errorLabel: () => '失败', normalizeResult: x => x, setTimer: fn => { timers.push(fn); return fn }, clearTimer: fn => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1) } })
  return { plan, calls, timers }
}
test('requires explicit valid sources and 2–4 nonempty questions', () => {
  assert.equal(validateRagPlan([], sources), null)
  assert.equal(validateRagPlan([{ q: 'Q' }, { q: 'R' }], sources), null)
  assert.equal(validateRagPlan(rows(), []), null)
  assert.equal(validateRagPlan([...rows(), ...rows(), ...rows()], sources), null)
  assert.equal(validateRagPlan([{ q: 'x'.repeat(257), sourceKey: 'document:1' }, rows()[1]], sources), null)
})
test('zero requests before confirm; frozen plan and normal per-source payloads', async () => {
  const { plan, calls } = fixture()
  const draft = rows()
  await flush(); assert.equal(calls.length, 0)
  assert.equal(plan.confirm(draft, sources), true)
  draft[1].q = 'edited after confirmation'
  assert.equal(plan.confirm(draft, sources), false)
  await flush()
  assert.equal(plan.state.value, 'complete')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].q, '问题 1')
  assert.deepEqual(calls[1].source, { type: 'ebook', id: 2 })
  assert.equal(calls[1].section, undefined)
  plan.dispose()
})
test('pending child blocks next request; connection failure pauses and resumes same run', async () => {
  let reads = 0
  let first = true
  const sent = []
  const f = fixture({ createQuery: async payload => { sent.push(payload); return first ? (first = false, response({ status: 'queued', id: 'run1' })) : done() }, getQuery: async () => { if (++reads === 1) throw new Error('offline'); return done() } })
  f.plan.confirm(rows(), sources); await flush()
  assert.equal(sent.length, 1)
  await f.timers.shift()(); await flush()
  assert.equal(f.plan.state.value, 'paused'); assert.equal(sent.length, 1)
  await f.plan.resume(); await flush()
  assert.equal(sent.length, 2); assert.equal(f.plan.state.value, 'complete')
  f.plan.dispose()
})
test('partial child retains its own status and continues the confirmed plan', async () => {
  let count = 0
  const { plan } = fixture({ createQuery: async () => ++count === 1
    ? response({ status: 'partial', answer: 'Supported', missingRequirements: ['Missing'] }) : done() })
  plan.confirm(rows(), sources); await flush()
  assert.equal(count, 2)
  assert.equal(plan.state.value, 'complete')
  assert.equal(plan.items.value[0].status, 'partial')
  assert.deepEqual(plan.items.value[0].result.missingRequirements, ['Missing'])
  plan.dispose()
})

test('failure never executes remaining children', async () => {
  let count = 0
  const { plan } = fixture({ createQuery: async () => { count++; throw new Error('denied') } })
  plan.confirm(rows(), sources); await flush()
  assert.equal(plan.state.value, 'error'); assert.equal(count, 1)
  assert.equal(plan.items.value[1].status, 'waiting')
  plan.dispose()
})
test('stop during create ignores late completion and never starts next child', async () => {
  let resolve, count = 0
  const { plan } = fixture({ createQuery: () => { count++; return new Promise(r => { resolve = r }) } })
  plan.confirm(rows(), sources)
  await plan.stop(); resolve(done()); await flush()
  assert.equal(count, 1); assert.equal(plan.state.value, 'stopped')
  plan.dispose()
})
test('dispose cancels a late queued response; no subsequent child starts', async () => {
  let resolve, count = 0
  const cancelled = []
  const { plan } = fixture({ createQuery: () => { count++; return new Promise(r => { resolve = r }) }, cancelQuery: async id => { cancelled.push(id); return response({ status: 'cancelled' }) } })
  plan.confirm(rows(), sources); plan.dispose()
  resolve(response({ status: 'queued', id: 'late' })); await flush()
  assert.deepEqual(cancelled, ['late']); assert.equal(count, 1)
})
test('completion winning cancellation preserves result but does not start next child', async () => {
  let count = 0
  const { plan } = fixture({ createQuery: async () => { count++; return response({ status: 'queued', id: 'race' }) }, cancelQuery: async () => done() })
  plan.confirm(rows(), sources); await flush()
  await plan.stop(); await flush()
  assert.equal(count, 1); assert.ok(plan.items.value[0].result)
  assert.equal(plan.items.value[1].status, 'waiting')
  plan.dispose()
})
