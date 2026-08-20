import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import AdmZip from 'adm-zip'
import sharp from 'sharp'
import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheKeys, CacheTTL } from '../utils/cache.js'
import { compressImage } from '../utils/imageCompress.js'
import { ebookResourceLimiter } from '../middlewares/security.js'
import { convertToUTC8 } from '../utils/time.js'
import { PAGINATION } from '../config/constants.js'
import { ensureUploadDirectory, inspectChunks, mergeChunkFiles, uploadPath, validateArchiveEntries, validateUploadDescriptor } from '../services/uploadSecurity.js'
import { getResourceStorageRuntime } from '../services/resourceStorageRuntime.js'
import { commitEbookUpload } from '../services/ebookStorageService.js'
import {
  EbookCoverError,
  encodeEbookCoverJpeg,
  resolveExistingEbookCover,
  ensureEbookCover
} from '../services/ebookCoverService.js'
import { registerTaskProcessor } from '../services/taskRuntime.js'
import {
  createEbookCoverTaskProcessor,
  EBOOK_COVER_EXECUTION_CLASS,
  EBOOK_COVER_PROCESSOR_VERSION,
  EBOOK_COVER_SUBJECT_TYPE,
  EBOOK_COVER_TASK_TYPE,
  EBOOK_COVER_TASK_TYPES
} from '../services/ebookCoverTaskProcessor.js'
import { enqueueExclusiveRun, getTaskById } from '../services/taskStore.js'
import {
  listDeletedEbooks,
  permanentlyDeleteEbook,
  restoreEbookFromTrash,
  softDeleteEbook,
  softDeleteEbooks
} from '../services/ebookTrashService.js'

const router = express.Router()
export const EBOOK_COVER_WAIT_INTERVAL_MS = 100
export const EBOOK_COVER_WAIT_TIMEOUT_MS = 60_000
const BOOK_UPLOAD_POLICY = {
  extensions: ['.txt', '.epub', '.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.html', '.htm'],
  maxChunks: 1000,
  maxChunkBytes: 11 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024
}

function validateEpubArchive(filePath) {
  const archive = new AdmZip(filePath)
  const entries = archive.getEntries()
  validateArchiveEntries(entries, {
    maxEntries: 20000,
    maxEntryBytes: 100 * 1024 * 1024,
    maxExpandedBytes: 1024 * 1024 * 1024,
    maxCompressionRatio: 200
  })
  return entries
}

// 分片上传临时目录
const booksRoot = getStoragePath('books')
const currentChunksDir = () => ensureUploadDirectory(booksRoot, 'chunks')
const currentIncomingDir = () => ensureUploadDirectory(booksRoot, 'incoming')
currentChunksDir()
currentIncomingDir()

// 辅助函数：从EPUB文件中提取封面图片
function extractEpubCover(epubPath) {
  try {
    console.log('🖼️ 开始提取EPUB封面')
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()
    const normalizedEntries = new Map(zipEntries.map(entry => [
      path.posix.normalize(entry.entryName.replace(/\\/g, '/')).replace(/^\/+/, ''),
      entry
    ]))

    // 查找封面图片（常见的封面文件名）
    const coverPatterns = [
      /cover\.(jpg|jpeg|png|gif)$/i,
      /cover-image\.(jpg|jpeg|png|gif)$/i,
      /coverimage\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/cover\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/images\/cover\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/Images\/cover\.(jpg|jpeg|png|gif)$/i
    ]

    // 优先从 OPF manifest 精确解析封面，避免模糊路径匹配到错误条目。
    for (const entry of zipEntries) {
      const opfName = path.posix.normalize(entry.entryName.replace(/\\/g, '/')).replace(/^\/+/, '')
      if (opfName.toLowerCase().endsWith('.opf')) {
        const opfContent = entry.getData().toString('utf8')
        const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
        const metaTags = opfContent.match(/<meta\b[^>]*>/gi) || []
        const coverMeta = metaTags.find(tag => String(attribute(tag, 'name')).toLowerCase() === 'cover')
        const coverId = coverMeta ? attribute(coverMeta, 'content') : null
        const itemTags = opfContent.match(/<item\b[^>]*>/gi) || []
        const coverItem = itemTags.find(tag => {
          const properties = String(attribute(tag, 'properties') || '').split(/\s+/u)
          return properties.includes('cover-image') || (coverId && attribute(tag, 'id') === coverId)
        })
        const rawHref = coverItem ? attribute(coverItem, 'href') : null
        if (rawHref) {
          let decodedHref
          try { decodedHref = decodeURIComponent(rawHref.split('#')[0]) } catch { decodedHref = rawHref.split('#')[0] }
          const coverName = path.posix.normalize(path.posix.join(path.posix.dirname(opfName), decodedHref)).replace(/^\/+/, '')
          const coverEntry = normalizedEntries.get(coverName)
          if (coverEntry) {
            console.log(`✅ 通过OPF找到封面: ${coverEntry.entryName}`)
            return {
              data: coverEntry.getData(),
              ext: path.extname(coverEntry.entryName).toLowerCase()
            }
          }
        }
        break
      }
    }

    // 如果没有从OPF找到，尝试直接查找封面文件
    for (const entry of zipEntries) {
      for (const pattern of coverPatterns) {
        if (pattern.test(entry.entryName)) {
          console.log(`✅ 通过文件名匹配找到封面: ${entry.entryName}`)
          return {
            data: entry.getData(),
            ext: path.extname(entry.entryName).toLowerCase()
          }
        }
      }
    }

    // 如果还没找到，尝试查找任何包含 'cover' 的图片文件
    for (const entry of zipEntries) {
      const name = entry.entryName.toLowerCase()
      if (name.includes('cover') && /\.(jpg|jpeg|png|gif)$/i.test(name)) {
        console.log(`✅ 通过关键词匹配找到封面: ${entry.entryName}`)
        return {
          data: entry.getData(),
          ext: path.extname(entry.entryName).toLowerCase()
        }
      }
    }

    // 查找第一个图片文件
    for (const entry of zipEntries) {
      if (/\.(jpg|jpeg|png|gif)$/i.test(entry.entryName)) {
        console.log(`⚠️ 使用第一个图片作为封面: ${entry.entryName}`)
        return {
          data: entry.getData(),
          ext: path.extname(entry.entryName).toLowerCase()
        }
      }
    }

    console.log(`⚠️ 未找到封面图片`)
    return null
  } catch (error) {
    console.error('❌ 提取EPUB封面失败:', error)
    return null
  }
}

function extractValidatedEpubCover(bookPath) {
  try {
    validateEpubArchive(bookPath)
  } catch (error) {
    throw new EbookCoverError('EBOOK_COVER_ARCHIVE_INVALID', 'EPUB archive validation failed.', error)
  }
  return extractEpubCover(bookPath)
}

// 辅助函数：从PDF文件中提取封面图片（使用pdf-poppler或pdf2pic需要额外依赖，暂时跳过）
function extractPdfCover(pdfPath) {
  // PDF封面提取需要额外的库如 pdf-poppler 或 pdf2pic
  // 这些库需要系统安装 poppler-utils，暂时不实现
  return null
}

// 辅助函数：从XML中提取文本内容（处理CDATA和嵌套标签）
function extractXmlText(xmlString, tagPattern) {
  // 尝试多种匹配模式
  const patterns = [
    // 标准格式 <dc:tag>content</dc:tag>
    new RegExp(`<${tagPattern}[^>]*>([^<]*)</${tagPattern}>`, 'i'),
    // 带命名空间的格式
    new RegExp(`<[^:]+:${tagPattern}[^>]*>([^<]*)</[^:]+:${tagPattern}>`, 'i'),
    // 自闭合标签（无内容）
    new RegExp(`<${tagPattern}[^>]*>\\s*([^<\\s][^<]*)\\s*</${tagPattern}>`, 'i')
  ]
  
  for (const pattern of patterns) {
    const match = xmlString.match(pattern)
    if (match && match[1]) {
      // 清理内容：去除前后空白、解码HTML实体
      let content = match[1].trim()
      // 解码常见HTML实体
      content = content.replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&quot;/g, '"')
                      .replace(/&#39;/g, "'")
                      .replace(/&apos;/g, "'")
      return content
    }
  }
  return null
}

