import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheTTL } from '../utils/cache.js'
import { compressBase64Image } from '../utils/imageCompress.js'

const router = express.Router()
const BANGUMI_API_BASE = process.env.BANGUMI_API_BASE || 'https://api.bgm.tv'
const BANGUMI_API_V0 = 'https://api.bgm.tv/v0'

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

// 下载图片并转换为base64（带压缩）
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
    const rawBase64 = `data:${contentType};base64,${base64}`
    
    // 压缩图片
    return await compressBase64Image(rawBase64, { maxWidth: 500, maxHeight: 500, quality: 85 })
  } catch (error) {
    console.error('下载图片失败:', error.message)
    return null
  }
}

// 获取动漫详情（包含角色和制作人员）
async function getAnimeDetail(bangumiId) {
  // 尝试从缓存获取
  const cacheKey = `anime:detail:${bangumiId}`
  try {
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[Redis] 命中缓存: ${cacheKey}`)
      return cached
    }
  } catch (e) {
    console.error('[动漫详情] 读取缓存失败:', e)
  }

  try {
    // 并行请求基本信息、角色、制作人员
    const [subjectRes, charactersRes, personsRes] = await Promise.all([
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS }),
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/characters`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS }),
      axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/persons`, { httpsAgent, timeout: 15000, headers: BANGUMI_HEADERS })
    ])

    const result = {
      subject: subjectRes.data,
      characters: charactersRes.data.data || [],
      persons: personsRes.data.data || []
    }

    // 缓存结果（1小时）
    await cache.set(cacheKey, result, CacheTTL.VERY_LONG)

    return result
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

  // 使用Redis缓存（1小时内不重复验证）
  const cacheKey = 'anime:token_status'
  try {
    const cached = await cache.get(cacheKey)
    if (cached !== null) {
      return cached.isValid
    }
  } catch (e) {
    console.error('[Token验证] 读取缓存失败:', e)
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
    
    // 缓存结果（1小时）
    await cache.set(cacheKey, { isValid, lastCheck: Date.now() }, CacheTTL.VERY_LONG)
    
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

    // 尝试从缓存获取
    const cacheKey = `anime:search:${keyword || ''}:${tag || ''}:${page}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log('[Redis] 命中缓存:', cacheKey)
      return res.json(cached)
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
        // 清除Token缓存
        cache.del('anime:token_status')
      }
      throw error
    })

    if (response.status === 401) {
      console.error('[Bangumi搜索] Token已失效（401响应）')
      // 清除Token缓存
      await cache.del('anime:token_status')
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

    const responseData = { data: searchResults, total }

    // 缓存结果（30分钟）
    await cache.set(cacheKey, responseData, CacheTTL.VERY_LONG)

    res.json(responseData)
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
router.post('/import', authenticateToken, requireWritePermission, async (req, res) => {
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
    // 尝试从缓存获取
    const cacheKey = `anime:relations:${req.params.bangumiId}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

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

    // 缓存结果（30分钟）
    await cache.set(cacheKey, relations, CacheTTL.VERY_LONG)

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
    const { status, favorite, sortBy = 'updated_at', sortOrder = 'DESC', page = 1, pageSize = 15, hideHidden } = req.query
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

    // 游客模式下隐藏已标记为隐藏的动漫
    if (hideHidden === 'true') {
      sql += ' AND (is_hidden = 0 OR is_hidden IS NULL)'
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
router.put('/:id', authenticateToken, requireWritePermission, async (req, res) => {
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
router.post('/:id/favorite', authenticateToken, requireWritePermission, async (req, res) => {
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
router.post('/:id/status', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { status } = req.body
    const validStatuses = ['none', 'want_to_watch', 'watching', 'watched']

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
    console.error('更新状态失败:', error)
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

// 刷新动漫信息（从 Bangumi API 重新获取并更新）
router.post('/:id/refresh', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 获取当前动漫信息
    const stmt = db.prepare('SELECT bangumi_id FROM anime WHERE id = ?')
    const anime = stmt.get(req.params.id)
    
    if (!anime) {
      return res.status(404).json({ message: '动漫不存在' })
    }
    
    const bangumiId = anime.bangumi_id
    
    // 从 Bangumi API 重新获取详细信息
    const detail = await getAnimeDetail(bangumiId)
    const animeInfo = detail.subject
    const characters = detail.characters || []
    const staff = detail.persons || []
    
    // 提取标签
    const tags = animeInfo.tags ? animeInfo.tags.map(t => t.name).join(',') : ''
    
    // 从 infobox 提取详细信息
    const infobox = animeInfo.infobox || []
    const author = extractFromInfobox(infobox, '作者') || extractFromInfobox(infobox, '原作')
    const director = extractFromInfobox(infobox, '导演') || extractFromInfobox(infobox, '监督')
    const studio = extractFromInfobox(infobox, '动画制作') || extractFromInfobox(infobox, '制作')
    
    // 下载封面图片并转换为base64
    const coverImageUrl = animeInfo.images?.large || animeInfo.images?.common
    console.log('[刷新动漫] 下载封面图片:', coverImageUrl)
    const coverImageData = await downloadImageAsBase64(coverImageUrl)
    console.log('[刷新动漫] 封面图片下载:', coverImageData ? '成功' : '失败')
    
    // 更新数据库
    const updateStmt = db.prepare(`
      UPDATE anime SET
        title = ?,
        name_cn = ?,
        name_original = ?,
        summary = ?,
        cover_image = ?,
        cover_image_data = ?,
        rating = ?,
        rating_count = ?,
        tags = ?,
        air_date = ?,
        eps = ?,
        eps_total = ?,
        author = ?,
        director = ?,
        studio = ?,
        infobox = ?,
        characters = ?,
        staff = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    
    updateStmt.run(
      animeInfo.name,
      animeInfo.name_cn,
      animeInfo.name,
      animeInfo.summary,
      coverImageUrl,
      coverImageData,
      animeInfo.rating?.score || 0,
      animeInfo.rating?.total || 0,
      tags,
      animeInfo.date || animeInfo.air_date,
      animeInfo.eps || 0,
      animeInfo.eps_count || animeInfo.total_episodes || 0,
      author,
      director,
      studio,
      JSON.stringify(infobox),
      JSON.stringify(characters),
      JSON.stringify(staff),
      req.params.id
    )
    
    // 返回更新后的数据
    const resultStmt = db.prepare('SELECT * FROM anime WHERE id = ?')
    const result = resultStmt.get(req.params.id)
    
    res.json({
      message: '刷新成功',
      data: {
        ...result,
        tags: result.tags ? result.tags.split(',') : [],
        infobox: result.infobox ? JSON.parse(result.infobox) : null,
        characters: result.characters ? JSON.parse(result.characters) : [],
        staff: result.staff ? JSON.parse(result.staff) : []
      }
    })
  } catch (error) {
    console.error('刷新动漫失败:', error)
    res.status(500).json({ message: error.message || '刷新失败' })
  }
})

