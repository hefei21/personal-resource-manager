import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  lookupPcWorkerProcessor,
  matchPcWorkerCapabilities,
  PC_WORKER_PROCESSOR_CATALOG,
  PC_WORKER_PROCESSOR_DEFINITIONS,
  rerankCandidateSetSha256
} from '../src/services/pcWorkerProcessorCatalog.js'

const hash = 'a'.repeat(64)

function vectorHash(vectors) {
  return crypto.createHash('sha256').update(JSON.stringify(vectors.map((vector) => vector.embedding))).digest('hex')
}

const model = {
  provider: 'local-provider',
  modelId: 'embedding-model',
  modelRevision: 'rev-1',
  dimensions: 3,
  inputLimit: 2048,
  distance: 'cosine',
  normalization: 'l2',
  configHash: hash
}

function sourceInput() {
  return {
    schemaVersion: 1,
    sourceType: 'document',
    sourceId: 7,
    sourceVersionId: '11',
    sourceContentSha256: hash,
    contentBytes: 123,
    format: 'markdown'
  }
}

function embeddingInput() {
  return {
    schemaVersion: 1,
    snapshotId: 17,
    sourceType: 'document',
    sourceId: 7,
    sourceVersionId: '11',
    sourceContentSha256: hash,
    model,
    chunks: [
      { chunkId: 101, ordinal: 0, chunkSha256: 'b'.repeat(64), body: '第一段\r\n\t第二段\n第三段' },
      { chunkId: 102, ordinal: 1, chunkSha256: 'c'.repeat(64), body: '第二段' }
    ]
  }
}

function queryInput() {
  return {
    schemaVersion: 1,
    querySha256: 'd'.repeat(64),
    query: '如何恢复\n\t索引？',
    model
  }
}

function rerankInput() {
  const candidates = [
    { candidateId: 'C1', text: '证据一' },
    { candidateId: 'C2', text: '证据二' }
  ]
  return {
    schemaVersion: 1,
    querySha256: 'd'.repeat(64),
    candidateSetSha256: rerankCandidateSetSha256(candidates),
    query: '如何恢复索引？',
    model,
    candidates
  }
}

function answerInput() {
  return {
    schemaVersion: 1,
    querySha256: 'd'.repeat(64),
    query: '如何恢复索引？',
    model,
    evidence: [
      { citationId: 'C1', text: '证据一' },
      { citationId: 'C2', text: '证据二' }
    ]
  }
}

test('catalog is immutable, allowlisted, and exposes the five RAG processors plus content.inspect', () => {
  assert.deepEqual(PC_WORKER_PROCESSOR_DEFINITIONS.map((item) => item.taskType), [
    'content.inspect',
    'rag.content.extract',
    'rag.embedding.generate',
    'rag.query.embed',
    'rag.rerank',
    'rag.answer.generate'
  ])
  assert.equal(Object.isFrozen(PC_WORKER_PROCESSOR_CATALOG), true)
  assert.equal(Object.isFrozen(lookupPcWorkerProcessor('rag.embedding.generate')), true)
  assert.equal(lookupPcWorkerProcessor('unknown.task'), null)
  assert.equal(lookupPcWorkerProcessor('content.inspect', 'v2'), null)
  for (const definition of PC_WORKER_PROCESSOR_DEFINITIONS) {
    assert.equal(typeof definition.processorVersion, 'string')
    assert.equal(definition.outputSchemaVersion, 1)
    assert.equal(typeof definition.inputMode, 'string')
    assert.ok(definition.inputMaxBytes > 0)
    assert.ok(definition.outputMaxBytes > 0)
    assert.ok(definition.maxBatchItems > 0)
    assert.equal(Object.isFrozen(definition.limits), true)
  }
})

