import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'resource-domain-import-task-test-data')

const {
  createResourceDomainImportTaskProcessor,
  RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES
} = await import('../src/services/resourceDomainImportTaskProcessor.js')

function task(overrides = {}) {
  return {
    id: 1,
    taskType: 'resource.domain.adapt',
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType: 'resource-domain-import',
    subjectId: 'owner',
    input: { scope: 'documents' },
    ...overrides
  }
}

function database() {
  return { prepare() {} }
}

test('processes a bounded domain import and returns counts only', async () => {
  const calls = []
  const progress = []
  const processor = createResourceDomainImportTaskProcessor({
    database: database(),
    reconcile: async () => ({ missingRecords: 0 }),
    adapt: async (options) => {
      calls.push(options)
      await options.onProgress({ processed: 1, total: 2 })
      await options.onProgress({ processed: 2, total: 2 })
      return {
        processed: 2,
        resourcesCreated: 1,
        resourcesReused: 1,
        sourcesCreated: 1,
        versionsCreated: 1,
        versionsReused: 1,
        contentObjectsCreated: 1,
        contentObjectsReused: 1,
        missingContent: 0,
        errors: 0,
        conflicts: 0,
        skipped: 0,
        path: 'must-not-leak'
      }
    }
  })
  const result = await processor({ task: task({ input: { scope: 'documents', cursor: 3, batchSize: 2 } }), progress: (value) => progress.push(value) })
  assert.deepEqual(result, {
    processed: 2,
    resourcesCreated: 1,
    resourcesReused: 1,
    sourcesCreated: 1,
    versionsCreated: 1,
    versionsReused: 1,
    contentObjectsCreated: 1,
    contentObjectsReused: 1,
    missingContent: 0,
    missingRecords: 0,
    errors: 0,
    conflicts: 0,
    skipped: 0
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { scope: 'documents', cursor: 3, batchSize: 2 })
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|path/u)
  assert.ok(progress.length >= 2)
})

test('rejects unsupported fields, wrong identity, and cancellation without invoking adapter', async () => {
  let called = false
  const processor = createResourceDomainImportTaskProcessor({
    database: database(),
    reconcile: async () => ({ missingRecords: 0 }),
    adapt: async () => {
      called = true
      return {}
    }
  })
  await assert.rejects(processor({ task: task({ input: { scope: 'documents', rootPath: '/secret' } }) }), {
    code: RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.INPUT_INVALID
  })
  await assert.rejects(processor({ task: task({ input: { scope: 'all', cursor: 1 } }) }), {
    code: RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.INPUT_INVALID
  })
  await assert.rejects(processor({ task: task({ taskType: 'resource.domain.other' }) }), {
    code: RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.INPUT_INVALID
  })
  await assert.rejects(processor({ task: task(), signal: AbortSignal.abort() }), {
    code: RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.CANCELLED
  })
  assert.equal(called, false)
})

test('maps SQLite busy to retryable stable task error', async () => {
  const processor = createResourceDomainImportTaskProcessor({
    database: database(),
    reconcile: async () => ({ missingRecords: 0 }),
    adapt: async () => { throw Object.assign(new Error('busy at /secret/path'), { code: 'SQLITE_BUSY' }) }
  })
  await assert.rejects(processor({ task: task() }), (error) => {
    assert.equal(error.code, RESOURCE_DOMAIN_IMPORT_TASK_ERROR_CODES.DATABASE_BUSY)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.summary, /secret|path/u)
    return true
  })
})

test('processor drains every bounded batch before succeeding', async () => {
  const calls = []
  const processor = createResourceDomainImportTaskProcessor({
    database: database(),
    reconcile: async () => ({ missingRecords: 0 }),
    adapt: async ({ input }) => {
      calls.push(input)
      if (calls.length === 1) return { processed: 2, resourcesCreated: 2, nextCursor: 2, hasMore: true }
      return { processed: 1, resourcesCreated: 1, nextCursor: 3, hasMore: false }
    }
  })
  const result = await processor({
    task: task({ input: { scope: 'documents', batchSize: 2 } })
  })
  assert.deepEqual(calls, [
    { scope: 'documents', cursor: 0, batchSize: 2 },
    { scope: 'documents', cursor: 2, batchSize: 2 }
  ])
  assert.equal(result.processed, 3)
  assert.equal(result.resourcesCreated, 3)
})
