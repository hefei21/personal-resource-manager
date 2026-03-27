import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcryptjs'
import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import { authenticateToken } from '../middlewares/auth.js'

const router = express.Router()

// 辅助函数：将 UTC 时间转换为 UTC+8
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  // SQLite 存储的时间格式：YYYY-MM-DD HH:mm:ss
  const date = new Date(utcTime + 'Z') // 添加 Z 表示 UTC
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000) // 加 8 小时
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hours = String(utc8Date.getHours()).padStart(2, '0')
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getStoragePath('uploads'))
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
})

// 创建分类
router.post('/categories', authenticateToken, async (req, res) => {
  try {
    const { name, parentId } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: '分类名称不能为空' })
    }

    const db = getDatabase()

    // 检查同层级下是否已存在同名分类
    const level = parentId ? await getCategoryLevel(db, parentId) + 1 : 0
    const path = parentId ? await buildCategoryPath(db, parentId) + '/' + name : name

    const checkStmt = db.prepare(
      'SELECT * FROM categories WHERE name = ? AND parent_id IS ? AND level = ?'
    )
    const existing = checkStmt.get(name, parentId || null, level)

    if (existing) {
      return res.status(400).json({ message: '同级分类下已存在同名分类' })
    }

    const stmt = db.prepare(
      'INSERT INTO categories (name, parent_id, path, level) VALUES (?, ?, ?, ?)'
    )
    const result = stmt.run(name, parentId || null, path, level)

    res.json({ id: result.lastInsertRowid, message: '创建成功' })
  } catch (error) {
    console.error('创建分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取分类树
router.get('/categories/tree', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM categories ORDER BY level, name')
    const rows = stmt.all()

    const tree = buildCategoryTree(rows)
    res.json({ data: tree })
  } catch (error) {
    console.error('获取分类树失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取分类列表（支持多级嵌套）
router.get('/categories', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    // 计算分类及其子分类下的文件数量
    function getCategoryFileCount(categoryPath) {
      const { category, subcategory } = parseCategoryPath(categoryPath)
      let stmt, count
      if (subcategory) {
        // 子分类：匹配 category = 根分类名 AND subcategory LIKE '子分类路径%'
        stmt = db.prepare('SELECT COUNT(*) as count FROM documents WHERE category = ? AND (subcategory = ? OR subcategory LIKE ?)')
        count = stmt.get(category, subcategory, `${subcategory}/%`).count
      } else {
        // 根分类：匹配 category = 分类名
        stmt = db.prepare('SELECT COUNT(*) as count FROM documents WHERE category = ?')
        count = stmt.get(category).count
      }
      return count
    }

    // 递归获取子分类
    function getSubcategories(parentId) {
      const stmt = db.prepare('SELECT * FROM categories WHERE parent_id = ? ORDER BY sort_order, name')
      const rows = stmt.all(parentId)
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        path: row.path,
        sortOrder: row.sort_order || 0,
        fileCount: getCategoryFileCount(row.path),
        subcategories: getSubcategories(row.id)
      }))
    }

    const stmt = db.prepare('SELECT * FROM categories WHERE level = 0 ORDER BY sort_order, name')
    const rows = stmt.all()

    const categories = rows.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      sortOrder: row.sort_order || 0,
      fileCount: getCategoryFileCount(row.path),
      subcategories: getSubcategories(row.id)
    }))

    res.json({ data: categories })
  } catch (error) {
    console.error('获取分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 递归获取所有子分类ID及其信息
function getAllSubcategories(db, parentId) {
  const result = []
  const stmt = db.prepare('SELECT id, name, path, parent_id, level FROM categories WHERE parent_id = ?')
  const children = stmt.all(parentId)

  for (const child of children) {
    result.push({
      id: child.id,
      name: child.name,
      path: child.path,
      parentId: child.parent_id,
      level: child.level
    })
    result.push(...getAllSubcategories(db, child.id))
  }

  return result
}

// 辅助函数：从分类path中提取category和subcategory
function parseCategoryPath(path) {
  const parts = path.split('/')
  const category = parts[0]
  const subcategory = parts.length > 1 ? parts.slice(1).join('/') : ''
  return { category, subcategory }
}

// 删除分类
router.delete('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const categoryId = req.params.id
    const { deleteFiles } = req.query // 是否删除文件：'true' 或 'false'

    // 检查分类是否存在
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(404).json({ message: '分类不存在' })
    }

    // 获取当前分类及其所有子分类
    const allCategories = [
      {
        id: category.id,
        name: category.name,
        path: category.path,
        parentId: category.parent_id,
        level: category.level
      },
      ...getAllSubcategories(db, categoryId)
    ]

    // 按层级从深到浅排序（先处理子分类，再处理父分类）
    allCategories.sort((a, b) => b.level - a.level)

    if (deleteFiles === 'true') {
      // 删除文件模式：删除所有相关文档及其文件
      for (const cat of allCategories) {
        const { category: catName, subcategory: subcatPath } = parseCategoryPath(cat.path)

        // 查找该分类下的文档（包括所有子分类下的文档）
        let docStmt, documents
        if (cat.level === 0) {
          // 根分类：匹配 category = 分类名
          docStmt = db.prepare('SELECT * FROM documents WHERE category = ?')
          documents = docStmt.all(catName)
        } else {
          // 子分类：匹配 category = 根分类名 AND subcategory LIKE '子分类路径%'
          docStmt = db.prepare('SELECT * FROM documents WHERE category = ? AND (subcategory = ? OR subcategory LIKE ?)')
          documents = docStmt.all(catName, subcatPath, `${subcatPath}/%`)
        }

        // 删除物理文件和版本记录
        for (const doc of documents) {
          if (doc.file_path && fs.existsSync(doc.file_path)) {
            fs.unlinkSync(doc.file_path)
          }
          const deleteVersionsStmt = db.prepare('DELETE FROM document_versions WHERE document_id = ?')
          deleteVersionsStmt.run(doc.id)
        }

        // 删除文档记录
        let deleteDocsStmt
        if (cat.level === 0) {
          deleteDocsStmt = db.prepare('DELETE FROM documents WHERE category = ?')
          deleteDocsStmt.run(catName)
        } else {
          deleteDocsStmt = db.prepare('DELETE FROM documents WHERE category = ? AND (subcategory = ? OR subcategory LIKE ?)')
          deleteDocsStmt.run(catName, subcatPath, `${subcatPath}/%`)
        }
      }
    } else {
      // 保留文件模式：将文件提升到父分类
      for (const cat of allCategories) {
        const { category: catName, subcategory: subcatPath } = parseCategoryPath(cat.path)

        // 计算父分类路径
        let newCategory = null
        let newSubcategory = null

        if (cat.parentId) {
          // 有父分类，获取父分类信息
          const parentCat = db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.parentId)
          if (parentCat) {
            const { category: parentCatName, subcategory: parentSubcat } = parseCategoryPath(parentCat.path)
            newCategory = parentCatName
            newSubcategory = parentSubcat
          }
        }
        // 如果没有父分类（根分类），则 newCategory 和 newSubcategory 都是 null

        // 更新该分类下直接属于它的文档的分类信息（不包括子分类的文档）
        let updateDocsStmt
        if (cat.level === 0) {
          // 根分类：更新 category = 根分类名 AND (subcategory IS NULL OR subcategory = '')
          updateDocsStmt = db.prepare('UPDATE documents SET category = ?, subcategory = ? WHERE category = ? AND (subcategory IS NULL OR subcategory = \'\')')
          updateDocsStmt.run(newCategory, newSubcategory || '', catName)
        } else {
          // 子分类：更新 category = 根分类名 AND subcategory = 子分类路径
          updateDocsStmt = db.prepare('UPDATE documents SET category = ?, subcategory = ? WHERE category = ? AND subcategory = ?')
          updateDocsStmt.run(newCategory, newSubcategory || '', catName, subcatPath)
        }
      }
    }

    // 删除所有分类（按层级从深到浅）
    const deleteCategoryStmt = db.prepare('DELETE FROM categories WHERE id = ?')
    for (const cat of allCategories) {
      deleteCategoryStmt.run(cat.id)
    }

    res.json({
      message: deleteFiles === 'true' ? '分类及相关文件已删除' : '分类已删除，文件已提升到父分类',
      deletedCategories: allCategories.length
    })
  } catch (error) {
    console.error('删除分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新分类名称
router.put('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body
    const categoryId = req.params.id

    if (!name || !name.trim()) {
      return res.status(400).json({ message: '分类名称不能为空' })
    }

    const db = getDatabase()

    // 获取当前分类信息
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(404).json({ message: '分类不存在' })
    }

    const newName = name.trim()
    const oldPath = category.path

    // 检查同层级下是否已存在同名分类
    const checkStmt = db.prepare('SELECT * FROM categories WHERE name = ? AND parent_id IS ? AND id != ?')
    const existing = checkStmt.get(newName, category.parent_id || null, categoryId)
    if (existing) {
      return res.status(400).json({ message: '同级分类下已存在同名分类' })
    }

    // 计算新路径
    let newPath
    if (category.parent_id) {
      // 子分类：从父分类路径构建新路径
      const parentCat = db.prepare('SELECT path FROM categories WHERE id = ?').get(category.parent_id)
      if (parentCat) {
        newPath = parentCat.path + '/' + newName
      } else {
        newPath = newName
      }
    } else {
      // 根分类：路径就是名称
      newPath = newName
    }

    // 更新分类名称和路径
    const updateStmt = db.prepare('UPDATE categories SET name = ?, path = ? WHERE id = ?')
    updateStmt.run(newName, newPath, categoryId)

    // 更新所有子分类的路径
    const updateSubcategories = db.transaction(() => {
      const childrenStmt = db.prepare('SELECT id, path FROM categories WHERE path LIKE ?')
      const children = childrenStmt.all(`${oldPath}/%`)

      for (const child of children) {
        const newChildPath = child.path.replace(oldPath + '/', newPath + '/')
        db.prepare('UPDATE categories SET path = ? WHERE id = ?').run(newChildPath, child.id)
      }
    })
    updateSubcategories()

    // 更新文档的分类信息
    const { category: oldCatName, subcategory: oldSubcat } = parseCategoryPath(oldPath)
    const { category: newCatName, subcategory: newSubcat } = parseCategoryPath(newPath)

    // 更新文档的 category 和 subcategory
    if (category.level === 0) {
      // 根分类：更新所有以旧名称为 category 的文档
      const updateDocsCategory = db.prepare('UPDATE documents SET category = ? WHERE category = ?')
      updateDocsCategory.run(newName, oldCatName)

      // 更新子分类路径前缀
      const updateDocsSubcategory = db.prepare('UPDATE documents SET subcategory = ? WHERE subcategory LIKE ?')
      updateDocsSubcategory.run(newName + '/%', oldCatName + '/%')
    } else {
      // 子分类：更新匹配旧路径的文档
      const updateDocs = db.prepare('UPDATE documents SET category = ?, subcategory = ? WHERE category = ? AND subcategory = ?')
      updateDocs.run(newCatName, newSubcat, oldCatName, oldSubcat)

      // 更新子分类路径前缀
      const updateChildDocs = db.prepare('UPDATE documents SET subcategory = ? WHERE subcategory LIKE ?')
      updateChildDocs.run(newSubcat + '/%', oldSubcat + '/%')
    }

    res.json({ message: '更新成功', newPath })
  } catch (error) {
    console.error('更新分类名称失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新分类排序
router.put('/categories/reorder', authenticateToken, async (req, res) => {
  try {
    const { orders } = req.body // orders 是一个数组，格式：[{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 1 }, ...]

    if (!orders || !Array.isArray(orders)) {
      return res.status(400).json({ message: '参数错误' })
    }

    const db = getDatabase()

    // 使用事务批量更新
    const updateStmt = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction((items) => {
      items.forEach(item => {
        updateStmt.run(item.sortOrder, item.id)
      })
    })

    transaction(orders)

    res.json({ message: '排序更新成功' })
  } catch (error) {
    console.error('更新排序失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 检查文档重名
router.get('/check-duplicate', authenticateToken, async (req, res) => {
  try {
    const { title, category, subcategory, excludeId } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM documents WHERE title = ?'
    const params = [title]

    if (category) {
      sql += ' AND category = ?'
      params.push(category)
    }
    if (subcategory) {
      sql += ' AND subcategory = ?'
      params.push(subcategory)
    }
    if (excludeId) {
      sql += ' AND id != ?'
      params.push(excludeId)
    }

    const stmt = db.prepare(sql)
    const existing = stmt.get(...params)

    if (existing) {
      // 生成新的文件名（添加后缀）
      let suffix = 1
      let newTitle
      let unique = false

      while (!unique) {
        newTitle = `${title} (${suffix})`
        const checkStmt = db.prepare(
          'SELECT * FROM documents WHERE title = ? AND category = ? AND subcategory = ? AND id != ?'
        )
        const checkExisting = checkStmt.get(newTitle, category || null, subcategory || null, excludeId || 0)
        if (!checkExisting) {
          unique = true
        } else {
          suffix++
        }
      }

      return res.json({ duplicate: true, suggestedTitle: newTitle })
    }

    res.json({ duplicate: false })
  } catch (error) {
    console.error('检查重名失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 辅助函数：构建分类树
function buildCategoryTree(categories, parentId = null) {
  const tree = []
  const children = categories.filter(cat => 
    (parentId === null && !cat.parent_id) || cat.parent_id === parentId
  )

  children.forEach(child => {
    const node = {
      id: child.id,
      name: child.name,
      path: child.path,
      level: child.level,
      children: buildCategoryTree(categories, child.id)
    }
    tree.push(node)
  })

  return tree
}

// 辅助函数：获取分类层级
function getCategoryLevel(db, categoryId) {
  const stmt = db.prepare('SELECT level FROM categories WHERE id = ?')
  const row = stmt.get(categoryId)
  return row ? row.level : 0
}

// 辅助函数：构建分类路径
function buildCategoryPath(db, categoryId) {
  const stmt = db.prepare('SELECT path FROM categories WHERE id = ?')
  const row = stmt.get(categoryId)
  return row ? row.path : ''
}

// 获取标签列表
router.get('/tags', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT DISTINCT tags FROM documents WHERE tags IS NOT NULL AND tags != \'\'')
    const rows = stmt.all()

    const tags = new Set()
    rows.forEach(row => {
      if (row.tags) {
        const tagList = row.tags.split(',').map(t => t.trim()).filter(t => t)
        tagList.forEach(t => tags.add(t))
      }
    })

    res.json({ data: Array.from(tags) })
  } catch (error) {
    console.error('获取标签失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取文档列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword, category, subcategory, tags, startDate, endDate, sortBy, sortOrder, includeSubcategories, page = 1, pageSize = 30 } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM documents WHERE 1=1'
    const params = []

    if (keyword) {
      sql += ' AND (title LIKE ? OR tags LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }

    if (category) {
      sql += ' AND category = ?'
      params.push(category)
    }

    if (subcategory) {
      if (includeSubcategories === 'true') {
        // 使用 LIKE 查询匹配子分类及其所有子分类
        // 例如：subcategory = "前端" 会匹配 "前端"、"前端/Vue"、"前端/React" 等
        sql += ' AND (subcategory = ? OR subcategory LIKE ?)'
        params.push(subcategory, `${subcategory}/%`)
      } else {
        // 精确匹配，只显示直接属于该分类的文件
        sql += ' AND subcategory = ?'
        params.push(subcategory)
      }
    }

    // 支持多标签搜索（逗号分隔）
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(t => t)
      if (tagList.length > 0) {
        const tagConditions = tagList.map(() => 'tags LIKE ?').join(' OR ')
        sql += ` AND (${tagConditions})`
        tagList.forEach(t => params.push(`%${t}%`))
      }
    }

    // 支持日期范围搜索（处理时区转换）
    // 前端传来的是本地时间（UTC+8），数据库存储的是 UTC 时间
    // 需要将本地时间转换为 UTC 时间进行比较
    if (startDate) {
      // 将前端传来的本地时间字符串直接与数据库中的 UTC 时间比较
      // 注意：SQLite 的 datetime 比较是字符串比较，格式必须一致
      sql += " AND updated_at >= ?"
      params.push(startDate)
    }
    if (endDate) {
      sql += " AND updated_at <= ?"
      params.push(endDate)
    }

    // 支持排序
    const validSortFields = ['title', 'category', 'subcategory', 'tags', 'version', 'updated_at', 'file_path', 'size', 'file_type']
    const validSortOrders = ['ASC', 'DESC']
    
    let sortField = validSortFields.includes(sortBy) ? sortBy : 'updated_at'
    let sortDirection = validSortOrders.includes(sortOrder?.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'
    
    // 这些字段需要在内存中排序（title、size、file_type）
    const memorySortFields = ['title', 'size', 'file_type']
    if (memorySortFields.includes(sortField)) {
      sql += ' ORDER BY id ASC' // 先按 id 排序获取数据，后面在内存中排序
    } else {
      sql += ` ORDER BY ${sortField} ${sortDirection}`
    }

    const stmt = db.prepare(sql)
    const rows = stmt.all(...params)

    // 辅助函数：获取文件扩展名
    const getFileExtension = (filePath) => {
      if (!filePath) return ''
      const parts = filePath.split('.')
      return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
    }

    // 辅助函数：将 UTC 时间转换为 UTC+8
    const convertToUTC8 = (utcTime) => {
      if (!utcTime) return utcTime
      // SQLite 存储的时间格式：YYYY-MM-DD HH:mm:ss
      const date = new Date(utcTime + 'Z') // 添加 Z 表示 UTC
      const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000) // 加 8 小时
      const year = utc8Date.getFullYear()
      const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
      const day = String(utc8Date.getDate()).padStart(2, '0')
      const hours = String(utc8Date.getHours()).padStart(2, '0')
      const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
      const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    }

    // 转换为驼峰命名
    let result = rows.map(row => {
      const filePath = row.file_path
      const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
      const fileExtension = getFileExtension(filePath)

      return {
        id: row.id,
        title: row.title,
        category: row.category,
        subcategory: row.subcategory,
        tags: row.tags,
        filePath: row.file_path,
        fileType: fileExtension,
        version: row.version,
        size: size,
        createdAt: convertToUTC8(row.created_at),
        updatedAt: convertToUTC8(row.updated_at)
      }
    })


    // 内存中排序
    if (sortField === 'title') {
      // 排序规则：中英文混合按拼音排序
      const collator = new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true })
      result.sort((a, b) => {
        const aTitle = a.title || ''
        const bTitle = b.title || ''
        const comparison = collator.compare(aTitle, bTitle)
        return sortDirection === 'DESC' ? -comparison : comparison
      })
    } else if (sortField === 'size') {
      result.sort((a, b) => {
        const comparison = (a.size || 0) - (b.size || 0)
        return sortDirection === 'DESC' ? -comparison : comparison
      })
    } else if (sortField === 'file_type') {
      // 按文件类型排序
      result.sort((a, b) => {
        const comparison = (a.fileType || '').localeCompare(b.fileType || '')
        return sortDirection === 'DESC' ? -comparison : comparison
      })
    }

    // 分页
    const total = result.length
    const pageNum = parseInt(page) || 1
    const pageSizeNum = parseInt(pageSize) || 30
    const startIndex = (pageNum - 1) * pageSizeNum
    const paginatedResult = result.slice(startIndex, startIndex + pageSizeNum)

    res.json({ data: paginatedResult, total })
  } catch (error) {
    console.error('获取文档失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 上传文档
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    console.log('文档上传请求:', {
      body: req.body,
      file: req.file,
      headers: req.headers
    })

    let { title, category, subcategory, tags, versionNote } = req.body
    const filePath = req.file.path

    console.log('上传的文件路径:', filePath)
    console.log('文件名:', req.file.filename)
    console.log('存储目录:', getStoragePath('uploads'))
    console.log('文档信息:', { title, category, subcategory, tags, versionNote })

    const db = getDatabase()

    // 检查重名并自动添加后缀
    let finalTitle = title
    let suffix = 1
    let unique = false

    while (!unique) {
      const checkStmt = db.prepare(
        'SELECT * FROM documents WHERE title = ? AND category = ? AND subcategory = ?'
      )
      const existing = checkStmt.get(finalTitle, category || null, subcategory || null)
      if (!existing) {
        unique = true
      } else {
        finalTitle = `${title} (${suffix})`
        suffix++
      }
    }

    const stmt = db.prepare(
      `INSERT INTO documents (title, category, subcategory, tags, file_path) VALUES (?, ?, ?, ?, ?)`
    )
    const result = stmt.run(finalTitle, category, subcategory || '', tags, filePath)

    // 创建版本记录
    const versionStmt = db.prepare(
      `INSERT INTO document_versions (document_id, version, file_path, note) VALUES (?, ?, ?, ?)`
    )
    versionStmt.run(result.lastInsertRowid, 1.0, filePath, versionNote || '初始版本')

    console.log('文档上传成功，ID:', result.lastInsertRowid)
    console.log('保存到数据库的路径:', filePath)
    console.log('最终标题:', finalTitle)
    res.json({ id: result.lastInsertRowid, title: finalTitle, message: '上传成功' })
  } catch (error) {
    console.error('文档上传错误:', error)
    console.error('错误堆栈:', error.stack)
    res.status(500).json({ message: '上传失败', error: error.message })
  }
})

// 获取文档内容用于编辑或预览
router.get('/:id/content', async (req, res) => {
  try {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    const jwt = await import('jsonwebtoken')
    jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      console.log('文档不存在:', req.params.id)
      return res.status(404).json({ message: '文档不存在' })
    }

    const filePath = document.file_path
    console.log('尝试读取文件:', filePath)
    console.log('文件是否存在:', fs.existsSync(filePath))

    // 获取文件大小
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0

    if (!fs.existsSync(filePath)) {
      console.error('文件不存在:', filePath)
      return res.status(404).json({ message: '文件不存在' })
    }

    // 检查文件扩展名
    const ext = path.extname(filePath).toLowerCase()
    const textFormats = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.sql', '.sh', '.bat', '.yml', '.yaml', '.csv', '.log']
    const binaryFormats = ['.pdf', '.zip', '.rar', '.7z', '.tar', '.gz']
    const officeFormats = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']
    const imageFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg']

    if (officeFormats.includes(ext)) {
      // Office文件：返回base64编码
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else if (binaryFormats.includes(ext)) {
      // 二进制文件：返回 base64 编码的数据用于前端预览
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else if (textFormats.includes(ext)) {
      // 文本文件：直接返回内容
      const content = fs.readFileSync(filePath, 'utf-8')
      res.json({
        content,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: false
      })
    } else if (imageFormats.includes(ext)) {
      // 图片文件：返回 base64 编码
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else {
      // 不支持的格式
      return res.status(400).json({
        message: '不支持的文件格式',
        supportedFormats: [...textFormats, ...binaryFormats, ...imageFormats, ...officeFormats]
      })
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('获取文档内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新文档内容
router.put('/:id/content', authenticateToken, async (req, res) => {
  try {
    const { content, versionNote, newVersion } = req.body
    if (!content) {
      return res.status(400).json({ message: '内容不能为空' })
    }

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      return res.status(404).json({ message: '文档不存在' })
    }

    const filePath = document.file_path
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    // 确定新版本号
    let finalVersion
    if (newVersion) {
      // 验证版本号格式
      const versionRegex = /^\d+(\.\d+)*$/
      if (!versionRegex.test(newVersion)) {
        return res.status(400).json({ message: '版本号格式不正确' })
      }

      // 验证版本号是否大于当前版本
      const currentVersion = document.version || '1.0'
      if (!isVersionGreater(newVersion, currentVersion.toString())) {
        return res.status(400).json({ message: `新版本号必须大于当前版本 ${currentVersion}` })
      }

      finalVersion = newVersion
    } else {
      // 自动递增版本号（小版本+1）
      const currentVersion = document.version || 1
      finalVersion = (parseFloat(currentVersion) + 0.1).toFixed(1)
    }

    // 备份当前版本
    const backupStmt = db.prepare(
      `INSERT INTO document_versions (document_id, version, file_path, note) VALUES (?, ?, ?, ?)`
    )
    backupStmt.run(req.params.id, finalVersion, filePath, versionNote || `版本 ${finalVersion}`)

    // 写入新内容
    fs.writeFileSync(filePath, content, 'utf-8')

    // 更新文档版本号
    const updateStmt = db.prepare(
      `UPDATE documents SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    updateStmt.run(finalVersion, req.params.id)

    res.json({ message: '保存成功', version: finalVersion })
  } catch (error) {
    console.error('更新文档内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 辅助函数：比较版本号
function isVersionGreater(newVersion, currentVersion) {
  const newParts = newVersion.split('.').map(Number)
  const currentParts = currentVersion.toString().split('.').map(Number)

  const maxLen = Math.max(newParts.length, currentParts.length)

  for (let i = 0; i < maxLen; i++) {
    const newPart = newParts[i] || 0
    const currentPart = currentParts[i] || 0

    if (newPart > currentPart) return true
    if (newPart < currentPart) return false
  }

  return false // 版本号相等
}

// 获取文档版本
router.get('/:id/versions', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare(
      'SELECT * FROM document_versions WHERE document_id = ? ORDER BY version DESC'
    )
    const rows = stmt.all(req.params.id)

    // 转换为驼峰命名
    const result = rows.map(row => ({
      id: row.id,
      documentId: row.document_id,
      version: row.version,
      filePath: row.file_path,
      note: row.note,
      createdAt: row.created_at
    }))

    res.json({ data: result })
  } catch (error) {
    console.error('获取版本失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新文档
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, category, subcategory, tags } = req.body
    const db = getDatabase()

    const stmt = db.prepare(
      `UPDATE documents SET title = ?, category = ?, subcategory = ?, tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(title, category, subcategory || '', tags, req.params.id)

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量更新文档
router.put('/batch/update', authenticateToken, async (req, res) => {
  try {
    const { ids, category, subcategory, tags } = req.body
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: '请选择要更新的文档' })
    }

    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')

    let sql = 'UPDATE documents SET updated_at = CURRENT_TIMESTAMP'
    const params = []

    if (category !== undefined) {
      sql += ', category = ?'
      params.push(category)
    }
    if (subcategory !== undefined) {
      sql += ', subcategory = ?'
      params.push(subcategory || '')
    }
    if (tags !== undefined) {
      sql += ', tags = ?'
      params.push(tags)
    }

    sql += ` WHERE id IN (${placeholders})`
    params.push(...ids)

    const stmt = db.prepare(sql)
    stmt.run(...params)

    res.json({ message: '批量更新成功', count: ids.length })
  } catch (error) {
    console.error('批量更新失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 下载文档
router.get('/download/:id', async (req, res) => {
  try {
    // 支持 token 参数认证
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    // 验证 token（简化版，实际应该使用 authenticateToken 中间件）
    const jwt = await import('jsonwebtoken')
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      console.log('文档不存在:', req.params.id)
      return res.status(404).json({ message: '文档不存在' })
    }

    const filePath = document.file_path
    console.log('尝试下载文件:', filePath)
    console.log('文件是否存在:', fs.existsSync(filePath))
    console.log('当前工作目录:', process.cwd())
    console.log('上传目录配置:', getStoragePath('uploads'))

    if (!fs.existsSync(filePath)) {
      console.error('文件不存在:', filePath)
      return res.status(404).json({ message: '文件不存在' })
    }

    const fileName = path.basename(filePath)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.sendFile(filePath)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('下载失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 下载特定版本
router.get('/download/version/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM document_versions WHERE id = ?')
    const version = stmt.get(req.params.id)

    if (!version) {
      return res.status(404).json({ message: '版本不存在' })
    }

    const filePath = version.file_path
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const fileName = path.basename(filePath)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.sendFile(filePath)
  } catch (error) {
    console.error('下载版本失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除文档
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    console.log('删除文档，ID:', req.params.id)
    console.log('数据库中的文档记录:', document)
    console.log('文件路径:', document?.file_path)

    if (document && document.file_path && fs.existsSync(document.file_path)) {
      console.log('删除文件:', document.file_path)
      fs.unlinkSync(document.file_path)
    } else if (document && document.file_path) {
      console.error('文件不存在，无法删除:', document.file_path)
    }

    const deleteStmt = db.prepare('DELETE FROM documents WHERE id = ?')
    deleteStmt.run(req.params.id)

    const deleteVersionsStmt = db.prepare('DELETE FROM document_versions WHERE document_id = ?')
    deleteVersionsStmt.run(req.params.id)

    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除失败:', error)
    console.error('错误堆栈:', error.stack)
    res.status(500).json({ message: '服务器错误' })
  }
})

// ============ 私密空间 API ============

// 私密空间密码验证
router.post('/private/verify-password', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body
    if (!password) {
      return res.status(400).json({ message: '请输入密码' })
    }

    const db = getDatabase()
    const stmt = db.prepare('SELECT password FROM private_settings WHERE id = 1')
    const settings = stmt.get()

    if (!settings) {
      return res.status(500).json({ message: '私密空间未初始化' })
    }

    const isValid = bcrypt.compareSync(password, settings.password)

    if (isValid) {
      res.json({ success: true })
    } else {
      res.status(401).json({ message: '密码错误' })
    }
  } catch (error) {
    console.error('验证密码失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 修改私密空间密码
router.post('/private/change-password', authenticateToken, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: '请填写所有字段' })
    }

    const db = getDatabase()
    const stmt = db.prepare('SELECT password FROM private_settings WHERE id = 1')
    const settings = stmt.get()

    if (!settings) {
      return res.status(500).json({ message: '私密空间未初始化' })
    }

    const isValid = bcrypt.compareSync(oldPassword, settings.password)

    if (!isValid) {
      return res.status(401).json({ message: '当前密码错误' })
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10)
    const updateStmt = db.prepare('UPDATE private_settings SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    updateStmt.run(hashedPassword)

    res.json({ message: '密码修改成功' })
  } catch (error) {
    console.error('修改密码失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取私密文件列表
router.get('/private/list', authenticateToken, async (req, res) => {
  try {
    const { keyword, page = 1, pageSize = 30 } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM private_documents WHERE 1=1'
    const params = []

    if (keyword) {
      sql += ' AND title LIKE ?'
      params.push(`%${keyword}%`)
    }

    sql += ' ORDER BY updated_at DESC'

    const stmt = db.prepare(sql)
    const rows = stmt.all(...params)

    // 转换为驼峰命名并转换时区
    const result = rows.map(row => ({
      id: row.id,
      title: row.title,
      filePath: row.file_path,
      size: row.size || 0,
      createdAt: convertToUTC8(row.created_at),
      updatedAt: convertToUTC8(row.updated_at)
    }))

    // 分页
    const total = result.length
    const pageNum = parseInt(page) || 1
    const pageSizeNum = parseInt(pageSize) || 30
    const startIndex = (pageNum - 1) * pageSizeNum
    const paginatedResult = result.slice(startIndex, startIndex + pageSizeNum)

    res.json({ data: paginatedResult, total })
  } catch (error) {
    console.error('获取私密文件列表失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 上传私密文件
router.post('/private/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { title } = req.body
    const filePath = req.file.path

    // 获取文件大小
    const size = fs.statSync(filePath).size

    const db = getDatabase()

    // 检查重名并自动添加后缀
    let finalTitle = title
    let suffix = 1
    let unique = false

    while (!unique) {
      const checkStmt = db.prepare('SELECT * FROM private_documents WHERE title = ?')
      const existing = checkStmt.get(finalTitle)
      if (!existing) {
        unique = true
      } else {
        finalTitle = `${title} (${suffix})`
        suffix++
      }
    }

    const stmt = db.prepare(
      `INSERT INTO private_documents (title, file_path, size) VALUES (?, ?, ?)`
    )
    const result = stmt.run(finalTitle, filePath, size)

    res.json({ id: result.lastInsertRowid, title: finalTitle, message: '上传成功' })
  } catch (error) {
    console.error('上传私密文件失败:', error)
    res.status(500).json({ message: '上传失败', error: error.message })
  }
})

// 下载私密文件
router.get('/download/private/:id', async (req, res) => {
  try {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    const jwt = await import('jsonwebtoken')
    jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM private_documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const filePath = document.file_path
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const fileName = path.basename(filePath)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.sendFile(filePath)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('下载私密文件失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除私密文件
router.delete('/private/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM private_documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (document && document.file_path && fs.existsSync(document.file_path)) {
      fs.unlinkSync(document.file_path)
    }

    const deleteStmt = db.prepare('DELETE FROM private_documents WHERE id = ?')
    deleteStmt.run(req.params.id)

    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除私密文件失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取私密文件内容用于预览
router.get('/private/:id/content', async (req, res) => {
  try {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    const jwt = await import('jsonwebtoken')
    jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM private_documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const filePath = document.file_path
    const fileSize = document.size || 0

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const ext = path.extname(filePath).toLowerCase()
    const textFormats = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.sql', '.sh', '.bat', '.yml', '.yaml', '.csv', '.log']
    const binaryFormats = ['.pdf', '.zip', '.rar', '.7z', '.tar', '.gz']
    const officeFormats = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']
    const imageFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg']

    if (officeFormats.includes(ext)) {
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else if (binaryFormats.includes(ext)) {
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else if (textFormats.includes(ext)) {
      const content = fs.readFileSync(filePath, 'utf-8')
      res.json({
        content,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: false
      })
    } else if (imageFormats.includes(ext)) {
      const content = fs.readFileSync(filePath)
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName: path.basename(filePath),
        fileSize: fileSize,
        isBase64: true
      })
    } else {
      return res.status(400).json({
        message: '不支持的文件格式'
      })
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('获取私密文件内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
