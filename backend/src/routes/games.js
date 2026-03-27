import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { authenticateToken } from '../middlewares/auth.js'

const router = express.Router()

// 创建代理 agent（用于访问被墙网站）
const httpsAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

// Steam API 不需要代理（国内可直接访问）
const steamAgent = undefined

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

// 尝试下载游戏封面（带回退机制和详细日志）
async function downloadGameCover(steamAppId, title) {
  if (!steamAppId) {
    console.log(`✗ ${title}: 没有 Steam AppID`)
    return null
  }

  // 封面源列表（按优先级）
  const coverSources = [
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900.jpg`, type: '纵向封面' },
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/library_600x900_2x.jpg`, type: '纵向封面高清' },
    { url: `https://steamcdn-a.akamaihd.net/steam/apps/${steamAppId}/header.jpg`, type: '横向头图' },
    // 备用 CDN
    { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900.jpg`, type: '纵向封面(CF)' },
    { url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/header.jpg`, type: '横向头图(CF)' },
    // Steam 社区 CDN
    { url: `https://steamcommunity.com/public/images/apps/${steamAppId}/header.jpg`, type: '社区头图' }
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

  // 所有 CDN 源都失败，尝试从 Steam Store API 获取封面 URL
  console.log(`[封面] ${title}: CDN 源均失败，尝试从 Store API 获取...`)
  try {
    const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${steamAppId}`
    const response = await axios.get(storeUrl, { httpsAgent: steamAgent, proxy: false, timeout: 15000 })

    if (response.data[steamAppId]?.success) {
      const appData = response.data[steamAppId].data

      // 先尝试纵向封面 CDN URL（优先使用纵向封面，适合卡片显示）
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

      // 最后才尝试横向封面和其他图片（可能不适合卡片显示）
      const possibleCovers = [
        appData.header_image,
        appData.background,
        appData.screenshots?.[0]?.path_full
      ].filter(Boolean)

      for (const coverUrl of possibleCovers) {
        if (coverUrl) {
          const coverData = await downloadImageAsBase64(coverUrl)
          if (coverData) {
            console.log(`✓ ${title}: 使用 Store API 封面 (${coverUrl}) [横向]`)
            return { url: coverUrl, data: coverData }
          }
        }
      }
    }
  } catch (e) {
    console.log(`[封面] ${title}: Store API 获取失败 - ${e.message}`)
  }

  console.log(`✗ ${title}: 所有封面源均失败 - ${failedSources.join('; ')}`)
  return null
}

// ========== Steam 配置管理 ==========

// 辅助函数：将 UTC 时间转换为 UTC+8
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  const date = new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hour = String(utc8Date.getHours()).padStart(2, '0')
  const minute = String(utc8Date.getMinutes()).padStart(2, '0')
  const second = String(utc8Date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

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
router.post('/steam/config', authenticateToken, async (req, res) => {
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
      const response = await axios.get(testUrl, { httpsAgent: steamAgent, proxy: false, timeout: 10000 })
      
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
router.delete('/steam/config', authenticateToken, (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM steam_config WHERE id = 1').run()
    res.json({ message: '配置已删除' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// ========== Steam 同步 ==========

// 异步任务管理器
const syncTasks = new Map()

// 创建任务
function createTask() {
  const taskId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const task = {
    id: taskId,
    status: 'pending', // pending, running, completed, failed
    progress: 0,
    message: '等待开始...',
    result: null,
    error: null,
    startTime: null,
    endTime: null
  }
  syncTasks.set(taskId, task)
  return task
}

// 更新任务状态
function updateTask(taskId, updates) {
  const task = syncTasks.get(taskId)
  if (task) {
    Object.assign(task, updates)
  }
}

// 清理过期任务（超过1小时）
setInterval(() => {
  const now = Date.now()
  for (const [id, task] of syncTasks) {
    if (task.endTime && now - task.endTime > 3600000) {
      syncTasks.delete(id)
    }
  }
}, 60000)

// 后台执行同步任务（优化版）- 只同步游戏列表，成就按需获取
async function executeSyncTask(taskId, steamId, apiKey) {
  const task = syncTasks.get(taskId)
  if (!task) return

  updateTask(taskId, { status: 'running', startTime: Date.now(), message: '正在获取游戏列表...' })

  try {
    const db = getDatabase()

    // 获取游戏列表（带重试机制）
    const gamesUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`

    let gamesResponse
    let lastError = null

    // 最多重试3次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[任务 ${taskId}] 尝试获取游戏列表 (第${attempt}次)...`)
        gamesResponse = await axios.get(gamesUrl, {
          httpsAgent: steamAgent,
          proxy: false,
          timeout: 60000 // 增加到60秒
        })
        break // 成功则退出循环
      } catch (e) {
        lastError = e
        console.error(`[任务 ${taskId}] 第${attempt}次尝试失败:`, e.message || e.code || '未知错误')
        if (attempt < 3) {
          console.log(`[任务 ${taskId}] 等待5秒后重试...`)
          await new Promise(resolve => setTimeout(resolve, 5000))
        }
      }
    }

    if (!gamesResponse) {
      throw new Error('获取游戏列表失败: ' + (lastError?.message || lastError?.code || '网络错误'))
    }

    const games = gamesResponse.data.response?.games || []
    console.log(`[任务 ${taskId}] 获取到 ${games.length} 个游戏`)

    let newCount = 0
    let updateCount = 0
    const totalGames = games.length

    // 使用事务批量处理游戏数据（大幅提升性能）
    const insertGame = db.prepare(`
      INSERT INTO games (steam_appid, title, cover_image, playtime_forever, playtime_2weeks, last_played)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const updateGame = db.prepare(`
      UPDATE games SET
        playtime_forever = ?,
        playtime_2weeks = ?,
        last_played = ?,
        cover_image = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE steam_appid = ?
    `)
    const findGame = db.prepare('SELECT id, cover_image, cover_image_data FROM games WHERE steam_appid = ?')

    // 批量处理游戏数据
    const transaction = db.transaction((gamesList) => {
      for (const game of gamesList) {
        // 使用纵向封面图（library_600x900.jpg）适配卡片显示
        const coverUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${game.appid}/library_600x900.jpg`
        const existing = findGame.get(game.appid)

        if (existing) {
          // 已有封面数据则完全保留封面信息，只更新游玩时间
          if (existing.cover_image_data) {
            updateGame.run(
              game.playtime_forever || 0,
              game.playtime_2weeks || 0,
              game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null,
              existing.cover_image, // 保留原封面 URL
              game.appid
            )
          } else {
            // 没有封面数据时，才更新封面 URL
            const shouldUpdateCover = !existing.cover_image || existing.cover_image.includes('steamcommunity/public/images/apps')
            const newCoverUrl = shouldUpdateCover ? coverUrl : existing.cover_image
            updateGame.run(
              game.playtime_forever || 0,
              game.playtime_2weeks || 0,
              game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null,
              newCoverUrl,
              game.appid
            )
          }
          updateCount++
        } else {
          insertGame.run(
            game.appid,
            game.name,
            coverUrl,
            game.playtime_forever || 0,
            game.playtime_2weeks || 0,
            game.rtime_last_played ? new Date(game.rtime_last_played * 1000).toISOString() : null
          )
          newCount++
        }
      }
    })

    // 执行事务
    transaction(games)
    updateTask(taskId, { progress: 50, message: `游戏数据同步完成 (${newCount} 新增, ${updateCount} 更新)` })

    // 更新同步时间（不再自动获取成就，改为按需获取）
    db.prepare('UPDATE steam_config SET last_sync = CURRENT_TIMESTAMP WHERE id = 1').run()

    const message = `同步完成！新增 ${newCount} 个游戏，更新 ${updateCount} 个游戏`

    updateTask(taskId, {
      status: 'completed',
      progress: 100,
      message,
      result: { newCount, updateCount, total: totalGames },
      endTime: Date.now()
    })
    console.log(`[任务 ${taskId}] 同步完成: ${message}`)
  } catch (error) {
    console.error(`[任务 ${taskId}] 同步失败:`, error)
    updateTask(taskId, {
      status: 'failed',
      message: '同步失败: ' + error.message,
      error: error.message,
      endTime: Date.now()
    })
  }
}