test('capability matching is allowlisted and preserves content.inspect compatibility', () => {
  const capabilities = {
    processors: [
      { taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 },
      { taskType: 'rag.embedding.generate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 },
      { taskType: 'rag.content.extract', processorVersion: 'v1', executionClass: 'cpu', outputSchemaVersion: 1 },
      { taskType: 'unknown.task', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }
    ]
  }
  assert.deepEqual(matchPcWorkerCapabilities(capabilities).map((item) => item.taskType), [
    'content.inspect', 'rag.embedding.generate', 'rag.content.extract'
  ])
  assert.deepEqual(matchPcWorkerCapabilities(capabilities, { executionClass: 'gpu' }).map((item) => item.taskType), [
    'content.inspect', 'rag.embedding.generate'
  ])
  assert.deepEqual(matchPcWorkerCapabilities(capabilities, { taskType: 'rag.answer.generate' }), [])
  const leaked = { processors: [{ ...capabilities.processors[0], path: 'C:\\private' }] }
  assert.deepEqual(matchPcWorkerCapabilities(leaked), [])
})

test('content.inspect keeps schema 1 projection, result normalization, and stale guard', () => {
  const definition = lookupPcWorkerProcessor('content.inspect')
  const input = definition.projectInput({ schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9 })
  assert.deepEqual(input, { schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9 })
  assert.deepEqual(definition.resolveInput({
    input,
    subjectContentHash: hash,
    subjectBytes: 5
  }), { schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9, sha256: hash })
  const result = definition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    implementation: { name: 'builtin-content-inspector', version: '1' },
    input: { sha256: hash, bytes: 5 },
    output: { sha256: hash, bytes: 5, nulBytes: 0, lineFeedBytes: 1, carriageReturnBytes: 0, utf8Valid: true }
  }, { sha256: hash, bytes: 5 })
  assert.equal(result.output.bytes, 5)
  assert.equal(definition.staleGuard({ resourceVersionId: 7, contentObjectId: 9, sha256: hash }, {
    resourceVersionId: 7, contentObjectId: 9, sha256: hash
  }), true)
  assert.equal(definition.staleGuard({ resourceVersionId: 8, contentObjectId: 9, sha256: hash }, {
    resourceVersionId: 7, contentObjectId: 9, sha256: hash
  }), false)
  assert.equal(definition.staleGuard({ resourceVersionId: 7, contentObjectId: 9, sha256: hash }, {
    resourceVersionId: 7, contentObjectId: 9, sha256: 'b'.repeat(64)
  }), false)
  assert.throws(() => definition.projectInput({ schemaVersion: 1, resourceVersionId: 7, contentObjectId: 9, path: 'C:\\private' }),
    (error) => error.code === 'PC_WORKER_PROCESSOR_INPUT_INVALID')
})

test('content extraction accepts PDF/DOCX/EPUB metadata and rejects inline artifact text', () => {
  const definition = lookupPcWorkerProcessor('rag.content.extract')
  for (const format of ['pdf', 'docx', 'epub']) {
    const input = definition.projectInput({ ...sourceInput(), format })
    const sections = [{ ordinal: 0, title: 'Section', text: 'Grounded text.', locator: format === 'pdf' ? { page: 1 } : { spineIndex: 0 } }]
    const artifact = JSON.stringify({ schemaVersion: 1, format, sections })
    const artifactSha256 = crypto.createHash('sha256').update(artifact).digest('hex')
    const artifactBytes = Buffer.byteLength(artifact)
    const result = definition.normalizeResult({
      schemaVersion: 1,
      processorVersion: 'v1',
      output: {
        sourceVersionId: input.sourceVersionId,
        sourceContentSha256: input.sourceContentSha256,
        extractorVersion: 'pc-worker-structured-text.v1',
        artifactSha256,
        artifactBytes,
        sectionCount: 1,
        format
      }
    }, input)
    assert.equal(result.output.format, format)
    assert.equal(Object.hasOwn(result.output, 'manifest'), false)
    assert.throws(() => definition.normalizeResult({
      schemaVersion: 1,
      processorVersion: 'v1',
      output: {
        sourceVersionId: input.sourceVersionId,
        sourceContentSha256: input.sourceContentSha256,
        extractorVersion: 'pc-worker-structured-text.v1',
        artifactSha256,
        artifactBytes,
        sectionCount: 1,
        format,
        manifest: { artifactSha256, artifactBytes, sectionCount: 1, format, sections }
      }
    }, input), (error) => error.code === 'PC_WORKER_PROCESSOR_INPUT_INVALID')
  }
})

