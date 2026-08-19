import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export class MusicPlaybackError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'MusicPlaybackError'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new MusicPlaybackError(code, message, cause ? { cause } : undefined)
}

function decimal(value) {
  try {
    return BigInt(value)
  } catch (error) {
    fail('MUSIC_RANGE_INVALID', 'Music byte range is invalid.', error)
  }
}

export function parseMusicRange(rangeHeader, size) {
  if (rangeHeader === undefined || rangeHeader === null) return null
  if (!Number.isSafeInteger(size) || size < 0) {
    fail('MUSIC_RANGE_INVALID', 'Music content size is invalid.')
  }

  const match = /^bytes=([0-9]+)?-([0-9]+)?$/u.exec(String(rangeHeader).trim())
  if (!match || (match[1] === undefined && match[2] === undefined) || size === 0) {
    fail('MUSIC_RANGE_INVALID', 'Music byte range is invalid.')
  }

  const contentSize = BigInt(size)
  let start
  let end

  if (match[1] !== undefined) {
    const requestedStart = decimal(match[1])
    if (requestedStart >= contentSize) fail('MUSIC_RANGE_INVALID', 'Music byte range is unsatisfiable.')
    start = Number(requestedStart)

    const requestedEnd = match[2] === undefined ? contentSize - 1n : decimal(match[2])
    if (requestedEnd < requestedStart) fail('MUSIC_RANGE_INVALID', 'Music byte range is invalid.')
    end = Number(requestedEnd >= contentSize ? contentSize - 1n : requestedEnd)
  } else {
    const suffixLength = decimal(match[2])
    if (suffixLength <= 0n) fail('MUSIC_RANGE_INVALID', 'Music byte range is invalid.')
    start = Number(suffixLength >= contentSize ? 0n : contentSize - suffixLength)
    end = size - 1
  }

  return Object.freeze({ start, end, length: end - start + 1 })
}

export function musicContentType(originalName, fileType) {
  const contentTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ape': 'audio/ape'
  }
  const nameExtension = path.extname(path.basename(String(originalName || ''))).toLowerCase()
  const typeExtension = fileType ? `.${String(fileType).replace(/^\./u, '').toLowerCase()}` : ''
  return contentTypes[nameExtension] || contentTypes[typeExtension] || 'audio/mpeg'
}

export async function hashMusicFile(filePath) {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return Object.freeze({ sha256: hash.digest('hex'), bytes })
}
