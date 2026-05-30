import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheTTL } from '../utils/cache.js'

const router = express.Router()

// 下载图片并转换为base64（支持代理）
async function downloadImageAsBase64(imageUrl, maxSizeKB = 100) {
  if (!imageUrl) return null
  try {
    // 配置代理（如果环境变量中有设置）
    const proxyUrl = process.env.HTTP_PROXY
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
    
    // 限制最大下载大小（防止下载过大的图标）
    const maxSizeBytes = maxSizeKB * 1024
    
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: maxSizeBytes, // axios 限制
      httpsAgent,
      proxy: false
    })
    
    // 再次检查实际大小
    const buffer = Buffer.from(response.data, 'binary')
    if (buffer.length > maxSizeBytes) {
      console.log(`[图标] 图片过大 (${Math.round(buffer.length / 1024)}KB)，跳过: ${imageUrl}`)
      return null
    }
    
    const base64 = buffer.toString('base64')
    const contentType = response.headers['content-type'] || 'image/x-icon'
    return `data:${contentType};base64,${base64}`
  } catch (error) {
    console.error('下载图片失败:', imageUrl, error.message)
    return null
  }
}

// 从URL获取标题和图标
router.get('/fetch-title', authenticateToken, async (req, res) => {
  try {
    const { url } = req.query
    if (!url) {
      return res.status(400).json({ message: 'URL不能为空' })
    }

    // 尝试从缓存获取
    const cacheKey = `bookmark:title:${url}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[书签管理] 命中标题缓存: ${url}`)
      return res.json(cached)
    }

    const urlObj = new URL(url)
    
    // 配置代理
    const proxyUrl = process.env.HTTP_PROXY
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
    
    // 获取网页内容（使用 axios 支持代理）
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000,
      httpsAgent,
      proxy: false
    })
    
    const html = response.data
    
    // 提取标题
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : ''
    
    // 提取favicon - 优先获取小尺寸图标
    let iconUrl = ''
    let iconData = null
    
    // 尝试标准 favicon.ico
    const defaultFavicon = `${urlObj.protocol}//${urlObj.host}/favicon.ico`
    iconData = await downloadImageAsBase64(defaultFavicon)
    if (iconData) {
      const result = { title, icon: defaultFavicon, iconData }
      // 缓存结果（1小时）
      await cache.set(cacheKey, result, CacheTTL.VERY_LONG)
      res.json(result)
      return
    }
    
    // 从 HTML 获取 icon
    const iconMatch = html.match(/<link[^>]*rel=["'](icon|shortcut icon)["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    if (iconMatch) {
      iconUrl = iconMatch[2]
    } else {
      const iconMatch2 = html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](icon|shortcut icon)["'][^>]*>/i)
      if (iconMatch2) {
        iconUrl = iconMatch2[1]
      }
    }
    
    // 处理相对路径
    if (iconUrl && !iconUrl.startsWith('http') && !iconUrl.startsWith('data:')) {
      if (iconUrl.startsWith('//')) {
        iconUrl = urlObj.protocol + iconUrl
      } else if (iconUrl.startsWith('/')) {
        iconUrl = `${urlObj.protocol}//${urlObj.host}${iconUrl}`
      } else {
        iconUrl = `${urlObj.protocol}//${urlObj.host}/${iconUrl}`
      }
    }
    
    // 如果是 data URL，直接使用（但检查大小）
    if (iconUrl && iconUrl.startsWith('data:')) {
      if (iconUrl.length < 100 * 1024 * 1.37) { // base64 约比原数据大 37%
        const result = { title, icon: iconUrl, iconData: iconUrl }
        await cache.set(cacheKey, result, CacheTTL.VERY_LONG)
        res.json(result)
        return
      }
    }
    
    // 尝试下载找到的图标
    if (iconUrl) {
      iconData = await downloadImageAsBase64(iconUrl)
      if (iconData) {
        const result = { title, icon: iconUrl, iconData }
        await cache.set(cacheKey, result, CacheTTL.VERY_LONG)
        res.json(result)
        return
      }
    }
    
    // 尝试 apple-touch-icon
    const appleIconMatch = html.match(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    if (appleIconMatch) {
      let appleIconUrl = appleIconMatch[1]
      if (!appleIconUrl.startsWith('http')) {
        if (appleIconUrl.startsWith('//')) {
          appleIconUrl = urlObj.protocol + appleIconUrl
        } else if (appleIconUrl.startsWith('/')) {
          appleIconUrl = `${urlObj.protocol}//${urlObj.host}${appleIconUrl}`
        } else {
          appleIconUrl = `${urlObj.protocol}//${urlObj.host}/${appleIconUrl}`
        }
      }
      iconData = await downloadImageAsBase64(appleIconUrl, 50) // 更严格的大小限制
      if (iconData) {
        const result = { title, icon: appleIconUrl, iconData }
        await cache.set(cacheKey, result, CacheTTL.VERY_LONG)
        res.json(result)
        return
      }
    }
    
    // 没有找到合适的图标
    const result = { title, icon: '', iconData: null }
    await cache.set(cacheKey, result, CacheTTL.VERY_LONG)
    res.json(result)
  } catch (error) {
    // 失败时返回空数据
    try {
      const urlObj = new URL(req.query.url)
      const defaultIconUrl = `${urlObj.protocol}//${urlObj.host}/favicon.ico`
      const iconData = await downloadImageAsBase64(defaultIconUrl)
      res.json({ title: '', icon: defaultIconUrl, iconData })
    } catch {
      res.json({ title: '', icon: '', iconData: null })
    }
  }
})

