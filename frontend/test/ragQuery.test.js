import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRagResponse, useRagQuery } from '../src/composables/useRagQuery.js'

const response = (status, extra = {}, http = 200) => ({ status: http, data: { data: { status, ...extra } } })
const queued = () => response('queued', { runId: 'q1', answer: null, citations: [], abstained: false, cancellable: true }, 202)
function fixture(overrides = {}) {
  const timers = new Map()
  let serial = 0
  const calls = []
  const api = {
    createQuery: async () => queued(),
    getQuery: async id => { calls.push(['get', id]); return response('answered', { answer: 'done' }) },
    cancelQuery: async id => { calls.push(['cancel', id]); return response('cancelled') },
    ...overrides
  }
  const controller = useRagQuery({ api, normalizeResult: value => value, errorLabel: () => 'error',
    setTimer: fn => { timers.set(++serial, fn); return serial }, clearTimer: id => timers.delete(id) })
  const tick = async () => { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); await entry[1]() }
  return { ...controller, calls, timers, tick }
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('202 with empty answer is pending; all active states precede result fields', () => {
  for (const state of ['queued', 'active', 'pending', 'leased', 'running'])
    assert.equal(classifyRagResponse(response(state, { answer: null, citations: [] })).kind, 'active')
  assert.equal(classifyRagResponse(response('degraded', { citations: [] })).kind, 'finished')
  assert.equal(classifyRagResponse(response('complete', { answer: 'Structured fact', citations: [] })).kind, 'finished')
  assert.throws(() => classifyRagResponse(response('unknown')))
})
test('queued to active to answer polls only while active', async () => {
  let n = 0
  const c = fixture({ getQuery: async () => ++n === 1 ? response('active', { runId: 'q1' }) : response('answered', { answer: 'done' }) })
  await c.submit({ q: 'example' }); assert.equal(c.state.value, 'polling'); assert.equal(c.result.value, null)
  await c.tick(); assert.equal(c.state.value, 'polling')
  await c.tick(); assert.equal(c.result.value.answer, 'done'); assert.equal(c.timers.size, 0)
})
test('network pause retains query id; resume does not resubmit', async () => {
  let n = 0
  const c = fixture({ getQuery: async () => { if (++n === 1) throw new Error('offline'); return response('answered', { answer: 'recovered' }) } })
  await c.submit({}); await c.tick(); assert.equal(c.state.value, 'paused'); assert.equal(c.queryId.value, 'q1')
  assert.equal(c.timers.size, 0); await c.resume(); assert.equal(c.result.value.answer, 'recovered')
})
test('old poll cannot overwrite cancellation or a new scope', async () => {
  const d = deferred(); const c = fixture({ getQuery: () => d.promise })
  await c.submit({}); const poll = c.tick(); await c.cancel()
  d.resolve(response('answered', { answer: 'stale' })); await poll
  assert.equal(c.state.value, 'cancelled'); assert.equal(c.result.value, null); assert.equal(c.timers.size, 0)
})
test('late create after cancel or dispose abandons newly created job', async () => {
  for (const operation of ['cancel', 'dispose']) {
    const d = deferred(); const c = fixture({ createQuery: () => d.promise })
    const submission = c.submit({}); await c[operation]()
    d.resolve(queued()); await submission; await Promise.resolve()
    assert.deepEqual(c.calls, [['cancel', 'q1']]); assert.equal(c.timers.size, 0)
  }
})
test('cancel failure is not reported as cancelled; terminal conflict reads actual answer', async () => {
  let conflict = false
  const c = fixture({ cancelQuery: async () => { throw conflict ? { response: { status: 409 } } : new Error('offline') } })
  await c.submit({}); await c.cancel(); assert.equal(c.state.value, 'paused'); assert.match(c.feedback.value, /尚未确认取消/)
  conflict = true; await c.cancel(); assert.equal(c.state.value, 'answered')
})
test('terminal failure clears query and stops polling; unmount ignores pending poll', async () => {
  const c = fixture({ getQuery: async () => response('failed', { errorCode: 'RAG_QUERY_FAILED' }) })
  await c.submit({}); await c.tick(); assert.equal(c.state.value, 'error'); assert.equal(c.queryId.value, '')
  const d = deferred(); const other = fixture({ getQuery: () => d.promise })
  await other.submit({}); const poll = other.tick(); other.dispose()
  d.resolve(queued()); await poll; assert.equal(other.timers.size, 0); assert.equal(other.result.value, null)
})
