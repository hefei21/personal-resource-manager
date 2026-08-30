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

function categoryName(value) {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim() : ''
  if (!name || name.length > 100 || name.includes('/') || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail('DOCUMENT_CATEGORY_NAME_INVALID', 'Category name is invalid.')
  }
  return name
}

function activeDocumentIds(database, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Object.freeze([])
  const unique = [...new Set(ids)]
  const hasTrashTable = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resource_trash_entries'"
  ).get())
  if (!hasTrashTable) return Object.freeze(unique.sort((left, right) => left - right))
  const placeholders = unique.map(() => '?').join(',')
  return Object.freeze(database.prepare(`
    SELECT d.id
    FROM documents d
    WHERE d.id IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM resource_trash_entries t
        WHERE t.resource_type = 'document' AND t.resource_id = d.id
      )
    ORDER BY d.id
  `).all(...unique).map((row) => Number(row.id)))
}

function documentIdsByCategoryIds(database, ids) {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return database.prepare(`SELECT id FROM documents WHERE category_id IN (${placeholders}) ORDER BY id`)
    .all(...ids).map((row) => Number(row.id))
}

function legacyPathFields(path) {
  const parts = path.split('/')
  return Object.freeze({ category: parts[0], subcategory: parts.slice(1).join('/') || null })
}

function legacyDocumentIds(database, path, subtree = false) {
  const fields = legacyPathFields(path)
  if (fields.subcategory === null) {
    return database.prepare(`
      SELECT id FROM documents
      WHERE category_id IS NULL AND category = ?
    `).all(fields.category).map((row) => Number(row.id))
  }
  const sql = subtree
    ? `SELECT id FROM documents WHERE category_id IS NULL AND category = ? AND (subcategory = ? OR subcategory LIKE ?)`
    : `SELECT id FROM documents WHERE category_id IS NULL AND category = ? AND subcategory = ?`
  const params = subtree
    ? [fields.category, fields.subcategory, `${fields.subcategory}/%`]
    : [fields.category, fields.subcategory]
  return database.prepare(sql).all(...params).map((row) => Number(row.id))
}

export function createDocumentCategory(database, input = {}) {
  databaseCheck(database)
  const name = categoryName(input.name)
  const parentId = input.parentId === undefined || input.parentId === null || input.parentId === ''
    ? null
    : positiveId(input.parentId)
  return database.transaction(() => {
    const parent = parentId === null
      ? null
      : database.prepare('SELECT id, path, level FROM categories WHERE id = ?').get(parentId)
    if (parentId !== null && !parent) fail('DOCUMENT_CATEGORY_PARENT_MISSING', 'Category parent does not exist.')
    if (database.prepare('SELECT id FROM categories WHERE name = ? AND parent_id IS ?').get(name, parentId)) {
      fail('DOCUMENT_CATEGORY_DUPLICATE', 'A sibling category already has this name.')
    }
    const path = parent ? `${parent.path}/${name}` : name
    const level = parent ? Number(parent.level) + 1 : 0
    const inserted = database.prepare(`
      INSERT INTO categories (name, parent_id, path, level) VALUES (?, ?, ?, ?)
    `).run(name, parentId, path, level)
    return Object.freeze({ categoryId: Number(inserted.lastInsertRowid), path, level })
  })()
}

export function reorderDocumentCategories(database, rawOrders) {
  databaseCheck(database)
  if (!Array.isArray(rawOrders) || rawOrders.length === 0 || rawOrders.length > 1000) {
    fail('DOCUMENT_CATEGORY_ORDER_INVALID', 'Category order is invalid.')
  }
  const seen = new Set()
  const orders = rawOrders.map((item) => {
    const id = positiveId(item?.id)
    const sortOrder = item?.sortOrder
    if (seen.has(id) || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
      fail('DOCUMENT_CATEGORY_ORDER_INVALID', 'Category order is invalid.')
    }
    seen.add(id)
    return Object.freeze({ id, sortOrder })
  })
  return database.transaction(() => {
    const rows = orders.map((item) => database.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(item.id))
    if (rows.some((row) => !row)) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Category does not exist.')
    const parentKey = rows[0].parent_id ?? null
    if (rows.some((row) => (row.parent_id ?? null) !== parentKey)) {
      fail('DOCUMENT_CATEGORY_ORDER_INVALID', 'Only sibling categories can be reordered together.')
    }
    const update = database.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
    for (const item of orders) update.run(item.sortOrder, item.id)
    return Object.freeze({ count: orders.length, parentId: parentKey })
  })()
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
    const affectedIds = [
      ...documentIdsByCategoryIds(database, ids),
      ...legacyDocumentIds(database, category.path, true)
    ]
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
      categoryId: parent?.id ?? null,
      activeDocumentIds: activeDocumentIds(database, affectedIds)
    })
  })()
}

