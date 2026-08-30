import express from 'express'
import multer from 'multer'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheKeys, CacheTTL } from '../utils/cache.js'
import { PAGINATION } from '../config/constants.js'
import {
  categoryCompatibilityFields,
  normalizeDocumentTags,
  resolveDocumentCategoryInput
} from '../services/documentDomainService.js'
import { documentOriginalName, getDocumentStorageRuntime } from '../services/documentStorageRuntime.js'
import { DocumentUploadStorage } from '../services/documentUploadStorage.js'
import { coordinateStorageCommit } from '../services/storageCommitCoordinator.js'
import {
  invalidateRagSource,
  scheduleRagSourceRefresh,
  scheduleRagSourcesRefresh
} from '../services/ragLifecycleService.js'
import {
  appendDocumentVersion,
  assertMatchingDocumentVersionFileType,
  assertDocumentVersionNotTrashed,
  DocumentVersionError,
  listDocumentVersions,
  normalizeDocumentVersionNote,
  restoreDocumentVersion,
  updateDocumentContent
} from '../services/documentVersionService.js'
import {
  listDeletedDocumentVersions,
  restoreDocumentVersionFromTrash,
  softDeleteDocumentVersion
} from '../services/documentVersionTrashService.js'
import {
  DocumentConflictError,
  documentUploadConflict,
  findDocumentUploadConflicts,
  normalizeDocumentConflictResolution,
  normalizeDocumentTitle,
  selectDocumentConflictTarget
} from '../services/documentConflictService.js'
import {
  listDeletedDocuments,
  permanentlyDeleteDocument,
  restoreDocumentFromTrash,
  softDeleteDocument
} from '../services/documentTrashService.js'
import {
  batchUpdateDocumentMetadata,
  createDocumentCategory,
  deleteDocumentCategoryTree,
  reorderDocumentCategories,
  renameDocumentCategory,
  updateDocumentMetadata
} from '../services/documentCategoryService.js'

const router = express.Router()
const DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv',
  '.json', '.xml', '.html', '.htm', '.rtf', '.odt', '.ods', '.jpg', '.jpeg',
  '.png', '.gif', '.bmp', '.webp'
])

const upload = multer({
  storage: new DocumentUploadStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (DOCUMENT_EXTENSIONS.has(ext)) return cb(null, true)
    const error = new Error('Document file type is unsupported.')
    error.code = 'DOCUMENT_FILE_TYPE_UNSUPPORTED'
    return cb(error, false)
  }
})

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

const DOCUMENT_PUBLIC_MESSAGES = Object.freeze({
  DOCUMENT_UPLOAD_CONFLICT: '当前分类中已有同名文档，请选择新建文档或作为指定文档的新版本',
  DOCUMENT_CONFLICT_RESOLUTION_INVALID: '文档冲突处理方式无效',
  DOCUMENT_CONFLICT_TARGET_INVALID: '选择的新版本目标已失效，请重新选择',
  DOCUMENT_CONTENT_IDENTICAL: '文件内容与当前版本完全相同，无需创建新版本',
  DOCUMENT_CATEGORY_ID_INVALID: '分类标识无效',
  DOCUMENT_CATEGORY_INVALID: '分类信息无效',
  DOCUMENT_CATEGORY_PATH_INVALID: '分类路径无效',
  DOCUMENT_CATEGORY_NOT_FOUND: '分类不存在或已被删除',
  DOCUMENT_CATEGORY_NAME_INVALID: '分类名称无效，不能包含斜杠或控制字符',
  DOCUMENT_CATEGORY_DUPLICATE: '同级分类中已经存在同名分类',
  DOCUMENT_CATEGORY_PARENT_MISSING: '父分类不存在或已被删除',
  DOCUMENT_CATEGORY_ORDER_INVALID: '只能对同一层级的有效分类重新排序',
  DOCUMENT_TAGS_INVALID: '标签格式无效',
  DOCUMENT_FILE_TYPE_UNSUPPORTED: '不支持该文件格式',
  DOCUMENT_FILE_TOO_LARGE: '文件超过 50 MB 上传上限',
  DOCUMENT_PREVIEW_TOO_LARGE: '文件超过 50 MB 在线预览上限，请下载后查看',
  DOCUMENT_CONTENT_REFERENCE_MISSING: '文档内容引用缺失，请先执行存储一致性检查',
  DOCUMENT_CONTENT_MISSING: '文档原始内容不存在，请先执行存储一致性检查',
  DOCUMENT_CONTENT_INVALID: '文档内容无效或为空',
  DOCUMENT_TITLE_INVALID: '文档标题不能为空',
  DOCUMENT_IDS_INVALID: '请选择有效的文档',
  DOCUMENT_VERSION_MANAGED: '版本号由系统自动管理',
  DOCUMENT_VERSION_NOTE_INVALID: '版本说明必须为 500 字以内的有效文本',
  DOCUMENT_VERSION_FILE_TYPE_MISMATCH: '新版本必须与当前文档保持相同文件类型；不同格式请另建文档',
  DOCUMENT_VERSION_NOT_FOUND: '历史版本不存在或已被删除',
  DOCUMENT_VERSION_IS_CURRENT: '当前版本不能恢复',
  DOCUMENT_VERSION_TRASHED: '该版本已进入版本回收站，需先从回收站恢复',
  DOCUMENT_NOT_FOUND: '文档不存在或已被删除',
  DOCUMENT_ALREADY_TRASHED: '文档已在回收站中',
  DOCUMENT_TRASH_NOT_FOUND: '文档已不在回收站中',
  DOCUMENT_TRASH_PURGE_IN_PROGRESS: '文档正在执行永久清理，暂时无法恢复',
  DOCUMENT_TRASH_LEGACY_MIGRATION_REQUIRED: '旧存储内容迁移完成后才能永久删除'
})

