import { createHash } from 'node:crypto'
import { convertToUTC8 } from '../utils/time.js'

export class NoteError extends Error {
  constructor(status, message, current = null) { super(message); this.status = status; this.current = current }
}
const active = "NOT EXISTS (SELECT 1 FROM resource_trash_entries x WHERE x.resource_type = 'note' AND x.resource_id = p.id)"
const fields = 'p.id, p.title, p.content, p.category_id, p.is_top, p.created_at, p.updated_at, p.revision'
export function normalizeNoteTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > 40 || tags.some(t => typeof t !== 'string' || t.length > 80)) throw new NoteError(400, '标签最多 40 个，每个不超过 80 字')
  return [...new Set(tags.map(t => t.normalize('NFKC').trim()).filter(Boolean))]
}
export function getNote(db, id, includeDeleted = false) {
  const note = db.prepare(`SELECT ${fields}, c.name AS category_name FROM blog_posts p LEFT JOIN blog_categories c ON c.id = p.category_id WHERE p.id = ? ${includeDeleted ? '' : 'AND ' + active}`).get(id)
  if (!note) throw new NoteError(404, '笔记不存在或已移入回收站')
  note.tags = db.prepare('SELECT t.name FROM blog_tags t JOIN blog_post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ? ORDER BY t.id').all(id).map(t => t.name)
  note.created_at = convertToUTC8(note.created_at)
  note.updated_at = convertToUTC8(note.updated_at)
  return note
}
export function listNotes(db, query = {}) {
  const page = Number(query.page || 1), pageSize = Number(query.pageSize || 30)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new NoteError(400, '分页参数无效')
  const clauses = [active], params = []
  if (query.category_id === 'unfiled') clauses.push('p.category_id IS NULL')
  else if (query.category_id) { clauses.push('p.category_id = ?'); params.push(query.category_id) }
  if (query.tag_id) { clauses.push('EXISTS (SELECT 1 FROM blog_post_tags pt WHERE pt.post_id = p.id AND pt.tag_id = ?)'); params.push(query.tag_id) }
  if (query.keyword) {
    const keyword = String(query.keyword).trim().slice(0, 200).replace(/[\\%_]/gu, '\\$&')
    clauses.push("(p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')"); params.push(`%${keyword}%`, `%${keyword}%`)
  }
  const where = clauses.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS count FROM blog_posts p WHERE ${where}`).get(...params).count
  const rows = db.prepare(`SELECT p.id FROM blog_posts p WHERE ${where} ORDER BY p.is_top DESC, p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  return { data: rows.map(row => { const note = getNote(db, row.id); const { content, ...summary } = note; return { ...summary, excerpt: (content || '').replace(/[#*\x60>]/gu, '').slice(0, 160) } }), total, page, pageSize }
}
function normalizedForm(db, input, current = {}) {
  const title = input.title ?? current.title, content = input.content ?? current.content ?? ''
  if (typeof title !== 'string' || !title.trim() || title.length > 300) throw new NoteError(400, '标题必填且不超过 300 字')
  if (typeof content !== 'string' || content.length > 1000000) throw new NoteError(400, '正文不能超过 100 万字')
  const category = input.category_id === undefined ? current.category_id : input.category_id
  if (category != null && !db.prepare('SELECT id FROM blog_categories WHERE id = ?').get(category)) throw new NoteError(400, '分类已不存在，请重新选择')
  return { title: title.trim(), content, category_id: category || null, is_top: (input.is_top ?? current.is_top) ? 1 : 0, tags: normalizeNoteTags(input.tags ?? current.tags ?? []) }
}
const fingerprint = form => createHash('sha256').update(JSON.stringify([form.title, form.content, form.category_id, form.is_top, [...form.tags].sort()])).digest('hex')
function mutationId(value, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/u.test(value)) throw new NoteError(400, '保存请求标识无效，请重新打开编辑器')
  return value
}
function writeTags(db, id, tags) {
  db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id)
  for (const name of tags) {
    db.prepare('INSERT OR IGNORE INTO blog_tags (name) VALUES (?)').run(name)
    const tag = db.prepare('SELECT id FROM blog_tags WHERE name = ?').get(name)
    db.prepare('INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)').run(id, tag.id)
  }
}
export function createNote(db, input) {
  return db.transaction(() => {
    const form = normalizedForm(db, input), key = mutationId(input.mutationId)
    if (key) {
      const prior = db.prepare('SELECT id FROM blog_posts WHERE creation_key = ?').get(key)
      if (prior) {
        const note = getNote(db, prior.id)
        if (fingerprint(note) !== fingerprint(form)) throw new NoteError(409, '该新建请求已保存，请先打开已保存笔记', note)
        return note
      }
    }
    const result = db.prepare('INSERT INTO blog_posts (title, content, category_id, is_top, creation_key) VALUES (?, ?, ?, ?, ?)').run(form.title, form.content, form.category_id, form.is_top, key)
    writeTags(db, result.lastInsertRowid, form.tags)
    return getNote(db, result.lastInsertRowid)
  })()
}
export function updateNote(db, id, input) {
  return db.transaction(() => {
    const current = getNote(db, id), form = normalizedForm(db, input, current), key = mutationId(input.mutationId, true)
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new NoteError(428, '请刷新笔记后再保存；本机内容不会被清除')
    const previous = db.prepare('SELECT last_mutation_id FROM blog_posts WHERE id = ?').get(id)
    if (previous.last_mutation_id === key && fingerprint(form) === fingerprint(current)) return current
    if (current.revision !== input.baseRevision || previous.last_mutation_id === key) throw new NoteError(409, '笔记已在其他位置修改，请比较后再决定', current)
    db.prepare('UPDATE blog_posts SET title = ?, content = ?, category_id = ?, is_top = ?, revision = revision + 1, last_mutation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(form.title, form.content, form.category_id, form.is_top, key, id)
    writeTags(db, id, form.tags)
    return getNote(db, id)
  })()
}
export function trashNote(db, id) {
  return db.transaction(() => {
    getNote(db, id)
    db.prepare("INSERT INTO resource_trash_entries (resource_type, resource_id, deleted_at, purge_after, metadata_json) VALUES ('note', ?, ?, ?, ?)").run(id, new Date().toISOString(), new Date(Date.now() + 30 * 86400000).toISOString(), '{"state":"deleted"}')
    db.prepare('UPDATE blog_posts SET revision = revision + 1 WHERE id = ?').run(id)
    return { id }
  })()
}
export function restoreNoteFromTrash({ database: db, id }) {
  return db.transaction(() => {
    getNote(db, id, true)
    const result = db.prepare("DELETE FROM resource_trash_entries WHERE resource_type = 'note' AND resource_id = ?").run(id)
    if (!result.changes) throw Object.assign(new Error('Note is not in trash'), { code: 'NOTE_TRASH_NOT_FOUND' })
    db.prepare('UPDATE blog_posts SET revision = revision + 1 WHERE id = ?').run(id)
    return { id }
  })()
}
export function permanentlyDeleteNote({ database: db, id }) {
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM resource_trash_entries WHERE resource_type = 'note' AND resource_id = ?").run(id)
    if (!result.changes) throw Object.assign(new Error('Note is not in trash'), { code: 'NOTE_TRASH_NOT_FOUND' })
    db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id)
    return { id }
  })()
}
export function noteCategories(db) {
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM blog_posts p WHERE p.category_id = c.id AND ${active}) AS post_count FROM blog_categories c ORDER BY c.sort_order, c.id`).all()
}
export function noteTags(db) {
  return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM blog_post_tags pt JOIN blog_posts p ON p.id = pt.post_id WHERE pt.tag_id = t.id AND ${active}) AS post_count FROM blog_tags t ORDER BY post_count DESC, t.name`).all()
}