// 辅助函数：解析EPUB元数据
function parseEpubMetadata(epubPath) {
  try {
    console.log('📖 开始解析EPUB元数据')
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()

    // 从 container.xml 找 OPF 路径
    let opfPath = null
    const containerEntry = zipEntries.find(e => e.entryName === 'META-INF/container.xml')
    if (containerEntry) {
      const containerXml = containerEntry.getData().toString('utf8')
      const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path=["']([^"']+)["']/i)
      if (rootfileMatch) {
        opfPath = rootfileMatch[1]
        console.log(`📋 从container.xml找到OPF路径: ${opfPath}`)
      }
    }

    // 查找OPF文件
    let opfEntry = null
    if (opfPath) {
      opfEntry = zipEntries.find(e => e.entryName === opfPath)
    }
    if (!opfEntry) {
      opfEntry = zipEntries.find(e => e.entryName.endsWith('.opf'))
    }

    if (!opfEntry) {
      console.log(`⚠️ 未找到OPF文件，无法解析元数据`)
      return null
    }

    console.log(`📄 找到OPF文件: ${opfEntry.entryName}`)
    const opfContent = opfEntry.getData().toString('utf8')
    
    // 调试：打印OPF内容的前500字符
    console.log(`📄 OPF内容预览: ${opfContent.substring(0, 500)}...`)

    // 解析元数据
    const metadata = {
      title: null,
      author: null,
      publisher: null,
      year: null,
      isbn: null,
      description: null
    }

    // 提取标题 - 多种格式尝试
    metadata.title = extractXmlText(opfContent, 'dc:title')
    if (!metadata.title) {
      // 尝试不带命名空间的格式
      const titleMatch = opfContent.match(/<title[^>]*>([^<]*)<\/title>/i)
      if (titleMatch) metadata.title = titleMatch[1].trim()
    }

    // 提取作者 - 多种格式尝试
    metadata.author = extractXmlText(opfContent, 'dc:creator')
    if (!metadata.author) {
      // 尝试查找 creator 标签的其他格式
      const creatorMatches = opfContent.matchAll(/<[^>]*creator[^>]*>([^<]+)<\/[^>]*creator>/gi)
      const authors = []
      for (const match of creatorMatches) {
        if (match[1] && match[1].trim()) {
          authors.push(match[1].trim())
        }
      }
      if (authors.length > 0) {
        metadata.author = authors.join(', ')
      }
    }

    // 提取出版社
    metadata.publisher = extractXmlText(opfContent, 'dc:publisher')

    // 提取日期/年份 - 多种格式
    const datePatterns = [
      /<dc:date[^>]*>([^<]*)<\/dc:date>/i,
      /<[^:]+:date[^>]*>([^<]*)<\/[^:]+:date>/i,
      /<meta[^>]*property=["']dcterms:modified["'][^>]*>([^<]*)</i,
      /<meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i
    ]
    for (const pattern of datePatterns) {
      const match = opfContent.match(pattern)
      if (match && match[1]) {
        const dateStr = match[1].trim()
        const yearMatch = dateStr.match(/(\d{4})/)
        if (yearMatch) {
          metadata.year = yearMatch[1]
          break
        }
      }
    }

    // 提取ISBN - 多种格式
    const isbnPatterns = [
      /<dc:identifier[^>]*scheme=["']ISBN["'][^>]*>([^<]*)<\/dc:identifier>/i,
      /<dc:identifier[^>]*>([^<]*ISBN[^<]*)<\/dc:identifier>/i,
      /<[^:]+:identifier[^>]*>([^<]*ISBN[^<]*)<\/[^:]+:identifier>/i,
      /ISBN[:\s]*(97[89][\d-]+)/i
    ]
    for (const pattern of isbnPatterns) {
      const match = opfContent.match(pattern)
      if (match) {
        if (pattern.toString().includes('ISBN[:\\s]*')) {
          metadata.isbn = match[1]
        } else {
          metadata.isbn = match[1].replace(/ISBN[:\s]*/i, '').trim()
        }
        if (metadata.isbn) break
      }
    }

    // 提取描述/简介
    metadata.description = extractXmlText(opfContent, 'dc:description')
    if (!metadata.description) {
      // 尝试其他描述标签
      const descPatterns = [
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
        /<meta[^>]*property=["']dcterms:description["'][^>]*>([^<]*)</i
      ]
      for (const pattern of descPatterns) {
        const match = opfContent.match(pattern)
        if (match && match[1]) {
          metadata.description = match[1].trim()
          break
        }
      }
    }

    console.log(`✅ EPUB元数据解析成功:`, metadata)
    return metadata
  } catch (error) {
    console.error('❌ 解析EPUB元数据失败:', error)
    return null
  }
}

// 辅助函数：解析EPUB目录（TOC）
function parseEpubToc(epubPath) {
  try {
    console.log('📑 开始解析EPUB目录')
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()

    // 从 container.xml 获取 OPF 路径
    let opfDir = ''
    const containerEntry = zipEntries.find(e => e.entryName === 'META-INF/container.xml')
    if (containerEntry) {
      const containerXml = containerEntry.getData().toString('utf8')
      const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path=["']([^"']+)["']/i)
      if (rootfileMatch) {
        opfDir = path.dirname(rootfileMatch[1])
      }
    }

    // 查找NCX文件（EPUB2）或NAV文件（EPUB3）
    let tocEntry = null
    let tocType = null

    // 尝试查找NCX文件
    for (const entry of zipEntries) {
      if (entry.entryName.endsWith('.ncx')) {
        tocEntry = entry
        tocType = 'ncx'
        break
      }
    }

    // 如果没有NCX，尝试查找NAV文件（EPUB3）
    if (!tocEntry) {
      for (const entry of zipEntries) {
        if (entry.entryName.endsWith('.nav.xhtml') || entry.entryName.endsWith('nav.xhtml')) {
          tocEntry = entry
          tocType = 'nav'
          break
        }
      }
    }

    // 如果还是没有，尝试从OPF中查找toc引用
    if (!tocEntry) {
      const opfEntry = zipEntries.find(e => e.entryName.endsWith('.opf'))
      if (opfEntry) {
        const opfContent = opfEntry.getData().toString('utf8')
        // 查找spine中的toc项
        const tocMatch = opfContent.match(/<item[^>]*id=["']toc["'][^>]*href=["']([^"']+)["']/i)
        if (tocMatch) {
          const tocPath = opfDir ? `${opfDir}/${tocMatch[1]}` : tocMatch[1]
          tocEntry = zipEntries.find(e => e.entryName === tocPath || e.entryName.endsWith(tocMatch[1]))
          if (tocEntry) {
            tocType = tocMatch[1].endsWith('.ncx') ? 'ncx' : 'nav'
          }
        }
      }
    }

    if (!tocEntry) {
      console.log('⚠️ 未找到目录文件')
      return []
    }

    console.log(`📑 找到目录文件: ${tocEntry.entryName} (${tocType})`)
    const tocContent = tocEntry.getData().toString('utf8')

    const chapters = []

    if (tocType === 'ncx') {
      // 解析NCX格式 - 扁平化处理所有navPoint（避免嵌套重复）
      // 方法：匹配所有<navPoint>到</navPoint>的块，无论嵌套深度
      const navPointRegex = /<navPoint[^>]*>[\s\S]*?<\/navPoint>/gi
      const navPointMatches = tocContent.match(navPointRegex) || []
      
      console.log(`📑 找到 ${navPointMatches.length} 个navPoint标签`)
      
      for (const navPointBlock of navPointMatches) {
        // 提取navLabel中的text
        const textMatch = navPointBlock.match(/<navLabel[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>/i)
        // 提取content中的src（第一个匹配）
        const srcMatch = navPointBlock.match(/<content[^>]*src=["']([^"']+)["']/i)
        
        if (textMatch && srcMatch) {
          const title = textMatch[1].replace(/<[^>]+>/g, '').trim() // 移除可能的HTML标签
          chapters.push({
            title: title,
            href: srcMatch[1].split('#')[0] // 移除锚点
          })
        }
      }
    } else {
      // 解析NAV/XHTML格式
      const navMatches = tocContent.matchAll(/<li[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi)
      for (const match of navMatches) {
        chapters.push({
          title: match[2].trim(),
          href: match[1].split('#')[0]
        })
      }
    }

    // 去重（同一章节可能有多个导航点）
    const uniqueChapters = []
    const seen = new Set()
    for (const ch of chapters) {
      const key = ch.href
      if (!seen.has(key) && ch.title) {
        seen.add(key)
        uniqueChapters.push(ch)
      }
    }

    console.log(`📑 解析到 ${uniqueChapters.length} 个章节`)
    
    // 如果需要，返回去重后的章节数组
    // 注意：完整的目录合并将在主函数中处理
    return uniqueChapters
  } catch (error) {
    console.error('❌ 解析EPUB目录失败:', error)
    return []
  }
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { cb(null, currentIncomingDir()) } catch (error) { cb(error) }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.txt', '.epub', '.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.html', '.htm']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowedTypes.includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('不支持的文件格式'))
    }
  }
})

// 分类管理

// 获取分类列表
router.get('/categories', authenticateToken, async (req, res) => {
  try {
    // 尝试从缓存获取
    const cacheKey = CacheKeys.BOOK_CATEGORIES
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM book_categories ORDER BY sort_order, name')
    const rows = stmt.all()

    const categories = rows.map(row => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order || 0,
      bookCount: 0 // 稍后统计
    }))

    // 统计每个分类的书籍数量
    for (const cat of categories) {
      const countStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM books b WHERE b.category_id = ? AND NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'ebook' AND t.resource_id = b.id
        )
      `)
      const result = countStmt.get(cat.id)
      cat.bookCount = result.count
    }

    // 缓存结果（10分钟）
    await cache.set(cacheKey, categories, CacheTTL.LONG)

    res.json({ data: categories })
  } catch (error) {
    console.error('获取分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 创建分类
router.post('/categories', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { name } = req.body
    if (!name || !name.trim()) {
      return res.status(400).json({ message: '分类名称不能为空' })
    }

    const db = getDatabase()
    
    // 检查是否已存在同名分类
    const checkStmt = db.prepare('SELECT * FROM book_categories WHERE name = ?')
    const existing = checkStmt.get(name.trim())
    if (existing) {
      return res.status(400).json({ message: '分类已存在' })
    }

    const stmt = db.prepare('INSERT INTO book_categories (name) VALUES (?)')
    const result = stmt.run(name.trim())

    // 清除分类缓存，确保分类列表实时更新
    await cache.del(CacheKeys.BOOK_CATEGORIES)

    res.json({ id: result.lastInsertRowid, message: '创建成功' })
  } catch (error) {
    console.error('创建分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 重命名分类
router.put('/categories/:id', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body
    const categoryId = req.params.id

    if (!name || !name.trim()) {
      return res.status(400).json({ message: '分类名称不能为空' })
    }

    const db = getDatabase()

    // 检查分类是否存在
    const category = db.prepare('SELECT * FROM book_categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(404).json({ message: '分类不存在' })
    }

    // 检查是否已存在同名分类
    const checkStmt = db.prepare('SELECT * FROM book_categories WHERE name = ? AND id != ?')
    const existing = checkStmt.get(name.trim(), categoryId)
    if (existing) {
      return res.status(400).json({ message: '分类已存在' })
    }

    const updateStmt = db.prepare('UPDATE book_categories SET name = ? WHERE id = ?')
    updateStmt.run(name.trim(), categoryId)

    // 清除分类缓存，确保分类列表实时更新
    await cache.del(CacheKeys.BOOK_CATEGORIES)

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除分类
router.delete('/categories/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const categoryId = req.params.id

    // 检查分类是否存在
    const category = db.prepare('SELECT * FROM book_categories WHERE id = ?').get(categoryId)
    if (!category) {
      return res.status(404).json({ message: '分类不存在' })
    }

    // 将该分类下的书籍的 category_id 设为 null
    db.prepare('UPDATE books SET category_id = NULL WHERE category_id = ?').run(categoryId)

    // 删除分类
    db.prepare('DELETE FROM book_categories WHERE id = ?').run(categoryId)

    // 清除分类缓存，确保分类列表实时更新
    await cache.del(CacheKeys.BOOK_CATEGORIES)

    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除分类失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新分类排序
router.put('/categories/reorder', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { orders } = req.body

    if (!orders || !Array.isArray(orders)) {
      return res.status(400).json({ message: '参数错误' })
    }

    const db = getDatabase()
    const updateStmt = db.prepare('UPDATE book_categories SET sort_order = ? WHERE id = ?')
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

// 书籍管理

// 分片上传

// 上传分片
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { cb(null, currentChunksDir()) } catch (error) { cb(error) }
  },
  filename: (req, file, cb) => cb(null, randomUUID())
})
const chunkUpload = multer({ storage: chunkStorage, limits: { fileSize: BOOK_UPLOAD_POLICY.maxChunkBytes, files: 1 } })

router.post('/upload-chunk', authenticateToken, requireWritePermission, chunkUpload.single('chunk'), async (req, res) => {
  try {
    const descriptor = validateUploadDescriptor(req.body, BOOK_UPLOAD_POLICY)
    const { chunkIndex: index, totalChunks, fileId, fileName } = descriptor

    if (!req.file) {
      return res.status(400).json({ message: '没有接收到分片' })
    }

    console.log(`📦 收到分片 ${index}/${totalChunks}: ${fileName}`)

    // 创建文件专属目录
    const fileDir = uploadPath(currentChunksDir(), fileId)
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true })
    }

    // 移动分片到专属目录
    const chunkPath = uploadPath(fileDir, `chunk_${index}`)
    if (fs.existsSync(chunkPath)) fs.rmSync(chunkPath, { force: true })
    fs.renameSync(req.file.path, chunkPath)

    res.json({ message: '分片上传成功', index: parseInt(index) })
  } catch (error) {
    console.error('上传分片失败:', error)
    if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true })
    res.status(400).json({ message: '上传分片失败' })
  }
})

// 合并分片并解析元数据
router.post('/merge-chunks', authenticateToken, requireWritePermission, async (req, res) => {
  let finalPath
  let staged
  try {
    const descriptor = validateUploadDescriptor(req.body, BOOK_UPLOAD_POLICY)
    const { fileId, fileName, totalChunks, extension } = descriptor

    console.log(`🔧 开始合并分片: ${fileName}`)
    console.log(`📊 预期分片数: ${totalChunks}`)

    const fileDir = uploadPath(currentChunksDir(), fileId)
    finalPath = uploadPath(currentIncomingDir(), `${Date.now()}-${Math.round(Math.random() * 1E9)}${extension}`)
    const inspected = inspectChunks(fileDir, fileId, totalChunks, (_id, index) => `chunk_${index}`, BOOK_UPLOAD_POLICY.maxTotalBytes)
    await mergeChunkFiles(inspected.paths, finalPath)
    console.log(`✅ 分片合并完成 (${(inspected.totalBytes / 1024 / 1024).toFixed(2)}MB)`)

    // 验证ZIP文件完整性（对于EPUB）
    const fileType = extension.replace('.', '')
    if (fileType === 'epub') {
      try {
        const testEntries = validateEpubArchive(finalPath)
        console.log(`✅ ZIP文件验证通过，条目数: ${testEntries.length}`)
      } catch (zipError) {
        console.error(`❌ ZIP文件验证失败:`, zipError.message)
        fs.rmSync(finalPath, { force: true })
        return res.status(400).json({ 
          message: 'EPUB文件合并后损坏，请重新上传',
          error: zipError.message 
        })
      }
    }

    // 删除分片目录
    fs.rmSync(fileDir, { recursive: true, force: true })

    // 解析元数据
    let metadata = {
      title: fileName.replace(/\.[^/.]+$/, ''),
      author: null,
      year: null,
      publisher: null,
      isbn: null,
      description: null
    }

    if (fileType === 'epub') {
      console.log(`📖 开始解析EPUB元数据...`)
      const epubMetadata = parseEpubMetadata(finalPath)
      if (epubMetadata) {
        metadata = { ...metadata, ...epubMetadata }
        console.log(`✅ 元数据解析结果:`, {
          书名: metadata.title,
          作者: metadata.author,
          出版社: metadata.publisher,
          年份: metadata.year
        })
      } else {
        console.log(`⚠️ 元数据解析返回空，使用默认值`)
      }
    }

    staged = await stageTemporaryFile(finalPath)
    finalPath = null
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: {
      ...metadata,
      stagingToken: staged.token,
      contentSha256: staged.sha256,
      contentBytes: staged.bytes,
      originalName: fileName
    } })
  } catch (error) {
    console.error('合并分片失败:', error)
    if (finalPath && fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true })
    if (staged?.token) {
      try { getResourceStorageRuntime().storageService.discardStaged(staged.token) } catch {}
    }
    res.status(400).json({ message: '合并失败' })
  }
})

// 取消分片上传（清理临时文件）
router.delete('/cancel-upload', authenticateToken, async (req, res) => {
  try {
    const fileId = String(req.body?.fileId || '')
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(fileId)) return res.status(400).json({ message: '上传标识无效' })
    const fileDir = uploadPath(currentChunksDir(), fileId)

    if (fs.existsSync(fileDir)) {
      fs.rmSync(fileDir, { recursive: true, force: true })
      console.log(`🗑️ 已清理分片: ${fileId}`)
    }

    res.json({ message: '已取消上传' })
  } catch (error) {
    console.error('取消上传失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 解析书籍元数据（上传前预解析）
router.post('/parse-metadata', authenticateToken, requireWritePermission, upload.single('file'), async (req, res) => {
  let filePath
  try {
    if (!req.file) {
      return res.status(400).json({ message: '请选择文件' })
    }

    filePath = req.file.path
    const fileType = path.extname(req.file.originalname).toLowerCase().replace('.', '')

    let metadata = {
      title: req.file.originalname.replace(/\.[^/.]+$/, ''),
      author: null,
      year: null,
      publisher: null,
      isbn: null,
      description: null
    }

    // 解析EPUB元数据
    if (fileType === 'epub') {
      const epubMetadata = parseEpubMetadata(filePath)
      if (epubMetadata) {
        metadata = { ...metadata, ...epubMetadata }
      }
    }

    // 删除临时文件
    res.json({ data: metadata })
  } catch (error) {
    console.error('解析元数据失败:', error)
    // 删除临时文件
    res.status(500).json({ message: '解析失败', error: error.message })
  } finally {
    if (filePath) fs.rmSync(filePath, { force: true })
  }
})

// 获取书籍列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword, category, sortBy, sortOrder } = req.query
    console.log('[Books API] 接收到的参数:', { keyword, category, sortBy, sortOrder })
    const db = getDatabase()

    const userId = req.user?.id || null // 游客为 null，管理员为用户ID
    
    // 构建 JOIN 条件：管理员只查自己的进度，游客只查空进度
    let progressJoin = ''
    if (userId) {
      // 管理员：user_id = 具体ID
      progressJoin = 'LEFT JOIN reading_progress rp ON b.id = rp.book_id AND rp.user_id = ?'
    } else {
      // 游客：user_id IS NULL
      progressJoin = 'LEFT JOIN reading_progress rp ON b.id = rp.book_id AND rp.user_id IS NULL'
    }
    
    let sql = `SELECT b.*, c.name as category_name,
               rp.current_page, rp.progress, rp.font_size
               FROM books b
               LEFT JOIN book_categories c ON b.category_id = c.id
               ${progressJoin}
               WHERE NOT EXISTS (
                 SELECT 1 FROM resource_trash_entries t
                 WHERE t.resource_type = 'ebook' AND t.resource_id = b.id
               )`
    const params = userId ? [userId] : []

    if (keyword) {
      sql += ' AND (b.title LIKE ? OR b.author LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }

    if (category) {
      sql += ' AND b.category_id = ?'
      params.push(category)
    }

    // 排序
    const validSortFields = ['title', 'author', 'year', 'updated_at', 'last_read_at']
    const validSortOrders = ['ASC', 'DESC']
    
    let sortField = validSortFields.includes(sortBy) ? sortBy : 'updated_at'
    let sortDirection = validSortOrders.includes(sortOrder?.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'
    
    // 特殊处理 last_read_at 排序（最近阅读）
    if (sortField === 'last_read_at') {
      sql += ` ORDER BY COALESCE(b.last_read_at, '1970-01-01') ${sortDirection}`
    } else {
      sql += ` ORDER BY b.${sortField} ${sortDirection}`
    }

    const stmt = db.prepare(sql)
    const rows = stmt.all(...params)

    const result = rows.map(row => ({
      id: row.id,
      title: row.title,
      author: row.author,
      year: row.year,
      publisher: row.publisher,
      isbn: row.isbn,
      description: row.description,
      coverImage: Boolean(row.cover_image),
      categoryId: row.category_id,
      categoryName: row.category_name,
      fileType: row.file_type,
      fileSize: row.file_size,
      totalPages: row.total_pages,
      currentPage: row.current_page || 0,
      progress: row.progress || 0,
      fontSize: row.font_size || 16,
      createdAt: convertToUTC8(row.created_at),
      updatedAt: convertToUTC8(row.updated_at),
      lastReadAt: row.last_read_at ? convertToUTC8(row.last_read_at) : null
    }))

    res.json({ data: result })
  } catch (error) {
    console.error('获取书籍列表失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 上传书籍
router.post('/upload', authenticateToken, requireWritePermission, upload.single('file'), async (req, res) => {
  let filePath
  let storedFilePath
  let bookInserted = false
  try {
    if (!req.file) return res.status(400).json({ message: '请选择文件' })
    const { title, author, year, publisher, isbn, description, categoryId } = req.body
    filePath = req.file.path
    storedFilePath = filePath
    const fileSize = fs.statSync(filePath).size
    const fileType = path.extname(req.file.originalname).toLowerCase().replace('.', '')

    console.log('📤 收到书籍上传请求:', {
      书名: title,
      作者: author || '未填写',
      文件大小: (fileSize / 1024 / 1024).toFixed(2) + 'MB',
      文件类型: fileType
    })

    const db = getDatabase()

    // 检查重名
    let finalTitle = title || req.file.originalname.replace(/\.[^/.]+$/, '')
    let suffix = 1
    let unique = false

    while (!unique) {
      const checkStmt = db.prepare('SELECT * FROM books WHERE title = ?')
      const existing = checkStmt.get(finalTitle)
      if (!existing) {
        unique = true
      } else {
        finalTitle = `${title || req.file.originalname.replace(/\.[^/.]+$/, '')} (${suffix})`
        suffix++
      }
    }

    // 计算总页数（简化版，按字符数估算）
    let totalPages = 0
    if (fileType === 'txt') {
      const content = fs.readFileSync(filePath, 'utf-8')
      totalPages = Math.ceil(content.length / 2000) // 每页约2000字符
      console.log(`📄 TXT文件页数估算: ${totalPages}页`)
    }

    // 提取封面图片
    let coverImagePath = null
    if (fileType === 'epub') {
      validateEpubArchive(filePath)
      console.log('🖼️ 开始提取EPUB封面...')
      const cover = extractEpubCover(filePath)
      if (cover) {
        // 创建covers目录
        const coversDir = path.join(getStoragePath('books'), 'covers')
        if (!fs.existsSync(coversDir)) {
          fs.mkdirSync(coversDir, { recursive: true })
        }
        
        // 压缩封面图片
        const compressedData = await compressImage(cover.data, { maxWidth: 500, maxHeight: 500, quality: 85 })
        
        // 保存封面图片（统一转为 .jpg 格式以节省空间）
        const coverFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`
        coverImagePath = path.join(coversDir, coverFileName)
        fs.writeFileSync(coverImagePath, compressedData)
        console.log(`✅ 封面提取成功: ${coverFileName} (原始: ${(cover.data.length / 1024).toFixed(2)}KB → 压缩后: ${(compressedData.length / 1024).toFixed(2)}KB)`)
      } else {
        console.log(`⚠️ 封面提取失败，将使用默认占位图`)
      }
    }

    const staged = await stageTemporaryFile(filePath)
    storedFilePath = null
    const created = await createManagedBook({
      database: db,
      staged,
      originalName: req.file.originalname,
      fields: { title: finalTitle, author, year, publisher, isbn, description, categoryId },
      totalPages,
      coverImagePath
    })
    bookInserted = true

    console.log(`✅ 书籍上传成功:`, {
      ID: created.id,
      书名: finalTitle,
      作者: author || '未填写',
      封面: coverImagePath ? '已提取' : '无'
    })

    // 清除分类缓存，确保分类数量统计实时更新
    await cache.del(CacheKeys.BOOK_CATEGORIES)

    res.json({ id: created.id, title: created.title, message: '上传成功' })
  } catch (error) {
    console.error('❌ 上传书籍失败:', error?.code || error?.name || 'UNKNOWN')
    if (!bookInserted && storedFilePath) fs.rmSync(storedFilePath, { force: true })
    res.status(400).json({ message: '上传失败' })
  }
})

