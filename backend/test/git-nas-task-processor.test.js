import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DATA_PATH ??= path.join(os.tmpdir(), 'git-nas-task-processor-test-data')

const {
  GIT_NAS_TASK_ERROR_CODES,
  createGitNasTaskProcessor
} = await import('../src/services/gitNasTaskProcessor.js')

function task(taskType, input, subjectType, subjectId) {
  return {
    id: 1,
    taskType,
    processorVersion: 'v1',
    executionClass: 'disk',
    subjectType,
    subjectId: String(subjectId),
    input
  }
}

test('discovery processor accepts only IDs and returns bounded numeric counts', async () => {
  const calls = []
  const processor = createGitNasTaskProcessor({
    database: { fake: true },
    discover: async (input) => {
      calls.push(input)
      return {
        generation: 2,
        rulesVersion: 3,
        visitedEntries: 12,
        candidates: 2,
        rejected: 1,
        created: 1,
        existing: 1,
        missing: 0,
        root_path: 'C:\\secret',
        relative_path: 'private'
      }
    },
    importCandidate: async () => {
      throw new Error('not expected')
    }
  })
  const progress = []
  const result = await processor({
    task: task('code.repository.git_nas.discover', { scanRootId: 1, rulesVersion: 3, generation: 2 }, 'nas-scan-root', 1),
    progress: async (value) => progress.push(value)
  })
  assert.deepEqual(result, {
    generation: 2,
    rulesVersion: 3,
    visitedEntries: 12,
    candidates: 2,
    rejected: 1,
    created: 1,
    existing: 1,
    missing: 0
  })
  assert.equal(calls[0].scanRootId, 1)
  assert.equal('root_path' in calls[0], false)
  assert.deepEqual(progress, [1])
})

test('import processor is strict, idempotent-result safe, and does not retain paths', async () => {
  const calls = []
  const processor = createGitNasTaskProcessor({
    database: { fake: true },
    discover: async () => {
      throw new Error('not expected')
    },
    importCandidate: async (input) => {
      calls.push(input)
      return { repositoryId: 8, resourceId: 4, status: 'already-imported', local_path: 'C:\\secret' }
    }
  })
  const result = await processor({
    task: task('code.repository.git_nas.import', { candidateId: 4 }, 'git-nas-candidate', 4),
    progress: async () => {}
  })
  assert.deepEqual(result, { repositoryId: 8, resourceId: 4, status: 'already-imported' })
  assert.deepEqual(calls, [{ database: { fake: true }, candidateId: 4, signal: undefined }])

  await assert.rejects(
    () => processor({
      task: task('code.repository.git_nas.import', { candidateId: 4, relativePath: 'secret' }, 'git-nas-candidate', 4)
    }),
    (error) => error.code === GIT_NAS_TASK_ERROR_CODES.INPUT_INVALID && error.retryable === false
  )
})

test('forged subjects and cancelled tasks are rejected before filesystem work', async () => {
  let called = false
  const processor = createGitNasTaskProcessor({
    database: { fake: true },
    discover: async () => { called = true },
    importCandidate: async () => { called = true }
  })
  await assert.rejects(
    () => processor({
      task: task('code.repository.git_nas.discover', { scanRootId: 1, rulesVersion: 1, generation: 1 }, 'git-nas-candidate', 1)
    }),
    (error) => error.code === GIT_NAS_TASK_ERROR_CODES.INPUT_INVALID
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => processor({
      task: task('code.repository.git_nas.import', { candidateId: 1 }, 'git-nas-candidate', 1),
      signal: controller.signal
    }),
    (error) => error.code === GIT_NAS_TASK_ERROR_CODES.CANCELLED
  )
  assert.equal(called, false)
})
