import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

import { inspectContent } from '../src/contentInspector.js'

test('content inspector returns deterministic bounded measurements', async () => {
  const content = Buffer.from('a\r\nb\0c\n', 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const result = await inspectContent(Readable.from([content.subarray(0, 3), content.subarray(3)]), {
    sha256,
    bytes: content.length
  })
  assert.deepEqual(result.output, {
    sha256,
    bytes: content.length,
    nulBytes: 1,
    lineFeedBytes: 2,
    carriageReturnBytes: 1,
    utf8Valid: true
  })
})

test('content inspector rejects tampered input and marks invalid UTF-8', async () => {
  const content = Buffer.from([0xc3, 0x28])
  const sha256 = createHash('sha256').update(content).digest('hex')
  const result = await inspectContent(Readable.from(content), { sha256, bytes: content.length })
  assert.equal(result.output.utf8Valid, false)
  await assert.rejects(
    inspectContent(Readable.from(content), { sha256: '0'.repeat(64), bytes: content.length }),
    (error) => error.code === 'WORKER_INPUT_MISMATCH' && error.retryable === false
  )
})
