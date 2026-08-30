import path from 'node:path'

export class DocumentPreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DocumentPreviewError'
    this.code = code
  }
}

function invalidRange() {
  throw new DocumentPreviewError('DOCUMENT_CONTENT_RANGE_INVALID', 'Document content range is invalid.')
}

export function parseDocumentByteRange(value, totalBytes) {
  if (value === undefined || value === null || value === '') return null
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || typeof value !== 'string') invalidRange()
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (match[1] === '' && match[2] === '')) invalidRange()

  let start
  let end
  if (match[1] === '') {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || totalBytes === 0) invalidRange()
    start = Math.max(0, totalBytes - suffixLength)
    end = totalBytes - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? totalBytes - 1 : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalBytes) invalidRange()
    end = Math.min(end, totalBytes - 1)
    if (end < start) invalidRange()
  }

  return Object.freeze({ start, end, length: end - start + 1 })
}

export function documentPreviewContentType(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase()
  if (extension === '.pdf') return 'application/pdf'
  return null
}
