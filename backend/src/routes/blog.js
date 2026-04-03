import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'

const router = express.Router()

// 时间转换函数：UTC转UTC+8
function convertToUTC8(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  const utc8Time = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return utc8Time.toISOString().replace('T', ' ').substring(0, 19)
}

// ==================== 文章相关 ====================

// 获取文章列表
router.get('/posts', (req, res) => {
  try {
    const db = getDatabase()
    const { status, category_id, keyword, page = 1, pageSize = 30 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(pageSize)
    
    let sql = `
      SELECT 
        p.*,
        c.name as category_name,
        GROUP_CONCAT(t.name) as tags,
        GROUP_CONCAT(t.color) as tag_colors
      FROM blog_posts p
      LEFT JOIN blog_categories c ON p.category_id = c.id
      LEFT JOIN blog_post_tags pt ON p.id = pt.post_id
      LEFT JOIN blog_tags t ON pt.tag_id = t.id
      WHERE 1=1
    `
    const params = []

    if (status) {
      sql += ` AND p.status = ?`
      params.push(status)
    }

    if (category_id) {
      sql += ` AND p.category_id = ?`
      params.push(category_id)
    }

    if (keyword) {
      sql += ` AND p.title LIKE ?`
      params.push(`%${keyword}%`)
    }

    sql += ` GROUP BY p.id`
    
    // 排序：置顶优先，然后按更新时间倒序
    sql += ` ORDER BY p.is_top DESC, p.updated_at DESC`

    // 获取总数
    const countSql = `SELECT COUNT(DISTINCT p.id) as total FROM blog_posts p WHERE 1=1${status ? ' AND p.status = ?' : ''}${category_id ? ' AND p.category_id = ?' : ''}${keyword ? ' AND p.title LIKE ?' : ''}`
    const countParams = []
    if (status) countParams.push(status)
    if (category_id) countParams.push(category_id)
    if (keyword) countParams.push(`%${keyword}%`)
    const totalResult = db.prepare(countSql).get(...countParams)
    const total = totalResult.total

    // 分页
    sql += ` LIMIT ? OFFSET ?`
    params.push(parseInt(pageSize), offset)

    const posts = db.prepare(sql).all(...params)

    // 处理结果
    const result = posts.map(post => ({
      ...post,
      category_name: post.category_name || null,
      tags: post.tags ? post.tags.split(',') : [],
      tag_colors: post.tag_colors ? post.tag_colors.split(',') : [],
      created_at: convertToUTC8(post.created_at),
      updated_at: convertToUTC8(post.updated_at)
    }))

    res.json({
      success: true,
      data: result,
      total,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    })
  } catch (error) {
    console.error('获取文章列表失败:', error)
    res.status(500).json({ success: false, message: '获取文章列表失败' })
  }
})

// 获取单篇文章
router.get('/posts/:id', (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params

    const post = db.prepare(`
      SELECT 
        p.*,
        c.name as category_name,
        GROUP_CONCAT(t.id) as tag_ids,
        GROUP_CONCAT(t.name) as tags,
        GROUP_CONCAT(t.color) as tag_colors
      FROM blog_posts p
      LEFT JOIN blog_categories c ON p.category_id = c.id
      LEFT JOIN blog_post_tags pt ON p.id = pt.post_id
      LEFT JOIN blog_tags t ON pt.tag_id = t.id
      WHERE p.id = ?
      GROUP BY p.id
    `).get(id)

    if (!post) {
      return res.status(404).json({ success: false, message: '文章不存在' })
    }

    res.json({
      success: true,
      data: {
        ...post,
        category_name: post.category_name || null,
        tag_ids: post.tag_ids ? post.tag_ids.split(',').map(Number) : [],
        tags: post.tags ? post.tags.split(',') : [],
        tag_colors: post.tag_colors ? post.tag_colors.split(',') : [],
        created_at: convertToUTC8(post.created_at),
        updated_at: convertToUTC8(post.updated_at)
      }
    })
  } catch (error) {
    console.error('获取文章失败:', error)
    res.status(500).json({ success: false, message: '获取文章失败' })
  }
})

// 创建文章
router.post('/posts', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { title, content, category_id, tags, status = 'draft', is_top = false } = req.body

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: '标题不能为空' })
    }

    // 插入文章
    const stmt = db.prepare(`
      INSERT INTO blog_posts (title, content, category_id, status, is_top)
      VALUES (?, ?, ?, ?, ?)
    `)
    const result = stmt.run(title.trim(), content || '', category_id || null, status, is_top ? 1 : 0)

    const postId = result.lastInsertRowid

    // 处理标签
    if (tags && Array.isArray(tags) && tags.length > 0) {
      const tagStmt = db.prepare('INSERT OR IGNORE INTO blog_tags (name) VALUES (?)')
      const tagIdStmt = db.prepare('SELECT id FROM blog_tags WHERE name = ?')
      const postTagStmt = db.prepare('INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)')

      for (const tagName of tags) {
        if (tagName && tagName.trim()) {
          // 插入或忽略已存在的标签
          tagStmt.run(tagName.trim())
          // 获取标签ID
          const tagRow = tagIdStmt.get(tagName.trim())
          if (tagRow) {
            postTagStmt.run(postId, tagRow.id)
          }
        }
      }
    }

    res.json({
      success: true,
      data: { id: postId },
      message: '创建成功'
    })
  } catch (error) {
    console.error('创建文章失败:', error)
    res.status(500).json({ success: false, message: '创建文章失败' })
  }
})

