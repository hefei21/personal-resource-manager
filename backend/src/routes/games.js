import express from 'express'
import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheTTL } from '../utils/cache.js'
import { compressBase64Image } from '../utils/imageCompress.js'
import { convertToUTC8 } from '../utils/time.js'
import { PAGINATION, TIMEOUT } from '../config/constants.js'
import { safeAxiosGet } from '../services/outboundRequest.js'
import { enqueueExclusiveRun, getTaskById } from '../services/taskStore.js'
import {
  STEAM_SYNC_EXECUTION_CLASS,
  STEAM_SYNC_MAX_ATTEMPTS,
  STEAM_SYNC_PROCESSOR_VERSION,
  STEAM_SYNC_SUBJECT_ID,
  STEAM_SYNC_SUBJECT_TYPE,
  STEAM_SYNC_TASK_TYPE
} from '../services/steamSyncTaskProcessor.js'

const router = express.Router()

// 创建代理 agent（用于访问被墙网站）
const httpsAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

// Steam API 使用代理（国内访问不稳定）
const steamAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

const STEAM_IMAGE_HOSTS = [
  'steamcdn-a.akamaihd.net',
  'cdn.cloudflare.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'avatars.akamai.steamstatic.com'
]

// 下载图片并转换为base64（带压缩）
async function downloadImageAsBase64(imageUrl) {
  if (!imageUrl) return null
  try {
    const response = await safeAxiosGet(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      allowedHosts: STEAM_IMAGE_HOSTS
    })
    const contentType = String(response.headers['content-type'] || '')
      .split(';')[0]
      .toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      return null
    }
    const base64 = Buffer.from(response.data, 'binary').toString('base64')
    const rawBase64 = `data:${contentType};base64,${base64}`
    
    // 压缩图片
    return await compressBase64Image(rawBase64, { maxWidth: 500, maxHeight: 500, quality: 85 })
  } catch (error) {
    console.error('下载图片失败:', error.message)
    return null
  }
}

// 下载游戏纵向封面（大图 library_600x900.jpg）
async function downloadGameCover(steamAppId, title) {
  if (!steamAppId) {
    console.log(`✗ ${title}: 没有 Steam AppID`)
    return null
  }

  // 只尝试纵向封面源，不下载横向封面（横向由 downloadGameHeaderCover 单独处理）
  const coverSources = [
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900.jpg`, type: '纵向封面' },
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900_2x.jpg`, type: '纵向封面高清' },
    // 备用 CDN
    { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg`, type: '纵向封面(CF)' }
  ]

  const failedSources = []

  for (const source of coverSources) {
    try {
      const coverData = await downloadImageAsBase64(source.url)
      if (coverData) {
        console.log(`✓ ${title}: 使用${source.type} (${source.url})`)
        return { url: source.url, data: coverData }
      } else {
        failedSources.push(`${source.type}: 返回空数据`)
      }
    } catch (e) {
      failedSources.push(`${source.type}: ${e.message || '下载失败'}`)
    }
  }

  // CDN 源均失败，尝试从 Steam Store API 获取纵向封面 URL
  console.log(`[封面] ${title}: CDN 纵向封面源均失败，尝试从 Store API 获取...`)
  try {
    const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}`
    const response = await axios.get(storeUrl, { httpsAgent: steamAgent, timeout: 15000 })

    if (response.data[steamAppId]?.success) {
      // 只尝试纵向封面，不下载横向
      const verticalCoverUrls = [
        `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900.jpg`,
        `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900_2x.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg`
      ]

      for (const coverUrl of verticalCoverUrls) {
        try {
          const coverData = await downloadImageAsBase64(coverUrl)
          if (coverData) {
            console.log(`✓ ${title}: 使用 Store API 纵向封面 (${coverUrl})`)
            return { url: coverUrl, data: coverData }
          }
        } catch (e) {
          // 继续尝试下一个
        }
      }
    }
  } catch (e) {
    console.log(`[封面] ${title}: Store API 获取失败 - ${e.message}`)
  }

  console.log(`✗ ${title}: 纵向封面下载失败 - ${failedSources.join('; ')}`)
  return null
}

