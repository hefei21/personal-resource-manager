import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  hashMusicFile,
  musicContentType,
  parseMusicRange
} from '../src/services/musicPlaybackService.js'

test('parses complete, open-ended, explicit, and suffix single-byte ranges', () => {
  assert.equal(parseMusicRange(undefined, 10), null)
  assert.deepEqual(parseMusicRange('bytes=2-5', 10), { start: 2, end: 5, length: 4 })
  assert.deepEqual(parseMusicRange('bytes=2-', 10), { start: 2, end: 9, length: 8 })
  assert.deepEqual(parseMusicRange('bytes=-3', 10), { start: 7, end: 9, length: 3 })
  assert.deepEqual(parseMusicRange('bytes=0-999', 10), { start: 0, end: 9, length: 10 })
})

test('rejects malformed, multiple, and unsatisfiable ranges', () => {
  for (const value of [
    'bytes=',
    'bytes=1-2,4-5',
    'bytes=10-',
    'bytes=8-2',
    'bytes=-0',
    '',
    'items=0-1'
  ]) {
    assert.throws(() => parseMusicRange(value, 10), { code: 'MUSIC_RANGE_INVALID' })
  }
  assert.throws(() => parseMusicRange('bytes=0-', 0), { code: 'MUSIC_RANGE_INVALID' })
})

test('uses safe music content types and hashes local test content', async () => {
  assert.equal(musicContentType('track.mp3'), 'audio/mpeg')
  assert.equal(musicContentType(null, 'flac'), 'audio/flac')
  assert.equal(musicContentType('track.unknown', 'flac'), 'audio/flac')

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-music-playback-'))
  try {
    const filePath = path.join(directory, 'track.mp3')
    fs.writeFileSync(filePath, 'audio-content')
    const metadata = await hashMusicFile(filePath)
    assert.equal(metadata.bytes, 13)
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/u)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