// 切换动漫隐藏状态
router.put('/:id/toggle-hidden', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const { id } = req.params

    // 获取当前状态
    const anime = db.prepare('SELECT is_hidden FROM anime WHERE id = ?').get(id)
    if (!anime) {
      return res.status(404).json({ message: '动漫不存在' })
    }

    // 切换状态
    const newHiddenStatus = anime.is_hidden === 1 ? 0 : 1
    const stmt = db.prepare('UPDATE anime SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    stmt.run(newHiddenStatus, id)

    res.json({ 
      message: newHiddenStatus === 1 ? '已隐藏' : '已取消隐藏',
      is_hidden: newHiddenStatus 
    })
  } catch (error) {
    console.error('切换隐藏状态失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除动漫
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
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
router.post('/batch-download-covers', authenticateToken, requireWritePermission, async (req, res) => {
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

// 搜索动漫资源（多源）

// 1. Nyaa（主站）
async function searchNyaa(keyword) {
  try {
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

      const magnetLink = $el.find('a[href^="magnet:"]').attr('href')
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
          detailUrl: detailUrl ? `https://${nyaaDomain}${detailUrl}` : null,
          source: 'Nyaa'
        })
      }
    })

    return results
  } catch (error) {
    console.error('[Nyaa] 搜索失败:', error.message)
    return []
  }
}

// 2. 动漫花园 (使用 AnimeGarden API)
async function searchDMHY(keyword) {
  try {
    // 使用 AnimeGarden API: https://api.animes.garden
    const searchUrl = `https://api.animes.garden/resources?search=${encodeURIComponent(keyword)}&pageSize=20`

    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'PersonalResourceManager/1.0',
        'Accept': 'application/json'
      }
    })

    const results = []
    const resources = response.data.resources || []

    for (const item of resources) {
      // AnimeGarden API 返回的数据结构
      const title = item.title || item.name || ''
      const magnetLink = item.magnet || item.magnetLink || ''

      if (title && magnetLink) {
        results.push({
          title,
          magnetLink,
          size: item.size || '-',
          date: item.date || item.createdAt || '-',
          seeders: item.seeders || '-',
          leechers: item.leechers || '-',
          downloads: item.downloads || '-',
          detailUrl: item.url || null,
          source: '动漫花园',
          fansub: item.fansub || item.publisher || null
        })
      }
    }

    console.log(`[动漫花园-AnimeGarden] 找到 ${results.length} 条结果`)
    return results.slice(0, 20)
  } catch (error) {
    console.error('[动漫花园-AnimeGarden] 搜索失败:', error.message)
    return []
  }
}