function documentFileName(document) {
  return documentOriginalName(document.original_name || document.file_path || document.title)
}

function documentExtension(document) {
  return path.extname(documentFileName(document)).toLowerCase()
}

function contentDispositionFileName(fileName) {
  return encodeURIComponent(fileName).replace(/['()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

async function readDocumentBuffer(contentService, document, maximumBytes = MAX_DOCUMENT_BYTES) {
  const metadata = await contentService.stat(document)
  if (metadata.bytes > maximumBytes) {
    const error = new Error('Document preview exceeds the allowed size.')
    error.code = 'DOCUMENT_PREVIEW_TOO_LARGE'
    throw error
  }
  const { stream } = await contentService.createReadStream(document)
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > maximumBytes) {
      stream.destroy()
      const error = new Error('Document preview exceeds the allowed size.')
      error.code = 'DOCUMENT_PREVIEW_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return { metadata, content: Buffer.concat(chunks) }
}

function sendDocumentError(res, error, fallbackMessage) {
  const statusByCode = {
    DOCUMENT_UPLOAD_CONFLICT: 409,
    DOCUMENT_CONFLICT_RESOLUTION_INVALID: 400,
    DOCUMENT_CONFLICT_TARGET_INVALID: 400,
    DOCUMENT_CONTENT_IDENTICAL: 409,
    DOCUMENT_CATEGORY_ID_INVALID: 400,
    DOCUMENT_CATEGORY_INVALID: 400,
    DOCUMENT_CATEGORY_PATH_INVALID: 400,
    DOCUMENT_CATEGORY_NOT_FOUND: 400,
    DOCUMENT_TAGS_INVALID: 400,
    DOCUMENT_CONTENT_REFERENCE_MISSING: 404,
    DOCUMENT_CONTENT_MISSING: 404,
    DOCUMENT_CONTENT_RANGE_INVALID: 416,
    DOCUMENT_PREVIEW_TOO_LARGE: 413,
    DOCUMENT_STORAGE_METADATA_INVALID: 409,
    DOCUMENT_STORAGE_METADATA_INCOMPLETE: 409,
    DOCUMENT_STORAGE_METADATA_MISMATCH: 409,
    DOCUMENT_STORAGE_KIND_INVALID: 409,
    DOCUMENT_CONTENT_INTEGRITY_FAILED: 409,
    DOCUMENT_CONTENT_INVALID: 400,
    DOCUMENT_ID_INVALID: 400,
    DOCUMENT_VERSION_MANAGED: 400,
    DOCUMENT_VERSION_INVALID: 400,
    DOCUMENT_VERSION_NOT_GREATER: 409,
    DOCUMENT_VERSION_NOTE_INVALID: 400,
    DOCUMENT_VERSION_FILE_TYPE_MISMATCH: 409,
    DOCUMENT_VERSION_NOT_FOUND: 404,
    DOCUMENT_VERSION_IS_CURRENT: 409,
    DOCUMENT_VERSION_NOT_CURRENT: 409,
    DOCUMENT_VERSION_TRASHED: 409,
    DOCUMENT_VERSION_NOT_TRASHED: 409,
    DOCUMENT_VERSION_PURGE_BLOCKED: 409,
    DOCUMENT_NOT_FOUND: 404
    , DOCUMENT_ALREADY_TRASHED: 409
    , DOCUMENT_TRASH_NOT_FOUND: 404
    , DOCUMENT_TRASH_PURGE_IN_PROGRESS: 409
    , DOCUMENT_TRASH_LEGACY_MIGRATION_REQUIRED: 409
    , DOCUMENT_CATEGORY_NAME_INVALID: 400
    , DOCUMENT_CATEGORY_DUPLICATE: 409
    , DOCUMENT_CATEGORY_PARENT_MISSING: 409
    , DOCUMENT_TITLE_INVALID: 400
    , DOCUMENT_IDS_INVALID: 400
    , DOCUMENT_CATEGORY_ORDER_INVALID: 400
    , DOCUMENT_FILE_TYPE_UNSUPPORTED: 415
    , DOCUMENT_FILE_TOO_LARGE: 413
  }
  const status = statusByCode[error?.code] ?? 500
  const body = {
    message: status === 500 ? fallbackMessage : (DOCUMENT_PUBLIC_MESSAGES[error?.code] || fallbackMessage),
    code: error?.code
  }
  if (error?.code === 'DOCUMENT_UPLOAD_CONFLICT') {
    body.candidates = Array.isArray(error.details?.candidates) ? error.details.candidates : []
    body.suggestedTitle = error.details?.suggestedTitle ?? null
  }
  return res.status(status).json(body)
}

function documentUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') {
      error.code = 'DOCUMENT_FILE_TOO_LARGE'
    }
    return sendDocumentError(res, error, '上传失败')
  })
}

