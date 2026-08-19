import { categoryCompatibilityFields, normalizeDocumentTags, resolveDocumentCategoryInput } from './documentDomainService.js'

export class DocumentCategoryError extends Error {
  constructor(code, message, options = {}) { super(message, options); this.name = 'DocumentCategoryError'; this.code = code }
}
function fail(code, message, cause) { throw new DocumentCategoryError(code, message, cause ? { cause } : undefined) }
function positiveId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(id) || id <= 0) fail('DOCUMENT_CATEGORY_ID_INVALID', 'Category ID is invalid.')
  return id
}
function databaseCheck(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DOCUMENT_CATEGORY_DATABASE_INVALID', 'Category database is invalid.')
  }
}

export function deleteDocumentCategoryTree(database, rawId) {
  databaseCheck(database); const id = positiveId(rawId)
  return database.transaction(() => {
    const category = database.prepare('SELECT id, parent_id, path FROM categories WHERE id = ?').get(id)
    if (!category) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Category does not exist.')
    const parent = category.parent_id
      ? database.prepare('SELECT id, path FROM categories WHERE id = ?').get(category.parent_id)
      : null
    const compatibility = categoryCompatibilityFields(parent)
    const ids = database.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM categories WHERE id = ?
        UNION ALL SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id
      ) SELECT id FROM subtree
    `).all(id).map((row) => row.id)
    const placeholders = ids.map(() => '?').join(',')
    const moved = database.prepare(`
      UPDATE documents SET category_id = ?, category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
      WHERE category_id IN (${placeholders})
    `).run(parent?.id ?? null, compatibility.category, compatibility.subcategory, ...ids).changes
    const pathParts = category.path.split('/')
    const rootName = pathParts[0]
    const legacyPath = pathParts.slice(1).join('/')
    const legacyMoved = legacyPath === ''
      ? database.prepare(`
          UPDATE documents SET category_id = ?, category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
          WHERE category_id IS NULL AND category = ?
        `).run(parent?.id ?? null, compatibility.category, compatibility.subcategory, rootName).changes
      : database.prepare(`
          UPDATE documents SET category_id = ?, category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
          WHERE category_id IS NULL AND category = ? AND (subcategory = ? OR subcategory LIKE ?)
        `).run(
          parent?.id ?? null,
          compatibility.category,
          compatibility.subcategory,
          rootName,
          legacyPath,
          `${legacyPath}/%`
        ).changes
    database.prepare('DELETE FROM categories WHERE id = ?').run(id)
    return Object.freeze({
      deletedCategories: ids.length,
      movedDocuments: moved + legacyMoved,
      categoryId: parent?.id ?? null
    })
  })()
}

export function renameDocumentCategory(database, rawId, rawName) {
  databaseCheck(database); const id = positiveId(rawId)
  const name = typeof rawName === 'string' ? rawName.normalize('NFKC').trim() : ''
  if (!name || name.includes('/')) fail('DOCUMENT_CATEGORY_NAME_INVALID', 'Category name is invalid.')
  return database.transaction(() => {
    const category = database.prepare('SELECT id, parent_id, path FROM categories WHERE id = ?').get(id)
    if (!category) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Category does not exist.')
    if (database.prepare('SELECT id FROM categories WHERE name = ? AND parent_id IS ? AND id != ?').get(name, category.parent_id, id)) {
      fail('DOCUMENT_CATEGORY_DUPLICATE', 'A sibling category already has this name.')
    }
    const parent = category.parent_id ? database.prepare('SELECT path FROM categories WHERE id = ?').get(category.parent_id) : null
    if (category.parent_id && !parent) fail('DOCUMENT_CATEGORY_PARENT_MISSING', 'Category parent does not exist.')
    const newPath = parent ? `${parent.path}/${name}` : name
    database.prepare('UPDATE categories SET name = ?, path = ? WHERE id = ?').run(name, newPath, id)
    const children = database.prepare('SELECT id, path FROM categories WHERE path LIKE ? ORDER BY level').all(`${category.path}/%`)
    for (const child of children) {
      database.prepare('UPDATE categories SET path = ? WHERE id = ?')
        .run(`${newPath}${child.path.slice(category.path.length)}`, child.id)
    }
    return Object.freeze({ categoryId: id, newPath, updatedDescendants: children.length })
  })()
}

export function updateDocumentMetadata(database, rawId, input = {}) {
  databaseCheck(database); const id = positiveId(rawId)
  const title = typeof input.title === 'string' ? input.title.normalize('NFKC').trim() : ''
  if (!title) fail('DOCUMENT_TITLE_INVALID', 'Document title is invalid.')
  const category = resolveDocumentCategoryInput(database, input)
  const compatibility = categoryCompatibilityFields(category)
  const tags = normalizeDocumentTags(input.tags)
  const result = database.prepare(`
    UPDATE documents SET title = ?, category_id = ?, category = ?, subcategory = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, category?.id ?? null, compatibility.category, compatibility.subcategory, tags.serialized, id)
  if (result.changes !== 1) fail('DOCUMENT_NOT_FOUND', 'Document does not exist.')
  return Object.freeze({ documentId: id, categoryId: category?.id ?? null, tags: tags.values })
}

export function batchUpdateDocumentMetadata(database, rawIds, input = {}) {
  databaseCheck(database)
  if (!Array.isArray(rawIds) || rawIds.length === 0) fail('DOCUMENT_IDS_INVALID', 'Document IDs are invalid.')
  const ids = [...new Set(rawIds.map(positiveId))]
  const category = (input.categoryId !== undefined || input.category !== undefined || input.subcategory !== undefined)
    ? resolveDocumentCategoryInput(database, input) : undefined
  const compatibility = category === undefined ? null : categoryCompatibilityFields(category)
  const tags = input.tags === undefined ? undefined : normalizeDocumentTags(input.tags)
  return database.transaction(() => {
    let count = 0
    for (const id of ids) {
      const fields = ['updated_at = CURRENT_TIMESTAMP']; const params = []
      if (category !== undefined) { fields.push('category_id = ?', 'category = ?', 'subcategory = ?'); params.push(category?.id ?? null, compatibility.category, compatibility.subcategory) }
      if (tags !== undefined) { fields.push('tags = ?'); params.push(tags.serialized) }
      count += database.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`).run(...params, id).changes
    }
    if (count !== ids.length) fail('DOCUMENT_NOT_FOUND', 'One or more documents do not exist.')
    return Object.freeze({ count, categoryId: category?.id ?? null })
  })()
}