function ebookFileType(originalName) {
  const extension = path.extname(String(originalName || '')).toLowerCase()
  if (!BOOK_UPLOAD_POLICY.extensions.includes(extension)) {
    throw Object.assign(new Error('Unsupported ebook file type.'), { code: 'EBOOK_UPLOAD_INVALID' })
  }
  return extension.slice(1)
}

async function stageTemporaryFile(filePath) {
  const runtime = getResourceStorageRuntime()
  try {
    return await runtime.storageService.stageFromStream(fs.createReadStream(filePath))
  } finally {
    fs.rmSync(filePath, { force: true })
  }
}

function uniqueBookTitle(database, requestedTitle, originalName) {
  const base = String(requestedTitle || path.basename(originalName, path.extname(originalName))).trim() || '未命名书籍'
  let candidate = base
  let suffix = 1
  while (database.prepare('SELECT 1 FROM books WHERE title = ?').get(candidate)) {
    candidate = `${base} (${suffix})`
    suffix += 1
  }
  return candidate
}

async function createManagedBook({ database, staged, originalName, fields, totalPages, coverImagePath }) {
  const runtime = getResourceStorageRuntime()
  const finalTitle = uniqueBookTitle(database, fields.title, originalName)
  const created = await commitEbookUpload({
    database,
    storageService: runtime.storageService,
    staged,
    ebook: {
      ...fields,
      title: finalTitle,
      originalName,
      fileType: ebookFileType(originalName),
      totalPages,
      coverImagePath
    }
  })
  return Object.freeze({ id: created.id, title: created.title })
}