// 更新文章
router.put('/posts/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { title, content, category_id, tags, status, is_top } = req.body

    // 检查文章是否存在
    const existing = db.prepare('SELECT id FROM blog_posts WHERE id = ?').get(id)
    if (!existing) {
      return res.status(404).json({ success: false, message: '文章不存在' })
    }

    // 更新文章
    const updateFields = []
    const params = []

    if (title !== undefined) {
      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: '标题不能为空' })
      }
      updateFields.push('title = ?')
      params.push(title.trim())
    }
    if (content !== undefined) {
      updateFields.push('content = ?')
      params.push(content || '')
    }
    if (category_id !== undefined) {
      updateFields.push('category_id = ?')
      params.push(category_id || null)
    }
    if (status !== undefined) {
      updateFields.push('status = ?')
      params.push(status)
    }
    if (is_top !== undefined) {
      updateFields.push('is_top = ?')
      params.push(is_top ? 1 : 0)
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP')
    params.push(id)

    db.prepare(`UPDATE blog_posts SET ${updateFields.join(', ')} WHERE id = ?`).run(...params)

    // 更新标签（如果提供了tags）
    if (tags !== undefined) {
      // 删除旧的关联
      db.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id)

      // 插入新的标签
      if (Array.isArray(tags) && tags.length > 0) {
        const tagStmt = db.prepare('INSERT OR IGNORE INTO blog_tags (name) VALUES (?)')
        const tagIdStmt = db.prepare('SELECT id FROM blog_tags WHERE name = ?')
        const postTagStmt = db.prepare('INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)')

        for (const tagName of tags) {
          if (tagName && tagName.trim()) {
            tagStmt.run(tagName.trim())
            const tagRow = tagIdStmt.get(tagName.trim())
            if (tagRow) {
              postTagStmt.run(id, tagRow.id)
            }
          }
        }
      }
    }

    res.json({
      success: true,
      message: '更新成功'
    })
  } catch (error) {
    console.error('更新文章失败:', error)
    res.status(500).json({ success: false, message: '更新文章失败' })
  }
})

// 删除文章
router.delete('/posts/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params

    // 删除文章（关联的标签会通过外键级联删除）
    const result = db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '文章不存在' })
    }

    res.json({
      success: true,
      message: '删除成功'
    })
  } catch (error) {
    console.error('删除文章失败:', error)
    res.status(500).json({ success: false, message: '删除文章失败' })
  }
})

// ==================== 分类相关 ====================

// 获取分类列表（树形）
router.get('/categories', (req, res) => {
  try {
    const db = getDatabase()
    
    // 获取所有分类
    const categories = db.prepare(`
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM blog_posts WHERE category_id = c.id) as post_count
      FROM blog_categories c
      ORDER BY c.sort_order ASC, c.created_at ASC
    `).all()

    // 构建树形结构
    const buildTree = (items, parentId = null) => {
      return items
        .filter(item => item.parent_id === parentId)
        .map(item => ({
          ...item,
          post_count: item.post_count || 0,
          children: buildTree(items, item.id)
        }))
    }

    const tree = buildTree(categories)

    res.json({
      success: true,
      data: tree
    })
  } catch (error) {
    console.error('获取分类列表失败:', error)
    res.status(500).json({ success: false, message: '获取分类列表失败' })
  }
})

// 获取所有分类（平铺）
router.get('/categories/all', (req, res) => {
  try {
    const db = getDatabase()
    
    const categories = db.prepare(`
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM blog_posts WHERE category_id = c.id) as post_count
      FROM blog_categories c
      ORDER BY c.sort_order ASC, c.created_at ASC
    `).all()

    res.json({
      success: true,
      data: categories.map(c => ({
        ...c,
        post_count: c.post_count || 0
      }))
    })
  } catch (error) {
    console.error('获取分类列表失败:', error)
    res.status(500).json({ success: false, message: '获取分类列表失败' })
  }
})

// 创建分类
router.post('/categories', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { name, parent_id, sort_order = 0 } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '分类名称不能为空' })
    }

    const stmt = db.prepare(`
      INSERT INTO blog_categories (name, parent_id, sort_order)
      VALUES (?, ?, ?)
    `)
    const result = stmt.run(name.trim(), parent_id || null, sort_order)

    res.json({
      success: true,
      data: { id: result.lastInsertRowid },
      message: '创建成功'
    })
  } catch (error) {
    console.error('创建分类失败:', error)
    res.status(500).json({ success: false, message: '创建分类失败' })
  }
})

