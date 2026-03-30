import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { authenticateToken } from '../middlewares/auth.js'

const router = express.Router()
const BANGUMI_API_BASE = process.env.BANGUMI_API_BASE || 'https://api.bgm.tv'
const BANGUMI_API_V0 = 'https://api.bgm.tv/v0'

// Token状态缓存（避免频繁验证）
let tokenStatusCache = {
  isValid: null,
  lastCheck: 0,
  ttl: 3600000 // 1小时缓存
}

// Bangumi API 要求自定义 User-Agent
// 如果提供了Access Token，可以获取更多搜索结果（避免limit=10的限制）
const BANGUMI_HEADERS = {
  'User-Agent': 'PersonalResourceManager/1.0 (https://github.com/user/pr-manager)',
  ...(process.env.BANGUMI_ACCESS_TOKEN && {
    'Authorization': `Bearer ${process.env.BANGUMI_ACCESS_TOKEN}`
  })
}

// 创建代理 agent
const httpsAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

// 下载图片并转换为base64
async function downloadImageAsBase64(imageUrl) {
  if (!imageUrl) return null
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      httpsAgent,
      timeout: 15000
    })
    const base64 = Buffer.from(response.data, 'binary').toString('base64')
    const contentType = response.headers['content-type'] || 'image/jpeg'
    return `data:${contentType};base64,${base64}`
  } catch (error) {
    console.error('下载图片失败:', error.message)
    return null
  }
}

// 获取动漫详情（包含角色和制作人员）
async function getAnimeDetail(bangumiId) {
  try {
    // 并行请求基本信息、角色、制作人员
    const [subjectRes, charactersRes, personsRes] = await Promise.all([
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS }),
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/characters`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS }),
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/persons`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS })
    ])

    return {
      subject: subjectRes.data,
      characters: charactersRes.data.data || [],
      persons: personsRes.data.data || []
    }
  } catch (error) {
    console.error('获取动漫详情失败:', error.message)
    throw new Error('获取详情失败')
  }
}

// 从 infobox 提取特定字段
function extractFromInfobox(infobox, key) {
  if (!infobox || !Array.isArray(infobox)) return null
  const item = infobox.find(i => i.key === key)
  if (!item) return null
  if (Array.isArray(item.value)) {
    return item.value.map(v => typeof v === 'string' ? v : v.v || v.name).join(', ')
  }
  return typeof item.value === 'string' ? item.value : item.value.v || item.value.name
}

// 爬取 Bangumi 动漫信息（保留旧函数兼容性）
async function scrapeAnimeInfo(bangumiId) {
  const detail = await getAnimeDetail(bangumiId)
  return detail.subject
}

// 验证Token是否有效（通过实际API调用）
async function validateToken() {
  if (!process.env.BANGUMI_ACCESS_TOKEN) {
    return false
  }

  // 使用缓存（1小时内不重复验证）
  const now = Date.now()
  if (tokenStatusCache.isValid !== null && (now - tokenStatusCache.lastCheck) < tokenStatusCache.ttl) {
    return tokenStatusCache.isValid
  }

  try {
    // 调用一个简单的API来验证Token
    const response = await axios.get(`${BANGUMI_API_V0}/subjects/1`, {
      httpsAgent,
      timeout: 5000,
      headers: BANGUMI_HEADERS,
      validateStatus: (status) => status < 500 // 不抛出4xx错误
    })

    // 如果返回401，说明Token无效
    const isValid = response.status !== 401
    tokenStatusCache = { isValid, lastCheck: now, ttl: 3600000 }
    return isValid
  } catch (error) {
    console.error('[Token验证] 验证失败:', error.message)
    // 网络错误时，假设Token有效（避免误报）
    return true
  }
}

