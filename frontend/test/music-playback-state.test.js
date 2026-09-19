import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQueue, nextQueueIndex, playbackSnapshot, readPlaybackSnapshot } from '../src/utils/musicPlaybackState.js'

test('queue normalizes stable IDs and never retains file paths or artwork', () => {
  const queue = normalizeQueue([{ id: 1, title: 'A', file_path: '/private', cover: 'blob:private' }, { id: '1' }, { id: -1 }, null])
  assert.equal(queue.length, 1)
  assert.equal(queue[0].id, 1)
  assert.equal(queue[0].file_path, undefined)
  assert.equal(queue[0].cover, undefined)
})
test('queue navigation wraps and shuffle excludes the current song', () => {
  assert.equal(nextQueueIndex(0, 3, -1), 2)
  assert.equal(nextQueueIndex(2, 3), 0)
  assert.equal(nextQueueIndex(0, 0), -1)
  for (const random of [0, .5, 1]) assert.notEqual(nextQueueIndex(2, 4, 1, true, () => random), 2)
})
test('snapshots preserve zero volume and current track within bounded queue', () => {
  const value = playbackSnapshot(Array.from({ length: 600 }, (_, i) => ({ id: i + 1 })), 600, 15, 0, 'shuffle', 100)
  assert.equal(value.queue.length, 500)
  assert.equal(value.volume, 0)
  assert.ok(value.queue.some(song => song.id === 600))
  assert.deepEqual(readPlaybackSnapshot(JSON.stringify(value), 200), value)
  assert.equal(value.playing, undefined)
})
test('malformed, expired and unsupported snapshots fail closed', () => {
  for (const value of ['{', 'null', '{"version":2}', '{"version":1,"savedAt":0}']) assert.equal(readPlaybackSnapshot(value, 31 * 86400000), null)
  const value = playbackSnapshot([], null, Infinity, NaN, 'unexpected', 100)
  assert.equal(value.position, 0)
  assert.equal(value.volume, 80)
  assert.equal(value.mode, 'sequence')
})