export function renameDocumentCategory(database, rawId, rawName) {
  databaseCheck(database); const id = positiveId(rawId)
  const name = categoryName(rawName)
  return database.transaction(() => {
    const category = database.prepare('SELECT id, parent_id, path FROM categories WHERE id = ?').get(id)
    if (!category) fail('DOCUMENT_CATEGORY_NOT_FOUND', 'Category does not exist.')
    if (database.prepare('SELECT id FROM categories WHERE name = ? AND parent_id IS ? AND id != ?').get(name, category.parent_id, id)) {
      fail('DOCUMENT_CATEGORY_DUPLICATE', 'A sibling category already has this name.')
    }
    const parent = category.parent_id ? database.prepare('SELECT path FROM categories WHERE id = ?').get(category.parent_id) : null
    if (category.parent_id && !parent) fail('DOCUMENT_CATEGORY_PARENT_MISSING', 'Category parent does not exist.')
    const newPath = parent ? `${parent.path}/${name}` : name
    const children = database.prepare('SELECT id, path FROM categories WHERE path LIKE ? ORDER BY level').all(`${category.path}/%`)
    const subtree = [{ id: category.id, path: category.path }, ...children]
    const affectedIds = legacyDocumentIds(database, category.path, true)
    for (const entry of subtree) {
      const nextPath = entry.id === category.id
        ? newPath
        : `${newPath}${entry.path.slice(category.path.length)}`
      affectedIds.push(...documentIdsByCategoryIds(database, [entry.id]))
      if (entry.id === category.id) {
        database.prepare('UPDATE categories SET name = ?, path = ? WHERE id = ?').run(name, nextPath, entry.id)
      } else {
        database.prepare('UPDATE categories SET path = ? WHERE id = ?').run(nextPath, entry.id)
      }
      const compatibility = categoryCompatibilityFields({ id: entry.id, path: nextPath })
      database.prepare(`
        UPDATE documents
        SET category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
        WHERE category_id = ?
      `).run(compatibility.category, compatibility.subcategory, entry.id)
      const oldFields = legacyPathFields(entry.path)
      database.prepare(`
        UPDATE documents
        SET category_id = ?, category = ?, subcategory = ?, updated_at = CURRENT_TIMESTAMP
        WHERE category_id IS NULL AND category = ? AND subcategory IS ?
      `).run(
        entry.id,
        compatibility.category,
        compatibility.subcategory,
        oldFields.category,
        oldFields.subcategory
      )
    }
    // Preserve unmigrated deeper legacy paths by replacing only the renamed prefix.
    const oldCompatibility = legacyPathFields(category.path)
    const newCompatibility = legacyPathFields(newPath)
    if (oldCompatibility.subcategory === null) {
      database.prepare(`
        UPDATE documents
        SET category = ?, updated_at = CURRENT_TIMESTAMP
        WHERE category_id IS NULL AND category = ?
      `).run(newCompatibility.category, oldCompatibility.category)
    } else {
      database.prepare(`
        UPDATE documents
        SET category = ?,
            subcategory = ? || substr(subcategory, length(?) + 1),
            updated_at = CURRENT_TIMESTAMP
        WHERE category_id IS NULL AND category = ?
          AND (subcategory = ? OR subcategory LIKE ?)
      `).run(
        newCompatibility.category,
        newCompatibility.subcategory,
        oldCompatibility.subcategory,
        oldCompatibility.category,
        oldCompatibility.subcategory,
        `${oldCompatibility.subcategory}/%`
      )
    }
    return Object.freeze({
      categoryId: id,
      newPath,
      updatedDescendants: children.length,
      activeDocumentIds: activeDocumentIds(database, affectedIds)
    })
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