async function verifiedBookPath(book) {
  return (await getResourceStorageRuntime().contentService.resolveVerifiedFilePath(book)).filePath
}

function activeBook(database, id) {
  return database.prepare(`
    SELECT b.* FROM books b WHERE b.id = ? AND NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'ebook' AND t.resource_id = b.id
    )
  `).get(id)
}

function persistEbookCoverPath(coverPath, previousCoverPath, context = {}) {
  const database = context.database ?? getDatabase()
  const bookId = context.book?.id
  if (!Number.isSafeInteger(Number(bookId)) || Number(bookId) <= 0) {
    throw new EbookCoverError('EBOOK_COVER_INPUT_INVALID', 'Ebook cover update input is invalid.')
  }
  try {
    const result = database.prepare(`
      UPDATE books SET cover_image = ?
      WHERE id = ? AND cover_image IS ?
    `).run(coverPath, Number(bookId), previousCoverPath)
    if (result.changes !== 1) {
      throw new EbookCoverError('EBOOK_COVER_UPDATE_CONFLICT', 'Ebook cover changed concurrently.')
    }
  } catch (error) {
    if (error instanceof EbookCoverError) throw error
    throw new EbookCoverError('EBOOK_COVER_DATABASE_UNAVAILABLE', 'Ebook cover database update failed.', error)
  }
}

function isEpubBook(book) {
  const extension = path.extname(String(book?.original_name || book?.file_path || '')).toLowerCase()
  return extension === '.epub' || String(book?.file_type || '').toLowerCase() === 'epub'
}

export function enqueueEbookCoverTask(database, bookId, runIdentity = randomUUID()) {
  return enqueueExclusiveRun(database, {
    taskType: EBOOK_COVER_TASK_TYPE,
    processorVersion: EBOOK_COVER_PROCESSOR_VERSION,
    subjectType: EBOOK_COVER_SUBJECT_TYPE,
    subjectId: String(bookId),
    subjectVersionId: runIdentity,
    input: { bookId },
    executionClass: EBOOK_COVER_EXECUTION_CLASS
  }, { taskTypes: EBOOK_COVER_TASK_TYPES })
}

function requestAbortController(req, res) {
  const controller = new AbortController()
  const listeners = []
  const abort = () => controller.abort()
  // IncomingMessage's `close` event may also fire after a normally completed
  // request body, before the response has been produced. Treat only an actual
  // request abort or a closed response as the waiter disconnecting.
  for (const [target, eventName] of [[req, 'aborted'], [res, 'close']]) {
    if (target && typeof target.once === 'function') {
      target.once(eventName, abort)
      listeners.push([target, eventName])
    }
  }
  if (req?.aborted || req?.destroyed || res?.destroyed) controller.abort()
  return {
    signal: controller.signal,
    cleanup() {
      for (const [target, eventName] of listeners) {
        target.removeListener?.(eventName, abort)
      }
    }
  }
}

function sleepForEbookCover(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let timer
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, milliseconds)
    signal?.addEventListener('abort', done, { once: true })
  })
}

