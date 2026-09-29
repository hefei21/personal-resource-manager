import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createQueryTranslationTransport } from '../src/ragQueryTranslationTransport.js'
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

test('queue expiry avoids inference and a late completion cannot extend the deadline', async () => {
  let now = 1000
  let calls = 0
  const input = { query: '中文问题', enabled: true, expiresAt: 1000, now: () => now,
    complete: async () => { calls++; now = 2000; return { finishReason: 'stop', value: { queries: ['Question?'] } } } }
  assert.equal((await translateRetrievalQuery(input)).status, 'timeout')
  assert.equal(calls, 0)
  assert.equal((await translateRetrievalQuery({ ...input, expiresAt: 1500 })).status, 'timeout')
  assert.equal(calls, 1)
})

test('queue time reduces the remaining inference budget', async () => {
  let signal
  const result = await translateRetrievalQuery({ query: '问题', enabled: true, timeoutMs: 2000,
    expiresAt: 1010, now: () => 1000,
    complete: input => { signal = input.signal; return new Promise(() => {}) } })
  assert.equal(result.status, 'timeout')
  assert.equal(signal.aborted, true)
})

test('configured HTTP translation transport enforces payload, failure and response bounds', async t => {
  let mode = 'ok'
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    assert.equal(req.url, '/v1/chat/completions')
    const input = JSON.parse(body)
    assert.equal(input.model, 'test-model')
    assert.equal(input.messages[1].content, '中文问题')
    assert.equal(input.temperature, 0)
    assert.equal(input.chat_template_kwargs.enable_thinking, false)
    if (mode === 'offline') { res.writeHead(503); res.end(); return }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/unexpected' }); res.end(); return }
    if (mode === 'large') { res.end('x'.repeat(65537)); return }
    if (mode === 'hung') return
    res.end(JSON.stringify({ choices: [{ finish_reason: mode === 'truncated' ? 'length' : 'stop',
      message: { content: JSON.stringify({ queries: ['Chinese question?'] }) } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const complete = createQueryTranslationTransport({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'test-model' })
  const run = () => translateRetrievalQuery({ query: '中文问题', enabled: true, complete, timeoutMs: 100 })
  assert.deepEqual((await run()).queries, ['中文问题', 'Chinese question?'])
  for (mode of ['offline', 'redirect', 'large', 'truncated', 'hung']) {
    const result = await run()
    assert.deepEqual(result.queries, ['中文问题'])
    assert.equal(result.status, mode === 'hung' ? 'timeout' : mode === 'truncated' ? 'invalid' : 'unavailable')
  }
})
