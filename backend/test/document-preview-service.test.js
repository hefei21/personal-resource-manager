import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  documentPreviewContentType,
  parseDocumentByteRange
} from '../src/services/documentPreviewService.js'

test('parses standard, open-ended and suffix document byte ranges', () => {
  assert.deepEqual(parseDocumentByteRange(undefined, 100), null)
  assert.deepEqual(parseDocumentByteRange('bytes=10-19', 100), { start: 10, end: 19, length: 10 })
  assert.deepEqual(parseDocumentByteRange('bytes=90-', 100), { start: 90, end: 99, length: 10 })
  assert.deepEqual(parseDocumentByteRange('bytes=-8', 100), { start: 92, end: 99, length: 8 })
  assert.deepEqual(parseDocumentByteRange('bytes=90-200', 100), { start: 90, end: 99, length: 10 })
})

test('rejects invalid or multipart document byte ranges', () => {
  for (const value of ['bytes=', 'bytes=100-101', 'bytes=20-10', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.throws(() => parseDocumentByteRange(value, 100), { code: 'DOCUMENT_CONTENT_RANGE_INVALID' })
  }
})

test('only exposes the supported inline PDF content type', () => {
  assert.equal(documentPreviewContentType('guide.PDF'), 'application/pdf')
  assert.equal(documentPreviewContentType('guide.docx'), null)
})
