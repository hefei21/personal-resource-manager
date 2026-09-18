import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEbookReadingProgressSync,
  deriveEbookChapterFraction,
  deriveWeightedEbookChapterFraction,
  EbookProgressConflictError,
  isEbookCfiForChapter
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
  const first = sync.queue({ currentPage: 2, progress: 10, chapterFraction: 0.25, cfi: 'cfi-2', fontSize: 18 })
  const second = sync.queue({ currentPage: 3, progress: 14, chapterFraction: 0.6, cfi: 'cfi-3', fontSize: 18 })
  await Promise.all([first, second])
  assert.equal(writes.length, 2)
  assert.equal(writes[0].revision, 0)
  assert.equal(writes[1].revision, 1)
  assert.equal(writes[1].chapterFraction, 0.6)
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
  await assert.rejects(first.queue({ currentPage: 4, progress: 22, chapterFraction: 0.45, cfi: 'pending-cfi' }), /offline/u)
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
  const restored = await resumed.load()
  assert.equal(restored.currentPage, 4)
  assert.equal(restored.chapterFraction, 0.45)
  await resumed.flush()
  assert.equal(resumedWrites.length, 1)
  assert.equal(resumed.remote.currentPage, 4)
  assert.equal(resumed.remote.chapterFraction, 0.45)
  assert.equal(resumed.remote.revision, 3)
})

test('pending local position cannot silently replace a newer device position', async () => {
  const local = storage()
  local.setItem('pr-manager:ebook-progress-pending:v1:12', JSON.stringify({ position: { currentPage: 2, progress: 28, chapterFraction: 0.8 }, baseRevision: 1, mutationId: 'pending' }))
  let writes = 0
  const sync = createEbookReadingProgressSync({ bookId: 12, storage: local, api: {
    getProgress: async () => ({ data: { currentPage: 6, progress: 63, chapterFraction: 0.3, revision: 2 } }),
    saveProgress: async () => { writes += 1; throw new Error('unexpected write') }
  } })
  const restored = await sync.load()
  assert.equal(restored.currentPage, 6)
  assert.equal(sync.conflict.local.chapterFraction, 0.8)
  assert.equal(writes, 0)
  const chosen = await sync.resolveConflict('remote')
  assert.equal(chosen.revision, 2)
  assert.equal(local.getItem('pr-manager:ebook-progress-pending:v1:12'), null)
})

test('overall progress provides a stable chapter-relative fallback locator', () => {
  assert.ok(Math.abs(deriveEbookChapterFraction(38, 14, 37) - 0.06) < 1e-9)
  assert.equal(deriveEbookChapterFraction(100, 36, 37), 1)
  assert.equal(deriveEbookChapterFraction(0, 0, 37), 0)
  assert.equal(deriveWeightedEbookChapterFraction(50, 1, [10, 30, 60]), null)
  assert.ok(Math.abs(deriveWeightedEbookChapterFraction(25, 1, [10, 30, 60]) - 0.5) < 1e-9)
  assert.equal(isEbookCfiForChapter('epubcfi([chapter-15]!/1/2/1:8)', 'chapter-15'), true)
  assert.equal(isEbookCfiForChapter('epubcfi(/29/1:8)', 'chapter-15'), false)
  assert.equal(isEbookCfiForChapter('epubcfi([chapter-14]!/1)', 'chapter-15'), false)
})
