import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'search-index-task-processor-data')

const {
  createSearchIndexTaskProcessor,
  normalizeSearchIndexTaskInput,
  SEARCH_INDEX_TASK_ERROR_CODES
} = await import('../src/services/searchIndexTaskProcessor.js')
const { projectTask } = await import('../src/services/taskTypeCatalog.js')

function task(overrides = {}) {
  return {
    id: 1,
    taskType: 'search.index.refresh',
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType: 'search-index',
    subjectId: 'owner',
    subjectVersionId: 'run-1',
    status: 'succeeded',
    progress: 100,
    attemptCount: 1,
    maxAttempts: 3,
    input: { rebuild: true, includeCodeFiles: false },
    result: {
      status: 'ready', inserted: 7, updated: 0, skipped: 0, deleted: 0, entryCount: 7, errorCount: 0
    },
    errorCode: null,
    ...overrides
  }
}

test('validates and safely projects the search refresh task contract', () => {
  assert.deepEqual(normalizeSearchIndexTaskInput(task()), { rebuild: true, includeCodeFiles: false })
  assert.equal(normalizeSearchIndexTaskInput(task({ input: { rebuild: 'yes' } })), null)
  const projected = projectTask(task())
  assert.deepEqual(projected.input, { rebuild: true, includeCodeFiles: false })
  assert.deepEqual(projected.result, {
    inserted: 7, updated: 0, skipped: 0, deleted: 0, entryCount: 7, errorCount: 0, status: 'ready'
  })
})

test('runs the NAS-local refresh and forwards bounded progress', async () => {
  const progress = []
  const processor = createSearchIndexTaskProcessor({
    database: { prepare() {} },
    collectEntries: async () => [],
    serviceFactory: ({ database }) => ({
      refresh: async ({ rebuild, includeCodeFiles, onProgress }) => {
        assert.ok(database)
        assert.equal(rebuild, true)
        assert.equal(includeCodeFiles, false)
        await onProgress(50)
        return task().result
      }
    })
  })
  const result = await processor({ task: task(), progress: async (value) => progress.push(value) })
  assert.equal(result.entryCount, 7)
  assert.deepEqual(progress, [50])
})

test('rejects malformed task input without leaking processor internals', async () => {
  const processor = createSearchIndexTaskProcessor({
    database: { prepare() {} },
    collectEntries: async () => [],
    serviceFactory: () => ({ refresh: async () => ({}) })
  })
  await assert.rejects(
    () => processor({ task: task({ input: { includeCodeFiles: 'yes' } }) }),
    (error) => error?.code === SEARCH_INDEX_TASK_ERROR_CODES.INPUT_INVALID && error?.retryable === false
  )
})
