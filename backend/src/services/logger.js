import { getDatabase } from '../config/database.js'
import { record404AndCheck } from './ipBlacklist.js'

// 日志配置
const LOG_CONFIG = {
  maxDays: 30,              // 保留 30 天日志
  batchSize: 10,            // 批量写入阈值
  flushInterval: 5000,      // 最多等 5 秒刷新
  excludePaths: [           // 不记录日志的路径
    '/api/stats',
    '/api/health',
    '/favicon.ico'
  ]
}

// 日志队列（异步批量写入）
const logQueue = []
let flushTimer = null

// 批量写入数据库
function flush() {
  if (logQueue.length === 0) return
  
  const logs = logQueue.splice(0, logQueue.length)
  clearTimeout(flushTimer)
  flushTimer = null
  
  try {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO access_logs (user_id, username, action, method, path, module, ip_address, ip_location, user_agent, request_body, response_status, duration, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMany = db.transaction((logs) => {
      for (const l of logs) {
        stmt.run(l.user_id, l.username, l.action, l.method, l.path, l.module, l.ip_address, l.ip_location, l.user_agent, l.request_body, l.response_status, l.duration, l.details)
      }
    })
    insertMany(logs)
    console.log(`[访问日志] 写入 ${logs.length} 条日志`)
  } catch (error) {
    console.error('[访问日志] 写入失败:', error)
  }
}

// 添加日志到队列
function addLog(data) {
  logQueue.push(data)
  
  // 队列达到阈值就写入
  if (logQueue.length >= LOG_CONFIG.batchSize) {
    flush()
  }
  
  // 启动定时刷新
  if (!flushTimer) {
    flushTimer = setTimeout(flush, LOG_CONFIG.flushInterval)
  }
}

// 清理过期日志（只保留最近 N 天）
function cleanupOldLogs() {
  try {
    const db = getDatabase()
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - LOG_CONFIG.maxDays)
    
    const result = db.prepare('DELETE FROM access_logs WHERE created_at < ?').run(cutoff.toISOString())
    if (result.changes > 0) {
      console.log(`[日志清理] 删除 ${result.changes} 条 ${LOG_CONFIG.maxDays} 天前的日志`)
    }
  } catch (error) {
    console.error('[日志清理] 失败:', error)
  }
}

// 定时清理任务（每天凌晨 3 点执行）
function scheduleCleanup() {
  // 启动时清理一次
  cleanupOldLogs()
  
  // 每天定时清理
  setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000)
  
  // 启动时也清理一次（确保）
  console.log(`[访问日志] 定时清理已启动，保留最近 ${LOG_CONFIG.maxDays} 天`)
}

// 根据请求推断操作类型
function getAction(method, path) {
  // 认证相关
  if (path.includes('/auth/login')) return 'login'
  if (path.includes('/auth/logout')) return 'logout'
  
  // 上传相关
  if (method === 'POST' && (path.includes('/upload') || path.includes('/chunk'))) return 'upload'
  
  // 删除相关
  if (method === 'DELETE') return 'delete'
  
  // 创建相关
  if (method === 'POST' && !path.includes('/upload')) return 'create'
  
  // 更新相关
  if (method === 'PUT') return 'update'
  
  // 访问
  return 'visit'
}

