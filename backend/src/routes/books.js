import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import sharp from 'sharp'
import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheKeys, CacheTTL } from '../utils/cache.js'
import { compressImage } from '../utils/imageCompress.js'

const router = express.Router()

// 分片上传临时目录
const chunksDir = path.join(getStoragePath('books'), 'chunks')

// 确保分片目录存在
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir, { recursive: true })
}

// 辅助函数：从EPUB文件中提取封面图片
function extractEpubCover(epubPath) {
  try {
    console.log(`🖼️ 开始提取EPUB封面: ${epubPath}`)
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()

    // 查找封面图片（常见的封面文件名）
    const coverPatterns = [
      /cover\.(jpg|jpeg|png|gif)$/i,
      /cover-image\.(jpg|jpeg|png|gif)$/i,
      /coverimage\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/cover\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/images\/cover\.(jpg|jpeg|png|gif)$/i,
      /OEBPS\/Images\/cover\.(jpg|jpeg|png|gif)$/i
    ]

    // 也尝试从OPF文件中解析封面
    let coverId = null
    for (const entry of zipEntries) {
      if (entry.entryName.endsWith('.opf')) {
        const opfContent = entry.getData().toString('utf8')
        // 查找 meta 元素中的 cover 属性
        const coverMatch = opfContent.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i)
        if (coverMatch) {
          coverId = coverMatch[1]
          console.log(`📋 从OPF找到封面ID: ${coverId}`)
        }
        // 如果找到cover id，在manifest中查找对应的href
        if (coverId) {
          const hrefMatch = opfContent.match(new RegExp(`<item[^>]*id=["']${coverId}["'][^>]*href=["']([^"']+)["']`, 'i'))
          if (hrefMatch) {
            const coverHref = hrefMatch[1]
            console.log(`📋 封面文件路径: ${coverHref}`)
            // 查找对应的文件
            for (const e of zipEntries) {
              if (e.entryName.includes(coverHref)) {
                console.log(`✅ 通过OPF找到封面: ${e.entryName}`)
                return {
                  data: e.getData(),
                  ext: path.extname(e.entryName).toLowerCase()
                }
              }
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

    // 最后尝试查找第一个图片文件
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
    console.log(`📖 开始解析EPUB元数据: ${epubPath}`)
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()

    // 首先尝试从 container.xml 找到 OPF 文件路径
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
    console.log(`📑 开始解析EPUB目录: ${epubPath}`)
    const zip = new AdmZip(epubPath)
    const zipEntries = zip.getEntries()

    // 首先从container.xml获取OPF路径
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
      // 解析NCX格式
      const navPointMatches = tocContent.matchAll(/<navPoint[^>]*id=["']([^"']*)["'][^>]*>([\s\S]*?)<\/navPoint>/gi)
      for (const match of navPointMatches) {
        const navPoint = match[2]
        const textMatch = navPoint.match(/<navLabel[^>]*>[\s\S]*?<text>([^<]*)<\/text>/i)
        const srcMatch = navPoint.match(/<content[^>]*src=["']([^"']+)["']/i)
        
        if (textMatch && srcMatch) {
          chapters.push({
            title: textMatch[1].trim(),
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
    return uniqueChapters
  } catch (error) {
    console.error('❌ 解析EPUB目录失败:', error)
    return []
  }
}

// 辅助函数：将 UTC 时间转换为 UTC+8
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  const date = new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
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
    cb(null, getStoragePath('books'))
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

// ============ 分类管理 API ============

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
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM books WHERE category_id = ?')
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

// ============ 书籍管理 API ============

// ============ 分片上传 API ============

// 上传分片
router.post('/upload-chunk', authenticateToken, multer({ dest: chunksDir }).single('chunk'), async (req, res) => {
  try {
    const { index, totalChunks, fileId, fileName } = req.body

    if (!req.file) {
      return res.status(400).json({ message: '没有接收到分片' })
    }

    console.log(`📦 收到分片 ${index}/${totalChunks}: ${fileName}`)

    // 创建文件专属目录
    const fileDir = path.join(chunksDir, fileId)
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true })
    }

    // 移动分片到专属目录
    const chunkPath = path.join(fileDir, `chunk_${index}`)
    fs.renameSync(req.file.path, chunkPath)

    res.json({ message: '分片上传成功', index: parseInt(index) })
  } catch (error) {
    console.error('上传分片失败:', error)
    res.status(500).json({ message: '上传分片失败', error: error.message })
  }
})

// 合并分片并解析元数据
router.post('/merge-chunks', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { fileId, fileName, totalChunks } = req.body

    console.log(`🔧 开始合并分片: ${fileName}`)
    console.log(`📊 预期分片数: ${totalChunks}`)

    const fileDir = path.join(chunksDir, fileId)
    const finalPath = path.join(getStoragePath('books'), `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(fileName)}`)

    // 验证所有分片是否存在
    const missingChunks = []
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(fileDir, `chunk_${i}`)
      if (!fs.existsSync(chunkPath)) {
        missingChunks.push(i)
      }
    }

    if (missingChunks.length > 0) {
      console.error(`❌ 缺失分片: ${missingChunks.join(', ')}`)
      return res.status(400).json({ message: `分片不完整，缺失: ${missingChunks.join(', ')}` })
    }

    // 同步合并分片，确保文件完全写入
    const chunks = []
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(fileDir, `chunk_${i}`)
      if (fs.existsSync(chunkPath)) {
        chunks.push(fs.readFileSync(chunkPath))
        fs.unlinkSync(chunkPath) // 删除已合并的分片
      }
    }

    // 将所有分片合并写入最终文件
    const finalBuffer = Buffer.concat(chunks)
    fs.writeFileSync(finalPath, finalBuffer)
    console.log(`✅ 分片合并完成: ${finalPath} (${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB)`)

    // 验证ZIP文件完整性（对于EPUB）
    const fileType = path.extname(fileName).toLowerCase().replace('.', '')
    if (fileType === 'epub') {
      try {
        const testZip = new AdmZip(finalPath)
        const testEntries = testZip.getEntries()
        console.log(`✅ ZIP文件验证通过，条目数: ${testEntries.length}`)
      } catch (zipError) {
        console.error(`❌ ZIP文件验证失败:`, zipError.message)
        // 不删除文件，让用户可以手动检查
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
      description: null,
      filePath: finalPath
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

    res.json({ data: metadata })
  } catch (error) {
    console.error('合并分片失败:', error)
    res.status(500).json({ message: '合并失败', error: error.message })
  }
})

// 取消分片上传（清理临时文件）
router.delete('/cancel-upload', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.body
    const fileDir = path.join(chunksDir, fileId)

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
  try {
    if (!req.file) {
      return res.status(400).json({ message: '请选择文件' })
    }

    const filePath = req.file.path
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
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    res.json({ data: metadata })
  } catch (error) {
    console.error('解析元数据失败:', error)
    // 删除临时文件
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json({ message: '解析失败', error: error.message })
  }
})

// 获取书籍列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword, category, sortBy, sortOrder } = req.query
    const db = getDatabase()

    let sql = `SELECT b.*, c.name as category_name,
               rp.current_page, rp.progress, rp.font_size
               FROM books b
               LEFT JOIN book_categories c ON b.category_id = c.id
               LEFT JOIN reading_progress rp ON b.id = rp.book_id
               WHERE 1=1`
    const params = []

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
      coverImage: row.cover_image,
      categoryId: row.category_id,
      categoryName: row.category_name,
      filePath: row.file_path,
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
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { title, author, year, publisher, isbn, description, categoryId } = req.body
    const filePath = req.file.path
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

    const stmt = db.prepare(
      `INSERT INTO books (title, author, year, publisher, isbn, description, category_id, file_path, file_type, file_size, total_pages, cover_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const result = stmt.run(
      finalTitle,
      author || null,
      year || null,
      publisher || null,
      isbn || null,
      description || null,
      categoryId || null,
      filePath,
      fileType,
      fileSize,
      totalPages,
      coverImagePath
    )

    // 创建初始阅读进度
    db.prepare(
      `INSERT INTO reading_progress (book_id, current_page, progress, font_size)
       VALUES (?, 0, 0, 16)`
    ).run(result.lastInsertRowid)

    console.log(`✅ 书籍上传成功:`, {
      ID: result.lastInsertRowid,
      书名: finalTitle,
      作者: author || '未填写',
      封面: coverImagePath ? '已提取' : '无'
    })

    res.json({ id: result.lastInsertRowid, title: finalTitle, message: '上传成功' })
  } catch (error) {
    console.error('❌ 上传书籍失败:', error)
    res.status(500).json({ message: '上传失败', error: error.message })
  }
})

// 使用已上传的文件路径创建书籍（分片上传后调用）
router.post('/upload-with-path', authenticateToken, async (req, res) => {
  try {
    const { filePath, title, author, year, publisher, isbn, description, categoryId } = req.body

    console.log('📤 收到upload-with-path请求:', {
      文件路径: filePath,
      书名: title,
      作者: author,
      分类ID: categoryId
    })

    if (!filePath) {
      console.error('❌ 文件路径为空')
      return res.status(400).json({ message: '文件路径不能为空' })
    }

    if (!fs.existsSync(filePath)) {
      console.error('❌ 文件不存在:', filePath)
      return res.status(400).json({ message: '文件不存在: ' + filePath })
    }

    const fileSize = fs.statSync(filePath).size
    const fileType = path.extname(filePath).toLowerCase().replace('.', '')

    console.log('📤 文件信息:', {
      文件路径: filePath,
      文件大小: (fileSize / 1024 / 1024).toFixed(2) + 'MB',
      文件类型: fileType,
      文件存在: fs.existsSync(filePath)
    })

    const db = getDatabase()

    // 检查重名
    let finalTitle = title || path.basename(filePath).replace(/\.[^/.]+$/, '')
    let suffix = 1
    let unique = false

    while (!unique) {
      const checkStmt = db.prepare('SELECT * FROM books WHERE title = ?')
      const existing = checkStmt.get(finalTitle)
      if (!existing) {
        unique = true
      } else {
        finalTitle = `${title || path.basename(filePath).replace(/\.[^/.]+$/, '')} (${suffix})`
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

    const stmt = db.prepare(
      `INSERT INTO books (title, author, year, publisher, isbn, description, category_id, file_path, file_type, file_size, total_pages, cover_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const result = stmt.run(
      finalTitle,
      author || null,
      year || null,
      publisher || null,
      isbn || null,
      description || null,
      categoryId || null,
      filePath,
      fileType,
      fileSize,
      totalPages,
      coverImagePath
    )

    // 创建初始阅读进度
    db.prepare(
      `INSERT INTO reading_progress (book_id, current_page, progress, font_size)
       VALUES (?, 0, 0, 16)`
    ).run(result.lastInsertRowid)

    console.log(`✅ 书籍创建成功:`, {
      ID: result.lastInsertRowid,
      书名: finalTitle,
      文件路径: filePath,
      文件类型: fileType,
      封面: coverImagePath ? '已提取' : '无'
    })

    res.json({ id: result.lastInsertRowid, title: finalTitle, message: '上传成功' })
  } catch (error) {
    console.error('❌ 创建书籍失败:', error)
    res.status(500).json({ message: '创建失败', error: error.message })
  }
})

// 删除书籍
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id)

    if (!book) {
      return res.status(404).json({ message: '书籍不存在' })
    }

    // 删除文件
    if (book.file_path && fs.existsSync(book.file_path)) {
      fs.unlinkSync(book.file_path)
    }

    // 删除数据库记录（reading_progress 和 book_chapters 会级联删除）
    db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id)

    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除书籍失败:', error)
    res.status(500).json({ message: '服务器错误' })
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

    for (const id of ids) {
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id)
      if (book && book.file_path && fs.existsSync(book.file_path)) {
        fs.unlinkSync(book.file_path)
      }
      db.prepare('DELETE FROM books WHERE id = ?').run(id)
    }

    res.json({ message: '批量删除成功' })
  } catch (error) {
    console.error('批量删除失败:', error)
    res.status(500).json({ message: '服务器错误' })
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

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新书籍失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// ============ 阅读器 API ============

// 获取书籍内容
router.get('/:id/content', async (req, res) => {
  try {
    console.log('📖 获取书籍内容请求, ID:', req.params.id)

    // 支持通过 URL query 参数或 header 传递 token
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    // 验证 token
    const jwt = await import('jsonwebtoken')
    jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id)

    if (!book) {
      console.log('❌ 书籍不存在, ID:', req.params.id)
      return res.status(404).json({ message: '书籍不存在' })
    }

    console.log('📖 书籍信息:', {
      ID: book.id,
      书名: book.title,
      文件路径: book.file_path,
      文件类型: book.file_type
    })

    if (!book.file_path) {
      console.log('❌ 文件路径为空')
      return res.status(404).json({ message: '文件路径为空' })
    }

    if (!fs.existsSync(book.file_path)) {
      console.log('❌ 文件不存在:', book.file_path)
      return res.status(404).json({ message: '文件不存在: ' + book.file_path })
    }

    console.log('✅ 文件存在:', book.file_path)

    const ext = path.extname(book.file_path).toLowerCase()

    if (ext === '.txt') {
      const content = fs.readFileSync(book.file_path, 'utf-8')

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
      console.log('📖 开始解析EPUB文件:', book.file_path)
      console.log('📖 文件大小:', (fs.statSync(book.file_path).size / 1024 / 1024).toFixed(2), 'MB')

      try {
        const zip = new AdmZip(book.file_path)
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
        const itemMatches1 = opfContent.matchAll(/<item[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["']/gi)
        for (const match of itemMatches1) {
          manifest[match[1]] = match[2]
        }
        const itemMatches2 = opfContent.matchAll(/<item[^>]*href=["']([^"']+)["'][^>]*id=["']([^"']+)["']/gi)
        for (const match of itemMatches2) {
          manifest[match[2]] = match[1]
        }
        console.log('📖 Manifest条目数:', Object.keys(manifest).length)

        // 解析目录
        const chapters = parseEpubToc(book.file_path)
        console.log('📖 目录章节数:', chapters.length)

        // 构建章节内容（保留HTML格式，支持图片）
        const bookId = req.params.id
        const token = req.query.token
        const chapterContents = []
        
        for (let i = 0; i < spineItems.length; i++) {
          const idref = spineItems[i]
          const href = manifest[idref]
          if (href) {
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
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
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
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
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
                    const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
                    return match.replace(src, apiUrl)
                  }
                  return match
                })

                // 提取body内容
                const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
                const bodyContent = bodyMatch ? bodyMatch[1] : htmlContent
                
                chapterContents.push({
                  id: idref,
                  href: href,
                  content: bodyContent
                })
              } catch (e) {
                console.log('⚠️ 处理章节失败:', href, e.message)
              }
            }
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
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              // 处理 CSS 背景图
              htmlContent = htmlContent.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, src) => {
                if (!src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('#')) {
                  let imgPath = src.startsWith('/') ? src.substring(1) : path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              // 处理 SVG image 标签
              htmlContent = htmlContent.replace(/<image[^>]*href=["']([^"']+)["']/gi, (match, src) => {
                if (!src.startsWith('http') && !src.startsWith('data:')) {
                  let imgPath = src.startsWith('/') ? src.substring(1) : path.normalize(path.join(chapterDir, src)).replace(/\\/g, '/')
                  const apiUrl = `/api/ebooks/${bookId}/resource?path=${encodeURIComponent(imgPath)}&token=${token}`
                  return match.replace(src, apiUrl)
                }
                return match
              })

              const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
              const bodyContent = bodyMatch ? bodyMatch[1] : htmlContent
              
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

        console.log(`✅ EPUB解析完成: ${chapterContents.length}个章节`)

        // 建立 href -> 章节索引的映射
        const hrefToIndex = {}
        chapterContents.forEach((ch, idx) => {
          // 规范化 href：移除路径前缀，只保留文件名
          const normalizedHref = ch.href.split('/').pop().split('#')[0]
          hrefToIndex[normalizedHref] = idx
          // 也存储完整路径（去掉锚点）
          hrefToIndex[ch.href.split('#')[0]] = idx
        })

        // 为 TOC 添加章节索引
        const tocWithIndex = chapters.map(ch => {
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
        console.error('❌ EPUB解析错误:', zipError)
        return res.status(500).json({ message: 'EPUB文件解析失败: ' + zipError.message })
      }
    } else if (ext === '.pdf') {
      // PDF 返回文件路径，前端使用 PDF.js 处理
      res.json({
        filePath: book.file_path,
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
    console.error('获取书籍内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取阅读进度
router.get('/:id/progress', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const progress = db.prepare('SELECT * FROM reading_progress WHERE book_id = ?').get(req.params.id)

    if (!progress) {
      console.log('📖 未找到阅读进度，返回默认值')
      return res.json({ currentPage: 0, scrollPosition: 0, progress: 0, fontSize: 16 })
    }

    const result = {
      currentPage: progress.current_page,
      scrollPosition: progress.current_chapter ? parseFloat(progress.current_chapter) : 0, // 复用 current_chapter 字段存滚动位置
      progress: progress.progress,
      fontSize: progress.font_size
    }
    
    console.log('📖 返回阅读进度:', {
      书籍ID: req.params.id,
      章节: result.currentPage,
      滚动位置: result.scrollPosition,
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
    const { currentPage, scrollPosition, progress, fontSize } = req.body
    const db = getDatabase()

    console.log('💾 保存阅读进度:', {
      书籍ID: req.params.id,
      章节: currentPage,
      滚动位置: scrollPosition,
      进度: progress
    })

    // 更新或插入阅读进度（current_chapter 字段复用存储 scrollPosition）
    const stmt = db.prepare(
      `INSERT INTO reading_progress (book_id, current_page, current_chapter, progress, font_size, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(book_id) DO UPDATE SET
       current_page = excluded.current_page,
       current_chapter = excluded.current_chapter,
       progress = excluded.progress,
       font_size = excluded.font_size,
       updated_at = CURRENT_TIMESTAMP`
    )
    stmt.run(req.params.id, currentPage || 0, String(scrollPosition || 0), progress || 0, fontSize || 16)

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
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id)

    if (!book) {
      return res.status(404).json({ message: '书籍不存在' })
    }

    if (!fs.existsSync(book.file_path)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const fileName = `${book.title}.${book.file_type}`
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
    res.sendFile(book.file_path)
  } catch (error) {
    console.error('下载书籍失败:', error)
    res.status(500).json({ message: '服务器错误' })
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

// 获取EPUB资源（图片、CSS等）
router.get('/:id/resource', async (req, res) => {
  try {
    const { path: resourcePath } = req.query
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')

    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    const jwt = await import('jsonwebtoken')
    jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    if (!resourcePath) {
      return res.status(400).json({ message: '缺少资源路径' })
    }

    console.log('📷 获取资源:', resourcePath)

    const db = getDatabase()
    const book = db.prepare('SELECT file_path FROM books WHERE id = ?').get(req.params.id)

    if (!book || !book.file_path || !fs.existsSync(book.file_path)) {
      return res.status(404).json({ message: '书籍不存在' })
    }

    const zip = new AdmZip(book.file_path)
    const zipEntries = zip.getEntries()

    // 规范化路径：移除 ./ 和多余的 /
    let normalizedPath = resourcePath.replace(/\\/g, '/')
    if (normalizedPath.startsWith('./')) {
      normalizedPath = normalizedPath.substring(2)
    }
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1)
    }

    console.log('📷 规范化路径:', normalizedPath)

    // 查找资源文件（多种匹配方式）
    let resourceEntry = zipEntries.find(e => e.entryName === normalizedPath)

    if (!resourceEntry) {
      // 尝试匹配结尾路径
      resourceEntry = zipEntries.find(e =>
        e.entryName.endsWith('/' + normalizedPath) ||
        e.entryName.endsWith(normalizedPath)
      )
    }

    if (!resourceEntry) {
      // 尝试只匹配文件名
      const fileName = normalizedPath.split('/').pop()
      resourceEntry = zipEntries.find(e => {
        const entryFileName = e.entryName.split('/').pop()
        return entryFileName === fileName
      })
    }

    if (!resourceEntry) {
      console.log('❌ 资源未找到:', normalizedPath)
      console.log('📁 ZIP中的图片文件:', zipEntries.filter(e => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(e.entryName)).map(e => e.entryName))
      return res.status(404).json({ message: '资源不存在' })
    }

    console.log('✅ 找到资源:', resourceEntry.entryName)

    const data = resourceEntry.getData()
    const ext = path.extname(resourcePath).toLowerCase()

    // 设置Content-Type
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf'
    }

    const contentType = contentTypes[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400') // 缓存1天
    res.send(data)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('获取资源失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取封面图片
router.get('/:id/cover', async (req, res) => {
  try {
    const db = getDatabase()
    const book = db.prepare('SELECT cover_image FROM books WHERE id = ?').get(req.params.id)

    if (!book || !book.cover_image) {
      return res.status(404).json({ message: '封面不存在' })
    }

    if (!fs.existsSync(book.cover_image)) {
      return res.status(404).json({ message: '封面文件不存在' })
    }

    // 根据文件扩展名设置Content-Type
    const ext = path.extname(book.cover_image).toLowerCase()
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    }
    const contentType = contentTypes[ext] || 'image/jpeg'

    res.setHeader('Content-Type', contentType)
    res.sendFile(book.cover_image)
  } catch (error) {
    console.error('获取封面失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