export async function waitForEbookCoverTask({
  taskId,
  readTask,
  signal,
  intervalMs = EBOOK_COVER_WAIT_INTERVAL_MS,
  timeoutMs = EBOOK_COVER_WAIT_TIMEOUT_MS,
  now = () => Date.now(),
  sleep = sleepForEbookCover
} = {}) {
  if (typeof readTask !== 'function') throw new TypeError('readTask must be a function')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function')
  const pollInterval = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : EBOOK_COVER_WAIT_INTERVAL_MS
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : EBOOK_COVER_WAIT_TIMEOUT_MS
  const startedAt = now()
  const maxPolls = Math.max(1, Math.ceil(timeout / Math.max(1, pollInterval)) + 1)
  let polls = 0

  while (polls < maxPolls) {
    if (signal?.aborted) return Object.freeze({ task: null, aborted: true, timedOut: false })
    const task = await readTask(taskId)
    if (task === null || task === undefined) {
      return Object.freeze({ task: null, aborted: false, timedOut: false, missing: true })
    }
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      return Object.freeze({ task, aborted: false, timedOut: false })
    }
    polls += 1
    if (signal?.aborted) return Object.freeze({ task: null, aborted: true, timedOut: false })
    if (now() - startedAt >= timeout) break
    await sleep(Math.min(pollInterval, Math.max(0, timeout - (now() - startedAt))), signal)
  }
  return Object.freeze({ task: null, aborted: Boolean(signal?.aborted), timedOut: !signal?.aborted })
}

const registeredEbookCoverTaskProcessor = createEbookCoverTaskProcessor({
  databaseProvider: getDatabase,
  booksRoot,
  resolveBookPath: verifiedBookPath,
  extractCover: extractValidatedEpubCover,
  compressCover: encodeEbookCoverJpeg,
  updateCoverPath: persistEbookCoverPath,
  ensureCover: ensureEbookCover
})
registerTaskProcessor(
  EBOOK_COVER_TASK_TYPE,
  EBOOK_COVER_PROCESSOR_VERSION,
  EBOOK_COVER_EXECUTION_CLASS,
  registeredEbookCoverTaskProcessor
)

function sendEbookRouteError(res, error) {
  const code = String(error?.code || '')
  if (code.endsWith('_INVALID') || code === 'EBOOK_IDS_INVALID') return res.status(400).json({ code, message: '请求无效' })
  if (code === 'EBOOK_NOT_FOUND' || code === 'EBOOK_TRASH_NOT_FOUND' || code === 'RESOURCE_CONTENT_MISSING') {
    return res.status(404).json({ code, message: '资源不存在' })
  }
  if (code === 'EBOOK_ALREADY_TRASHED' || code === 'EBOOK_TRASH_PURGE_IN_PROGRESS') {
    return res.status(409).json({ code, message: '资源状态冲突' })
  }
  if (code === 'EBOOK_TRASH_LEGACY_MIGRATION_REQUIRED') {
    return res.status(409).json({ code, message: '旧版内容迁移后才能永久删除' })
  }
  return res.status(500).json({ code: code || 'EBOOK_OPERATION_FAILED', message: '服务器错误' })
}

// 使用已上传的文件路径创建书籍（分片上传后调用）
router.post('/upload-with-path', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { title, author, year, publisher, isbn, description, categoryId } = req.body
    const stagingToken = String(req.body.stagingToken || '')
    const contentSha256 = String(req.body.contentSha256 || '')
    const contentBytes = Number(req.body.contentBytes)
    const originalName = path.basename(String(req.body.originalName || ''))
    const runtime = getResourceStorageRuntime()
    const filePath = runtime.storageService.stagingFile(stagingToken)

    console.log('📤 收到upload-with-path请求:', {
      书名: title,
      作者: author,
      分类ID: categoryId
    })

    if (!/^[a-f0-9]{64}$/.test(contentSha256) || !Number.isSafeInteger(contentBytes) || contentBytes < 0 || !originalName) {
      return res.status(400).json({ message: '暂存文件元数据无效' })
    }

    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ message: '暂存文件不存在' })
    }

    const fileSize = fs.statSync(filePath).size
    const fileType = ebookFileType(originalName)
    if (fileSize !== contentBytes) return res.status(400).json({ message: '暂存文件大小不一致' })

    console.log('📤 文件信息:', {
      文件大小: (fileSize / 1024 / 1024).toFixed(2) + 'MB',
      文件类型: fileType
    })

    const db = getDatabase()

    // 检查重名
    let finalTitle = title || originalName.replace(/\.[^/.]+$/, '')
    let suffix = 1
    let unique = false

    while (!unique) {
      const checkStmt = db.prepare('SELECT * FROM books WHERE title = ?')
      const existing = checkStmt.get(finalTitle)
      if (!existing) {
        unique = true
      } else {
        finalTitle = `${title || originalName.replace(/\.[^/.]+$/, '')} (${suffix})`
        suffix++
      }
    }

    // 计算总页数
    let totalPages = 0
    if (fileType === 'txt') {
      const content = fs.readFileSync(filePath, 'utf-8')
      totalPages = Math.ceil(content.length / 2000)
      console.log(`📄 TXT文件页数估算: ${totalPages}页`)
    }

    // 提取封面图片
    let coverImagePath = null
    if (fileType === 'epub') {
      validateEpubArchive(filePath)
      console.log('🖼️ 开始提取EPUB封面...')
      const cover = extractEpubCover(filePath)
      if (cover) {
        const coversDir = path.join(getStoragePath('books'), 'covers')
        if (!fs.existsSync(coversDir)) {
          fs.mkdirSync(coversDir, { recursive: true })
        }
        
        // 压缩封面图片
        const compressedData = await compressImage(cover.data, { maxWidth: 500, maxHeight: 500, quality: 85 })
        
        // 保存封面图片（统一转为 .jpg 格式以节省空间）
        const coverFileName = `${Date.now()}-${Math.round(Math.random() * 1E9)}.jpg`
        coverImagePath = path.join(coversDir, coverFileName)
        fs.writeFileSync(coverImagePath, compressedData)
        console.log(`✅ 封面提取成功: ${coverFileName} (原始: ${(cover.data.length / 1024).toFixed(2)}KB → 压缩后: ${(compressedData.length / 1024).toFixed(2)}KB)`)
      }
    }

    const created = await createManagedBook({
      database: db,
      staged: { token: stagingToken, sha256: contentSha256, bytes: contentBytes },
      originalName,
      fields: { title: finalTitle, author, year, publisher, isbn, description, categoryId },
      totalPages,
      coverImagePath
    })

    console.log(`✅ 书籍创建成功:`, {
      ID: created.id,
      书名: finalTitle,
      文件类型: fileType,
      封面: coverImagePath ? '已提取' : '无'
    })

    res.json({ id: created.id, title: created.title, message: '上传成功' })
  } catch (error) {
    console.error('❌ 创建书籍失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

// 删除书籍
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const result = softDeleteEbook({ database: db, id: req.params.id })
    await cache.del(CacheKeys.BOOK_CATEGORIES)
    res.json({ data: result, message: '已移入回收站' })
  } catch (error) {
    console.error('删除书籍失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

// 批量删除书籍
router.post('/batch-delete', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: '请选择要删除的书籍' })
    }

    const db = getDatabase()
    const result = softDeleteEbooks({ database: db, ids })
    await cache.del(CacheKeys.BOOK_CATEGORIES)
    res.json({ data: result, message: '已批量移入回收站' })
  } catch (error) {
    console.error('批量删除失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

router.get('/trash', authenticateToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: listDeletedEbooks(getDatabase()) })
  } catch (error) {
    sendEbookRouteError(res, error)
  }
})

router.post('/trash/:id/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = restoreEbookFromTrash({ database: getDatabase(), id: req.params.id })
    await cache.del(CacheKeys.BOOK_CATEGORIES)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '恢复成功' })
  } catch (error) {
    sendEbookRouteError(res, error)
  }
})

router.delete('/trash/:id/permanent', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const runtime = getResourceStorageRuntime()
    const result = await permanentlyDeleteEbook({
      database: getDatabase(),
      storageService: runtime.storageService,
      id: req.params.id
    })
    await cache.del(CacheKeys.BOOK_CATEGORIES)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '已永久删除' })
  } catch (error) {
    sendEbookRouteError(res, error)
  }
})