// 根据请求路径推断所属模块
function getModule(path) {
  // ===== 1. 认证模块 =====
  if (path.startsWith('/api/auth')) return '认证'
  if (path === '/token-status' || path.startsWith('/token-status')) return '认证'

  // ===== 2. 文档模块 =====
  if (path.startsWith('/api/documents')) return '文档'

  // ===== 3. 书籍模块（ebooks 是 books 的别名） =====
  if (path.startsWith('/api/ebooks') || path.startsWith('/api/books')) return '书籍'
  if (path.startsWith('/api/book-search')) return '书籍搜索'
  // 书籍资源接口（如 /123/progress, /123/cover）
  if (path.match(/^\/\d+\/(progress|content|cover|chapters|toc|download|resource|cache)$/)) {
    return '书籍'
  }

  // ===== 4. 音乐模块 =====
  if (path.startsWith('/api/music')) return '音乐'
  // 音乐资源接口（如 /play/123, /123/lyrics, /123/cover）
  if (path.match(/^\/play\/\d+$/)) return '音乐'
  if (path.match(/^\/\d+\/(lyrics|cover)$/)) return '音乐'

  // ===== 5. 书签模块 =====
  if (path.startsWith('/api/bookmarks')) return '书签'

  // ===== 6. 代码模块 =====
  if (path.startsWith('/api/code')) return '代码'
  // 代码仓库原始文件访问（如 /code/123/raw/...）
  if (path.match(/^\/code\/\d+\/raw\//)) return '代码'

  // ===== 7. 动漫模块 =====
  if (path.startsWith('/api/anime')) return '动漫'

  // ===== 8. 游戏模块 =====
  if (path.startsWith('/api/games')) return '游戏'
  // 游戏相关独立路由
  if (path.startsWith('/steam/')) return '游戏'
  if (path.startsWith('/batch-download-covers')) return '游戏'
  if (path.startsWith('/clear-covers')) return '游戏'

  // ===== 9. 待办事项模块 =====
  if (path.startsWith('/api/todos')) return '待办'

  // ===== 10. 博客模块 =====
  if (path.startsWith('/api/blog')) return '博客'

  // ===== 11. 搜索模块 =====
  if (path.startsWith('/api/search')) return '搜索'

  // ===== 12. 日志模块 =====
  if (path.startsWith('/api/admin/logs')) return '日志'

  // ===== 13. 统计模块 =====
  if (path.startsWith('/api/stats')) return '统计'

  // ===== 14. 缓存模块 =====
  if (path.startsWith('/api/cache')) return '缓存'

  // ===== 15. 代理测试模块 =====
  if (path.startsWith('/api/proxy-test')) return '代理测试'

  // ===== 16. 通用资源接口 =====
  if (path === '/all-ids' || path.startsWith('/all-ids')) return '资源管理'

  // ===== 17. 系统/健康检查 =====
  if (path === '/' || path === '/health' || path === '/api/health') return '系统'

  // ===== 18. 静态资源 =====
  if (path.startsWith('/uploads/')) return '文件上传'

  // ===== 19. 封面/缩略图资源（兜底判断） =====
  if (path.includes('/cover') || path.includes('/thumbnail')) {
    if (path.includes('music') || path.includes('song')) return '音乐'
    if (path.includes('book')) return '书籍'
    if (path.includes('anime')) return '动漫'
    if (path.includes('game')) return '游戏'
    return '资源文件'
  }

  // ===== 20. 攻击拦截（扫描请求） =====
  const SCAN_PATTERNS = [
    /^\/api\/heartbeat$/, /^\/api\/app\//, /^\/api\/system\//,
    /^\/api\/set\//, /^\/api\/api\//, /^\/api\/seller\//,
    /^\/api\/currency\//, /^\/api\/common\//, /^\/api\/new-version\//,
    /^\/api\/contract\//, /^\/api\/menus$/, /^\/api\/customer-service$/,
    /^\/actuator\//, /^\/admin\//, /^\/manage\//, /^\/manager\//,
    /^\/wp-admin\//, /^\/wp-login/, /^\/api\/v[0-9]+\//,
    /^\/rest\//, /^\/graphql/, /^\/.env$/, /^\/.git\//,
    /^\/config\//, /^\/phpmyadmin/
  ]
  if (SCAN_PATTERNS.some(pattern => pattern.test(path))) {
    return '攻击拦截'
  }

  return '其他'
}

// IP2Region 查询器（懒加载）
let ip2regionSearcher = null
let ip2regionInitialized = false

// 初始化 IP2Region（异步）
async function initIP2Region() {
  if (ip2regionInitialized) return ip2regionSearcher !== null

  try {
    // 动态导入 ip2region（ES Module 方式）
    const ip2regionModule = await import('ip2region')
    // 只在开发环境输出详细日志
    if (process.env.NODE_ENV === 'development') {
      console.log('[IP定位] ip2region 模块导入成功:', Object.keys(ip2regionModule))
    }
    
    // 尝试不同的导出方式
    const IP2Region = ip2regionModule.default || ip2regionModule.IP2Region || ip2regionModule
    
    if (typeof IP2Region !== 'function' && typeof IP2Region !== 'object') {
      throw new Error(`IP2Region 类型错误: ${typeof IP2Region}`)
    }
    
    // 如果是对象，尝试找到构造函数
    const Constructor = typeof IP2Region === 'function' ? IP2Region : IP2Region.default || IP2Region.IP2Region
    
    ip2regionSearcher = new Constructor()
    ip2regionInitialized = true
    console.log('[IP定位] IP2Region 初始化成功')
    return true
  } catch (error) {
    ip2regionInitialized = true
    console.warn('[IP定位] IP2Region 初始化失败，使用备用方案:', error.message)
    return false
  }
}

// 根据IP地址推断属地（使用 IP2Region）
async function getIPLocation(ip) {
  if (!ip || ip === 'unknown') return '未知'

  // 本地地址
  if (ip === '127.0.0.1' || ip === '::1') return '本地'
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return '本地'
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1])
    if (second >= 16 && second <= 31) return '本地'
  }

  // 尝试使用 IP2Region 查询
  try {
    if (!ip2regionSearcher) {
      await initIP2Region()
    }

    if (ip2regionSearcher) {
      const result = ip2regionSearcher.search(ip)
      // 只在开发环境或出错时输出详细日志
      if (process.env.NODE_ENV === 'development') {
        console.log('[IP定位] IP2Region 查询结果:', result, '类型:', typeof result)
      }

      if (result) {
        let country, province, city
        
        // 处理不同的返回格式
        if (typeof result === 'object') {
          // 如果返回的是对象，直接提取字段
          country = result.country || ''
          province = result.province || result.region || ''  // province 或 region 字段
          city = result.city || ''
        } else {
          // 解析 IP2Region 字符串返回格式：国家|区域|省份|城市|ISP
          // 例如：中国|0|广东省|广州市|电信
          const parts = String(result).split('|')
          country = parts[0] || ''
          province = parts[2] || ''
          city = parts[3] || ''
        }

        // 如果是中国，显示省份+城市（简化：只显示城市）
        if (country === '中国') {
          // 简化显示：如果有城市显示城市，否则显示省份
          if (city && city !== '0') {
            return city  // 只返回城市名，如"深圳"
          } else if (province && province !== '0') {
            return province  // 只返回省份名，如"广东"
          } else {
            return '中国'
          }
        }

        // 如果是国外，显示国家
        if (country && country !== '0') {
          return country  // 如"美国"
        }
      }
    }
  } catch (error) {
    console.warn('[IP定位] IP2Region 查询失败:', error.message)
  }

  // 备用方案：简单判断
  const firstOctet = parseInt(ip.split('.')[0])
  const chinaFirstOctets = [
    1, 14, 27, 36, 39, 42, 49, 58, 59, 60, 61,
    101, 103, 106, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
    120, 121, 122, 123, 124, 125, 126,
    150, 153, 157, 159, 161, 162, 163, 171, 175, 180, 182, 183,
    202, 203, 210, 211, 218, 219, 220, 221, 222, 223
  ]

  if (chinaFirstOctets.includes(firstOctet)) return '中国'

  return '境外'
}