// 3. ACG.RIP
async function searchACGRip(keyword) {
  try {
    const searchUrl = `https://acg.rip/search/${encodeURIComponent(keyword)}/`
    
    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })

    const cheerio = await import('cheerio')
    const $ = cheerio.load(response.data)
    const results = []

    // ACG.RIP 的表格结构
    $('tbody tr').each((index, element) => {
      const $el = $(element)
      const titleLink = $el.find('td:nth-child(2) a')
      const title = titleLink.text().trim()
      
      const magnetLink = $el.find('a[href^="magnet:"]').attr('href')
      const size = $el.find('td:nth-child(3)').text().trim()
      const date = $el.find('td:nth-child(4)').text().trim()

      if (title && magnetLink) {
        results.push({
          title,
          magnetLink,
          size,
          date,
          seeders: '-',
          leechers: '-',
          downloads: '-',
          detailUrl: null,
          source: 'ACG.RIP'
        })
      }
    })

    console.log(`[ACG.RIP] 找到 ${results.length} 条结果`)
    return results.slice(0, 20)
  } catch (error) {
    console.error('[ACG.RIP] 搜索失败:', error.message)
    return []
  }
}

// 4. 蜜柑计划
async function searchMikan(keyword) {
  try {
    const searchUrl = `https://mikanani.me/Home/Search?searchstr=${encodeURIComponent(keyword)}`
    
    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })

    const cheerio = await import('cheerio')
    const $ = cheerio.load(response.data)
    const results = []

    // 蜜柑计划的结构
    $('.magnet-link-wrap, tr').each((index, element) => {
      const $el = $(element)
      const titleLink = $el.find('a').first()
      const title = titleLink.attr('title') || titleLink.text().trim()
      
      const magnetLink = $el.find('a[href^="magnet:"]').attr('href')
      const size = $el.find('.size, td:nth-child(3)').text().trim()
      const date = $el.find('.date, td:nth-child(4)').text().trim()

      if (title && magnetLink) {
        results.push({
          title,
          magnetLink,
          size,
          date,
          seeders: '-',
          leechers: '-',
          downloads: '-',
          detailUrl: null,
          source: '蜜柑计划'
        })
      }
    })

    console.log(`[蜜柑计划] 找到 ${results.length} 条结果`)
    return results.slice(0, 20)
  } catch (error) {
    console.error('[蜜柑计划] 搜索失败:', error.message)
    return []
  }
}