// 获取所有标签
router.get('/tags', authenticateToken, async (req, res) => {
  try {
    console.log('获取书签标签...')
    const db = getDatabase()
    console.log('数据库连接成功')

    // 定义缓存键
    const cacheKey = 'bookmark:tags'

    // 尝试从缓存获取
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log('[Redis] 命中缓存:', cacheKey)
      return res.json({ data: cached })
    }

    // 先检查表结构
    const tableInfo = db.prepare("PRAGMA table_info(bookmarks)").all()
    console.log('bookmarks表字段:', tableInfo.map(c => c.name).join(', '))

    const rows = db.prepare("SELECT DISTINCT tags FROM bookmarks WHERE tags IS NOT NULL AND tags != ''").all()
    console.log('查询结果:', rows.length, '条记录')
    
    // 解析所有标签并去重
    const tagsSet = new Set()
    rows.forEach(row => {
      if (row.tags) {
        row.tags.split(',').forEach(tag => {
          const trimmed = tag.trim()
          if (trimmed) tagsSet.add(trimmed)
        })
      }
    })
    
    const tags = Array.from(tagsSet).sort()
    console.log('返回标签:', tags.length, '个')
    
    // 缓存结果（30分钟）
    await cache.set(cacheKey, tags, CacheTTL.LONG)
    
    res.json({ data: tags })
  } catch (error) {
    console.error('获取标签失败:', error.message)
    console.error('错误代码:', error.code)
    console.error('完整错误:', JSON.stringify(error, Object.getOwnPropertyNames(error)))
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 获取书签列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword, tags, sortBy = 'updated_at', page = 1, pageSize = 15 } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM bookmarks WHERE 1=1'
    const params = []

    if (keyword) {
      sql += ' AND (title LIKE ? OR url LIKE ? OR description LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }

    // 标签筛选（支持多标签）
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim()).filter(t => t)
      if (tagList.length > 0) {
        const tagConditions = tagList.map(() => 'tags LIKE ?').join(' OR ')
        sql += ` AND (${tagConditions})`
        tagList.forEach(tag => params.push(`%${tag}%`))
      }
    }

    // 排序
    if (sortBy === 'title') {
      sql += ' ORDER BY title COLLATE NOCASE ASC'
    } else {
      sql += ' ORDER BY updated_at DESC'
    }

    // 获取总数
    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM (${sql})`)
    const countResult = countStmt.get(params)
    const total = countResult.total

    // 分页
    const offset = (parseInt(page) - 1) * parseInt(pageSize)
    sql += ` LIMIT ? OFFSET ?`
    params.push(parseInt(pageSize), offset)

    const stmt = db.prepare(sql)
    const rows = stmt.all(params)
    res.json({ data: rows, total })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 创建书签
router.post('/', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { title, url, icon, iconData, category, tags, description } = req.body
    const db = getDatabase()

    const stmt = db.prepare(
      `INSERT INTO bookmarks (title, url, icon, icon_data, category, tags, description) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const result = stmt.run(title, url, icon || '', iconData || null, category || '', tags, description)
    res.json({ id: result.lastInsertRowid, message: '创建成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新书签
router.put('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { title, url, icon, iconData, category, tags, description } = req.body
    const db = getDatabase()

    const stmt = db.prepare(
      `UPDATE bookmarks SET title = ?, url = ?, icon = ?, icon_data = ?, category = ?, tags = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(title, url, icon || '', iconData || null, category || '', tags, description, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除书签
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    const stmt = db.prepare('DELETE FROM bookmarks WHERE id = ?')
    stmt.run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量删除书签
router.post('/batch-delete', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: '请选择要删除的书签' })
    }

    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    const stmt = db.prepare(`DELETE FROM bookmarks WHERE id IN (${placeholders})`)
    stmt.run(ids)
    
    // 清除标签缓存
    await cache.del('bookmark:tags')
    
    res.json({ message: '批量删除成功', deletedCount: ids.length })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量下载图标
router.post('/batch-download-icons', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 获取所有没有图标数据的书签
    const bookmarks = db.prepare('SELECT id, url, icon FROM bookmarks WHERE icon_data IS NULL OR icon_data = \'\'').all()
    
    if (bookmarks.length === 0) {
      return res.json({ message: '没有需要下载的图标', updatedCount: 0 })
    }
    
    let updatedCount = 0
    const errors = []
    
    for (const bookmark of bookmarks) {
      try {
        let iconUrl = bookmark.icon
        let iconData = null
        
        // 如果是 data URL，直接使用
        if (iconUrl && iconUrl.startsWith('data:')) {
          iconData = iconUrl
        } else {
          // 如果没有图标URL，尝试获取默认favicon
          if (!iconUrl) {
            try {
              const urlObj = new URL(bookmark.url)
              iconUrl = `${urlObj.protocol}//${urlObj.host}/favicon.ico`
            } catch {
              continue
            }
          }
          
          // 检查 URL 是否完整（是否有文件扩展名）
          if (iconUrl && !iconUrl.match(/\.(ico|png|jpg|jpeg|gif|svg|webp)(\?|$)/i)) {
            // 尝试添加 .ico 扩展名
            const iconUrlWithExt = iconUrl + '.ico'
            iconData = await downloadImageAsBase64(iconUrlWithExt)
            if (iconData) {
              iconUrl = iconUrlWithExt
            } else {
              // 尝试 .svg
              const iconUrlWithSvg = iconUrl + '.svg'
              iconData = await downloadImageAsBase64(iconUrlWithSvg)
              if (iconData) {
                iconUrl = iconUrlWithSvg
              }
            }
          }
          
          // 如果还没有图标数据，尝试原始 URL
          if (!iconData) {
            iconData = await downloadImageAsBase64(iconUrl)
          }
        }
        
        if (iconData) {
          // 更新数据库
          const stmt = db.prepare('UPDATE bookmarks SET icon = ?, icon_data = ? WHERE id = ?')
          stmt.run(iconUrl, iconData, bookmark.id)
          updatedCount++
        }
      } catch (error) {
        errors.push({ id: bookmark.id, url: bookmark.url, error: error.message })
      }
    }
    
    res.json({ 
      message: `成功更新 ${updatedCount}/${bookmarks.length} 个图标`,
      updatedCount,
      total: bookmarks.length,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    console.error('批量下载图标失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