// 提取详情（脱敏处理）
function extractDetails(req) {
  const path = req.path
  
  // 登录
  if (path.includes('/auth/login')) {
    return JSON.stringify({ username: req.body?.username })
  }
  
  // 上传
  if (path.includes('/upload') || path.includes('/chunk')) {
    return JSON.stringify({ fileName: req.body?.fileName || req.file?.originalname })
  }
  
  // 删除
  if (req.method === 'DELETE') {
    const id = path.match(/\/(\d+)/)?.[1]
    return JSON.stringify({ deletedId: id })
  }
  
  // 获取资源 ID
  const idMatch = path.match(/\/api\/(\w+)\/(\d+)/)
  if (idMatch) {
    return JSON.stringify({ resource: idMatch[1], id: idMatch[2] })
  }
  
  return null
}

// 脱敏处理请求体
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null
  
  const safe = { ...body }
  delete safe.password
  delete safe.token
  delete safe.newPassword
  delete safe.oldPassword
  delete safe.privatePassword
  
  const keys = Object.keys(safe)
  return keys.length > 0 ? JSON.stringify(safe) : null
}

// 获取真实 IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip ||
         'unknown'
}

// Express 中间件：记录访问日志
export function accessLogger(req, res, next) {
  // 跳过不需要记录的路径
  if (LOG_CONFIG.excludePaths.some(p => req.path.startsWith(p))) {
    return next()
  }
  
  const startTime = Date.now()
  const originalEnd = res.end
  
  res.end = async function(...args) {
    const duration = Date.now() - startTime
    const userId = req.user?.id || null
    const username = req.user?.username || 'guest'
    const action = getAction(req.method, req.path)
    const module = getModule(req.path)
    const ipAddress = getClientIP(req)
    const ipLocation = await getIPLocation(ipAddress)
    const details = extractDetails(req)

    addLog({
      user_id: userId,
      username,
      action,
      method: req.method,
      path: req.path,
      module,
      ip_address: ipAddress,
      ip_location: ipLocation,
      user_agent: req.get('user-agent') || '',
      request_body: sanitizeBody(req.body),
      response_status: res.statusCode,
      duration,
      details
    })

    // 记录404请求并检查是否需要拉黑
    if (res.statusCode === 404) {
      record404AndCheck(req)
    }

    originalEnd.apply(res, args)
  }
  
  next()
}

