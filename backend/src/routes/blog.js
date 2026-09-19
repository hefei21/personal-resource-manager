import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireOwner } from '../middlewares/auth.js'
import { cache } from '../utils/cache.js'
import { NoteError, listNotes, getNote, createNote, updateNote, trashNote, noteCategories, noteTags, normalizeNoteTags } from '../services/noteService.js'

const router = express.Router()
router.use(authenticateToken, requireOwner)
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
const handle = operation => async (req, res) => {
  try {
    const result = operation(getDatabase(), req)
    if (req.method !== 'GET') await cache.delPattern('blog:*').catch(() => {})
    res.json({ success: true, ...result })
  } catch (error) {
    const status = error instanceof NoteError ? error.status : 500
    if (status === 500) console.error('[Notes]', error.code || error.name)
    res.status(status).json({ success: false, message: status === 500 ? '笔记操作失败，请重试' : error.message, ...(error.current ? { current: error.current } : {}) })
  }
}
router.get('/posts', handle((db, req) => listNotes(db, req.query)))
router.get('/posts/:id', handle((db, req) => ({ data: getNote(db, req.params.id) })))
router.post('/posts', handle((db, req) => ({ data: createNote(db, req.body) })))
router.put('/posts/:id', handle((db, req) => ({ data: updateNote(db, req.params.id, req.body) })))
router.delete('/posts/:id', handle((db, req) => ({ data: trashNote(db, req.params.id) })))

router.get('/categories/all', handle(db => ({ data: noteCategories(db) })))
router.get('/categories', handle(db => {
  const rows = noteCategories(db)
  const tree = (parent = null, seen = new Set()) => rows.filter(row => row.parent_id === parent && !seen.has(row.id)).map(row => ({ ...row, children: tree(row.id, new Set([...seen, row.id])) }))
  return { data: tree() }
}))
function categoryName(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 80) throw new NoteError(400, '分类名称必填且不超过 80 字')
  return input.trim()
}
function validateParent(db, parent, id) {
  const seen = new Set([Number(id)])
  let cursor = parent
  while (cursor != null) {
    if (seen.has(Number(cursor))) throw new NoteError(400, '分类不能循环嵌套')
    seen.add(Number(cursor))
    const row = db.prepare('SELECT parent_id FROM blog_categories WHERE id = ?').get(cursor)
    if (!row) throw new NoteError(400, '父分类不存在')
    cursor = row.parent_id
  }
}
router.post('/categories', handle((db, req) => {
  const parent = req.body.parent_id || null
  validateParent(db, parent)
  const result = db.prepare('INSERT INTO blog_categories (name, parent_id, sort_order) VALUES (?, ?, ?)').run(categoryName(req.body.name), parent, Number.isSafeInteger(req.body.sort_order) ? req.body.sort_order : 0)
  return { data: { id: result.lastInsertRowid } }
}))
router.put('/categories/:id', handle((db, req) => {
  const existing = db.prepare('SELECT * FROM blog_categories WHERE id = ?').get(req.params.id)
  if (!existing) throw new NoteError(404, '分类不存在')
  const parent = req.body.parent_id === undefined ? existing.parent_id : req.body.parent_id || null
  validateParent(db, parent, req.params.id)
  db.prepare('UPDATE blog_categories SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?').run(categoryName(req.body.name ?? existing.name), parent, Number.isSafeInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order, req.params.id)
  return {}
}))
router.delete('/categories/:id', handle((db, req) => db.transaction(() => {
  if (db.prepare('SELECT 1 FROM blog_categories WHERE parent_id = ?').get(req.params.id)) throw new NoteError(400, '请先处理子分类')
  if (!db.prepare('SELECT 1 FROM blog_categories WHERE id = ?').get(req.params.id)) throw new NoteError(404, '分类不存在')
  db.prepare('UPDATE blog_posts SET category_id = NULL, revision = revision + 1 WHERE category_id = ?').run(req.params.id)
  db.prepare('DELETE FROM blog_categories WHERE id = ?').run(req.params.id)
  return {}
})()))
router.get('/tags', handle(db => ({ data: noteTags(db) })))
router.post('/tags', handle((db, req) => {
  const name = normalizeNoteTags([req.body.name])[0]
  if (!name) throw new NoteError(400, '标签名称不能为空')
  db.prepare('INSERT OR IGNORE INTO blog_tags (name, color) VALUES (?, ?)').run(name, typeof req.body.color === 'string' ? req.body.color.slice(0, 80) : null)
  return { data: db.prepare('SELECT id FROM blog_tags WHERE name = ?').get(name) }
}))
router.put('/tags/:id', handle((db, req) => db.transaction(() => {
  const existing = db.prepare('SELECT * FROM blog_tags WHERE id = ?').get(req.params.id)
  if (!existing) throw new NoteError(404, '标签不存在')
  const name = normalizeNoteTags([req.body.name ?? existing.name])[0]
  if (!name) throw new NoteError(400, '标签名称不能为空')
  if (!db.prepare('SELECT id FROM blog_tags WHERE id = ?').get(req.params.id)) throw new NoteError(404, '标签不存在')
  if (db.prepare('SELECT id FROM blog_tags WHERE name = ? AND id != ?').get(name, req.params.id)) throw new NoteError(409, '已有同名标签')
  db.prepare('UPDATE blog_posts SET revision = revision + 1 WHERE id IN (SELECT post_id FROM blog_post_tags WHERE tag_id = ?)').run(req.params.id)
  db.prepare('UPDATE blog_tags SET name = ?, color = ? WHERE id = ?').run(name, typeof req.body.color === 'string' ? req.body.color.slice(0, 80) : existing.color, req.params.id)
  return {}
})()))
router.delete('/tags/:id', handle((db, req) => db.transaction(() => {
  db.prepare('UPDATE blog_posts SET revision = revision + 1 WHERE id IN (SELECT post_id FROM blog_post_tags WHERE tag_id = ?)').run(req.params.id)
  if (!db.prepare('DELETE FROM blog_tags WHERE id = ?').run(req.params.id).changes) throw new NoteError(404, '标签不存在')
  return {}
})()))
export default router
