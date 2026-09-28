import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { translateRetrievalQuery, validateQueryTranslations } from '../src/ragQueryTranslation.js'

test('disabled and unavailable preserve original without inference', async () => {
  const query = 'Click 默认 1 次吗？'
  assert.deepEqual(await translateRetrievalQuery({ query }), { status: 'disabled', queries: [query] })
  assert.equal((await translateRetrievalQuery({ query, enabled: true })).status, 'unavailable')
})
test('English-only queries bypass translation without consuming inference', async () => {
  const result = await translateRetrievalQuery({ query: 'What is SQLite?', enabled: true,
    complete: () => { throw new Error('Must not call model') } })
  assert.equal(result.status, 'not_applicable')
  assert.deepEqual(result.queries, ['What is SQLite?'])
})
test('bounded question-only translation retains original and removes duplicates', async () => {
  const query = 'Click 默认 1 次吗？'
  const result = await translateRetrievalQuery({ query, enabled: true, complete: async input => {
    assert.equal(input.messages.length, 2)
    assert.equal(input.messages[1].content, query)
    return { finishReason: 'stop', value: { queries: ['Does Click default to 1?', 'Does Click default to 1?'] } }
  } })
  assert.deepEqual(result.queries, [query, 'Does Click default to 1?'])
})
test('reject missing or changed identifiers, numbers, controls, URLs and schema excess', () => {
  for (const text of ['Is default 1?', 'ClickHouse defaults to 1?', 'Click defaults to 10?', 'Click 1\n', 'Click 1 https://example.org']) {
    assert.deepEqual(validateQueryTranslations('Click 1', { queries: [text] }), [])
  }
  assert.deepEqual(validateQueryTranslations('Click 1', { queries: ['Click 1'], scope: 'all' }), [])
  assert.deepEqual(validateQueryTranslations('Click 1', { queries: ['a', 'b', 'c'] }), [])
  assert.deepEqual(validateQueryTranslations('Click --help read_uncommitted=0', { queries: ['Click help read_uncommitted=1 and 0'] }), [])
})
test('invalid or truncated output cannot replace original', async () => {
  for (const response of [{ finishReason: 'length', value: { queries: ['translation'] } }, { finishReason: 'stop', value: { queries: [1] } }]) {
    assert.deepEqual((await translateRetrievalQuery({ query: '问题', enabled: true, complete: async () => response })).queries, ['问题'])
  }
})
test('offline and hung transport fail open with a bounded deadline', async () => {
  const base = { query: '问题', enabled: true, timeoutMs: 10 }
  assert.equal((await translateRetrievalQuery({ ...base, complete: async () => { throw new Error('offline') } })).status, 'unavailable')
  let transportSignal
  const result = await translateRetrievalQuery({ ...base, complete: ({ signal }) => { transportSignal = signal; return new Promise(() => {}) } })
  assert.equal(result.status, 'timeout')
  assert.equal(transportSignal.aborted, true)
  assert.deepEqual(result.queries, ['问题'])
})
test('user cancellation propagates instead of starting original fallback', async () => {
  const controller = new AbortController()
  const reason = new Error('User left')
  await assert.rejects(translateRetrievalQuery({ query: '问题', enabled: true, signal: controller.signal,
    complete: async () => { controller.abort(reason); return new Promise(() => {}) }
  }), error => error === reason)
})
test('real HTTP transport timeout aborts fetch and retains the query', async () => {
  const server = http.createServer((_request, _response) => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await translateRetrievalQuery({ query: '中文问题', enabled: true, timeoutMs: 100,
      complete: async ({ signal }) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal })
        return response.json()
      }
    })
    assert.deepEqual(result, { status: 'timeout', queries: ['中文问题'] })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