// 查询日志（供管理员接口调用）
export function queryLogs(params) {
  const db = getDatabase()
  const { page = 1, pageSize = 50, userId, action, startDate, endDate, keyword } = params
  
  let where = '1=1'
  const args = []
  
  if (userId) {
    where += ' AND user_id = ?'
    args.push(userId)
  }
  if (action) {
    where += ' AND action = ?'
    args.push(action)
  }
  if (startDate) {
    where += ' AND created_at >= ?'
    args.push(startDate)
  }
  if (endDate) {
    where += ' AND created_at <= ?'
    args.push(endDate)
  }
  if (keyword) {
    where += ' AND (path LIKE ? OR username LIKE ? OR ip_address LIKE ?)'
    const kw = `%${keyword}%`
    args.push(kw, kw, kw)
  }
  
  const offset = (page - 1) * pageSize
  
  const total = db.prepare(`SELECT COUNT(*) as count FROM access_logs WHERE ${where}`).get(...args)?.count || 0
  const data = db.prepare(`SELECT * FROM access_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset)
  
  return { data, total, page, pageSize }
}

// 获取日志统计
export function getLogStats() {
  const db = getDatabase()
  
  // 使用 UTC 时间
  const now = new Date()
  const todayUTC = now.toISOString().split('T')[0]
  
  // 今日访问量（UTC 时间）
  const todayCount = db.prepare(`SELECT COUNT(*) as count FROM access_logs WHERE DATE(created_at) = ?`).get(todayUTC)?.count || 0
  
  // 总记录数
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM access_logs').get()?.count || 0
  
  // 今日活跃用户（按 IP 去重统计）
  const todayActiveUsers = db.prepare(`
    SELECT COUNT(DISTINCT ip_address) as count 
    FROM access_logs 
    WHERE DATE(created_at) = ?
  `).get(todayUTC)?.count || 0
  
  // 热门操作
  const topActions = db.prepare(`
    SELECT action, COUNT(*) as count 
    FROM access_logs 
    GROUP BY action 
    ORDER BY count DESC 
    LIMIT 5
  `).all()
  
  return {
    todayCount,
    totalCount,
    todayActiveUsers,
    topActions
  }
}

// 启动日志服务
export function initLogger() {
  scheduleCleanup()
  console.log('[访问日志] 日志服务已启动')
}

export default {
  accessLogger,
  queryLogs,
  getLogStats,
  initLogger
}