// 下载游戏横向封面（header.jpg）
async function downloadGameHeaderCover(steamAppId, title) {
  if (!steamAppId) {
    console.log(`✗ ${title}: 没有 Steam AppID，无法下载横向封面`)
    return null
  }

  const headerSources = [
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/header.jpg`, type: '横向头图' },
    { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`, type: '横向头图(CF)' },
    { url: `https://steamcommunity.com/public/images/apps/${steamAppId}/header.jpg`, type: '社区头图' }
  ]

  for (const source of headerSources) {
    try {
      const coverData = await downloadImageAsBase64(source.url)
      if (coverData) {
        console.log(`✓ ${title}: 横向封面下载成功 (${source.type})`)
        return { url: source.url, data: coverData }
      }
    } catch (e) {
      console.warn(`✗ ${title}: ${source.type} 下载失败`)
    }
  }

  // CDN 源均失败，尝试从 Steam Store API 获取 header_image
  console.log(`[封面] ${title}: CDN 横向封面源均失败，尝试从 Store API 获取...`)
  try {
    const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}`
    const response = await axios.get(storeUrl, { httpsAgent: steamAgent, timeout: 15000 })

    if (response.data[steamAppId]?.success) {
      const appData = response.data[steamAppId].data
      const possibleCovers = [
        appData.header_image,
        appData.background,
        appData.screenshots?.[0]?.path_full
      ].filter(Boolean)

      for (const coverUrl of possibleCovers) {
        if (coverUrl) {
          const coverData = await downloadImageAsBase64(coverUrl)
          if (coverData) {
            console.log(`✓ ${title}: 使用 Store API 横向封面 (${coverUrl})`)
            return { url: coverUrl, data: coverData }
          }
        }
      }
    }
  } catch (e) {
    console.log(`[封面] ${title}: Store API 获取失败 - ${e.message}`)
  }

  console.log(`✗ ${title}: 所有横向封面源均失败`)
  return null
}

// Steam 配置管理

// 获取 Steam 配置
router.get('/steam/config', authenticateToken, (req, res) => {
  try {
    const db = getDatabase()
    const config = db.prepare('SELECT steam_id, api_key, last_sync, auto_sync FROM steam_config WHERE id = 1').get()
    if (config) {
      config.last_sync = convertToUTC8(config.last_sync)
    }
    res.json({ data: config || null })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 保存 Steam 配置
router.post('/steam/config', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { steamId, apiKey } = req.body
    const db = getDatabase()

    // 验证配置
    if (!steamId || !apiKey) {
      return res.status(400).json({ message: 'Steam ID 和 API Key 不能为空' })
    }

    // 测试 API 是否有效（Steam API 不需要代理）
    try {
      const testUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=0&include_played_free_games=1`
      const response = await axios.get(testUrl, { httpsAgent: steamAgent, timeout: 10000 })
      
      if (response.data.response) {
        // 保存配置
        const stmt = db.prepare(`
          INSERT INTO steam_config (id, steam_id, api_key, last_sync, auto_sync)
          VALUES (1, ?, ?, NULL, 0)
          ON CONFLICT(id) DO UPDATE SET steam_id = ?, api_key = ?, updated_at = CURRENT_TIMESTAMP
        `)
        stmt.run(steamId, apiKey, steamId, apiKey)
        res.json({ message: '配置保存成功' })
      } else {
        res.status(400).json({ message: 'Steam API 验证失败，请检查配置' })
      }
    } catch (error) {
      console.error('验证 Steam API 失败:', error.message)
      res.status(400).json({ message: 'Steam API 验证失败，请检查配置是否正确' })
    }
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除 Steam 配置
router.delete('/steam/config', authenticateToken, requireWritePermission, (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM steam_config WHERE id = 1').run()
    res.json({ message: '配置已删除' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// Steam 同步

const STEAM_SYNC_TASK_TYPES = Object.freeze([STEAM_SYNC_TASK_TYPE])
const ACTIVE_TASK_STATUSES = new Set(['pending', 'leased', 'running'])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function normalizeSteamSyncIdempotencyKey(value) {
  if (value === undefined || value === null) return randomUUID()
  if (typeof value !== 'string') {
    const error = new Error('Idempotency-Key 无效')
    error.code = 'TASK_IDEMPOTENCY_KEY_INVALID'
    throw error
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    const error = new Error('Idempotency-Key 无效')
    error.code = 'TASK_IDEMPOTENCY_KEY_INVALID'
    throw error
  }
  return normalized
}

function taskCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function taskTimestamp(value) {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function steamTaskResult(task) {
  if (!isPlainObject(task?.result)) return null
  const inserted = taskCounter(task.result.inserted ?? task.result.newCount)
  const updated = taskCounter(task.result.updated ?? task.result.updateCount)
  return {
    total: taskCounter(task.result.total),
    inserted,
    updated,
    newCount: inserted,
    updateCount: updated
  }
}

function isSteamSyncTask(task) {
  return task?.taskType === STEAM_SYNC_TASK_TYPE &&
    task?.processorVersion === STEAM_SYNC_PROCESSOR_VERSION &&
    task?.executionClass === STEAM_SYNC_EXECUTION_CLASS &&
    task?.subjectType === STEAM_SYNC_SUBJECT_TYPE &&
    task?.subjectId === STEAM_SYNC_SUBJECT_ID
}

export function publicSteamSyncTaskStatus(task) {
  if (!isSteamSyncTask(task)) return null
  const active = ACTIVE_TASK_STATUSES.has(task.status)
  const result = steamTaskResult(task)
  const status = active
    ? 'running'
    : task.status === 'succeeded'
      ? 'completed'
      : 'failed'
  const message = active
    ? '正在获取游戏列表...'
    : status === 'completed'
      ? `同步完成！新增 ${result?.inserted ?? 0} 个游戏，更新 ${result?.updated ?? 0} 个游戏`
      : task.status === 'cancelled'
        ? '任务已取消'
        : task.errorSummary || '同步失败'
  const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) &&
    task.progress >= 0 && task.progress <= 100
    ? task.progress
    : 0

  return {
    id: task.id,
    taskId: task.id,
    status,
    progress,
    message,
    result,
    error: status === 'failed' ? task.errorSummary || null : null,
    startTime: taskTimestamp(task.startedAt || task.createdAt),
    endTime: taskTimestamp(task.finishedAt),
    ...(task.errorCode ? { code: task.errorCode } : {})
  }
}

export function enqueueSteamSyncTask(database, idempotencyKey) {
  const subjectVersionId = normalizeSteamSyncIdempotencyKey(idempotencyKey)
  return enqueueExclusiveRun(database, {
    taskType: STEAM_SYNC_TASK_TYPE,
    processorVersion: STEAM_SYNC_PROCESSOR_VERSION,
    subjectType: STEAM_SYNC_SUBJECT_TYPE,
    subjectId: STEAM_SYNC_SUBJECT_ID,
    subjectVersionId,
    input: {},
    executionClass: STEAM_SYNC_EXECUTION_CLASS,
    maxAttempts: STEAM_SYNC_MAX_ATTEMPTS
  }, { taskTypes: STEAM_SYNC_TASK_TYPES })
}

// 开始同步（持久任务）- 只同步游戏列表，成就按需获取
router.post('/steam/sync', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const input = req.body === undefined ? {} : req.body
    if (!isPlainObject(input) || Object.keys(input).length !== 0) {
      return res.status(400).json({ message: 'Steam 同步任务输入必须为空对象。', code: 'TASK_INPUT_INVALID' })
    }

    const outcome = enqueueSteamSyncTask(
      getDatabase(),
      normalizeSteamSyncIdempotencyKey(req.get('Idempotency-Key'))
    )
    const task = outcome.task
    if (outcome.activeConflict) {
      return res.json({ taskId: task.id, status: 'running', message: '已有同步任务在进行中' })
    }

    if (outcome.created) {
      return res.json({ taskId: task.id, status: 'pending', message: '同步任务已启动' })
    }

    const publicTask = publicSteamSyncTaskStatus(task)
    return res.json({
      taskId: task.id,
      status: publicTask?.status || 'pending',
      message: outcome.created ? '同步任务已启动' : publicTask?.message || '同步任务已受理'
    })
  } catch (error) {
    if (error?.code === 'TASK_IDEMPOTENCY_KEY_INVALID') {
      return res.status(400).json({ message: error.message, code: error.code })
    }
    console.error('启动 Steam 同步失败:', error?.code || 'UNKNOWN_ERROR')
    return res.status(500).json({ message: '启动同步失败' })
  }
})

// 查询同步任务状态
router.get('/steam/sync/:taskId', authenticateToken, (req, res) => {
  try {
    const task = getTaskById(getDatabase(), req.params.taskId)
    const publicTask = publicSteamSyncTaskStatus(task)
    if (!publicTask) {
      return res.status(404).json({ message: '任务不存在' })
    }
    return res.json({ data: publicTask })
  } catch (error) {
    if (error?.code === 'TASK_ID_INVALID' || error?.code === 'TASK_NOT_FOUND') {
      return res.status(404).json({ message: '任务不存在' })
    }
    console.error('查询 Steam 同步任务失败:', error?.code || 'UNKNOWN_ERROR')
    return res.status(500).json({ message: '服务器错误' })
  }
})

// 游戏管理

// 获取游戏列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, favorite, genre, platform, keyword, sortBy = 'playtime_2weeks', sortOrder = 'DESC', page = PAGINATION.DEFAULT_PAGE, pageSize = PAGINATION.DEFAULT_PAGE_SIZE } = req.query
    const db = getDatabase()

    let sql = 'SELECT id, steam_appid, title, name_original, cover_image, cover_image_data, header_cover_image, header_cover_image_data, description, developers, publishers, release_date, genres, tags, platforms, metacritic_score, metacritic_url, playtime_forever, playtime_2weeks, last_played, status, user_rating, is_favorite, notes, achievements_total, achievements_completed, created_at, updated_at FROM games WHERE 1=1'
    const params = []

    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }

    if (favorite === 'true') {
      sql += ' AND is_favorite = 1'
    }

    if (genre) {
      sql += ' AND genres LIKE ?'
      params.push(`%${genre}%`)
    }

    if (platform) {
      sql += ' AND platforms LIKE ?'
      params.push(`%${platform}%`)
    }

    if (keyword) {
      sql += ' AND (title LIKE ? OR name_original LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`)
    }

    // 排序：默认按两周内游玩时长，相等则按总游玩时长
    const validSortOrders = ['ASC', 'DESC']
    const order = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'

    sql += ` ORDER BY playtime_2weeks ${order}, playtime_forever ${order}`

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
    console.error('获取游戏列表失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 代理获取 Steam 封面图片（生产模块在挂载层统一要求 Owner）
// 必须放在 /:id 路由之前，否则会被当作 ID 处理
router.get('/cover-proxy', async (req, res) => {
  const { appid, type = 'library' } = req.query
  
  if (!/^\d{1,12}$/.test(String(appid || ''))) {
    return res.status(400).json({ message: 'appid 参数无效' })
  }
  if (!['library', 'header'].includes(type)) {
    return res.status(400).json({ message: '封面类型无效' })
  }
  
  // 构建封面 URL
  const coverUrls = [
    type === 'library' 
      ? `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg`
      : `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/header.jpg`
  ]
  
  for (const url of coverUrls) {
    try {
      const response = await safeAxiosGet(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 5 * 1024 * 1024,
        allowedHosts: STEAM_IMAGE_HOSTS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })
      
      const contentType = String(response.headers['content-type'] || '')
        .split(';')[0]
        .toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        continue
      }
      res.set('Content-Type', contentType)
      res.set('Cache-Control', 'public, max-age=86400') // 缓存1天
      return res.send(Buffer.from(response.data, 'binary'))
    } catch (e) {
      console.warn(`[封面代理] 失败: ${url}`, e.message)
      continue
    }
  }
  
  // 所有源都失败
  res.status(404).json({ message: '封面获取失败' })
})

