import assert from 'node:assert/strict'
import test from 'node:test'
import { createRagRerankService } from '../src/services/ragRerankService.js'
import { QWEN_RERANKER_MODEL as model } from '../src/config/qwenReranker.js'
import { selectGlobalRerankedEvidence } from '../src/services/ragHybridRetriever.js'

const candidates = count => Array.from({ length: count }, (_, i) => ({ citationId: `C${i}`, body: `evidence ${i}` }))
function success(request, score = c => Number(c.candidateId.slice(1))) {
  return { id: 1, status: 'succeeded', result: { schemaVersion: 1, processorVersion: 'v1', output: {
    model, querySha256: request.input.querySha256, candidateSetSha256: request.input.candidateSetSha256,
    candidates: request.input.candidates.map(c => ({ candidateId: c.candidateId, score: score(c) })).sort((a, b) => b.score - a.score)
  } } }
}
test('150-candidate pool uses bounded tasks and returns original objects in global score order', async () => {
  const calls = [], input = candidates(150)
  const service = createRagRerankService({ model, maxCandidates: 50, workerAvailable: () => true,
    taskStore: { enqueueExclusiveRun(request) { calls.push(request); return { task: success(request) } } } })
  const result = await service.rerankPool({ query: 'q', candidates: input })
  assert.equal(result.applied, true)
  assert.deepEqual(calls.map(c => c.input.candidates.length), [50, 50, 50])
  assert.deepEqual(result.candidates, [...input].reverse())
  assert.equal(result.candidates[0], input[149])
  assert.equal(new Set(calls.map(c => c.input.candidateSetSha256)).size, 3)
  assert.equal((await service.rerankPool({ query: 'q', candidates: candidates(151) })).applied, false)
  assert.equal(calls.length, 3)
})
test('batches share a deadline including enqueue time and never publish partial ranking', async () => {
  for (const failure of ['deadline', 'invalid', 'cancel']) {
    let now = 0, calls = 0
    const input = candidates(120), controller = new AbortController()
    const service = createRagRerankService({ model, maxCandidates: 50, now: () => now, waitMs: 3000,
      workerAvailable: () => true, taskStore: { enqueueExclusiveRun(request) {
        calls++; now += 1600
        if (calls === 2 && failure === 'cancel') controller.abort()
        const task = success(request)
        if (calls === 2 && failure === 'invalid') { now = 2000; task.result.output.candidateSetSha256 = 'a'.repeat(64) }
        return { task }
      } } })
    if (failure === 'cancel') await assert.rejects(service.rerankPool({ query: 'q', candidates: input, signal: controller.signal }))
    else {
      const result = await service.rerankPool({ query: 'q', candidates: input })
      assert.equal(result.applied, false); assert.deepEqual(result.candidates, input)
    }
    assert.equal(calls, 2)
  }
})
test('equal scores remain stable across batches; disabled and duplicate pools enqueue nothing', async () => {
  const input = candidates(51)
  let calls = 0
  const options = { model, maxCandidates: 50, workerAvailable: () => true,
    taskStore: { enqueueExclusiveRun(request) { calls++; return { task: success(request, () => 1) } } } }
  assert.deepEqual((await createRagRerankService(options).rerankPool({ query: 'q', candidates: input })).candidates, input)
  calls = 0
  assert.equal((await createRagRerankService({ ...options, enabled: false }).rerankPool({ query: 'q', candidates: input })).applied, false)
  assert.equal((await createRagRerankService(options).rerankPool({ query: 'q', candidates: [...input, input[0]] })).applied, false)
  assert.equal(calls, 0)
})
test('post-rerank selector keeps lexical hits, rescues lower candidates, caps each source and rejects substitutions', () => {
  const pool = candidates(20).map((c,i) => ({ ...c, sourceId: i < 10 ? 1 : 2, sourceType: 'document', sourceVersionId: 'v1', snapshotId: 1, ordinal: i*3, locator: { startLine:i*3, endLine:i*3 } }))
  const ranked = [...pool].reverse()
  const selected = selectGlobalRerankedEvidence({ pool, ranked })
  assert.equal(selected.length, 10)
  assert.equal(selected[0], pool[0]); assert.ok(selected.includes(pool[19]))
  for (const id of [1,2]) assert.ok(selected.filter(c => c.sourceId === id).length <= 6)
  assert.throws(() => selectGlobalRerankedEvidence({ pool, ranked: ranked.slice(1) }))
  assert.throws(() => selectGlobalRerankedEvidence({ pool, ranked: pool.map(() => pool[0]) }))
  assert.throws(() => selectGlobalRerankedEvidence({ pool, ranked: [...pool.slice(0,-1), {citationId:'invented'}] }))
  const changedBody = ranked.map(c => ({ ...c, body: 'untrusted replacement' }))
  assert.ok(selectGlobalRerankedEvidence({ pool, ranked: changedBody }).every(c => c.body !== 'untrusted replacement'))
})
