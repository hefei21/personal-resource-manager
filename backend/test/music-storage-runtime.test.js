import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-music-runtime-'))
}

function cleanup(value) {
  fs.rmSync(value, { recursive: true, force: true })
}

test('registers the default music legacy adapter and exposes it through the shared content service', async () => {
  const directory = root()
  const previousMusicPath = process.env.MUSIC_PATH
  try {
    const storageRoot = path.join(directory, 'storage')
    const musicLegacyRoot = path.join(directory, 'music')
    const ebookLegacyRoot = path.join(directory, 'books')
    fs.mkdirSync(musicLegacyRoot)
    fs.mkdirSync(ebookLegacyRoot)
    process.env.MUSIC_PATH = musicLegacyRoot
    const legacyFile = path.join(musicLegacyRoot, 'old.mp3')
    fs.writeFileSync(legacyFile, 'legacy-audio')
    const { createResourceStorageRuntime } = await import('../src/services/resourceStorageRuntime.js?music-default-test')
    const runtime = createResourceStorageRuntime({
      storageRoot,
      ebooksLegacyRoot: ebookLegacyRoot
    })
    assert.deepEqual(runtime.legacyStorageAdapters.music.roots, [fs.realpathSync.native(musicLegacyRoot)])
    assert.equal((await runtime.contentServiceFor('music').stat({ file_path: legacyFile })).bytes, 12)
    const staged = await runtime.storageService.stageFromStream(Readable.from(['managed-audio']))
    const committed = await runtime.storageService.commitStaged({
      token: staged.token,
      kind: 'music',
      expectedSha256: staged.sha256,
      expectedBytes: staged.bytes
    })
    const managed = {
      file_path: path.join(directory, 'not-used-by-storage-first'),
      storage_key: committed.storageKey,
      content_sha256: committed.sha256,
      content_bytes: committed.bytes
    }
    assert.equal((await runtime.contentServiceFor('music').stat(managed)).source, 'storage')
  } finally {
    if (previousMusicPath === undefined) delete process.env.MUSIC_PATH
    else process.env.MUSIC_PATH = previousMusicPath
    cleanup(directory)
  }
})