// 获取单个游戏详情
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM games WHERE id = ?')
    const row = stmt.get(req.params.id)

    if (!row) {
      return res.status(404).json({ message: '游戏不存在' })
    }

    res.json({ data: row })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取游戏成就详情
router.get('/:id/achievements', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params
    
    // 尝试从缓存获取
    const cacheKey = `game:achievements:${id}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[游戏管理] 命中成就缓存: ${id}`)
      return res.json({ data: cached })
    }
    
    const db = getDatabase()
    
    // 获取游戏信息
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id)
    if (!game) {
      return res.status(404).json({ message: '游戏不存在' })
    }

    // 从数据库获取成就详情
    const achievements = db.prepare(`
      SELECT 
        achievement_id as id,
        name,
        description,
        icon,
        icon_gray as iconGray,
        is_achieved as isAchieved,
        unlock_time as unlockTime,
        global_percent as globalPercent
      FROM game_achievements 
      WHERE game_id = ?
      ORDER BY is_achieved DESC, global_percent DESC
    `).all(game.id)

    const result = {
      game: {
        id: game.id,
        title: game.title,
        steam_appid: game.steam_appid,
        cover_image: game.cover_image,
        cover_image_data: game.cover_image_data,
        header_cover_image: game.header_cover_image,
        header_cover_image_data: game.header_cover_image_data,
        playtime_forever: game.playtime_forever,
        playtime_2weeks: game.playtime_2weeks,
        last_played: game.last_played,
        achievements_total: game.achievements_total,
        achievements_completed: game.achievements_completed,
        has_achievements_data: achievements.length > 0
      },
      achievements
    }
    
    // 缓存结果（10分钟）
    await cache.set(cacheKey, result, CacheTTL.MEDIUM)

    res.json({ data: result })
  } catch (error) {
    console.error('获取成就详情失败:', error.message || error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 按需获取/刷新游戏成就数据
router.post('/:id/fetch-achievements', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 获取游戏信息和Steam配置
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id)
    if (!game) {
      return res.status(404).json({ message: '游戏不存在' })
    }

    if (!game.steam_appid) {
      return res.status(400).json({ message: '该游戏不是Steam游戏' })
    }

    const steamConfig = db.prepare('SELECT steam_id, api_key FROM steam_config WHERE id = 1').get()
    if (!steamConfig) {
      return res.status(400).json({ message: '请先配置Steam账号' })
    }

    const { steam_id: steamId, api_key: apiKey } = steamConfig

    // 辅助函数：处理成就图标 URL
    const getAchievementIconUrl = (icon, appid) => {
      if (!icon) return null
      if (icon.startsWith('http://') || icon.startsWith('https://')) {
        return icon
      }
      return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appid}/${icon}`
    }

    // 获取玩家成就
    const playerAchievementsUrl = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${steamId}&appid=${game.steam_appid}`
    let achResponse
    try {
      achResponse = await axios.get(playerAchievementsUrl, { httpsAgent: steamAgent, timeout: 30000 })
    } catch (e) {
      if (e.response?.status === 403) {
        return res.status(200).json({ message: '该游戏没有成就或您未拥有此游戏', data: { achievements: [] } })
      }
      throw e
    }

    const playerAchievements = achResponse.data.playerstats?.achievements || []
    if (playerAchievements.length === 0) {
      return res.status(200).json({ message: '该游戏没有成就数据', data: { achievements: [] } })
    }

    const total = playerAchievements.length
    const completed = playerAchievements.filter(a => a.achieved === 1).length

    // 获取成就定义（名称、描述、图标）
    let achievementDefs = []
    try {
      const schemaUrl = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${apiKey}&appid=${game.steam_appid}`
      const schemaResponse = await axios.get(schemaUrl, { httpsAgent: steamAgent, timeout: 30000 })
      achievementDefs = schemaResponse.data.game?.availableGameStats?.achievements || []
    } catch (e) {
      console.log(`获取成就定义失败: ${game.title}`)
    }

    // 获取全球完成率
    let globalPercents = {}
    try {
      const globalUrl = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${game.steam_appid}`
      const globalResponse = await axios.get(globalUrl, { httpsAgent: steamAgent, timeout: 30000 })
      const achList = globalResponse.data.achievementpercentages?.achievements || []
      globalPercents = achList.reduce((acc, a) => { acc[a.name] = a.percent; return acc }, {})
    } catch (e) {
      console.log(`获取全球完成率失败: ${game.title}`)
    }

    // 清除旧数据并插入新数据
    db.prepare('DELETE FROM game_achievements WHERE game_id = ?').run(game.id)

    const insertAch = db.prepare(`
      INSERT INTO game_achievements (game_id, achievement_id, name, description, icon, icon_gray, is_achieved, unlock_time, global_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const pa of playerAchievements) {
      const def = achievementDefs.find(d => d.name === pa.apiname) || {}
      const globalPercent = parseFloat(globalPercents[pa.apiname]) || 0

      const iconUrl = getAchievementIconUrl(def.icon, game.steam_appid)
      const iconGrayUrl = getAchievementIconUrl(def.icongray, game.steam_appid) || iconUrl

      insertAch.run(
        game.id,
        pa.apiname,
        def.displayName || pa.apiname,
        def.description || '',
        pa.achieved ? (iconUrl || iconGrayUrl) : (iconGrayUrl || iconUrl),
        iconGrayUrl || iconUrl,
        pa.achieved ? 1 : 0,
        pa.unlocktime ? new Date(pa.unlocktime * 1000).toISOString() : null,
        Math.round(globalPercent * 10) / 10
      )
    }

    // 更新游戏的成就统计
    db.prepare(`
      UPDATE games SET achievements_total = ?, achievements_completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(total, completed, game.id)

    // 返回新获取的成就数据
    const achievements = db.prepare(`
      SELECT 
        achievement_id as id,
        name,
        description,
        icon,
        icon_gray as iconGray,
        is_achieved as isAchieved,
        unlock_time as unlockTime,
        global_percent as globalPercent
      FROM game_achievements 
      WHERE game_id = ?
      ORDER BY is_achieved DESC, global_percent DESC
    `).all(game.id)

    console.log(`[成就获取] 成功获取 ${game.title} 的成就数据: ${completed}/${total}`)

    res.json({ 
      message: '成就数据获取成功',
      data: {
        game: {
          id: game.id,
          title: game.title,
          achievements_total: total,
          achievements_completed: completed
        },
        achievements
      }
    })
  } catch (error) {
    console.error('获取成就数据失败:', error.message || error)
    res.status(500).json({ message: '获取成就数据失败: ' + (error.message || '未知错误') })
  }
})

