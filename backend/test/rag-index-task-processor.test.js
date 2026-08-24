import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'rag-index-task-processor-data')

const {
  createRagIndexTaskProcessor,
  normalizeRagIndexTaskInput,
  RAG_INDEX_TASK_ERROR_CODES
} = await import('../src/services/ragIndexTaskProcessor.js')
const { projectTask } = await import('../src/services/taskTypeCatalog.js')

function task(overrides = {}) {
  return {
    id: 1,
    taskType: 'rag.index.refresh',
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType: 'rag-index',
    subjectId: 'owner',
    subjectVersionId: 'refresh-1',
    status: 'succeeded',
    progress: 100,
    attemptCount: 1,
    maxAttempts: 3,
    input: {
      source: { type: 'document', id: 7 },
      filter: { sourceIds: [7] },
      rebuild: true
    },
    result: {
      status: 'ready', sourceCount: 1, indexedCount: 1, skippedCount: 0,
      failedCount: 0, errorCount: 0, chunkCount: 3
    },
    ...overrides
  }
}

test('normalizes a bounded source/filter/rebuild contract and rejects paths or model options', () => {
  assert.deepEqual(normalizeRagIndexTaskInput(task().input), {
    source: { type: 'document', id: 7 },
    filter: { sourceIds: [7] },
    rebuild: true
  })
  assert.deepEqual(normalizeRagIndexTaskInput({}), {
    source: { type: 'all', id: null },
    rebuild: false
  })
  assert.equal(normalizeRagIndexTaskInput({ path: '/private/a.md' }), null)
  assert.equal(normalizeRagIndexTaskInput({ modelUrl: 'http://127.0.0.1:1234' }), null)
  assert.equal(normalizeRagIndexTaskInput({ source: { type: 'document', id: 7 }, filter: { sourceIds: [8] } }), null)
})

test('projects only safe RAG index task input and bounded result counters', () => {
  const projected = projectTask(task())
  assert.ok(projected)
  assert.deepEqual(projected.input, task().input)
  assert.deepEqual(projected.result, {
    sourceCount: 1,
    indexedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    errorCount: 0,
    chunkCount: 3,
    status: 'ready'
  })
  assert.equal(projectTask(task({ input: { source: { type: 'document', id: 7 }, path: '/secret' } }))?.input, null)
  assert.doesNotMatch(JSON.stringify(projected), /path|modelUrl|collection|storage/iu)
})

test('refreshes through RagTextIndexService with filtered sources and bounded progress', async () => {
  const calls = { collect: [], refresh: [] }
  const progress = []
  const processor = createRagIndexTaskProcessor({
    database: { name: 'database' },
    collectSources: async (options) => {
      calls.collect.push(options)
      await options.onProgress(40)
      return {
        sources: [
          { sourceType: 'document', sourceId: 7, title: 'selected' },
          { sourceType: 'document', sourceId: 8, title: 'excluded' }
        ],
        errors: [
          { code: 'RAG_SOURCE_DOCUMENT_FAILED', sourceType: 'document', sourceId: 8 },
          { code: 'RAG_SOURCE_COLLECTION_WARNING' }
        ]
      }
    },
    serviceFactory: ({ database, collectSources }) => ({
      refresh: async (options) => {
        calls.refresh.push({ database, options })
        const collected = await collectSources({ onProgress: options.onProgress })
        assert.deepEqual(collected.sources.map((source) => source.sourceId), [7])
        assert.deepEqual(collected.errors, [{ code: 'RAG_SOURCE_COLLECTION_WARNING' }])
        await options.onProgress(100)
        return { status: 'ready', sourceCount: 1, indexedCount: 1, skippedCount: 0, failedCount: 0, errorCount: 0, chunkCount: 2 }
      }
    })
  })
  const result = await processor({ task: task(), progress: async (value) => progress.push(value) })
  assert.equal(result.status, 'ready')
  assert.deepEqual(calls.collect[0].source, { type: 'document', id: 7 })
  assert.deepEqual(calls.collect[0].filter, { sourceIds: [7] })
  assert.equal(calls.refresh[0].options.rebuild, true)
  assert.deepEqual(progress, [20, 100])
})

test('rejects malformed input and observes cancellation before collecting', async () => {
  let collected = false
  const processor = createRagIndexTaskProcessor({
    database: {},
    collectSources: async () => { collected = true; return { sources: [], errors: [] } },
    serviceFactory: () => ({ refresh: async () => ({}) })
  })
  await assert.rejects(
    () => processor({ task: task({ input: { source: { type: 'document', id: 7 }, rebuild: 'yes' } }) }),
    (error) => error?.code === RAG_INDEX_TASK_ERROR_CODES.INPUT_INVALID && error?.retryable === false
  )
  await assert.rejects(
    () => processor({ task: task(), signal: AbortSignal.abort() }),
    (error) => error?.code === RAG_INDEX_TASK_ERROR_CODES.CANCELLED && error?.retryable === false
  )
  assert.equal(collected, false)
})
