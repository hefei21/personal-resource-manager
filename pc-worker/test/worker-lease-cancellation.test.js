import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { WorkerApiClient } from '../src/apiClient.js'
import { PcWorker } from '../src/worker.js'

async function exercise(t, { status, code, ignoreAbort = false }) {
  const calls = []
  let release
  let processorSignal
  const server = http.createServer((req, res) => {
    const action = req.url.split('/').at(-1)
    calls.push(action)
    req.resume()
    if (action === 'heartbeat' && status === 0) { req.socket.destroy(); return }
    res.writeHead(action === 'heartbeat' ? status : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(action === 'heartbeat' ? { code } : { data: {} }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const disabled = () => ({ supports: () => false })
  const worker = new PcWorker({
    config: { heartbeatIntervalMs: 5 },
    api: new WorkerApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    logger: { info() {}, warn() {} },
    modelReadinessFactory: () => ({ refresh: async () => false, isReady: () => true }),
    embeddingProcessorFactory: disabled,
    rerankProcessorFactory: disabled,
    contentExtractProcessorFactory: disabled,
    answerProcessorFactory: () => ({
      supports: () => true,
      process: (_task, { signal }) => new Promise((resolve, reject) => {
        processorSignal = signal
        release = () => resolve({ output: {} })
        signal.addEventListener('abort', () => {
          if (ignoreAbort) release()
          else reject(Object.assign(new Error('Stopped'), { code: 'WORKER_PROCESSOR_CANCELLED' }))
        }, { once: true })
      })
    })
  })
  worker.state = { accessToken: 'synthetic', accessExpiresAt: new Date(Date.now() + 3600000).toISOString() }
  worker.profile = {}
  const running = worker.execute({ id: 1, taskType: 'rag.answer.generate', leaseToken: 'synthetic' })
  // Observe rejection immediately; never leave an unhandled rejection while waiting.
  const outcome = running.then(() => null, error => error)
  t.after(() => { release?.(); worker.stop() })
  return { calls, outcome, release: () => release(), signal: () => processorSignal }
}

for (const code of ['TASK_INVALID_STATE', 'TASK_LEASE_MISMATCH', 'TASK_LEASE_EXPIRED', 'TASK_STATE_CONFLICT']) {
  test(`authoritative ${code} aborts processing without reporting a retry`, { timeout: 3000 }, async t => {
    const run = await exercise(t, { status: 409, code })
    assert.equal((await run.outcome).code, code)
    assert.equal(run.signal().aborted, true)
    assert.equal(run.calls.includes('complete'), false)
    assert.equal(run.calls.includes('fail'), false)
  })
}

test('processor returning after lease rejection cannot complete the task', { timeout: 3000 }, async t => {
  const run = await exercise(t, { status: 409, code: 'TASK_LEASE_EXPIRED', ignoreAbort: true })
  assert.equal((await run.outcome).code, 'TASK_LEASE_EXPIRED')
  assert.equal(run.calls.includes('complete'), false)
  assert.equal(run.calls.includes('fail'), false)
})

for (const [status, code] of [[0, 'NETWORK_FAILURE'], [503, 'TEMPORARILY_UNAVAILABLE'], [409, 'UNKNOWN_CONFLICT']]) {
  test(`non-authoritative heartbeat ${status}/${code} does not abort`, { timeout: 3000 }, async t => {
    const run = await exercise(t, { status, code })
    while (!run.calls.includes('heartbeat')) await new Promise(resolve => setTimeout(resolve, 5))
    // Let the HTTP response reach the worker before finishing the processor.
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(run.signal().aborted, false)
    run.release()
    assert.equal(await run.outcome, null)
    assert.equal(run.calls.includes('complete'), true)
    assert.equal(run.calls.includes('fail'), false)
  })
}
