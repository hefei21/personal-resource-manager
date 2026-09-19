import { createHash } from 'node:crypto'
import { load } from 'cheerio'

export class BookmarkError extends Error {
  constructor(status, message, details = {}) {
    super(message)
    this.status = status
    this.details = details
  }
}
const active =
  "NOT EXISTS (SELECT 1 FROM resource_trash_entries t WHERE t.resource_type = 'bookmark' AND t.resource_id = b.id)"
export function bookmarkUrl(value) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new BookmarkError(400, '请输入有效链接（最长 4096 字）')
  let text = value.trim()
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new BookmarkError(400, '链接格式不正确')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw new BookmarkError(400, '仅支持不含账号密码的 HTTP/HTTPS 链接')
  return parsed.href
}
export function bookmarkTags(value) {
  let tags = value || []
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags)
    } catch {
      tags = tags.split(',')
    }
  }
  if (
    !Array.isArray(tags) ||
    tags.length > 30 ||
    tags.some((t) => typeof t !== 'string' || t.length > 80)
  )
    throw new BookmarkError(400, '标签最多 30 个，每个不超过 80 字')
  return [
    ...new Set(tags.map((t) => t.normalize('NFKC').trim()).filter(Boolean)),
  ]
}
const textField = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max)
    throw new BookmarkError(400, `${label}不能超过 ${max} 字`)
  return value.trim()
}
export function safeBookmarkIcon(value) {
  return typeof value === 'string' &&
    value.length <= 140000 &&
    /^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i.test(
      value,
    )
    ? value
    : null
}
export function bookmarkForm(input) {
  const url = bookmarkUrl(input.url)
  return {
    title: textField(input.title || new URL(url).hostname, 300, '名称'),
    url,
    category: textField(input.category || '', 120, '分类'),
    tags: bookmarkTags(input.tags),
    description: textField(input.description || '', 5000, '备注'),
    icon_data: safeBookmarkIcon(input.iconData ?? input.icon_data),
  }
}
export const bookmarkVersion = (row) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        row.title,
        row.url,
        row.category || '',
        bookmarkTags(row.tags),
        row.description || '',
        row.icon_data || null,
      ]),
    )
    .digest('hex')
