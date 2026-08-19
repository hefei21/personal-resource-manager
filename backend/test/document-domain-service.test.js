import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
  DocumentContentService,
  categoryCompatibilityFields,
  normalizeDocumentTags,
  resolveDocumentCategory,
  resolveDocumentCategoryInput,
  resolveDocumentContentReference
} from '../src/services/documentDomainService.js'

const hash = 'a'.repeat(64)
const storageKey = `documents/aa/${hash}`

test('normalizes, deduplicates and deterministically sorts document tags', () => {
  assert.deepEqual(normalizeDocumentTags(' Vue,vue,  Node   JS,中文，标签, ,ＡＩ '), {
    values: ['AI', 'Node JS', 'Vue', '中文', '标签'],
    serialized: 'AI,Node JS,Vue,中文,标签'
  })
  assert.deepEqual(normalizeDocumentTags(null), { values: [], serialized: null })
  assert.throws(() => normalizeDocumentTags(['valid', 3]), { code: 'DOCUMENT_TAGS_INVALID' })
  assert.throws(() => normalizeDocumentTags(['valid,ambiguous']), { code: 'DOCUMENT_TAGS_INVALID' })
})

test('resolves legacy category path input to one authoritative category ID', () => {
  const database = {
    prepare(sql) {
      if (sql.includes('WHERE path = ?')) return { get: (value) => value === '技术/前端/Vue' ? { id: 7 } : undefined }
      return { get: (id) => id === 7 ? { id: 7, name: 'Vue', parent_id: 3, path: '技术/前端/Vue', level: 2 } : undefined }
    }
  }
  assert.equal(resolveDocumentCategoryInput(database, { category: '技术', subcategory: '前端/Vue' }).id, 7)
  assert.equal(resolveDocumentCategoryInput(database, {}), null)
  assert.throws(() => resolveDocumentCategoryInput(database, { category: '不存在' }), { code: 'DOCUMENT_CATEGORY_NOT_FOUND' })
  assert.throws(() => resolveDocumentCategoryInput(database, { category: '', subcategory: 'Vue' }), { code: 'DOCUMENT_CATEGORY_PATH_INVALID' })
})

test('prefers complete storage metadata and only falls back when storage_key is absent', () => {
  assert.deepEqual(resolveDocumentContentReference({
    storage_key: storageKey,
    content_sha256: hash,
    content_bytes: 7,
    file_path: '/legacy/ignored.txt'
  }), { source: 'storage', storageKey, sha256: hash, bytes: 7 })
  assert.deepEqual(resolveDocumentContentReference({ storage_key: null, file_path: '/legacy/doc.txt' }), {
    source: 'legacy', filePath: '/legacy/doc.txt'
  })
  assert.throws(() => resolveDocumentContentReference({
    storage_key: storageKey, content_sha256: null, content_bytes: null, file_path: '/legacy/doc.txt'
  }), { code: 'DOCUMENT_STORAGE_METADATA_INCOMPLETE' })
  assert.throws(() => resolveDocumentContentReference({ storage_key: null, file_path: null }), {
    code: 'DOCUMENT_CONTENT_REFERENCE_MISSING'
  })
})

test('rejects malformed or mismatched storage metadata without legacy fallback', () => {
  assert.throws(() => resolveDocumentContentReference({
    storage_key: 'documents/not-a-key', content_sha256: hash, content_bytes: 1, file_path: '/legacy/doc.txt'
  }), { code: 'DOCUMENT_STORAGE_METADATA_INVALID' })
  assert.throws(() => resolveDocumentContentReference({
    storage_key: storageKey, content_sha256: 'b'.repeat(64), content_bytes: 1, file_path: '/legacy/doc.txt'
  }), { code: 'DOCUMENT_STORAGE_METADATA_MISMATCH' })
  assert.throws(() => resolveDocumentContentReference({
    storage_key: `books/aa/${hash}`, content_sha256: hash, content_bytes: 1
  }), { code: 'DOCUMENT_STORAGE_KIND_INVALID' })
})

test('delegates storage and legacy reads through one content interface', async () => {
  const calls = []
  const service = new DocumentContentService({
    storageService: {
      async stat(key) { calls.push(['storage-stat', key]); return { storageKey: key, sha256: hash, bytes: 7, modifiedAt: 'new' } },
      async createReadStream(key, range) { calls.push(['storage-read', key, range]); return Readable.from(['new']) }
    },
    legacyStorageAdapter: {
      stat(filePath) { calls.push(['legacy-stat', filePath]); return { bytes: 3, modifiedAt: 'old', filePath } },
      createReadStream(filePath, range) { calls.push(['legacy-read', filePath, range]); return Readable.from(['old']) }
    }
  })
  assert.deepEqual(await service.stat({ storage_key: storageKey, content_sha256: hash, content_bytes: 7 }), {
    source: 'storage', storageKey, sha256: hash, bytes: 7, modifiedAt: 'new'
  })
  assert.equal((await service.createReadStream({ file_path: '/legacy/doc.txt' }, { start: 0, end: 2 })).source, 'legacy')
  assert.deepEqual(calls, [
    ['storage-stat', storageKey],
    ['legacy-read', '/legacy/doc.txt', { start: 0, end: 2 }]
  ])
})

test('maps storage failures to stable document error semantics', async () => {
  const service = new DocumentContentService({
    storageService: {
      async stat() { throw Object.assign(new Error('internal path'), { code: 'STORAGE_OBJECT_MISSING' }) },
      async createReadStream() { throw Object.assign(new Error('bad range'), { code: 'STORAGE_RANGE_INVALID' }) }
    },
    legacyStorageAdapter: { stat() {}, createReadStream() {} }
  })
  await assert.rejects(service.stat({ storage_key: storageKey, content_sha256: hash, content_bytes: 7 }), {
    code: 'DOCUMENT_CONTENT_MISSING'
  })
  await assert.rejects(service.createReadStream(
    { storage_key: storageKey, content_sha256: hash, content_bytes: 7 }, { start: 9, end: 10 }
  ), { code: 'DOCUMENT_CONTENT_RANGE_INVALID' })
})

test('resolves one authoritative category and derives legacy compatibility fields', () => {
  const database = {
    prepare(sql) {
      assert.match(sql, /FROM categories WHERE id = \?/u)
      return { get: (id) => id === 7 ? { id: 7, name: 'Vue', parent_id: 3, path: '技术/前端/Vue', level: 2 } : undefined }
    }
  }
  const category = resolveDocumentCategory(database, '7')
  assert.deepEqual(category, { id: 7, name: 'Vue', parentId: 3, path: '技术/前端/Vue', level: 2 })
  assert.deepEqual(categoryCompatibilityFields(category), { category: '技术', subcategory: '前端/Vue' })
  assert.deepEqual(categoryCompatibilityFields(null), { category: null, subcategory: null })
  assert.throws(() => resolveDocumentCategory(database, 0), { code: 'DOCUMENT_CATEGORY_ID_INVALID' })
  assert.throws(() => resolveDocumentCategory(database, 99), { code: 'DOCUMENT_CATEGORY_NOT_FOUND' })
  assert.throws(() => resolveDocumentCategory({ prepare: () => ({
    get: () => ({ id: 7, name: 'Vue', parent_id: 3, path: '', level: 2 })
  }) }, 7), { code: 'DOCUMENT_CATEGORY_INVALID' })
})
