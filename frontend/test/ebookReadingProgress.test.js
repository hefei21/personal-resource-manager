import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEbookReadingProgressSync,
  EbookProgressConflictError
} from '../src/domain/ebookReadingProgress.js'

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  }
}

test('ebook progress writes are serialized and advance the shared revision', async () => {
  const writes = []
  let revision = 0
  const api = {
    getProgress: async () => ({ data: { currentPage: 0, progress: 0, revision: 0 } }),
    saveProgress: async (_bookId, input) => {
      writes.push(structuredClone(input))
      assert.equal(input.revision, revision)
      revision += 1
      return { data: { data: { ...input, revision, updatedAt: `t${revision}` } } }
    }
  }
  const sync = createEbookReadingProgressSync({ bookId: 7, api, storage: storage() })
  await sync.load()
  const first = sync.queue({ currentPage: 2, progress: 10, cfi: 'cfi-2', fontSize: 18 })
  const second = sync.queue({ currentPage: 3, progress: 14, cfi: 'cfi-3', fontSize: 18 })
  await Promise.all([first, second])
  assert.equal(writes.length, 2)
  assert.equal(writes[0].revision, 0)
  assert.equal(writes[1].revision, 1)
  assert.equal(sync.remote.currentPage, 3)
  assert.equal(sync.remote.revision, 2)
})

test('a stale client exposes an explicit cross-device conflict decision', async () => {
  let forcePayload = null
  const api = {
    getProgress: async () => ({ data: { currentPage: 1, progress: 5, revision: 3 } }),
    saveProgress: async (_bookId, input) => {
      if (!input.force) {
        throw Object.assign(new Error('conflict'), {
          response: {
            status: 409,
            data: {
              code: 'EBOOK_PROGRESS_CONFLICT',
              latest: { currentPage: 8, progress: 44, revision: 4, updatedAt: 'remote' }
            }
          }
        })
      }
      forcePayload = input
      return { data: { data: { ...input, revision: 5, updatedAt: 'local' } } }
    }
  }
  const statuses = []
  const sync = createEbookReadingProgressSync({
    bookId: 7,
    api,
    storage: storage(),
    onStatus: (status) => statuses.push(status.name)
  })
  await sync.load()
  await assert.rejects(
    sync.queue({ currentPage: 5, progress: 26, cfi: 'local-cfi' }),
    EbookProgressConflictError
  )
  assert.equal(sync.conflict.remote.currentPage, 8)
  await sync.resolveConflict('local')
  assert.equal(forcePayload.force, true)
  assert.equal(forcePayload.revision, 4)
  assert.equal(sync.remote.currentPage, 5)
  assert.ok(statuses.includes('conflict'))
})

test('an offline write stays pending and resumes after a reload', async () => {
  const local = storage()
  const offlineApi = {
    getProgress: async () => ({ data: { currentPage: 1, progress: 4, revision: 2 } }),
    saveProgress: async () => { throw new Error('offline') }
  }
  const first = createEbookReadingProgressSync({ bookId: 9, api: offlineApi, storage: local })
  await first.load()
  await assert.rejects(first.queue({ currentPage: 4, progress: 22, cfi: 'pending-cfi' }), /offline/u)
  assert.ok([...local.values.keys()].some((key) => key.includes('ebook-progress-pending')))

  const resumedWrites = []
  const onlineApi = {
    getProgress: async () => ({ data: { currentPage: 1, progress: 4, revision: 2 } }),
    saveProgress: async (_bookId, input) => {
      resumedWrites.push(input)
      return { data: { data: { ...input, revision: 3, updatedAt: 'online' } } }
    }
  }
  const resumed = createEbookReadingProgressSync({ bookId: 9, api: onlineApi, storage: local })
  await resumed.load()
  await resumed.flush()
  assert.equal(resumedWrites.length, 1)
  assert.equal(resumed.remote.currentPage, 4)
  assert.equal(resumed.remote.revision, 3)
})