const project = (row) => ({
  ...row,
  icon: undefined,
  tags: bookmarkTags(row.tags),
  icon_data: safeBookmarkIcon(row.icon_data),
  version: bookmarkVersion(row),
})
export function getBookmark(db, id) {
  const row = db
    .prepare(`SELECT b.* FROM bookmarks b WHERE b.id = ? AND ${active}`)
    .get(id)
  if (!row) throw new BookmarkError(404, '书签不存在或已移入回收站')
  return project(row)
}
export function duplicateBookmarks(db, url, exclude = 0) {
  const key = bookmarkUrl(url)
  return db
    .prepare(
      `SELECT b.id, b.url, b.title FROM bookmarks b WHERE b.id != ? AND ${active}`,
    )
    .all(exclude)
    .filter((row) => {
      try {
        return bookmarkUrl(row.url) === key
      } catch {
        return false
      }
    })
    .map(({ id, title }) => ({ id, title }))
}
const registered = new WeakSet()
export function listBookmarks(db, query = {}) {
  if (!registered.has(db)) {
    db.function('bookmark_has_tag', { deterministic: true }, (stored, tag) => {
      try {
        return Number(bookmarkTags(stored).includes(tag))
      } catch {
        return 0
      }
    })
    registered.add(db)
  }
  const page = Number(query.page || 1),
    pageSize = Number(query.pageSize || 24)
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new BookmarkError(400, '分页参数无效')
  const clauses = [active],
    params = []
  if (query.keyword) {
    const term =
      '%' +
      String(query.keyword)
        .slice(0, 200)
        .replace(/[\\%_]/g, '\\$&') +
      '%'
    clauses.push(
      "(b.title LIKE ? ESCAPE '\\' OR b.url LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\')",
    )
    params.push(term, term, term)
  }
  if (query.category) {
    clauses.push("COALESCE(b.category, '') = ?")
    params.push(query.category === '__unfiled' ? '' : query.category)
  }
  if (query.tag) {
    clauses.push('bookmark_has_tag(b.tags, ?) = 1')
    params.push(String(query.tag))
  }
  const where = clauses.join(' AND '),
    total = db
      .prepare(`SELECT COUNT(*) AS n FROM bookmarks b WHERE ${where}`)
      .get(...params).n
  const order =
    query.sortBy === 'title'
      ? 'b.title COLLATE NOCASE'
      : query.sortBy === 'created_at'
        ? 'b.created_at'
        : 'b.updated_at'
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC'
  const data = db
    .prepare(
      `SELECT b.* FROM bookmarks b WHERE ${where} ORDER BY ${order} ${direction}, b.id ${direction} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(project)
  return { data, total, page, pageSize }
}
export function bookmarkMetadata(db) {
  const rows = db
      .prepare(`SELECT b.category, b.tags FROM bookmarks b WHERE ${active}`)
      .all(),
    categories = new Map(),
    tags = new Map()
  for (const row of rows) {
    if (row.category)
      categories.set(row.category, (categories.get(row.category) || 0) + 1)
    for (const tag of bookmarkTags(row.tags))
      tags.set(tag, (tags.get(tag) || 0) + 1)
  }
  return {
    categories: [...categories]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tags: [...tags]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    total: rows.length,
  }
}
export function saveBookmark(db, input, id = null) {
  return db.transaction(() => {
    const form = bookmarkForm(input)
    if (id) {
      const current = getBookmark(db, id)
      if (input.baseVersion !== current.version)
        throw new BookmarkError(409, '书签已在其他位置修改，本机输入已保留', {
          current,
        })
    }
    const duplicates = duplicateBookmarks(db, form.url, id || 0)
    if (duplicates.length && input.allowDuplicate !== true)
      throw new BookmarkError(409, '已有相同链接，是否仍保存为独立书签？', {
        duplicates,
      })
    const values = [
      form.title,
      form.url,
      form.category,
      JSON.stringify(form.tags),
      form.description,
      form.icon_data,
    ]
    if (id)
      db.prepare(
        "UPDATE bookmarks SET title=?,url=?,category=?,tags=?,description=?,icon_data=?,icon='',updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).run(...values, id)
    else
      id = Number(
        db
          .prepare(
            "INSERT INTO bookmarks(title,url,category,tags,description,icon_data,icon) VALUES(?,?,?,?,?,?,'')",
          )
          .run(...values).lastInsertRowid,
      )
    return getBookmark(db, id)
  })()
}
export function trashBookmarks(db, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new BookmarkError(400, '请选择 1–100 项书签')
  return db.transaction(() => {
    for (const id of new Set(ids)) {
      getBookmark(db, id)
      db.prepare(
        "INSERT INTO resource_trash_entries(resource_type,resource_id,deleted_at,purge_after,metadata_json) VALUES('bookmark',?,?,?,?)",
      ).run(
        id,
        new Date().toISOString(),
        new Date(Date.now() + 30 * 86400000).toISOString(),
        '{"state":"deleted"}',
      )
    }
    return { count: new Set(ids).size }
  })()
}
export function restoreBookmarkFromTrash({ database: db, id }) {
  return db.transaction(() => {
    if (
      !db.prepare('SELECT id FROM bookmarks WHERE id=?').get(id) ||
      !db
        .prepare(
          "DELETE FROM resource_trash_entries WHERE resource_type='bookmark' AND resource_id=?",
        )
        .run(id).changes
    )
      throw Object.assign(new Error('Bookmark not in trash'), {
        code: 'BOOKMARK_TRASH_NOT_FOUND',
      })
    return { id }
  })()
}
export function permanentlyDeleteBookmark({ database: db, id }) {
  return db.transaction(() => {
    if (
      !db
        .prepare(
          "DELETE FROM resource_trash_entries WHERE resource_type='bookmark' AND resource_id=?",
        )
        .run(id).changes
    )
      throw Object.assign(new Error('Bookmark not in trash'), {
        code: 'BOOKMARK_TRASH_NOT_FOUND',
      })
    db.prepare('DELETE FROM bookmarks WHERE id=?').run(id)
    return { id }
  })()
}
export function previewBookmarkImport(db, content, format) {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content) > 2 * 1024 * 1024
  )
    throw new BookmarkError(400, '导入文件不能超过 2 MB')
  let source
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content)
      source = Array.isArray(parsed) ? parsed : parsed.bookmarks
    } catch {
      throw new BookmarkError(400, 'JSON 文件格式不正确')
    }
  } else {
    const $ = load(content)
    source = $('a[href]')
      .toArray()
      .map((el) => ({
        url: $(el).attr('href'),
        title: $(el).text(),
        category: $(el).parents('dl').first().prevAll('h3').first().text(),
        tags: $(el).attr('tags') || '',
        description: $(el).parent().next('dd').text(),
      }))
  }
  if (!Array.isArray(source) || !source.length || source.length > 500)
    throw new BookmarkError(400, '每次导入 1–500 条书签')
  const seen = new Set()
  return source.map((row, index) => {
    try {
      const form = bookmarkForm(row),
        duplicates = duplicateBookmarks(db, form.url)
      const duplicate = seen.has(form.url) || duplicates.length > 0
      seen.add(form.url)
      return { index, form, duplicate, duplicates }
    } catch (error) {
      return { index, error: error.message }
    }
  })
}
export function importBookmarks(db, items) {
  if (!Array.isArray(items) || !items.length || items.length > 500)
    throw new BookmarkError(400, '每次确认导入 1–500 条书签')
  return db.transaction(() => {
    let imported = 0,
      skipped = 0
    for (const item of items) {
      const form = bookmarkForm(item)
      if (duplicateBookmarks(db, form.url).length) {
        skipped++
        continue
      }
      saveBookmark(db, form)
      imported++
    }
    return { imported, skipped }
  })()
}
export function exportBookmarks(db) {
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks b WHERE ${active}`)
    .get().n
  if (count > 10000)
    throw new BookmarkError(400, '单次导出上限为一万条，请缩小资源库后重试')
  return {
    format: 'pr-manager-bookmarks-v1',
    bookmarks: db
      .prepare(`SELECT b.* FROM bookmarks b WHERE ${active} ORDER BY b.id`)
      .all()
      .map((row) => {
        const { title, url, category, tags, description } = project(row)
        return { title, url, category, tags, description }
      }),
  }
}