async function scheduleDocumentIndex(database, sourceId, reasonCode) {
  try {
    const outcome = await scheduleRagSourceRefresh({ database, sourceType: 'document', sourceId, reasonCode })
    return ['enqueued', 'existing'].includes(outcome?.status)
      ? null
      : 'DOCUMENT_SAVED_INDEX_REFRESH_FAILED'
  } catch (error) {
    console.error('[Documents] index refresh scheduling failed:', error?.code || error?.name || 'UNKNOWN')
    return 'DOCUMENT_SAVED_INDEX_REFRESH_FAILED'
  }
}

async function scheduleDocumentIndexes(database, sourceIds, reasonCode) {
  const ids = Array.isArray(sourceIds) ? [...new Set(sourceIds)] : []
  if (ids.length === 0) return null
  try {
    const outcome = await scheduleRagSourcesRefresh({ database, sourceType: 'document', sourceIds: ids, reasonCode })
    return ['enqueued', 'existing'].includes(outcome?.status)
      ? null
      : 'DOCUMENT_SAVED_INDEX_REFRESH_FAILED'
  } catch (error) {
    console.error('[Documents] batch index refresh scheduling failed:', error?.code || error?.name || 'UNKNOWN')
    return 'DOCUMENT_SAVED_INDEX_REFRESH_FAILED'
  }
}

function documentSuccessMessage(message, warningCode) {
  return warningCode ? `${message}，索引刷新将在稍后重试` : message
}

function assertDocumentVersionFileType(database, documentId, originalName) {
  const document = database.prepare(`
    SELECT title, original_name, file_path
    FROM documents
    WHERE id = ?
  `).get(documentId)
  if (!document) return
  assertMatchingDocumentVersionFileType(documentFileName(document), originalName)
}

