import assert from 'node:assert/strict'
import test from 'node:test'

import {
  invalidateRagSource,
  scheduleRagSourceRefresh,
  scheduleRagSourcesRefresh
} from '../src/services/ragLifecycleService.js'

function fakeDatabase() {
  const calls = []
  return {
    calls,
    prepare(sql) {
      return {
        get(tableName) {
          if (sql.includes('sqlite_master')) {
            return tableName === 'rag_source_state' ? { present: 1 } : undefined
          }
          return undefined
        },
        run(...parameters) {
          calls.push({ sql, parameters })
          return { changes: 1 }
        }
      }
    }
  }
}

test('lifecycle refresh invalidates prior evidence and enqueues an exact durable source task', async () => {
  const database = fakeDatabase()
  const enqueued = []
  const outcome = await scheduleRagSourceRefresh({
    database,
    sourceType: 'ebook',
    sourceId: 23,
    reasonCode: 'RAG_SOURCE_CREATED',
    runIdentity: () => 'run-1',
    enqueue: (receivedDatabase, task) => {
      assert.equal(receivedDatabase, database)
      enqueued.push(task)
      return { created: true, task: { id: 91 } }
    }
  })
  assert.equal(outcome.status, 'enqueued')
  assert.equal(outcome.invalidated, true)
  assert.equal(outcome.taskId, 91)
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0].sql, /active_snapshot_id = NULL/u)
  assert.deepEqual(enqueued[0].input, {
    source: { type: 'ebook', id: 23 },
    filter: { sourceType: 'ebook', sourceIds: [23] },
    rebuild: false
  })
  assert.equal(enqueued[0].subjectVersionId, 'lifecycle:ebook:23:run-1')
})

test('failed enqueue leaves the source stale instead of serving the old snapshot', async () => {
  const database = fakeDatabase()
  const outcome = await scheduleRagSourceRefresh({
    database,
    sourceType: 'document',
    sourceId: 7,
    enqueue: () => { throw new Error('queue unavailable') }
  })
  assert.equal(outcome.status, 'stale_only')
  assert.equal(outcome.invalidated, true)
})

test('trash invalidation updates only an existing source state and never creates work', () => {
  const database = fakeDatabase()
  assert.equal(invalidateRagSource(database, {
    sourceType: 'code_repository',
    sourceId: 5,
    reasonCode: 'RAG_SOURCE_DELETED'
  }), true)
  assert.match(database.calls[0].sql, /^\s*UPDATE rag_source_state/u)
})

test('batch lifecycle changes coalesce into one bounded source task', async () => {
  const database = fakeDatabase()
  const enqueued = []
  const outcome = await scheduleRagSourcesRefresh({
    database,
    sourceType: 'document',
    sourceIds: [7, 8],
    runIdentity: () => 'batch-1',
    enqueue: (_database, task) => {
      enqueued.push(task)
      return { created: true, task: { id: 92 } }
    }
  })
  assert.equal(outcome.status, 'enqueued')
  assert.equal(outcome.invalidated, 2)
  assert.equal(database.calls.length, 2)
  assert.equal(enqueued.length, 1)
  assert.deepEqual(enqueued[0].input, {
    source: { type: 'document' },
    filter: { sourceType: 'document', sourceIds: [7, 8] },
    rebuild: false
  })
})