// 测试资源站点连通性
router.get('/resources/test', authenticateToken, async (req, res) => {
  const results = []
  
  // 测试 Nyaa
  try {
    console.log('[连通性测试] 测试 Nyaa...')
    const startTime = Date.now()
    const response = await axios.get('https://nyaa.si/', {
      httpsAgent,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    const responseTime = Date.now() - startTime
    results.push({
      name: 'Nyaa',
      url: 'https://nyaa.si/',
      status: 'ok',
      responseTime: `${responseTime}ms`,
      httpStatus: response.status
    })
    console.log('[连通性测试] Nyaa: OK')
  } catch (error) {
    results.push({
      name: 'Nyaa',
      url: 'https://nyaa.si/',
      status: 'failed',
      error: error.message
    })
    console.error('[连通性测试] Nyaa: FAILED -', error.message)
  }

  // 测试 动漫花园 (使用 AnimeGarden API)
  try {
    console.log('[连通性测试] 测试 动漫花园...')
    const startTime = Date.now()
    const response = await axios.get('https://api.animes.garden/resources?pageSize=1', {
      httpsAgent,
      timeout: 10000,
      headers: {
        'User-Agent': 'PersonalResourceManager/1.0',
        'Accept': 'application/json'
      }
    })
    const responseTime = Date.now() - startTime
    results.push({
      name: '动漫花园',
      url: 'https://api.animes.garden/',
      status: 'ok',
      responseTime: `${responseTime}ms`,
      httpStatus: response.status
    })
    console.log('[连通性测试] 动漫花园: OK')
  } catch (error) {
    results.push({
      name: '动漫花园',
      url: 'https://api.animes.garden/',
      status: 'failed',
      error: error.message
    })
    console.error('[连通性测试] 动漫花园: FAILED -', error.message)
  }

  // 测试 ACG.RIP
  try {
    console.log('[连通性测试] 测试 ACG.RIP...')
    const startTime = Date.now()
    const response = await axios.get('https://acg.rip/', {
      httpsAgent,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    const responseTime = Date.now() - startTime
    results.push({
      name: 'ACG.RIP',
      url: 'https://acg.rip/',
      status: 'ok',
      responseTime: `${responseTime}ms`,
      httpStatus: response.status
    })
    console.log('[连通性测试] ACG.RIP: OK')
  } catch (error) {
    results.push({
      name: 'ACG.RIP',
      url: 'https://acg.rip/',
      status: 'failed',
      error: error.message
    })
    console.error('[连通性测试] ACG.RIP: FAILED -', error.message)
  }

  // 测试 蜜柑计划
  try {
    console.log('[连通性测试] 测试 蜜柑计划...')
    const startTime = Date.now()
    // 尝试多个可能的域名
    const mikanDomains = [
      'https://mikanani.me/',
      'https://mikanime.tv/',
      'https://mikan.tv/'
    ]
    let lastError = null
    let success = false

    for (const domain of mikanDomains) {
      try {
        const response = await axios.get(domain, {
          httpsAgent,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        })
        const responseTime = Date.now() - startTime
        results.push({
          name: '蜜柑计划',
          url: domain,
          status: 'ok',
          responseTime: `${responseTime}ms`,
          httpStatus: response.status
        })
        console.log(`[连通性测试] 蜜柑计划: OK (${domain})`)
        success = true
        break
      } catch (e) {
        lastError = e
        continue
      }
    }

    if (!success) {
      throw lastError
    }
  } catch (error) {
    results.push({
      name: '蜜柑计划',
      url: 'https://mikanani.me/',
      status: 'failed',
      error: error.message
    })
    console.error('[连通性测试] 蜜柑计划: FAILED -', error.message)
  }

  const summary = {
    total: results.length,
    success: results.filter(r => r.status === 'ok').length,
    failed: results.filter(r => r.status === 'failed').length
  }

  res.json({
    message: '连通性测试完成',
    summary,
    results
  })
})

// 搜索动漫资源（整合多源）
// mode: 'parallel' = 同时多源搜索, 'sequential' = 顺序匹配（按优先级）
router.get('/resources/search', authenticateToken, async (req, res) => {
  try {
    const { keyword, mode = 'parallel' } = req.query
    if (!keyword) {
      return res.status(400).json({ message: '请提供搜索关键词' })
    }

    // 尝试从缓存获取
    const cacheKey = `anime:resources:${mode}:${keyword.toLowerCase()}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[资源搜索] 命中缓存: ${keyword}`)
      return res.json(cached)
    }

    // 资源源优先级配置（可扩展）
    const sourcePriority = [
      { name: 'Nyaa', search: searchNyaa },
      { name: '动漫花园', search: searchDMHY },
      { name: 'ACG.RIP', search: searchACGRip },
      { name: '蜜柑计划', search: searchMikan }
    ]

    console.log(`[资源搜索] 开始搜索: ${keyword}, 模式: ${mode}`)

    let allResults = []

    if (mode === 'sequential') {
      // 顺序匹配模式：按优先级依次搜索，第一个源有结果就停止
      for (const source of sourcePriority) {
        console.log(`[资源搜索-顺序模式] 搜索 ${source.name}...`)
        try {
          const results = await source.search(keyword)
          if (results.length > 0) {
            allResults = results
            console.log(`[资源搜索-顺序模式] ${source.name} 找到 ${results.length} 条，停止搜索后续源`)
            break // 第一个源有结果就停止
          }
        } catch (error) {
          console.error(`[资源搜索-顺序模式] ${source.name} 失败:`, error.message)
        }
      }
    } else {
      // 并行搜索模式（默认）
      const searchPromises = sourcePriority.map(source => 
        source.search(keyword).catch(error => {
          console.error(`[资源搜索-并行模式] ${source.name} 失败:`, error.message)
          return []
        })
      )
      const results = await Promise.all(searchPromises)
      allResults = results.flat()
    }

    // 去重（根据标题前50字符）
    const uniqueResults = []
    const seen = new Set()
    for (const result of allResults) {
      const key = result.title.toLowerCase().substring(0, 50)
      if (!seen.has(key)) {
        seen.add(key)
        uniqueResults.push(result)
      }
    }

    // 按种子数排序（Nyaa结果优先）
    uniqueResults.sort((a, b) => {
      if (a.source === 'Nyaa' && b.source !== 'Nyaa') return -1
      if (b.source === 'Nyaa' && a.source !== 'Nyaa') return 1
      const seedersA = parseInt(a.seeders) || 0
      const seedersB = parseInt(b.seeders) || 0
      return seedersB - seedersA
    })

    console.log(`[资源搜索] 找到 ${uniqueResults.length} 条结果`)

    const result = { 
      data: uniqueResults.slice(0, 50),
      mode,
      sources: sourcePriority.map(s => s.name)
    }

    // 缓存结果（30分钟）
    await cache.set(cacheKey, result, CacheTTL.LONG)

    res.json(result)
  } catch (error) {
    console.error('搜索资源失败:', error.message)
    res.status(500).json({ message: '搜索资源失败' })
  }
})

export default router