// 获取Bangumi Token状态
router.get('/token-status', authenticateToken, async (req, res) => {
  try {
    const hasToken = !!process.env.BANGUMI_ACCESS_TOKEN

    if (!hasToken) {
      return res.json({
        hasToken: false,
        isValid: false,
        message: ''
      })
    }

    // 验证Token是否有效
    const isValid = await validateToken()

    console.log('[Token状态检查] BANGUMI_ACCESS_TOKEN 存在:', hasToken)
    console.log('[Token状态检查] Token有效:', isValid)

    res.json({
      hasToken,
      isValid,
      message: isValid ? '' : '⚠️ Bangumi Token 已失效，请重新配置'
    })
  } catch (error) {
    console.error('获取Token状态失败:', error)
    res.status(500).json({ message: '获取Token状态失败' })
  }
})

// 搜索动漫
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { keyword, tag } = req.query
    const page = parseInt(req.query.page) || 1
    if (!keyword && !tag) {
      return res.status(400).json({ message: '请输入搜索关键词或标签' })
    }

    // 构建 Bangumi API 搜索请求体
    // Bangumi v0 API: POST /v0/search/subjects
    // filter 中包含 type, tag, air_date 等筛选条件
    const searchBody = {
      keyword: keyword || '',  // keyword 是必需的顶层字段
      sort: 'match',  // 排序方式：match(匹配度), heat(热门), rank(排名)
      filter: {
        type: [2]  // 动画类型（数组格式）
      }
    }

    // 如果有标签，添加到filter中（数组格式）
    if (tag) {
      searchBody.filter.tag = [tag]
    }

    console.log('[Bangumi搜索] 请求参数:', JSON.stringify(searchBody, null, 2))
    console.log('[Bangumi搜索] 是否使用Access Token:', !!process.env.BANGUMI_ACCESS_TOKEN)
    console.log('[Bangumi搜索] Token值长度:', process.env.BANGUMI_ACCESS_TOKEN?.length || 0)

    // Bangumi API 限制：每次请求最多返回 20 条数据
    // 前端分页请求：每次只请求一页
    const limit = 20 // Bangumi API 硬编码限制
    const offset = (parseInt(page) - 1) * limit
    const requestUrl = `${BANGUMI_API_V0}/search/subjects?limit=${limit}&offset=${offset}`

    console.log(`[Bangumi搜索] 请求URL: ${requestUrl}`)

    const response = await axios.post(requestUrl, searchBody, {
      httpsAgent,
      timeout: 15000,
      headers: BANGUMI_HEADERS,
      validateStatus: (status) => status < 500
    }).catch(error => {
      if (error.response?.status === 401) {
        console.error('[Bangumi搜索] Token已失效（401）')
        tokenStatusCache = { isValid: false, lastCheck: Date.now(), ttl: 3600000 }
      }
      throw error
    })

    if (response.status === 401) {
      console.error('[Bangumi搜索] Token已失效（401响应）')
      tokenStatusCache = { isValid: false, lastCheck: Date.now(), ttl: 3600000 }
      return res.status(401).json({ message: 'Bangumi Token已失效，请重新配置' })
    }

    const pageData = response.data.data || []
    const total = response.data.total || 0

    console.log(`[Bangumi搜索] 结果: ${pageData.length} 条, 总数: ${total}`)

    // 过滤只保留动画类型
    const results = pageData.filter(item => item.type === 2)

    // 不再需要手动排序，Bangumi API 已经按匹配度排序
    const scoredResults = results.map(item => ({ ...item, _score: 50 }))

    // 性能优化：不再对每个搜索结果单独请求详情API
    // 详细信息会在用户点击详情时按需获取
    // 搜索结果只返回基本信息，大幅减少API请求次数
    const searchResults = scoredResults.map(item => ({
      id: item.id,
      name: item.name,
      name_cn: item.name_cn,
      images: item.images,
      rating: item.rating,
      rating_count: item.rating?.total || 0,
      // 以下字段从搜索结果中已有的信息提取
      air_date: item.date || item.air_date,
      eps: item.eps,
      eps_total: item.eps_count || item.total_episodes,
      tags: item.tags,
      summary: item.summary,
      _score: item._score
    }))

    res.json({ data: searchResults, total })
  } catch (error) {
    console.error('搜索动漫失败:', error)

    // 如果是401错误，返回特定消息
    if (error.response?.status === 401) {
      return res.status(401).json({
        message: 'Bangumi Token已失效，请重新配置',
        tokenExpired: true
      })
    }

    res.status(500).json({ message: '搜索失败' })
  }
})