test('RAG embedding input/output binds source and model identity with finite, exact vectors', () => {
  const definition = lookupPcWorkerProcessor('rag.embedding.generate')
  const input = definition.projectInput(embeddingInput())
  const workerData = [
    { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
    { object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] }
  ]
  // The catalog receives the Worker final output only; OpenAI-compatible data[].object is handled before this boundary.
  const vectors = workerData.map((item, index) => ({
    chunkId: input.chunks[index].chunkId,
    chunkSha256: input.chunks[index].chunkSha256,
    embedding: item.embedding
  }))
  const result = definition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model,
      snapshotId: 17,
      sourceVersionId: '11',
      sourceContentSha256: hash,
      vectors,
      vectorSha256: vectorHash(vectors)
    }
  }, input)
  assert.equal(result.output.vectors.length, 2)
  assert.equal(result.output.vectorSha256, vectorHash(vectors))
  assert.equal(definition.staleGuard(input, { ...input, model: { ...model, configHash: 'e'.repeat(64) } }), false)
  assert.throws(() => definition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model,
      vectors: [{ chunkId: 101, chunkSha256: 'b'.repeat(64), embedding: [0.1, Number.NaN, 0.3] }],
      vectorSha256: hash
    }
  }, input), (error) => error.code === 'PC_WORKER_PROCESSOR_RESULT_COUNT_INVALID')
  assert.throws(() => definition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: {
      model,
      vectors,
      vectorSha256: 'f'.repeat(64)
    }
  }, input), (error) => error.code === 'PC_WORKER_PROCESSOR_RESULT_INVALID')
  assert.throws(() => definition.projectInput({
    ...embeddingInput(),
    chunks: [{ ...embeddingInput().chunks[0], body: 'bad\u0000text' }]
  }), (error) => error.code === 'PC_WORKER_PROCESSOR_INPUT_INVALID')
})

test('query embed, rerank, and answer reject stale identity, invalid numbers, and answer fields', () => {
  const queryDefinition = lookupPcWorkerProcessor('rag.query.embed')
  const query = queryDefinition.projectInput(queryInput())
  const embedding = [0.1, 0.2, 0.3]
  const queryResult = queryDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { model, querySha256: query.querySha256, embedding, vectorSha256: vectorHash([{ embedding }]) }
  }, query)
  assert.deepEqual(queryResult.output.embedding, embedding)
  assert.equal(queryResult.output.vectorSha256, vectorHash([{ embedding }]))
  assert.throws(() => queryDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { model, querySha256: query.querySha256, embedding, vectorSha256: 'e'.repeat(64) }
  }, query), (error) => error.code === 'PC_WORKER_PROCESSOR_RESULT_INVALID')

  const rerankDefinition = lookupPcWorkerProcessor('rag.rerank')
  const rerank = rerankDefinition.projectInput(rerankInput())
  const rerankResult = rerankDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { model, querySha256: rerank.querySha256, candidateSetSha256: rerank.candidateSetSha256, candidates: [{ candidateId: 'C2', score: 0.9 }, { candidateId: 'C1', score: 0.4 }] }
  }, rerank)
  assert.deepEqual(rerankResult.output.candidates.map((item) => item.candidateId), ['C2', 'C1'])
  assert.throws(() => rerankDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { model, querySha256: rerank.querySha256, candidateSetSha256: rerank.candidateSetSha256, candidates: [{ candidateId: 'C1', score: Infinity }] }
  }, rerank), (error) => error.code === 'PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH' || error.code === 'PC_WORKER_PROCESSOR_RESULT_INVALID')

  const answerDefinition = lookupPcWorkerProcessor('rag.answer.generate')
  const answer = answerDefinition.projectInput(answerInput())
  const answerResult = answerDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { answer: '按证据恢复。', abstained: false, reasonCode: 'grounded', citations: ['C1'] }
  }, answer)
  assert.deepEqual(answerResult.output.citations, ['C1'])
  assert.throws(() => answerDefinition.normalizeResult({
    schemaVersion: 1,
    processorVersion: 'v1',
    output: { answer: '伪造', abstained: false, citations: ['C9'], extra: 'forbidden' }
  }, answer), (error) => error.code === 'PC_WORKER_PROCESSOR_INPUT_INVALID')
})