// 更新分类
router.put('/categories/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { name, parent_id, sort_order } = req.body

    // 检查分类是否存在
    const existing = db.prepare('SELECT id FROM blog_categories WHERE id = ?').get(id)
    if (!existing) {
      return res.status(404).json({ success: false, message: '分类不存在' })
    }

    // 检查是否将分类设为自己的子分类
    if (parent_id && parseInt(parent_id) === parseInt(id)) {
      return res.status(400).json({ success: false, message: '不能将分类设为自己的子分类' })
    }

    const updateFields = []
    const params = []

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: '分类名称不能为空' })
      }
      updateFields.push('name = ?')
      params.push(name.trim())
    }
    if (parent_id !== undefined) {
      updateFields.push('parent_id = ?')
      params.push(parent_id || null)
    }
    if (sort_order !== undefined) {
      updateFields.push('sort_order = ?')
      params.push(sort_order)
    }

    params.push(id)

    db.prepare(`UPDATE blog_categories SET ${updateFields.join(', ')} WHERE id = ?`).run(...params)

    res.json({
      success: true,
      message: '更新成功'
    })
  } catch (error) {
    console.error('更新分类失败:', error)
    res.status(500).json({ success: false, message: '更新分类失败' })
  }
})

// 删除分类
router.delete('/categories/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params

    // 检查是否有子分类
    const children = db.prepare('SELECT id FROM blog_categories WHERE parent_id = ?').all(id)
    if (children.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: '该分类下还有子分类，请先删除子分类' 
      })
    }

    // 将该分类下的文章的category_id设为null
    db.prepare('UPDATE blog_posts SET category_id = NULL WHERE category_id = ?').run(id)

    // 删除分类
    const result = db.prepare('DELETE FROM blog_categories WHERE id = ?').run(id)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '分类不存在' })
    }

    res.json({
      success: true,
      message: '删除成功'
    })
  } catch (error) {
    console.error('删除分类失败:', error)
    res.status(500).json({ success: false, message: '删除分类失败' })
  }
})

// ==================== 标签相关 ====================

// 获取标签列表
router.get('/tags', (req, res) => {
  try {
    const db = getDatabase()
    
    const tags = db.prepare(`
      SELECT 
        t.*,
        COUNT(pt.post_id) as post_count
      FROM blog_tags t
      LEFT JOIN blog_post_tags pt ON t.id = pt.tag_id
      GROUP BY t.id
      ORDER BY post_count DESC, t.name ASC
    `).all()

    res.json({
      success: true,
      data: tags.map(t => ({
        ...t,
        post_count: t.post_count || 0
      }))
    })
  } catch (error) {
    console.error('获取标签列表失败:', error)
    res.status(500).json({ success: false, message: '获取标签列表失败' })
  }
})

// 创建标签
router.post('/tags', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { name, color } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: '标签名称不能为空' })
    }

    // 检查标签是否已存在
    const existing = db.prepare('SELECT id FROM blog_tags WHERE name = ?').get(name.trim())
    if (existing) {
      return res.status(400).json({ success: false, message: '标签已存在' })
    }

    const stmt = db.prepare(`
      INSERT INTO blog_tags (name, color)
      VALUES (?, ?)
    `)
    const result = stmt.run(name.trim(), color || null)

    res.json({
      success: true,
      data: { id: result.lastInsertRowid },
      message: '创建成功'
    })
  } catch (error) {
    console.error('创建标签失败:', error)
    res.status(500).json({ success: false, message: '创建标签失败' })
  }
})

// 更新标签
router.put('/tags/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params
    const { name, color } = req.body

    // 检查标签是否存在
    const existing = db.prepare('SELECT id FROM blog_tags WHERE id = ?').get(id)
    if (!existing) {
      return res.status(404).json({ success: false, message: '标签不存在' })
    }

    const updateFields = []
    const params = []

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: '标签名称不能为空' })
      }
      // 检查名称是否已被其他标签使用
      const nameUsed = db.prepare('SELECT id FROM blog_tags WHERE name = ? AND id != ?').get(name.trim(), id)
      if (nameUsed) {
        return res.status(400).json({ success: false, message: '标签名称已被使用' })
      }
      updateFields.push('name = ?')
      params.push(name.trim())
    }
    if (color !== undefined) {
      updateFields.push('color = ?')
      params.push(color || null)
    }

    params.push(id)

    db.prepare(`UPDATE blog_tags SET ${updateFields.join(', ')} WHERE id = ?`).run(...params)

    res.json({
      success: true,
      message: '更新成功'
    })
  } catch (error) {
    console.error('更新标签失败:', error)
    res.status(500).json({ success: false, message: '更新标签失败' })
  }
})

// 删除标签
router.delete('/tags/:id', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params

    // 删除标签（关联会通过外键级联删除）
    const result = db.prepare('DELETE FROM blog_tags WHERE id = ?').run(id)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '标签不存在' })
    }

    res.json({
      success: true,
      message: '删除成功'
    })
  } catch (error) {
    console.error('删除标签失败:', error)
    res.status(500).json({ success: false, message: '删除标签失败' })
  }
})

export default router