// 创建分类
router.post('/categories', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = createDocumentCategory(getDatabase(), req.body)
    try { await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    res.json({ id: result.categoryId, path: result.path, message: '创建成功' })
  } catch (error) {
    console.error('创建分类失败:', error)
    return sendDocumentError(res, error, '创建分类失败')
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
    // 尝试从缓存获取
    const cacheKey = CacheKeys.DOC_CATEGORIES
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()

    // 一次性获取所有分类
    const allCategoriesStmt = db.prepare('SELECT * FROM categories ORDER BY sort_order, name')
    const allCategories = allCategoriesStmt.all()
    
    // 构建分类ID到分类的映射
    const categoryMap = new Map(allCategories.map(cat => [cat.id, cat]))
    
    // 构建父ID到子分类列表的映射
    const childrenMap = new Map()
    for (const cat of allCategories) {
      const parentId = cat.parent_id || 0
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, [])
      }
      childrenMap.get(parentId).push(cat)
    }

    // 一次性获取所有文档分类统计
    // 按 category 和 subcategory 分组统计
    const docStatsStmt = db.prepare(`
      SELECT 
        d.category,
        d.subcategory,
        COUNT(*) as count
      FROM documents d
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_trash_entries t
        WHERE t.resource_type = 'document' AND t.resource_id = d.id
      )
      GROUP BY d.category, d.subcategory
    `)
    const docStats = docStatsStmt.all()
    
    // 构建分类路径到文档数量的映射
    const pathCountMap = new Map()
    
    // 初始化所有分类路径的计数为0
    for (const cat of allCategories) {
      pathCountMap.set(cat.path, 0)
    }
    
    // 统计每个路径的文档数量
    for (const stat of docStats) {
      const { category, subcategory, count } = stat
      
      if (!subcategory) {
        // 根分类下的文档
        const currentCount = pathCountMap.get(category) || 0
        pathCountMap.set(category, currentCount + count)
      } else {
        // 子分类下的文档：更新该子分类及其所有父分类的计数
        const parts = subcategory.split('/')
        
        // 更新根分类的计数（子分类文档也要算到根分类）
        pathCountMap.set(category, (pathCountMap.get(category) || 0) + count)
        
        // 更新完整路径及中间路径（如前端/Vue会累加到前端）
        let currentPath = category
        for (let i = 0; i < parts.length; i++) {
          currentPath = i === 0 ? `${category}/${parts[0]}` : `${currentPath}/${parts[i]}`
          pathCountMap.set(currentPath, (pathCountMap.get(currentPath) || 0) + count)
        }
      }
    }

    // 递归获取子分类（使用内存中的映射，不再查询数据库）
    function getSubcategories(parentId) {
      const children = childrenMap.get(parentId) || []
      return children.map(child => ({
        id: child.id,
        name: child.name,
        path: child.path,
        sortOrder: child.sort_order || 0,
        fileCount: pathCountMap.get(child.path) || 0,
        subcategories: getSubcategories(child.id)
      }))
    }

    // 获取根分类
    const rootCategories = childrenMap.get(0) || []

    const categories = rootCategories.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      sortOrder: row.sort_order || 0,
      fileCount: pathCountMap.get(row.path) || 0,
      subcategories: getSubcategories(row.id)
    }))

    // 缓存结果（5分钟）
    await cache.set(cacheKey, categories, CacheTTL.MEDIUM)

    res.json({ data: categories })
  } catch (error) {
    console.error('获取分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除分类
router.delete('/categories/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = deleteDocumentCategoryTree(database, req.params.id)
    try { await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    const warningCode = await scheduleDocumentIndexes(
      database,
      result.activeDocumentIds,
      'RAG_SOURCE_METADATA_CHANGED'
    )
    return res.json({
      message: documentSuccessMessage('分类已删除，文档已移到父分类或未分类', warningCode),
      deletedCategories: result.deletedCategories,
      movedDocuments: result.movedDocuments,
      categoryId: result.categoryId,
      warningCode
    })
  } catch (error) {
    console.error('删除分类失败:', error)
    return sendDocumentError(res, error, '删除分类失败')
  }
})

// 更新分类排序 - 注意：必须放在 /categories/:id 之前，否则会被 :id 匹配
router.put('/categories/reorder', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = reorderDocumentCategories(getDatabase(), req.body?.orders)
    try { await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    res.json({ message: '排序更新成功', count: result.count })
  } catch (error) {
    console.error('更新排序失败:', error)
    return sendDocumentError(res, error, '更新排序失败')
  }
})