// 更新书籍信息
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, author, year, publisher, isbn, description, categoryId } = req.body
    const db = getDatabase()

    const stmt = db.prepare(
      `UPDATE books SET title = ?, author = ?, year = ?, publisher = ?, isbn = ?, description = ?, category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(title, author, year, publisher, isbn, description, categoryId || null, req.params.id)

    // 清除分类缓存，确保分类数量统计实时更新
    await cache.del(CacheKeys.BOOK_CATEGORIES)

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新书籍失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 阅读器

// 获取书籍内容
router.get('/:id/content', authenticateToken, async (req, res) => {
  try {
    console.log('📖 获取书籍内容请求, ID:', req.params.id)

    const db = getDatabase()
    const book = activeBook(db, req.params.id)

    if (!book) {
      console.log('❌ 书籍不存在, ID:', req.params.id)
      return res.status(404).json({ message: '书籍不存在' })
    }

    console.log('📖 书籍信息:', {
      ID: book.id,
      书名: book.title,
      文件类型: book.file_type
    })

    const bookFilePath = await verifiedBookPath(book)
    const ext = `.${String(book.file_type || '').toLowerCase()}`

    if (ext === '.txt') {
      const content = fs.readFileSync(bookFilePath, 'utf-8')

      // 分页处理
      const pageSize = 2000 // 每页字符数
      const totalPages = Math.ceil(content.length / pageSize)

      res.json({
        content,
        totalPages,
        fileType: 'txt',
        title: book.title
      })
    } else if (ext === '.epub') {
      // 检查是否有缓存
      if (book.content_cache) {
        try {
          console.log('📖 使用缓存内容')
          const cachedData = JSON.parse(book.content_cache)
          // 清理旧缓存中曾经嵌入的 URL 凭据。
          if (cachedData.chapters) {
            cachedData.chapters = cachedData.chapters.map(chapter => {
              if (chapter.content) {
                chapter.content = chapter.content
                  .replace(/&token=[^&"']+/g, '')
                  .replace(/\?token=[^&"']+/g, '')
              }
              return chapter
            })
          }
          
          return res.json({
            chapters: cachedData.chapters,
            toc: cachedData.toc,
            fileType: 'epub',
            title: book.title
          })
        } catch (e) {
          console.log('⚠️ 缓存解析失败，重新解析文件')
        }
      }

      // EPUB 文件解析
      console.log('📖 开始解析EPUB文件')

      try {
        const zip = new AdmZip(bookFilePath)
        const zipEntries = zip.getEntries()
        console.log('📖 ZIP条目数:', zipEntries.length)

        // 查找OPF文件
        let opfEntry = null
        let containerEntry = zipEntries.find(e => e.entryName === 'META-INF/container.xml')

        if (containerEntry) {
          console.log('📖 找到container.xml')
          const containerXml = containerEntry.getData().toString('utf8')
          const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path=["']([^"']+)["']/i)
          if (rootfileMatch) {
            console.log('📖 OPF路径:', rootfileMatch[1])
            opfEntry = zipEntries.find(e => e.entryName === rootfileMatch[1])
          }
        }

        // 如果没找到container.xml，尝试直接找OPF文件
        if (!opfEntry) {
          console.log('📖 尝试直接查找OPF文件')
          opfEntry = zipEntries.find(e => e.entryName.endsWith('.opf'))
        }

        if (!opfEntry) {
          console.log('❌ 未找到OPF文件')
          return res.status(400).json({ message: '无法解析EPUB文件：未找到OPF文件' })
        }

        console.log('📖 找到OPF文件:', opfEntry.entryName)
        const opfContent = opfEntry.getData().toString('utf8')
        const opfDir = path.dirname(opfEntry.entryName)

        // 解析spine中的内容顺序
        const spineItems = []
        const spineMatches = opfContent.matchAll(/<itemref[^>]*idref=["']([^"']+)["']/gi)
        for (const match of spineMatches) {
          spineItems.push(match[1])
        }
        console.log('📖 Spine条目数:', spineItems.length)

        // 解析manifest获取文件路径 - 支持多种格式
        const manifest = {}
        
        // 方法1: 标准顺序 id -> href
        const itemMatches1 = opfContent.matchAll(/<item[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["']/gi)
        for (const match of itemMatches1) {
          manifest[match[1]] = match[2]
        }
        
        // 方法2: 反向顺序 href -> id
        const itemMatches2 = opfContent.matchAll(/<item[^>]*href=["']([^"']+)["'][^>]*id=["']([^"']+)["']/gi)
        for (const match of itemMatches2) {
          manifest[match[2]] = match[1]
        }
        
        // 方法3: 处理可能的多行情况
        const itemMatches3 = opfContent.matchAll(/<item\s+([^>]*\n?[^>]*)\/>/gi)
        for (const match of itemMatches3) {
          const itemContent = match[1]
          const idMatch = itemContent.match(/id=["']([^"']+)["']/i)
          const hrefMatch = itemContent.match(/href=["']([^"']+)["']/i)
          if (idMatch && hrefMatch && !manifest[idMatch[1]]) {
            manifest[idMatch[1]] = hrefMatch[1]
          }
        }
        
        console.log('📖 Manifest条目数:', Object.keys(manifest).length)
        console.log('📖 Manifest前5项:', Object.entries(manifest).slice(0, 5))

        // 解析目录
        const chapters = parseEpubToc(bookFilePath)
        console.log('📖 目录章节数:', chapters.length)

        // 构建章节内容（保留HTML格式，支持图片）
        const bookId = req.params.id
        const chapterContents = []
        
        console.log('📖 开始处理 spine 章节...')
        let processedCount = 0
        let skippedCount = 0
        
        for (let i = 0; i < spineItems.length; i++) {
          const idref = spineItems[i]
          const href = manifest[idref]
          
          if (!href) {
            console.log(`⚠️ Spine[${i}]: idref="${idref}" 在 manifest 中未找到对应的 href`)
            skippedCount++
            continue
          }
          
          const fullPath = opfDir ? `${opfDir}/${href}` : href
          let contentEntry = zipEntries.find(e => e.entryName === fullPath)
          
          if (!contentEntry) {
            contentEntry = zipEntries.find(e => 
              e.entryName.endsWith('/' + href) || 
              e.entryName === href ||
              e.entryName.endsWith(fullPath)
            )
          }
          
          if (contentEntry) {
            processedCount++
            try {
              let htmlContent = contentEntry.getData().toString('utf8')

                // 处理图片路径 - 转换为API调用
                const chapterDir = path.dirname(fullPath)

                // 处理 img 标签的 src 属性
                htmlContent = htmlContent.replace(/<img[^>]*src=["']([^"']+)["']/gi, (match, src) => {
                  let imgPath = src
                  if (!src.startsWith('http') && !src.startsWith('data:')) {
                    if (src.startsWith('/')) {
                      imgPath = src.substring(1)
                    } else {
                      imgPath = path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                    }
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                    return match.replace(src, apiUrl)
                  }
                  return match
                })

                // 处理 CSS 中的背景图 url(...)
                htmlContent = htmlContent.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, src) => {
                  let imgPath = src
                  if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('#')) {
                    if (src.startsWith('/')) {
                      imgPath = src.substring(1)
                    } else {
                      imgPath = path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                    }
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                    return match.replace(src, apiUrl)
                  }
                  return match
                })

                // 处理 image 标签（SVG）
                htmlContent = htmlContent.replace(/<image[^>]*href=["']([^"']+)["']/gi, (match, src) => {
                  let imgPath = src
                  if (!src.startsWith('http') && !src.startsWith('data:')) {
                    if (src.startsWith('/')) {
                      imgPath = src.substring(1)
                    } else {
                      imgPath = path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                    }
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                    return match.replace(src, apiUrl)
                  }
                  return match
                })

                // 提取body内容
                const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
                let bodyContent = bodyMatch ? bodyMatch[1] : htmlContent
                
                // 移除可能导致内容隐藏的样式和脚本
                bodyContent = bodyContent
                  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除脚本
                  .replace(/style=["'][^"']*display:\s*none[^"']*["']/gi, '') // 移除display:none样式
                
                // 检查内容是否为纯图片（无文字但有图片）
                const textContent = bodyContent.replace(/<[^>]+>/g, '').trim()
                const hasImages = /<img\s|<image\s/i.test(bodyContent)
                
                if (textContent.length === 0 && !hasImages) {
                  console.log(`⚠️ 章节内容为空: ${href}`)
                } else if (textContent.length === 0 && hasImages) {
                  console.log(`🖼️ 图片章节: ${href} (仅包含图片)`)
                }
                
                chapterContents.push({
                  id: idref,
                  href: href,
                  content: bodyContent
                })
              } catch (e) {
                console.log('⚠️ 处理章节失败:', href, e.message)
              }
            } else {
              console.log(`⚠️ 找不到章节文件: spine[${i}] idref="${idref}" -> href="${href}" (查找路径: ${fullPath})`)
              skippedCount++
            }
          }

        // 如果没有spine，尝试直接读取所有HTML文件
        if (chapterContents.length === 0) {
          console.log('📖 未找到spine内容，尝试直接读取所有HTML文件')
          const htmlFiles = zipEntries.filter(e => 
            e.entryName.endsWith('.html') || 
            e.entryName.endsWith('.htm') || 
            e.entryName.endsWith('.xhtml')
          )
          
          for (const entry of htmlFiles) {
            try {
              let htmlContent = entry.getData().toString('utf8')
              const chapterDir = path.dirname(entry.entryName)

              // 处理 img 标签
              htmlContent = htmlContent.replace(/<img[^>]*src=["']([^"']+)["']/gi, (match, src) => {
                if (!src.startsWith('http') && !src.startsWith('data:')) {
                  let imgPath = src.startsWith('/') ? src.substring(1) : path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              // 处理 CSS 背景图
              htmlContent = htmlContent.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, src) => {
                if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('#')) {
                  let imgPath = src.startsWith('/') ? src.substring(1) : path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              // 处理 SVG image 标签
              htmlContent = htmlContent.replace(/<image[^>]*href=["']([^"']+)["']/gi, (match, src) => {
                if (!src.startsWith('http') && !src.startsWith('data:')) {
                  let imgPath = src.startsWith('/') ? src.substring(1) : path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
              let bodyContent = bodyMatch ? bodyMatch[1] : htmlContent
              
              // 移除可能导致内容隐藏的样式和脚本
              bodyContent = bodyContent
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/style=["'][^"']*display:\s*none[^"']*["']/gi, '')
              
              chapterContents.push({
                id: entry.entryName,
                href: entry.entryName,
                content: bodyContent
              })
            } catch (e) {
              console.log('⚠️ 处理HTML文件失败:', entry.entryName, e.message)
            }
          }
        }

        console.log(`✅ EPUB解析完成: ${chapterContents.length}个章节 (成功处理: ${processedCount}, 跳过: ${skippedCount})`)
        
        // 显示前3个章节的标题（用于调试）
        if (chapterContents.length > 0) {
          console.log('📖 前3个章节预览:')
          chapterContents.slice(0, 3).forEach((ch, idx) => {
            const preview = ch.content.replace(/<[^>]+>/g, '').substring(0, 100)
            console.log(`   [${idx}] ${ch.id}: ${preview}...`)
          })
        }

        // 建立 href -> 章节索引的映射
        const hrefToIndex = {}
        chapterContents.forEach((ch, idx) => {
          // 规范化 href：移除路径前缀，只保留文件名
          const normalizedHref = ch.href.split('/').pop().split('#')[0]
          hrefToIndex[normalizedHref] = idx
          // 也存储完整路径（去掉锚点）
          hrefToIndex[ch.href.split('#')[0]] = idx
        })

        // 生成完整目录：如果 NCX 章节数少于 spine 实际章节数，自动补充
        let finalToc = chapters
        
        if (chapters.length < chapterContents.length) {
          console.log(`📖 目录章节不足 (${chapters.length}/${chapterContents.length})，自动补充缺失章节`)
          
          // 收集已在目录中的 href（用于去重）
          const tocHrefs = new Set(chapters.map(ch => ch.href.split('#')[0]))
          
          // 用 spine 顺序生成完整目录
          finalToc = []
          for (const idref of spineItems) {
            const href = manifest[idref] || ''
            const cleanHref = href.split('#')[0]
            
            // 检查是否在现有目录中
            const existingChapter = chapters.find(ch => 
              ch.href === href || ch.href === cleanHref ||
              ch.href.endsWith('/' + cleanHref) || cleanHref.endsWith('/' + ch.href)
            )
            
            if (existingChapter) {
              finalToc.push({ ...existingChapter })
            } else if (hrefToIndex[cleanHref] !== undefined || hrefToIndex[href] !== undefined) {
              // 在章节内容中有但目录中没有，自动添加标题
              const fileName = cleanHref.split('/').pop().replace(/\.(x?html?)$/i, '')
              // 尝试生成友好的标题
              let title = fileName.replace(/[_-]/g, ' ')
                .replace(/^(ch|chapter|part|section)\s*/i, '第')
                .replace(/(\d+)$/, '$1章')
              
              // 如果是图片/插图页面
              if (/illustration|image|cover|postscript/i.test(fileName)) {
                title = fileName.replace(/(\d+)/, ' $1').replace(/^/, '插图')
              }
              
              finalToc.push({
                title: title,
                href: href,
                isAutoGenerated: true
              })
            }
          }
          console.log(`📖 目录已扩展为 ${finalToc.length} 个章节`)
        }

        // 为 TOC 添加章节索引
        const tocWithIndex = finalToc.map(ch => {
          const normalizedHref = ch.href.split('/').pop().split('#')[0]
          let chapterIndex = hrefToIndex[normalizedHref]
          if (chapterIndex === undefined) {
            chapterIndex = hrefToIndex[ch.href.split('#')[0]]
          }
          return {
            ...ch,
            chapterIndex: chapterIndex !== undefined ? chapterIndex : 0
          }
        })
        console.log('📖 TOC索引映射完成')

        // 保存到缓存
        try {
          const cacheData = {
            chapters: chapterContents,
            toc: tocWithIndex
          }
          db.prepare('UPDATE books SET content_cache = ? WHERE id = ?').run(JSON.stringify(cacheData), book.id)
          console.log('📖 内容已缓存到数据库')
        } catch (e) {
          console.log('⚠️ 缓存保存失败:', e.message)
        }

        res.json({
          chapters: chapterContents,
          toc: tocWithIndex,
          fileType: 'epub',
          title: book.title
        })
      } catch (zipError) {
        console.error('❌ EPUB解析错误:', zipError?.code || zipError?.name || 'UNKNOWN')
        return res.status(500).json({ message: 'EPUB文件解析失败' })
      }
    } else if (ext === '.pdf') {
      // PDF 通过受控下载接口读取，不暴露服务器路径。
      res.json({
        downloadUrl: `/api/ebooks/download/${book.id}`,
        totalPages: book.total_pages,
        fileType: 'pdf',
        title: book.title
      })
    } else {
      // 其他格式暂时不支持在线阅读
      res.status(400).json({ message: '此格式暂不支持在线阅读，请下载后查看' })
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('获取书籍内容失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

// 分页获取章节内容
router.get('/:id/chapters', authenticateToken, async (req, res) => {
  try {
    const bookId = req.params.id
    const startIndex = parseInt(req.query.start) || 0
    const count = parseInt(req.query.count) || 5
    
    const db = getDatabase()
    const book = activeBook(db, bookId)
    
    if (!book) {
      return res.status(404).json({ message: '书籍不存在' })
    }
    const bookFilePath = await verifiedBookPath(book)
    const ext = `.${String(book.file_type || '').toLowerCase()}`
    
    // 优先使用缓存
    let allChapters = []
    let toc = []
    
    if (book.content_cache) {
      try {
        const cached = JSON.parse(book.content_cache)
        allChapters = cached.chapters || []
        toc = cached.toc || []
        
        // 清理旧缓存中曾经嵌入的 URL 凭据。
        if (allChapters.length > 0) {
          allChapters = allChapters.map(chapter => {
            if (chapter.content) {
              chapter.content = chapter.content
                .replace(/&token=[^&"']+/g, '')
                .replace(/\?token=[^&"']+/g, '')
            }
            return chapter
          })
        }
      } catch (e) {
        console.log('缓存解析失败')
      }
    }
    
    // 如果没有缓存，解析EPUB
    if (allChapters.length === 0 && ext === '.epub') {
      // 返回简化版目录结构，不加载内容
      const zip = new AdmZip(bookFilePath)
      const zipEntries = zip.getEntries()
      
      // 解析目录
      let containerEntry = zipEntries.find(e => e.entryName === 'META-INF/container.xml')
      let opfEntry = null
      if (containerEntry) {
        const containerXml = containerEntry.getData().toString('utf8')
        const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path=["']([^"']+)["']/i)
        if (rootfileMatch) {
          opfEntry = zipEntries.find(e => e.entryName === rootfileMatch[1])
        }
      }
      if (!opfEntry) {
        opfEntry = zipEntries.find(e => e.entryName.endsWith('.opf'))
      }
      
      if (opfEntry) {
        const opfDir = path.dirname(opfEntry.entryName)
        const opfContent = opfEntry.getData().toString('utf8')
        
        // 解析spine获取章节顺序
        const spineItems = []
        const spineMatches = opfContent.matchAll(/<itemref[^>]*idref=["']([^"']+)["']/gi)
        for (const match of spineMatches) {
          spineItems.push(match[1])
        }
        
        // 解析manifest
        const manifest = {}
        const itemMatches = opfContent.matchAll(/<item[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["']/gi)
        for (const match of itemMatches) {
          manifest[match[1]] = match[2]
        }
        
        // 构建章节列表（不含内容）
        let index = 0
        for (const idref of spineItems) {
          const href = manifest[idref]
          if (href && (href.endsWith('.html') || href.endsWith('.xhtml') || href.endsWith('.htm'))) {
            allChapters.push({
              id: `chapter-${index}`,
              title: `章节 ${index + 1}`,
              href: opfDir ? `${opfDir}/${href}` : href,
              index: index,
              content: null // 内容延迟加载
            })
            index++
          }
        }
        
        // 解析NCX获取标题
        const ncxId = opfContent.match(/<spine[^>]*toc=["']([^"']+)["']/i)?.[1]
        if (ncxId && manifest[ncxId]) {
          const ncxEntry = zipEntries.find(e => e.entryName === (opfDir ? `${opfDir}/${manifest[ncxId]}` : manifest[ncxId]))
          if (ncxEntry) {
            const ncxContent = ncxEntry.getData().toString('utf8')
            const navMatches = ncxContent.matchAll(/<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]*src=["']([^"']+)["']/gi)
            for (const match of navMatches) {
              const title = match[1].trim()
              const src = match[2].split('#')[0]
              const chapter = allChapters.find(ch => ch.href.includes(src) || src.includes(ch.href.split('/').pop()))
              if (chapter) {
                chapter.title = title
              }
            }
          }
        }
      }
    }
    
    // 加载指定范围的章节内容
    const endIndex = Math.min(startIndex + count, allChapters.length)
    const chaptersToLoad = allChapters.slice(startIndex, endIndex)
    
    if (ext === '.epub') {
      const zip = new AdmZip(bookFilePath)
      for (const chapter of chaptersToLoad) {
        if (!chapter.content && chapter.href) {
          const entry = zip.getEntries().find(e => 
            e.entryName === chapter.href || 
            e.entryName.endsWith(chapter.href.split('/').pop())
          )
          if (entry) {
            let htmlContent = entry.getData().toString('utf8')
            
            // 处理图片路径 - 转换为API调用（与/content接口一致）
            const chapterDir = path.dirname(chapter.href)
            
            // 处理 img 标签的 src 属性
            htmlContent = htmlContent.replace(/<img[^>]*src=["']([^"']+)["']/gi, (match, src) => {
              let imgPath = src
              if (!src.startsWith('http') && !src.startsWith('data:')) {
                if (src.startsWith('/')) {
                  imgPath = src.substring(1)
                } else {
                  imgPath = path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                }
                const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}`
                return match.replace(src, apiUrl)
              }
              return match
            })
            
            // 提取body内容
            const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i)
            chapter.content = bodyMatch ? bodyMatch[1] : htmlContent
          }
        }
      }
    }
    
    res.json({
      chapters: chaptersToLoad,
      toc: toc,
      total: allChapters.length,
      startIndex,
      endIndex,
      hasMore: endIndex < allChapters.length
    })
    
  } catch (error) {
    console.error('获取章节失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

// 获取阅读进度
router.get('/:id/progress', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const userId = req.user?.id || null // 游客为 null，管理员为用户ID
    
    const progress = db.prepare(`
      SELECT * FROM reading_progress 
      WHERE book_id = ? AND user_id IS ?
    `).get(req.params.id, userId)

    if (!progress) {
      console.log('📖 未找到阅读进度，返回默认值', { 书籍ID: req.params.id, 用户ID: userId })
      return res.json({ 
        currentPage: 0, 
        progress: 0, 
        fontSize: 16, 
        cfi: null // EPUB CFI 定位锚点
      })
    }

    const result = {
      currentPage: progress.current_page,
      cfi: progress.cfi || null, // EPUB CFI 定位锚点
      progress: progress.progress,
      fontSize: progress.font_size
    }
    
    console.log('📖 返回阅读进度:', {
      书籍ID: req.params.id,
      用户ID: userId,
      章节: result.currentPage,
      CFI: result.cfi,
      进度: result.progress
    })
    
    res.json(result)
  } catch (error) {
    console.error('获取阅读进度失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 保存阅读进度
router.post('/:id/progress', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { currentPage, progress, fontSize, cfi } = req.body
    const db = getDatabase()
    const userId = req.user?.id || null // 游客为 null，管理员为用户ID
    
    console.log('💾 保存阅读进度:', {
      书籍ID: req.params.id,
      用户ID: userId,
      章节: currentPage,
      CFI: cfi,
      进度: progress
    })

    // 更新或插入阅读进度
    const stmt = db.prepare(
      `INSERT INTO reading_progress (book_id, user_id, current_page, cfi, progress, font_size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(book_id, user_id) DO UPDATE SET
       current_page = excluded.current_page,
       cfi = excluded.cfi,
       progress = excluded.progress,
       font_size = excluded.font_size,
       updated_at = CURRENT_TIMESTAMP`
    )
    stmt.run(
      req.params.id, 
      userId, 
      currentPage || 0, 
      cfi || null, // EPUB CFI 定位锚点
      progress || 0, 
      fontSize || 16
    )

    // 更新书籍的最后阅读时间
    db.prepare('UPDATE books SET last_read_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id)

    res.json({ message: '进度已保存' })
  } catch (error) {
    console.error('保存阅读进度失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 下载书籍
router.get('/download/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const book = activeBook(db, req.params.id)

    if (!book) {
      return res.status(404).json({ message: '书籍不存在' })
    }

    const contentService = getResourceStorageRuntime().contentService
    const metadata = await contentService.stat(book)
    const readable = await contentService.createReadStream(book)
    const fileName = book.original_name || `${book.title}.${book.file_type}`
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(metadata.bytes))
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    readable.stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ message: '文件读取失败' })
      else res.destroy()
    })
    readable.stream.pipe(res)
  } catch (error) {
    console.error('下载书籍失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

// 清除书籍缓存（游客可访问，这是重新解析功能）
router.delete('/:id/cache', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('UPDATE books SET content_cache = NULL WHERE id = ?').run(req.params.id)
    res.json({ message: '缓存已清除' })
  } catch (error) {
    console.error('清除缓存失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取EPUB资源（图片、CSS等）- 应用专门的限流器
router.get('/:id/resource', authenticateToken, ebookResourceLimiter, async (req, res) => {
  try {
    const { path: resourcePath } = req.query
    if (!resourcePath) {
      return res.status(400).json({ message: '缺少资源路径' })
    }

    const db = getDatabase()
    const book = activeBook(db, req.params.id)

    if (!book) {
      return res.status(404).json({ message: '书籍不存在' })
    }

    const bookFilePath = await verifiedBookPath(book)
    const zip = new AdmZip(bookFilePath)
    const zipEntries = zip.getEntries()

    // EPUB 资源只能按规范化后的精确条目名读取。
    const rawPath = String(resourcePath).replace(/\\/g, '/')
    if (rawPath.includes('\0')) {
      return res.status(400).json({ message: '资源路径无效' })
    }
    const normalizedPath = path.posix.normalize(rawPath)
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
    if (
      !normalizedPath ||
      normalizedPath === '..' ||
      normalizedPath.startsWith('../')
    ) {
      return res.status(400).json({ message: '资源路径无效' })
    }

    const resourceEntry = zipEntries.find(
      entry => entry.entryName.replace(/\\/g, '/') === normalizedPath
    )

    if (!resourceEntry) {
      // 返回204 No Content而不是500，避免控制台报错
      return res.status(204).end()
    }

    const ext = path.extname(normalizedPath).toLowerCase()
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf'
    }
    const contentType = contentTypes[ext]
    if (!contentType) {
      return res.status(415).json({
        message: '该 EPUB 资源类型不允许在线加载'
      })
    }
    if ((resourceEntry.header?.size || 0) > 10 * 1024 * 1024) {
      return res.status(413).json({ message: 'EPUB 资源过大' })
    }

    let data
    try {
      data = resourceEntry.getData()
    } catch (err) {
      console.error('❌ 读取资源数据失败:', resourceEntry.entryName, err.message)
      return res.status(500).json({ message: '读取资源失败' })
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=86400') // 缓存1天
    res.send(data)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('❌ 获取资源失败:', error?.code || error?.name || 'UNKNOWN')
    sendEbookRouteError(res, error)
  }
})

function sendEbookCoverFile(res, cover) {
  const ext = path.extname(cover.filePath).toLowerCase()
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }
  const contentType = contentTypes[ext] || 'image/jpeg'

  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'private, max-age=86400')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.sendFile(cover.fileName, { root: cover.root })
}

function sendEbookCoverError(res, error) {
  const code = String(error?.code || '')
  if (code === 'EBOOK_COVER_BOOK_NOT_FOUND' ||
      code === 'EBOOK_COVER_NOT_FOUND' ||
      code === 'EBOOK_COVER_SOURCE_MISSING') {
    return res.status(404).json({ code, message: '封面不存在' })
  }
  if (code === 'EBOOK_COVER_TOO_LARGE') {
    return res.status(413).json({ code, message: '封面文件过大' })
  }
  if (code === 'EBOOK_COVER_ARCHIVE_INVALID') {
    return res.status(422).json({ code, message: '电子书文件无效' })
  }
  console.error('获取封面失败:', code || error?.name || 'UNKNOWN')
  return res.status(500).json({ message: '服务器错误' })
}

// 获取封面图片；派生封面缺失时从受控 EPUB 原文件按需提交持久任务。
router.get('/:id/cover', authenticateToken, ebookResourceLimiter, async (req, res) => {
  try {
    const bookId = Number(req.params.id)
    if (!Number.isSafeInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ message: '书籍编号无效' })
    }
    const db = getDatabase()
    const book = activeBook(db, bookId)

    if (!book) {
      return res.status(404).json({ message: '封面不存在' })
    }

    const existingCover = resolveExistingEbookCover({
      booksRoot,
      storedPath: book.cover_image
    })
    if (existingCover) return sendEbookCoverFile(res, existingCover)
    if (!isEpubBook(book)) {
      return res.status(404).json({ code: 'EBOOK_COVER_NOT_FOUND', message: '封面不存在' })
    }

    const outcome = enqueueEbookCoverTask(db, bookId)
    const requestAbort = requestAbortController(req, res)
    try {
      const waited = await waitForEbookCoverTask({
        taskId: outcome.task.id,
        readTask: taskId => getTaskById(db, taskId),
        signal: requestAbort.signal
      })
      if (waited.aborted) return
      if (waited.timedOut) {
        res.setHeader('Retry-After', '1')
        return res.status(503).json({
          code: 'EBOOK_COVER_TASK_TIMEOUT',
          message: '封面生成仍在进行中'
        })
      }
      if (waited.missing) {
        return sendEbookCoverError(res, { code: 'EBOOK_COVER_TASK_MISSING' })
      }
      if (!waited.task || waited.task.status !== 'succeeded') {
        return sendEbookCoverError(res, {
          code: waited.task?.errorCode || 'EBOOK_COVER_TASK_FAILED'
        })
      }

      const refreshedBook = activeBook(db, bookId)
      if (!refreshedBook) {
        return res.status(404).json({ message: '封面不存在' })
      }
      const generatedCover = resolveExistingEbookCover({
        booksRoot,
        storedPath: refreshedBook.cover_image
      })
      if (!generatedCover) {
        return sendEbookCoverError(res, { code: 'EBOOK_COVER_NOT_FOUND' })
      }
      if (requestAbort.signal.aborted) return
      return sendEbookCoverFile(res, generatedCover)
    } finally {
      requestAbort.cleanup()
    }
  } catch (error) {
    if (req?.aborted || req?.destroyed || res?.destroyed) return
    if (error instanceof EbookCoverError || String(error?.code || '').startsWith('EBOOK_COVER_')) {
      return sendEbookCoverError(res, error)
    }
    console.error('获取封面失败:', error?.code || error?.name || 'UNKNOWN')
    return res.status(500).json({ message: '服务器错误' })
  }
})

export default router