// 开始同步（异步）- 只同步游戏列表，成就按需获取
router.post('/steam/sync', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const config = db.prepare('SELECT steam_id, api_key FROM steam_config WHERE id = 1').get()
    if (!config) {
      return res.status(400).json({ message: '请先配置 Steam 账号' })
    }

    // 检查是否有正在运行的任务
    for (const [id, task] of syncTasks) {
      if (task.status === 'running') {
        return res.json({ taskId: id, status: 'running', message: '已有同步任务在进行中' })
      }
    }

    // 创建新任务
    const task = createTask()
    
    // 异步执行同步
    executeSyncTask(task.id, config.steam_id, config.api_key)

    res.json({ taskId: task.id, status: 'pending', message: '同步任务已启动' })
  } catch (error) {
    console.error('启动同步失败:', error)
    res.status(500).json({ message: '启动同步失败: ' + error.message })
  }
})

// 查询同步任务状态
router.get('/steam/sync/:taskId', authenticateToken, (req, res) => {
  const { taskId } = req.params
  const task = syncTasks.get(taskId)
  
  if (!task) {
    return res.status(404).json({ message: '任务不存在' })
  }

  res.json({ data: task })
})

// ========== 游戏管理 ==========

// 获取游戏列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, favorite, genre, platform, keyword, sortBy = 'playtime_2weeks', sortOrder = 'DESC', page = 1, pageSize = 30 } = req.query
    const db = getDatabase()

    let sql = 'SELECT * FROM games WHERE 1=1'
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
    const db = getDatabase()
    
    // 获取游戏信息
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id)
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

    res.json({ 
      data: {
        game: {
          id: game.id,
          title: game.title,
          steam_appid: game.steam_appid,
          cover_image: game.cover_image,
          cover_image_data: game.cover_image_data,
          playtime_forever: game.playtime_forever,
          playtime_2weeks: game.playtime_2weeks,
          last_played: game.last_played,
          achievements_total: game.achievements_total,
          achievements_completed: game.achievements_completed,
          has_achievements_data: achievements.length > 0
        },
        achievements
      }
    })
  } catch (error) {
    console.error('获取成就详情失败:', error.message || error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 按需获取/刷新游戏成就数据
router.post('/:id/fetch-achievements', authenticateToken, async (req, res) => {
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
      achResponse = await axios.get(playerAchievementsUrl, { httpsAgent: steamAgent, proxy: false, timeout: 15000 })
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
      const schemaResponse = await axios.get(schemaUrl, { httpsAgent: steamAgent, proxy: false, timeout: 15000 })
      achievementDefs = schemaResponse.data.game?.availableGameStats?.achievements || []
    } catch (e) {
      console.log(`获取成就定义失败: ${game.title}`)
    }

    // 获取全球完成率
    let globalPercents = {}
    try {
      const globalUrl = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${game.steam_appid}`
      const globalResponse = await axios.get(globalUrl, { httpsAgent: steamAgent, proxy: false, timeout: 15000 })
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
router.put('/:id', authenticateToken, async (req, res) => {
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
router.delete('/:id', authenticateToken, async (req, res) => {
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
router.post('/:id/favorite', authenticateToken, async (req, res) => {
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
router.post('/:id/status', authenticateToken, async (req, res) => {
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
router.post('/:id/rating', authenticateToken, async (req, res) => {
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

// 批量下载封面（优化：已有可用封面则跳过）
router.post('/batch-download-covers', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()

    // 获取所有游戏
    const games = db.prepare('SELECT id, title, cover_image, cover_image_data, steam_appid FROM games').all()

    if (games.length === 0) {
      return res.json({ message: '没有游戏需要处理', updatedCount: 0 })
    }

    let updatedCount = 0
    let skippedCount = 0
    const errors = []

    for (const game of games) {
      try {
        // 如果已有封面数据，跳过
        if (game.cover_image_data) {
          skippedCount++
          continue
        }

        // 尝试下载封面（带回退机制）
        if (game.steam_appid) {
          // 先尝试从 Steam Store API 获取游戏详情（可选，用于补充信息）
          try {
            const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${game.steam_appid}`
            const response = await axios.get(storeUrl, { httpsAgent: steamAgent, proxy: false, timeout: 10000 })

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

          // 下载封面（带回退：纵向 → 纵向高清 → 横向）
          const coverResult = await downloadGameCover(game.steam_appid, game.title)

          if (coverResult) {
            db.prepare('UPDATE games SET cover_image = ?, cover_image_data = ? WHERE id = ?').run(coverResult.url, coverResult.data, game.id)
            updatedCount++
          } else {
            errors.push({ id: game.id, title: game.title, error: '所有封面源均不可用' })
            console.error(`✗ 下载封面失败: ${game.title} - 所有封面源均不可用`)
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
router.post('/clear-covers', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('UPDATE games SET cover_image = NULL, cover_image_data = NULL').run()
    res.json({ message: '封面数据已清除，请重新执行批量下载' })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

// 单独更新某个游戏的封面
router.post('/:id/refresh-cover', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const game = db.prepare('SELECT id, title, steam_appid FROM games WHERE id = ?').get(req.params.id)

    if (!game) {
      return res.status(404).json({ message: '游戏不存在' })
    }

    if (!game.steam_appid) {
      return res.status(400).json({ message: '该游戏没有 Steam AppID' })
    }

    // 尝试下载封面
    const coverResult = await downloadGameCover(game.steam_appid, game.title)

    if (coverResult) {
      db.prepare('UPDATE games SET cover_image = ?, cover_image_data = ? WHERE id = ?').run(coverResult.url, coverResult.data, game.id)
      res.json({
        message: '封面更新成功',
        data: {
          cover_image: coverResult.url,
          cover_image_data: coverResult.data
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
    const db = getDatabase()

    const stats = {
      totalGames: db.prepare('SELECT COUNT(*) as count FROM games').get().count,
      totalPlaytime: db.prepare('SELECT SUM(playtime_forever) as total FROM games').get().total || 0,
      playedGames: db.prepare('SELECT COUNT(*) as count FROM games WHERE status IN (?, ?, ?)').get('playing', 'played', 'dropped').count,
      favoriteGames: db.prepare('SELECT COUNT(*) as count FROM games WHERE is_favorite = 1').get().count
    }

    res.json({ data: stats })
  } catch (error) {
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
