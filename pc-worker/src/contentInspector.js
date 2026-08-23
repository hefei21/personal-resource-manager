import { createHash } from 'node:crypto'

export async function inspectContent(stream, expected) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw Object.assign(new Error('Authorized content stream is unavailable.'), { code: 'WORKER_INPUT_STREAM_INVALID', retryable: true })
  }
  const hash = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let nulBytes = 0
  let lineFeedBytes = 0
  let carriageReturnBytes = 0
  let utf8Valid = true
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    hash.update(chunk)
    for (const byte of chunk) {
      if (byte === 0) nulBytes += 1
      else if (byte === 10) lineFeedBytes += 1
      else if (byte === 13) carriageReturnBytes += 1
    }
    if (utf8Valid) {
      try { decoder.decode(chunk, { stream: true }) } catch { utf8Valid = false }
    }
  }
  if (utf8Valid) {
    try { decoder.decode() } catch { utf8Valid = false }
  }
  const sha256 = hash.digest('hex')
  if (sha256 !== expected.sha256 || bytes !== expected.bytes) {
    throw Object.assign(new Error('Downloaded content does not match its authorized identity.'), {
      code: 'WORKER_INPUT_MISMATCH',
      retryable: false
    })
  }
  return {
    schemaVersion: 1,
    processorVersion: 'v1',
    implementation: { name: 'builtin-content-inspector', version: '1' },
    input: { sha256, bytes },
    output: { sha256, bytes, nulBytes, lineFeedBytes, carriageReturnBytes, utf8Valid }
  }
}