// 更新分类名称
router.put('/categories/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const renamed = renameDocumentCategory(database, req.params.id, req.body.name)
    try { await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    const warningCode = await scheduleDocumentIndexes(
      database,
      renamed.activeDocumentIds,
      'RAG_SOURCE_METADATA_CHANGED'
    )
    return res.json({
      message: documentSuccessMessage('重命名成功', warningCode),
      newPath: renamed.newPath,
      warningCode
    })
  } catch (error) {
    console.error('更新分类名称失败:', error)
    return sendDocumentError(res, error, '重命名分类失败')
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

// 获取标签列表
router.get('/tags', authenticateToken, async (req, res) => {
  try {
    // 尝试从缓存获取
    const cacheKey = CacheKeys.DOC_TAGS
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT DISTINCT d.tags
      FROM documents d
      WHERE d.tags IS NOT NULL AND d.tags != ''
        AND NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'document' AND t.resource_id = d.id
        )
    `)
    const rows = stmt.all()

    const tags = new Set()
    rows.forEach(row => {
      if (row.tags) {
        const tagList = row.tags.split(',').map(t => t.trim()).filter(t => t)
        tagList.forEach(t => tags.add(t))
      }
    })

    const tagArray = Array.from(tags)

    // 缓存结果（10分钟）
    await cache.set(cacheKey, tagArray, CacheTTL.LONG)

    res.json({ data: tagArray })
  } catch (error) {
    console.error('获取标签失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取文档列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword, category, subcategory, tags, startDate, endDate, sortBy, sortOrder, includeSubcategories, page = PAGINATION.DEFAULT_PAGE, pageSize = PAGINATION.DEFAULT_PAGE_SIZE } = req.query
    const db = getDatabase()

    let sql = `SELECT * FROM documents d WHERE NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t WHERE t.resource_type = 'document' AND t.resource_id = d.id
    )`
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
    const getFileExtension = (fileName) => {
      if (!fileName) return ''
      const parts = fileName.split('.')
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
      const displayName = documentFileName(row)
      const fileExtension = getFileExtension(displayName)

      return {
        id: row.id,
        title: row.title,
        category: row.category,
        subcategory: row.subcategory,
        tags: row.tags,
        filePath: displayName,
        fileType: fileExtension,
        version: row.version,
        size: Number.isSafeInteger(row.content_bytes) ? row.content_bytes : 0,
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
    const pageNum = parseInt(page) || PAGINATION.DEFAULT_PAGE
    const pageSizeNum = parseInt(pageSize) || PAGINATION.DEFAULT_PAGE_SIZE
    const startIndex = (pageNum - 1) * pageSizeNum
    const paginatedResult = result.slice(startIndex, startIndex + pageSizeNum)

    res.json({ data: paginatedResult, total })
  } catch (error) {
    console.error('获取文档失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 上传文档
router.post('/upload', authenticateToken, requireWritePermission, documentUpload, async (req, res) => {
  let stagedToken = req.file?.stagingToken
  try {
    if (!req.file?.stagingToken) return res.status(400).json({ message: '请选择文件' })
    const title = normalizeDocumentTitle(req.body.title)
    const resolution = normalizeDocumentConflictResolution(req.body.resolution)
    if (Object.prototype.hasOwnProperty.call(req.body, 'newVersion') ||
      Object.prototype.hasOwnProperty.call(req.body, 'version')) {
      throw new DocumentVersionError('DOCUMENT_VERSION_MANAGED', 'Document version numbers are managed by the system.')
    }

    const db = getDatabase()
    const category = resolveDocumentCategoryInput(db, {
      categoryId: req.body.categoryId,
      category: req.body.category,
      subcategory: req.body.subcategory
    })
    const compatibility = categoryCompatibilityFields(category)
    const normalizedTags = normalizeDocumentTags(req.body.tags)
    const originalName = documentOriginalName(req.file.originalName)
    const initialVersionNote = normalizeDocumentVersionNote(req.body.versionNote)
    const conflicts = findDocumentUploadConflicts(db, {
      title,
      category,
      contentSha256: req.file.contentSha256
    })

    if (resolution === 'new_version') {
      const target = selectDocumentConflictTarget(conflicts, req.body.targetDocumentId)
      if (target.hashMatches) {
        throw new DocumentConflictError(
          'DOCUMENT_CONTENT_IDENTICAL',
          'Document content is identical to the current version.'
        )
      }
      assertDocumentVersionFileType(db, target.id, req.file.originalName)
      const runtime = getDocumentStorageRuntime()
      const result = await appendDocumentVersion({
        database: db,
        runtime,
        id: target.id,
        staged: {
          token: req.file.stagingToken,
          sha256: req.file.contentSha256,
          bytes: req.file.contentBytes
        },
        versionNote: initialVersionNote
      })
      stagedToken = null
      const warningCode = await scheduleDocumentIndex(db, target.id, 'RAG_SOURCE_VERSION_CHANGED')
      return res.json({
        id: target.id,
        title: target.title,
        version: result.version,
        resolution: 'new_version',
        warningCode,
        message: documentSuccessMessage('新版本上传成功', warningCode)
      })
    }

    const conflict = conflicts.length > 0
      ? documentUploadConflict({ database: db, title, category, contentSha256: req.file.contentSha256 })
      : null
    if (conflict) throw conflict

    let documentId
    const runtime = getDocumentStorageRuntime()
    await coordinateStorageCommit({
      database: db,
      storageService: runtime.storageService,
      idempotencyKey: `document-upload:${randomUUID()}`,
      stagingToken: stagedToken,
      kind: 'documents',
      expectedSha256: req.file.contentSha256,
      expectedBytes: req.file.contentBytes,
      writeDatabase: ({ storageKey, sha256, bytes }) => {
        const result = db.prepare(`
          INSERT INTO documents
            (title, category, subcategory, category_id, tags, file_path, storage_key,
             content_sha256, content_bytes, original_name, version)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1.0)
        `).run(
          title,
          compatibility.category,
          compatibility.subcategory,
          category?.id ?? null,
          normalizedTags.serialized,
          storageKey,
          sha256,
          bytes,
          originalName
        )
        documentId = Number(result.lastInsertRowid)
        db.prepare(`
          INSERT INTO document_versions
            (document_id, version, file_path, storage_key, content_sha256, content_bytes, note)
          VALUES (?, 1, NULL, ?, ?, ?, ?)
        `).run(documentId, storageKey, sha256, bytes, initialVersionNote || '初始版本')
      }
    })
    stagedToken = null

    // 新文档会同时改变标签建议和分类计数。
    try {
      await Promise.all([cache.del(CacheKeys.DOC_TAGS), cache.del(CacheKeys.DOC_CATEGORIES)])
    } catch (error) {
      console.warn('文档缓存清理失败:', error?.code ?? error?.name)
    }

    const warningCode = await scheduleDocumentIndex(db, documentId, 'RAG_SOURCE_CREATED')

    res.json({
      id: documentId,
      title,
      resolution: 'create',
      warningCode,
      message: documentSuccessMessage('上传成功', warningCode)
    })
  } catch (error) {
    if (stagedToken) {
      try { getDocumentStorageRuntime().storageService.discardStaged(stagedToken) } catch {}
    }
    console.error('文档上传错误:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '上传失败')
  }
})

// 在明确文档上下文中上传新版本，不依赖同名冲突来选择目标。
router.post('/:id/versions/upload', authenticateToken, requireWritePermission, documentUpload, async (req, res) => {
  let stagedToken = req.file?.stagingToken
  try {
    if (!req.file?.stagingToken) return res.status(400).json({ message: '请选择文件' })
    if (Object.prototype.hasOwnProperty.call(req.body, 'newVersion') ||
      Object.prototype.hasOwnProperty.call(req.body, 'version')) {
      throw new DocumentVersionError('DOCUMENT_VERSION_MANAGED', 'Document version numbers are managed by the system.')
    }
    const database = getDatabase()
    assertDocumentVersionFileType(database, req.params.id, req.file.originalName)
    const result = await appendDocumentVersion({
      database,
      runtime: getDocumentStorageRuntime(),
      id: req.params.id,
      staged: {
        token: req.file.stagingToken,
        sha256: req.file.contentSha256,
        bytes: req.file.contentBytes
      },
      versionNote: normalizeDocumentVersionNote(req.body.versionNote)
    })
    stagedToken = null
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_VERSION_CHANGED')
    return res.json({
      id: Number(req.params.id),
      version: result.version,
      warningCode,
      message: documentSuccessMessage('新版本上传成功', warningCode)
    })
  } catch (error) {
    if (stagedToken) {
      try { getDocumentStorageRuntime().storageService.discardStaged(stagedToken) } catch {}
    }
    console.error('上传文档新版本失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '上传新版本失败')
  }
})

// 获取文档内容用于编辑或预览
router.get('/:id/content', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      console.log('文档不存在:', req.params.id)
      return res.status(404).json({ message: '文档不存在' })
    }

    const fileName = documentFileName(document)
    const { metadata, content } = await readDocumentBuffer(getDocumentStorageRuntime().contentService, document)

    // 检查文件扩展名
    const ext = documentExtension(document)
    const textFormats = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.sql', '.sh', '.bat', '.yml', '.yaml', '.csv', '.log']
    const binaryFormats = ['.pdf', '.zip', '.rar', '.7z', '.tar', '.gz']
    const officeFormats = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']
    const imageFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

    if (ext === '.svg') {
      return res.status(415).json({
        message: 'SVG 含主动内容风险，仅支持下载，不支持在线预览'
      })
    }

    if (officeFormats.includes(ext)) {
      // Office文件：返回base64编码
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName,
        fileSize: metadata.bytes,
        isBase64: true
      })
    } else if (binaryFormats.includes(ext)) {
      // 二进制文件：返回 base64 编码的数据用于前端预览
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName,
        fileSize: metadata.bytes,
        isBase64: true
      })
    } else if (textFormats.includes(ext)) {
      // 文本文件：直接返回内容
      res.json({
        content: content.toString('utf8'),
        fileName,
        fileSize: metadata.bytes,
        isBase64: false
      })
    } else if (imageFormats.includes(ext)) {
      // 图片文件：返回 base64 编码
      const base64 = content.toString('base64')
      res.json({
        content: base64,
        fileName,
        fileSize: metadata.bytes,
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
    console.error('获取文档内容失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

// 更新文档内容
router.put('/:id/content', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const body = req.body ?? {}
    const database = getDatabase()
    const update = {
      database,
      runtime: getDocumentStorageRuntime(),
      id: req.params.id,
      content: body.content,
      versionNote: body.versionNote
    }
    if (Object.prototype.hasOwnProperty.call(body, 'newVersion')) update.newVersion = body.newVersion
    if (Object.prototype.hasOwnProperty.call(body, 'version')) update.version = body.version
    const result = await updateDocumentContent(update)
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_VERSION_CHANGED')
    res.json({
      message: documentSuccessMessage('保存成功', warningCode),
      version: result.version,
      warningCode
    })
  } catch (error) {
    console.error('更新文档内容失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error?.cause ?? error, '服务器错误')
  }
})

// 获取文档版本
router.get('/:id/versions/trash', authenticateToken, async (req, res) => {
  try {
    res.json({ data: listDeletedDocumentVersions(getDatabase(), req.params.id) })
  } catch (error) {
    console.error('获取文档版本回收列表失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '获取文档版本回收列表失败')
  }
})

router.get('/:id/versions', authenticateToken, async (req, res) => {
  try {
    res.json({ data: listDocumentVersions(getDatabase(), req.params.id) })
  } catch (error) {
    console.error('获取版本失败:', error)
    return sendDocumentError(res, error, '获取版本失败')
  }
})

// 更新文档
router.put('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = updateDocumentMetadata(database, req.params.id, req.body)
    try { await cache.del(CacheKeys.DOC_TAGS); await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_METADATA_CHANGED')
    return res.json({
      message: documentSuccessMessage('更新成功', warningCode),
      categoryId: result.categoryId,
      tags: result.tags,
      warningCode
    })
  } catch (error) {
    console.error('更新失败:', error)
    return sendDocumentError(res, error, '更新文档失败')
  }
})

// 批量更新文档
router.put('/batch/update', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = batchUpdateDocumentMetadata(database, req.body.ids, req.body)
    try { await cache.del(CacheKeys.DOC_TAGS); await cache.del(CacheKeys.DOC_CATEGORIES) } catch {}
    const warningCode = await scheduleDocumentIndexes(
      database,
      req.body.ids || [],
      'RAG_SOURCE_METADATA_CHANGED'
    )
    return res.json({
      message: documentSuccessMessage('批量更新成功', warningCode),
      count: result.count,
      categoryId: result.categoryId,
      warningCode
    })
  } catch (error) {
    console.error('批量更新失败:', error)
    return sendDocumentError(res, error, '批量更新失败')
  }
})

// 下载文档
router.get('/download/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM documents WHERE id = ?')
    const document = stmt.get(req.params.id)

    if (!document) {
      console.log('文档不存在:', req.params.id)
      return res.status(404).json({ message: '文档不存在' })
    }

    const fileName = documentFileName(document)
    const { stream } = await getDocumentStorageRuntime().contentService.createReadStream(document)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${contentDispositionFileName(fileName)}`)
    stream.on('error', (error) => {
      console.error('下载流失败:', error?.code ?? error?.name)
      if (!res.headersSent) sendDocumentError(res, error, '服务器错误')
      else res.destroy(error)
    })
    stream.pipe(res)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('下载失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

// 下载特定版本
router.get('/download/version/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare(`
      SELECT v.*, d.original_name, d.title
      FROM document_versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.id = ?
    `)
    const version = stmt.get(req.params.id)

    if (!version) {
      return res.status(404).json({ message: '版本不存在' })
    }
    assertDocumentVersionNotTrashed(db, version.id)

    const fileName = documentFileName(version)
    const { stream } = await getDocumentStorageRuntime().contentService.createReadStream(version)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${contentDispositionFileName(fileName)}`)
    stream.on('error', (error) => {
      console.error('版本下载流失败:', error?.code ?? error?.name)
      if (!res.headersSent) sendDocumentError(res, error, '服务器错误')
      else res.destroy(error)
    })
    stream.pipe(res)
  } catch (error) {
    console.error('下载版本失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

router.get('/trash', authenticateToken, async (req, res) => {
  try { res.json({ data: listDeletedDocuments(getDatabase()) }) } catch (error) {
    console.error('获取文档回收站失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

router.post('/trash/:id/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = restoreDocumentFromTrash({ database, id: req.params.id })
    try { await Promise.all([cache.del(CacheKeys.DOC_TAGS), cache.del(CacheKeys.DOC_CATEGORIES)]) } catch {}
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_RESTORED')
    res.json({
      message: documentSuccessMessage('恢复成功', warningCode),
      categoryId: result.categoryId,
      warningCode
    })
  } catch (error) {
    console.error('恢复文档失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

router.delete('/trash/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = await permanentlyDeleteDocument({
      database: getDatabase(), storageService: getDocumentStorageRuntime().storageService, id: req.params.id
    })
    res.json({ message: '永久删除成功', purgedObjects: result.purgedObjects })
  } catch (error) {
    console.error('永久删除文档失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

router.delete('/:id/versions/:versionId', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = softDeleteDocumentVersion({
      database: getDatabase(),
      id: req.params.id,
      versionId: req.params.versionId
    })
    res.json({ message: '历史版本已移入回收保护', deletedAt: result.deletedAt, purgeAfter: result.purgeAfter })
  } catch (error) {
    console.error('删除文档历史版本失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '删除文档历史版本失败')
  }
})

router.post('/:id/versions/:versionId/trash/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = await restoreDocumentVersionFromTrash({
      database,
      runtime: getDocumentStorageRuntime(),
      id: req.params.id,
      versionId: req.params.versionId,
      versionNote: req.body?.versionNote
    })
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_VERSION_CHANGED')
    res.json({
      message: documentSuccessMessage('历史版本恢复成功', warningCode),
      version: result.version,
      warningCode
    })
  } catch (error) {
    console.error('恢复回收文档版本失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error?.cause ?? error, '恢复回收文档版本失败')
  }
})

router.post('/:id/versions/:versionId/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = await restoreDocumentVersion({
      database,
      runtime: getDocumentStorageRuntime(),
      id: req.params.id,
      versionId: req.params.versionId,
      versionNote: req.body?.versionNote
    })
    const warningCode = await scheduleDocumentIndex(database, req.params.id, 'RAG_SOURCE_VERSION_CHANGED')
    res.json({
      message: documentSuccessMessage('恢复成功', warningCode),
      version: result.version,
      warningCode
    })
  } catch (error) {
    console.error('恢复文档版本失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error?.cause ?? error, '服务器错误')
  }
})

// 删除文档
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const database = getDatabase()
    const result = softDeleteDocument({ database, id: req.params.id })
    invalidateRagSource(database, {
      sourceType: 'document',
      sourceId: req.params.id,
      reasonCode: 'RAG_SOURCE_TRASHED'
    })
    try { await Promise.all([cache.del(CacheKeys.DOC_TAGS), cache.del(CacheKeys.DOC_CATEGORIES)]) } catch {}
    res.json({ message: '已移入回收站', purgeAfter: result.purgeAfter })
  } catch (error) {
    console.error('删除失败:', error?.code ?? error?.name)
    return sendDocumentError(res, error, '服务器错误')
  }
})

export default router
