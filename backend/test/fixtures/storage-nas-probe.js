import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { StorageService } from '../../src/services/storageService.js'

const mountRoot = process.env.STORAGE_NAS_TEST_ROOT

test('verifies storage commit, deduplication, range read, trash, and restore on a NAS mount', async () => {
  assert.ok(path.isAbsolute(mountRoot ?? ''), 'STORAGE_NAS_TEST_ROOT must be an absolute mounted path')
  const runRoot = fs.mkdtempSync(path.join(mountRoot, 'storage-probe-'))
  try {
    const service = new StorageService({ rootPath: runRoot })
    const first = await service.stageFromStream(Readable.from(['nas-storage-probe']))
    const committed = await service.commitStaged({
      token: first.token,
      kind: 'documents',
      expectedSha256: first.sha256,
      expectedBytes: first.bytes
    })
    assert.equal(committed.reused, false)

    const second = await service.stageFromStream(Readable.from(['nas-storage-probe']))
    const reused = await service.commitStaged({ token: second.token, kind: 'documents' })
    assert.equal(reused.reused, true)
    assert.equal(reused.storageKey, committed.storageKey)

    const chunks = []
    for await (const chunk of await service.createReadStream(committed.storageKey, { start: 4, end: 10 })) {
      chunks.push(chunk)
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'storage')

    const trashed = await service.trashObject({
      storageKey: committed.storageKey,
      activeReferenceCount: 0
    })
    await assert.rejects(service.stat(committed.storageKey), { code: 'STORAGE_OBJECT_MISSING' })

    const restored = await service.restoreTrashed(trashed.trashToken)
    assert.equal(restored.storageKey, committed.storageKey)
    assert.equal((await service.stat(restored.storageKey)).sha256, first.sha256)
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true })
  }
})
