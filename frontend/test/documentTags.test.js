import assert from 'node:assert/strict'
import test from 'node:test'

import { documentTagsLabel, normalizeDocumentTags } from '../src/utils/documentTags.js'

test('document tags accept the backend JSON representation and legacy values', () => {
  assert.deepEqual(normalizeDocumentTags('["PDF","中文"]'), ['PDF', '中文'])
  assert.deepEqual(normalizeDocumentTags('PDF, 中文'), ['PDF', '中文'])
  assert.deepEqual(normalizeDocumentTags([' PDF ', '中文']), ['PDF', '中文'])
  assert.deepEqual(normalizeDocumentTags(null), [])
})

test('document tag labels are readable without serialized JSON punctuation', () => {
  assert.equal(documentTagsLabel('["PDF","中文"]'), 'PDF、中文')
})
