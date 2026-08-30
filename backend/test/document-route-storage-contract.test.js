import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(directory, '..', 'src', 'routes', 'documents.js'), 'utf8')

test('ordinary document deletion is owner-write protected and uses the trash service', () => {
  assert.match(source, /router\.delete\('\/:id', authenticateToken, requireWritePermission,/u)
  assert.match(source, /const database = getDatabase\(\)[\s\S]*softDeleteDocument\(\{ database, id: req\.params\.id \}\)/u)
  assert.match(source, /invalidateRagSource\(database,[\s\S]*reasonCode: 'RAG_SOURCE_TRASHED'/u)
  const ordinaryDelete = source.slice(source.indexOf("router.delete('/:id'"), source.indexOf('// 私密空间'))
  assert.doesNotMatch(ordinaryDelete, /unlinkSync|DELETE FROM documents|DELETE FROM document_versions/u)
})

test('document list excludes unified trash entries and permanent deletion is explicit', () => {
  assert.match(source, /NOT EXISTS \(\s*SELECT 1 FROM resource_trash_entries/u)
  assert.match(source, /router\.get\('\/trash', authenticateToken,/u)
  assert.match(source, /router\.post\('\/trash\/:id\/restore', authenticateToken, requireWritePermission,/u)
  assert.match(source, /router\.delete\('\/trash\/:id', authenticateToken, requireWritePermission,/u)
})

test('category mutations use transactional domain services and cannot delete document content', () => {
  const categoryDelete = source.slice(source.indexOf("router.delete('/categories/:id'"), source.indexOf("router.put('/categories/reorder'"))
  assert.match(categoryDelete, /deleteDocumentCategoryTree/u)
  assert.doesNotMatch(categoryDelete, /deleteFiles|unlinkSync|DELETE FROM documents|DELETE FROM document_versions/u)
  const categoryRename = source.slice(source.indexOf("router.put('/categories/:id'"), source.indexOf('// 检查文档重名'))
  assert.match(categoryRename, /renameDocumentCategory/u)
  assert.doesNotMatch(categoryRename, /UPDATE documents/u)
})

test('document list uses stable category IDs and exposes them to the client', () => {
  assert.match(source, /const \{ keyword, categoryId,[\s\S]*includeSubcategories/u)
  assert.match(source, /resolveDocumentCategory\(db, categoryId\)/u)
  assert.match(source, /categoryId: row\.category_id/u)
})

test('PDF preview is authenticated, range-aware and streamed without base64 buffering', () => {
  const preview = source.slice(source.indexOf("router.get('/preview/:id'"), source.indexOf('// 获取文档内容用于编辑或预览'))
  assert.match(preview, /authenticateToken/u)
  assert.match(preview, /parseDocumentByteRange\(req\.headers\.range/u)
  assert.match(preview, /Accept-Ranges/u)
  assert.match(preview, /Content-Range/u)
  assert.match(preview, /createReadStream\(document, range \|\| \{\}\)/u)
  assert.match(preview, /stream\.pipe\(res\)/u)
  assert.doesNotMatch(preview, /toString\('base64'\)|readDocumentBuffer/u)
})
