import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TASK_TYPE_LABELS,
  effectiveTaskStatus,
  taskCanRetry,
  taskErrorLabel,
  taskSourcePresentation,
  taskStageLabel
} from '../src/domain/taskPresentation.js'

test('task presentation names every RAG stage and resolves an owner-visible resource source', () => {
  for (const type of [
    'rag.index.refresh', 'rag.content.extract', 'rag.embedding.generate',
    'rag.query.embed', 'rag.rerank', 'rag.answer.generate'
  ]) assert.notEqual(TASK_TYPE_LABELS[type], undefined, type)

  const task = {
    taskType: 'rag.content.extract',
    executionClass: 'cpu',
    source: { kind: 'resource', type: 'ebook', id: 23, label: '电子书', title: '无职转生', route: '/books' }
  }
  assert.deepEqual(taskSourcePresentation(task), {
    title: '无职转生', meta: '电子书 · #23', route: '/books'
  })
  assert.equal(taskStageLabel(task), 'PC Worker · 文件正文提取')
})

test('partial index results are not presented as completed and ephemeral query jobs are not manually retried', () => {
  assert.equal(effectiveTaskStatus({ status: 'succeeded', result: { status: 'partial' } }), 'partial')
  assert.equal(taskCanRetry({ status: 'failed', taskType: 'rag.answer.generate' }), false)
  assert.equal(taskCanRetry({ status: 'failed', taskType: 'rag.content.extract' }), true)
  assert.equal(taskCanRetry({ status: 'failed', taskType: 'rag.embedding.generate', errorCode: 'WORKER_PROCESSOR_INPUT_INVALID' }), false)
  assert.equal(taskCanRetry({ status: 'failed', taskType: 'rag.embedding.generate', errorCode: 'WORKER_EMBEDDING_INPUT_TOO_LARGE' }), false)
  assert.match(taskErrorLabel('WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID'), /压缩包结构无效/u)
  assert.match(taskErrorLabel('WORKER_EMBEDDING_INPUT_TOO_LARGE'), /超过 Worker 的安全大小限制/u)
  assert.match(taskErrorLabel('WORKER_PROCESSING_FAILED'), /旧任务未保留具体原因/u)
})