// 更新游戏信息
router.put('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { status, isFavorite, userRating, notes } = req.body
    const db = getDatabase()

    const stmt = db.prepare(`
      UPDATE games SET 
        status = ?, 
        is_favorite = ?, 
        user_rating = ?, 
        notes = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `)
    stmt.run(status, isFavorite ? 1 : 0, userRating || 0, notes, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除游戏
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('DELETE FROM games WHERE id = ?')
    stmt.run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 切换收藏状态
router.post('/:id/favorite', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE games SET is_favorite = NOT is_favorite, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
    stmt.run(req.params.id)
    res.json({ message: '操作成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新游戏状态
router.post('/:id/status', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { status } = req.body
    const validStatuses = ['unplayed', 'playing', 'played', 'dropped', 'wishlist']

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: '无效的状态' })
    }

    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE games SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
    stmt.run(status, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新评分
router.post('/:id/rating', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { rating } = req.body
    const db = getDatabase()

    if (typeof rating !== 'number' || rating < 0 || rating > 10) {
      return res.status(400).json({ message: '评分必须在 0-10 之间' })
    }

    const stmt = db.prepare(`
      UPDATE games SET user_rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
    stmt.run(rating, req.params.id)
    res.json({ message: '评分成功' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量下载封面（已有封面则跳过）
router.post('/batch-download-covers', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()

    // 获取所有游戏
    const games = db.prepare('SELECT id, title, cover_image, cover_image_data, header_cover_image, header_cover_image_data, steam_appid FROM games').all()

    if (games.length === 0) {
      return res.json({ message: '没有游戏需要处理', updatedCount: 0 })
    }

    let updatedCount = 0
    let skippedCount = 0
    const errors = []

    for (const game of games) {
      try {
        // 只有纵向+横向封面都有才跳过
        if (game.cover_image_data && game.header_cover_image_data) {
          skippedCount++
          continue
        }

        // 尝试下载封面
        if (game.steam_appid) {
          // 先尝试从 Steam Store API 获取游戏详情（可选，用于补充信息）
          try {
            const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${game.steam_appid}`
            const response = await axios.get(storeUrl, { httpsAgent: steamAgent, timeout: 10000 })

            if (response.data[game.steam_appid]?.success) {
              const appData = response.data[game.steam_appid].data

              // 更新游戏详细信息
              if (appData) {
                db.prepare(`
                  UPDATE games SET
                    description = ?,
                    developers = ?,
                    publishers = ?,
                    release_date = ?,
                    genres = ?,
                    platforms = ?,
                    metacritic_score = ?,
                    metacritic_url = ?
                  WHERE id = ?
                `).run(
                  appData.short_description || null,
                  appData.developers?.join(',') || null,
                  appData.publishers?.join(',') || null,
                  appData.release_date?.date || null,
                  appData.genres?.map(g => g.description).join(',') || null,
                  ['windows', 'mac', 'linux'].filter(p => appData.platforms?.[p]).join(',') || null,
                  appData.metacritic?.score || null,
                  appData.metacritic?.url || null,
                  game.id
                )
              }
            }
          } catch (e) {
            console.log(`获取游戏详情失败: ${game.title}`)
          }

          let downloadedAny = false

          // 缺纵向封面才下载
          if (!game.cover_image_data) {
            const coverResult = await downloadGameCover(game.steam_appid, game.title)
            if (coverResult) {
              db.prepare('UPDATE games SET cover_image = ?, cover_image_data = ? WHERE id = ?').run(coverResult.url, coverResult.data, game.id)
              downloadedAny = true
            }
          }

          // 缺横向封面才下载
          if (!game.header_cover_image_data) {
            const headerResult = await downloadGameHeaderCover(game.steam_appid, game.title)
            if (headerResult) {
              db.prepare('UPDATE games SET header_cover_image = ?, header_cover_image_data = ? WHERE id = ?').run(headerResult.url, headerResult.data, game.id)
              downloadedAny = true
            }
          }

          if (downloadedAny) {
            updatedCount++
          } else if (!game.cover_image_data || !game.header_cover_image_data) {
            // 有缺失但下载失败
            errors.push({ id: game.id, title: game.title, error: '封面源均不可用' })
            console.error(`✗ 下载封面失败: ${game.title} - 封面源均不可用`)
          }
        }
      } catch (error) {
        errors.push({ id: game.id, title: game.title, error: error.message })
        console.error(`✗ 下载封面失败: ${game.title}`, error.message)
      }
    }

    res.json({
      message: `成功更新 ${updatedCount} 个封面，跳过 ${skippedCount} 个已有封面`,
      updatedCount,
      skippedCount,
      total: games.length,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    console.error('批量下载封面失败:', error.message || error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 清除所有封面数据（用于重新下载）
router.post('/clear-covers', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('UPDATE games SET cover_image = NULL, cover_image_data = NULL, header_cover_image = NULL, header_cover_image_data = NULL').run()
    res.json({ message: '封面数据已清除，请重新执行批量下载' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 单独更新某个游戏的封面
router.post('/:id/refresh-cover', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const game = db.prepare('SELECT id, title, steam_appid FROM games WHERE id = ?').get(req.params.id)

    if (!game) {
      return res.status(404).json({ message: '游戏不存在' })
    }

    if (!game.steam_appid) {
      return res.status(400).json({ message: '该游戏没有 Steam AppID' })
    }

    // 下载纵向封面（大图）
    const coverResult = await downloadGameCover(game.steam_appid, game.title)
    if (coverResult) {
      db.prepare('UPDATE games SET cover_image = ?, cover_image_data = ? WHERE id = ?').run(coverResult.url, coverResult.data, game.id)
    }

    // 下载横向封面（header）
    const headerResult = await downloadGameHeaderCover(game.steam_appid, game.title)
    if (headerResult) {
      db.prepare('UPDATE games SET header_cover_image = ?, header_cover_image_data = ? WHERE id = ?').run(headerResult.url, headerResult.data, game.id)
    }

    if (coverResult || headerResult) {
      res.json({
        message: '封面更新成功',
        data: {
          cover_image: coverResult?.url || null,
          cover_image_data: coverResult?.data || null,
          header_cover_image: headerResult?.url || null,
          header_cover_image_data: headerResult?.data || null
        }
      })
    } else {
      res.status(400).json({ message: '无法获取该游戏的封面，请查看后端日志了解详情' })
    }
  } catch (error) {
    console.error('更新封面失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取统计数据
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    // 尝试从缓存获取
    const cacheKey = 'game:stats'
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()

    const stats = {
      totalGames: db.prepare('SELECT COUNT(*) as count FROM games').get().count,
      totalPlaytime: db.prepare('SELECT SUM(playtime_forever) as total FROM games').get().total || 0,
      playedGames: db.prepare('SELECT COUNT(*) as count FROM games WHERE status IN (?, ?, ?)').get('playing', 'played', 'dropped').count,
      favoriteGames: db.prepare('SELECT COUNT(*) as count FROM games WHERE is_favorite = 1').get().count
    }

    // 缓存结果（2分钟）
    await cache.set(cacheKey, stats, CacheTTL.SHORT * 2)

    res.json({ data: stats })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