// 导入动漫（支持前端传递数据或后端获取）
router.post('/import', authenticateToken, async (req, res) => {
  try {
    const { bangumiId, animeData } = req.body

    if (!bangumiId && !animeData) {
      return res.status(400).json({ message: '请提供 Bangumi ID 或动漫数据' })
    }

    let animeInfo, characters = [], staff = []

    // 如果前端传递了完整数据，直接使用
    if (animeData) {
      animeInfo = animeData
      characters = animeData.characters || []
      staff = animeData.staff || []
    } else {
      // 否则从 Bangumi API 获取
      try {
        const detail = await getAnimeDetail(bangumiId)
        animeInfo = detail.subject
        characters = detail.characters
        staff = detail.persons
      } catch (apiError) {
        console.error('获取 Bangumi 详情失败:', apiError.message)
        return res.status(500).json({ message: '获取动漫详情失败，请稍后重试' })
      }
    }

    const db = getDatabase()
    const tags = animeInfo.tags ? (typeof animeInfo.tags === 'string' ? animeInfo.tags : animeInfo.tags.map(t => t.name).join(',')) : ''

    // 从 infobox 提取详细信息
    const infobox = animeInfo.infobox || []
    const author = animeInfo.author || extractFromInfobox(infobox, '作者') || extractFromInfobox(infobox, '原作')
    const director = animeInfo.director || extractFromInfobox(infobox, '导演') || extractFromInfobox(infobox, '监督')
    const studio = animeInfo.studio || extractFromInfobox(infobox, '动画制作') || extractFromInfobox(infobox, '制作')
    
    // 下载封面图片并转换为base64
    const coverImageUrl = animeInfo.cover_image || animeInfo.images?.large || animeInfo.images?.common
    console.log('下载封面图片:', coverImageUrl)
    const coverImageData = await downloadImageAsBase64(coverImageUrl)
    console.log('封面图片下载:', coverImageData ? '成功' : '失败')

    try {
      const stmt = db.prepare(
        `INSERT INTO anime (
          bangumi_id, title, name_cn, name_original, summary, cover_image, cover_image_data,
          rating, rating_count, tags, air_date, eps, eps_total,
          author, director, studio, infobox, characters, staff
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const result = stmt.run(
        animeInfo.id || bangumiId,
        animeInfo.name || animeInfo.name_cn || animeInfo.title,
        animeInfo.name_cn,
        animeInfo.name_original || animeInfo.name,
        animeInfo.summary,
        coverImageUrl,
        coverImageData,
        typeof animeInfo.rating === 'number' ? animeInfo.rating : (animeInfo.rating?.score || 0),
        animeInfo.rating_count || animeInfo.rating?.total || 0,
        tags,
        animeInfo.air_date || animeInfo.date,
        animeInfo.eps || 0,
        animeInfo.eps_total || animeInfo.eps_count || animeInfo.total_episodes || 0,
        author,
        director,
        studio,
        JSON.stringify(infobox),
        JSON.stringify(characters),
        JSON.stringify(staff)
      )
      res.json({ id: result.lastInsertRowid, message: '导入成功' })
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ message: '该动漫已存在' })
      }
      return res.status(500).json({ message: '导入失败' })
    }
  } catch (error) {
    console.error('导入动漫失败:', error)
    res.status(500).json({ message: error.message || '导入失败' })
  }
})

// 获取动漫详情（从 Bangumi API）
router.get('/detail/:bangumiId', authenticateToken, async (req, res) => {
  try {
    const detail = await getAnimeDetail(req.params.bangumiId)
    res.json({ data: detail })
  } catch (error) {
    res.status(500).json({ message: error.message || '获取详情失败' })
  }
})

// 从数据库获取动漫详情（通过 bangumi_id）
router.get('/bangumi/:bangumiId', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM anime WHERE bangumi_id = ?')
    const row = stmt.get(req.params.bangumiId)
    
    if (!row) {
      return res.status(404).json({ message: '动漫不存在' })
    }
    
    // 解析 JSON 字段
    const result = {
      ...row,
      tags: row.tags ? row.tags.split(',') : [],
      infobox: row.infobox ? JSON.parse(row.infobox) : null,
      characters: row.characters ? JSON.parse(row.characters) : [],
      staff: row.staff ? JSON.parse(row.staff) : []
    }
    
    res.json({ data: result })
  } catch (error) {
    console.error('获取动漫详情失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取关联作品（前作、续作等）
router.get('/relations/:bangumiId', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${BANGUMI_API_V0}/subjects/${req.params.bangumiId}/subjects`, {
      httpsAgent,
      timeout: 15000,
      headers: BANGUMI_HEADERS
    })
    // 只保留前传和续集
    const relations = (response.data || []).filter(item => {
      const relationType = item.relation || ''
      return relationType.includes('前传') || 
             relationType.includes('续集') || 
             relationType.includes('前作') || 
             relationType.includes('续作') ||
             relationType.includes('Prequel') ||
             relationType.includes('Sequel')
    })
    res.json({ data: relations })
  } catch (error) {
    // Bangumi API 可能不支持某些条目的关联查询，返回空数组而非报错
    console.error('获取关联作品失败:', error.message)
    res.json({ data: [] })
  }
})

// 获取动漫列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, favorite, sortBy = 'updated_at', sortOrder = 'DESC', page = 1, pageSize = 15 } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM anime WHERE 1=1'
    const params = []

    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }

    if (favorite === 'true') {
      sql += ' AND is_favorite = 1'
    }

    // 排序支持
    const validSortFields = ['updated_at', 'air_date', 'rating', 'user_rating', 'status']
    const validSortOrders = ['ASC', 'DESC']
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'updated_at'
    const order = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'

    // 处理 NULL 值排序
    if (sortField === 'air_date') {
      sql += ` ORDER BY ${sortField} IS NULL, ${sortField} ${order}`
    } else if (sortField === 'rating' || sortField === 'user_rating') {
      sql += ` ORDER BY ${sortField} ${order}`
    } else {
      sql += ` ORDER BY ${sortField} ${order}`
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

    // 解析 JSON 字段（列表不返回 cover_image_data，减少响应体）
    const parsedRows = rows.map(row => ({
      ...row,
      cover_image_data: undefined, // 不返回封面数据，前端按需加载
      tags: row.tags ? row.tags.split(',') : [],
      infobox: row.infobox ? JSON.parse(row.infobox) : null,
      characters: row.characters ? JSON.parse(row.characters) : [],
      staff: row.staff ? JSON.parse(row.staff) : []
    }))

    res.json({ data: parsedRows, total })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取单个动漫详情
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM anime WHERE id = ?')
    const row = stmt.get(req.params.id)
    
    if (!row) {
      return res.status(404).json({ message: '动漫不存在' })
    }
    
    // 解析 JSON 字段
    const result = {
      ...row,
      tags: row.tags ? row.tags.split(',') : [],
      infobox: row.infobox ? JSON.parse(row.infobox) : null,
      characters: row.characters ? JSON.parse(row.characters) : [],
      staff: row.staff ? JSON.parse(row.staff) : []
    }
    
    res.json({ data: result })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取动漫封面（按需加载）
router.get('/:id/cover', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT cover_image_data, cover_image FROM anime WHERE id = ?')
    const row = stmt.get(req.params.id)

    if (!row) {
      return res.status(404).json({ message: '动漫不存在' })
    }

    res.json({
      cover: row.cover_image_data || null,
      coverUrl: row.cover_image || null
    })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新动漫信息
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { status, isFavorite } = req.body
    const db = getDatabase()

    const stmt = db.prepare(
      `UPDATE anime SET status = ?, is_favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(status, isFavorite ? 1 : 0, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 切换收藏状态
router.post('/:id/favorite', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    const stmt = db.prepare(
      `UPDATE anime SET is_favorite = NOT is_favorite, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(req.params.id)
    res.json({ message: '操作成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新观看状态
router.post('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body
    const validStatuses = ['none', 'watching', 'watched']

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: '无效的状态' })
    }

    const db = getDatabase()
    const stmt = db.prepare(
      `UPDATE anime SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(status, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新用户评分 (0-10, 0表示未评分, 1-10表示0.5-5星)
router.post('/:id/rating', authenticateToken, async (req, res) => {
  try {
    const { rating } = req.body
    const db = getDatabase()

    // 验证评分范围 (0-10)
    if (typeof rating !== 'number' || rating < 0 || rating > 10) {
      return res.status(400).json({ message: '评分必须在 0-10 之间' })
    }

    const stmt = db.prepare(
      `UPDATE anime SET user_rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    stmt.run(rating, req.params.id)
    res.json({ message: '评分成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除动漫
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    const stmt = db.prepare('DELETE FROM anime WHERE id = ?')
    stmt.run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量下载动漫封面
router.post('/batch-download-covers', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    // 获取所有没有封面数据的动漫
    const animeList = db.prepare('SELECT id, title, cover_image FROM anime WHERE cover_image_data IS NULL OR cover_image_data = \'\'').all()

    if (animeList.length === 0) {
      return res.json({ message: '没有需要下载的封面', updatedCount: 0 })
    }

    let updatedCount = 0
    const errors = []

    for (const anime of animeList) {
      try {
        if (!anime.cover_image) {
          continue
        }

        // 下载封面
        const coverData = await downloadImageAsBase64(anime.cover_image)

        if (coverData) {
          // 更新数据库
          const stmt = db.prepare('UPDATE anime SET cover_image_data = ? WHERE id = ?')
          stmt.run(coverData, anime.id)
          updatedCount++
          console.log(`✓ 下载封面: ${anime.title}`)
        }
      } catch (error) {
        errors.push({ id: anime.id, title: anime.title, error: error.message })
        console.error(`✗ 下载封面失败: ${anime.title}`, error.message)
      }
    }

    res.json({
      message: `成功更新 ${updatedCount}/${animeList.length} 个封面`,
      updatedCount,
      total: animeList.length,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    console.error('批量下载封面失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// Nyaa 搜索动漫资源
router.get('/resources/search', authenticateToken, async (req, res) => {
  try {
    const { keyword } = req.query
    if (!keyword) {
      return res.status(400).json({ message: '请提供搜索关键词' })
    }

    // Nyaa 搜索（动漫分类 1_0 - 动漫）
    const nyaaDomain = 'nyaa.si'
    const searchUrl = `https://${nyaaDomain}/?f=0&c=1_0&q=${encodeURIComponent(keyword)}`

    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })

    const cheerio = await import('cheerio')
    const $ = cheerio.load(response.data)
    const results = []

    // 解析搜索结果
    $('tr.default, tr.success, tr.danger').each((index, element) => {
      const $el = $(element)
      const titleLink = $el.find('td:nth-child(2) a:last-child')
      const title = titleLink.attr('title') || titleLink.text().trim()
      const detailUrl = titleLink.attr('href')

      // 获取磁力链接
      const magnetLink = $el.find('a[href^="magnet:"]').attr('href')

      // 获取大小、日期等信息
      const size = $el.find('td:nth-child(4)').text().trim()
      const date = $el.find('td:nth-child(5)').text().trim()
      const seeders = $el.find('td:nth-child(6)').text().trim()
      const leechers = $el.find('td:nth-child(7)').text().trim()
      const downloads = $el.find('td:nth-child(8)').text().trim()

      if (title && magnetLink) {
        results.push({
          title,
          magnetLink,
          size,
          date,
          seeders,
          leechers,
          downloads,
          detailUrl: detailUrl ? `https://${nyaaDomain}${detailUrl}` : null
        })
      }
    })

    res.json({ data: results.slice(0, 20) }) // 最多返回20条
  } catch (error) {
    console.error('搜索资源失败:', error.message)
    res.status(500).json({ message: '搜索资源失败' })
  }
})

export default router
