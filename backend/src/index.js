import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

// 加载环境变量
dotenv.config()

// 全局错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]', error)
  if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
    process.exit(1)
  }
})

// 导入配置
import { initDatabase, setCurrentReq } from './config/database.js'
import { ensureDirectories } from './config/storage.js'
import { initRedis, closeRedis } from './utils/redis.js'
import { migrateCompressCovers } from './utils/migration.js'
import { migrate as migrateAccessLogs } from '../migrate-access-logs.js'

// 导入安全中间件
import {
  securityHeaders,
  globalLimiter,
  readLimiter,
  slowQueryDetector
} from './middlewares/security.js'



// 导入路由
import authRoutes from './routes/auth.js'
import documentsRoutes from './routes/documents.js'
import musicRoutes from './routes/music.js'
import booksRoutes from './routes/books.js'
import codeRoutes from './routes/code.js'
import bookmarksRoutes from './routes/bookmarks.js'
import animeRoutes from './routes/anime.js'
import gamesRoutes from './routes/games.js'
import searchRoutes from './routes/search.js'
import bookSearchRoutes from './routes/bookSearch.js'
import todosRoutes from './routes/todos.js'
import blogRoutes from './routes/blog.js'
import { getDatabase } from './config/database.js'
import { authenticateToken } from './middlewares/auth.js'
import { accessLogger, queryLogs, getLogStats, initLogger } from './services/logger.js'
import { 
  initIpBlacklistTable, 
  ipBlacklistMiddleware, 
  queryBlacklist, 
  getBlacklistStats, 
  manualBlockIp, 
  unblockIp 
} from './services/ipBlacklist.js'

const app = express()
const PORT = process.env.PORT || 3000

// 信任代理配置
app.set('trust proxy', 1)

// IP黑名单检查（暂时禁用）
// app.use(ipBlacklistMiddleware)

// 安全中间件
app.use(securityHeaders)
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.CORS_ORIGIN?.split(',') || true)
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400
}))

// 请求体解析
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(cookieParser())

// 慢查询检测（记录响应时间超过3秒的请求）- 暂时禁用
// app.use(slowQueryDetector(3000))

// 全局速率限制（兜底防护）
app.use(globalLimiter)

// 攻击拦截中间件（拦截常见扫描路径）
const SCAN_PATTERNS = [
  // ThinkPHP 漏洞扫描
  /^\/api\/heartbeat$/,
  /^\/api\/app\//,
  /^\/api\/system\//,
  /^\/api\/set\//,
  /^\/api\/api\//,
  /^\/api\/seller\//,
  /^\/api\/currency\//,
  /^\/api\/common\//,
  /^\/api\/new-version\//,
  /^\/api\/contract\//,
  /^\/api\/menus$/,
  /^\/api\/customer-service$/,
  // Spring Boot Actuator
  /^\/actuator\//,
  // 常见后台路径
  /^\/admin\//,
  /^\/manage\//,
  /^\/manager\//,
  /^\/wp-admin\//,
  /^\/wp-login/,
  // 常见 API 路径扫描
  /^\/api\/v[0-9]+\//,
  /^\/rest\//,
  /^\/graphql/,
  // 其他常见扫描
  /^\/.env$/,
  /^\/.git\//,
  /^\/config\//,
  /^\/phpmyadmin/,
]

// 攻击拦截中间件
app.use((req, res, next) => {
  const path = req.path
  
  // 检查是否是扫描请求
  const isScanRequest = SCAN_PATTERNS.some(pattern => pattern.test(path))
  
  if (isScanRequest) {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.connection.remoteAddress
    console.warn(`[攻击拦截] 拦截扫描请求: ${req.method} ${path} from ${clientIP}`)
    
    // 直接返回 404
    return res.status(404).json({ 
      message: 'Not Found',
      code: 404
    })
  }
  
  next()
})

// 请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  next()
})

// 静态文件服务 - 映射 /uploads 到 uploads 目录
const uploadsPath = process.env.UPLOADS_PATH || '/app/data/uploads'
console.log('[Static] Uploads path:', uploadsPath)
console.log('[Static] Screenshots exists:', fs.existsSync(path.join(uploadsPath, 'screenshots')))
app.use('/uploads', express.static(uploadsPath))

// 健康检查
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {}
  }
  
  try {
    const db = getDatabase()
    db.prepare('SELECT 1').get()
    health.services.database = 'ok'
  } catch (error) {
    health.services.database = 'error'
    health.status = 'degraded'
  }
  
  try {
    const redis = await import('./utils/redis.js')
    const isConnected = redis.getRedis && redis.getRedis().isReady
    health.services.redis = isConnected ? 'ok' : 'not_connected'
    if (!isConnected && health.status === 'ok') {
      health.status = 'degraded'
    }
  } catch (error) {
    health.services.redis = 'not_configured'
  }
  
  const statusCode = health.status === 'ok' ? 200 : 503
  res.status(statusCode).json(health)
})

// 兼容旧路径
app.get('/health', (req, res) => {
  res.redirect('/api/health')
})

// 代理测试
app.get('/api/proxy-test', async (req, res) => {
  try {
    const axios = (await import('axios')).default
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    
    const proxyUrl = process.env.HTTP_PROXY || '未配置'
    const targetUrl = req.query.url || 'https://www.google.com'
    const useProxy = req.query.proxy !== 'false'  // 默认使用代理
    
    // 创建代理 agent
    const httpsAgent = useProxy && proxyUrl !== '未配置' 
      ? new HttpsProxyAgent(proxyUrl) 
      : undefined
    
    // 测试访问目标网站
    const response = await axios.get(targetUrl, {
      timeout: 15000,
      httpsAgent,
      validateStatus: () => true
    })
    
    res.json({
      success: true,
      proxy: useProxy ? proxyUrl : '未使用代理',
      target: targetUrl,
      status: response.status,
      message: '访问成功'
    })
  } catch (error) {
    res.json({
      success: false,
      proxy: req.query.proxy !== 'false' ? (process.env.HTTP_PROXY || '未配置') : '未使用代理',
      target: req.query.url || 'https://www.google.com',
      error: error.message,
      message: '访问失败'
    })
  }
})

// 统计接口 - 优化仪表盘性能（应用读速率限制）
app.get('/api/stats', authenticateToken, readLimiter, (req, res) => {
  try {
    const db = getDatabase()
    
    // 判断是否为游客：游客不显示已隐藏的动漫
    const isGuest = req.user?.isGuest || false
    
    // 使用 COUNT 查询，性能远高于加载全部数据
    const stats = {
      documents: db.prepare('SELECT COUNT(*) as count FROM documents').get()?.count || 0,
      music: db.prepare('SELECT COUNT(*) as count FROM music').get()?.count || 0,
      books: db.prepare('SELECT COUNT(*) as count FROM books').get()?.count || 0,
      games: db.prepare('SELECT COUNT(*) as count FROM games').get()?.count || 0,
      code: db.prepare('SELECT COUNT(*) as count FROM code_repositories').get()?.count || 0,
      bookmarks: db.prepare('SELECT COUNT(*) as count FROM bookmarks').get()?.count || 0,
      blog: {
        total: db.prepare('SELECT COUNT(*) as count FROM blog_posts').get()?.count || 0,
        published: db.prepare("SELECT COUNT(*) as count FROM blog_posts WHERE status = 'published'").get()?.count || 0,
        draft: db.prepare("SELECT COUNT(*) as count FROM blog_posts WHERE status = 'draft'").get()?.count || 0
      },
      anime: isGuest ? {
        // 游客：过滤已隐藏的动漫
        total: db.prepare('SELECT COUNT(*) as count FROM anime WHERE is_hidden = 0 OR is_hidden IS NULL').get()?.count || 0,
        want_to_watch: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'want_to_watch' AND (is_hidden = 0 OR is_hidden IS NULL)").get()?.count || 0,
        watching: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'watching' AND (is_hidden = 0 OR is_hidden IS NULL)").get()?.count || 0,
        watched: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'watched' AND (is_hidden = 0 OR is_hidden IS NULL)").get()?.count || 0
      } : {
        // 管理员：显示所有动漫（包括隐藏的）
        total: db.prepare('SELECT COUNT(*) as count FROM anime').get()?.count || 0,
        want_to_watch: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'want_to_watch'").get()?.count || 0,
        watching: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'watching'").get()?.count || 0,
        watched: db.prepare("SELECT COUNT(*) as count FROM anime WHERE status = 'watched'").get()?.count || 0
      }
    }
    
    res.json({ data: stats })
  } catch (error) {
    console.error('获取统计失败:', error)
    res.status(500).json({ message: '获取统计失败' })
  }
})

// API 路由
// 访问日志中间件（记录所有 API 请求）
app.use('/api', accessLogger)

app.use('/api/auth', authRoutes)

// API 路由（authenticateToken 中间件会自动设置数据库上下文）
app.use('/api/documents', documentsRoutes)
app.use('/api/music', musicRoutes)
app.use('/api/ebooks', booksRoutes)  // 改为 ebooks 避免"books"关键词被拦截
app.use('/api/code', codeRoutes)
app.use('/api/bookmarks', bookmarksRoutes)
app.use('/api/anime', animeRoutes)
app.use('/api/games', gamesRoutes)
app.use('/api/search', searchRoutes)
app.use('/api/book-search', bookSearchRoutes)  // 电子书搜索
app.use('/api/todos', todosRoutes)  // 待办事项
app.use('/api/blog', blogRoutes)  // 博客管理

// 管理员访问日志接口
app.get('/api/admin/logs', authenticateToken, (req, res) => {
  // 检查是否为管理员
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以查看日志' })
  }
  
  try {
    const result = queryLogs(req.query)
    res.json({
      data: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    })
  } catch (error) {
    console.error('查询日志失败:', error)
    res.status(500).json({ message: '查询日志失败' })
  }
})

// 管理员日志统计接口
app.get('/api/admin/logs/stats', authenticateToken, (req, res) => {
  // 检查是否为管理员
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以查看日志统计' })
  }
  
  try {
    const stats = getLogStats()
    res.json({ data: stats })
  } catch (error) {
    console.error('获取日志统计失败:', error)
    res.status(500).json({ message: '获取日志统计失败' })
  }
})

// Redis缓存监控接口
app.get('/api/cache/stats', authenticateToken, async (req, res) => {
  try {
    const { cache } = await import('./utils/cache.js')
    const stats = await cache.getStats()
    res.json({
      success: true,
      data: stats
    })
  } catch (error) {
    console.error('获取缓存状态失败:', error)
    res.status(500).json({ success: false, message: '获取缓存状态失败' })
  }
})

// 清空缓存接口（需要管理员权限）
app.post('/api/cache/clear', authenticateToken, async (req, res) => {
  try {
    const { cache } = await import('./utils/cache.js')
    await cache.clear()
    res.json({
      success: true,
      message: '缓存已清空'
    })
  } catch (error) {
    console.error('清空缓存失败:', error)
    res.status(500).json({ success: false, message: '清空缓存失败' })
  }
})

// IP黑名单管理

// 获取黑名单列表（仅管理员）
app.get('/api/admin/blacklist', authenticateToken, (req, res) => {
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以查看黑名单' })
  }
  
  try {
    const result = queryBlacklist(req.query)
    res.json({
      data: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize
    })
  } catch (error) {
    console.error('查询黑名单失败:', error)
    res.status(500).json({ message: '查询黑名单失败' })
  }
})

// 获取黑名单统计（仅管理员）
app.get('/api/admin/blacklist/stats', authenticateToken, (req, res) => {
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以查看黑名单统计' })
  }
  
  try {
    const stats = getBlacklistStats()
    res.json({ data: stats })
  } catch (error) {
    console.error('获取黑名单统计失败:', error)
    res.status(500).json({ message: '获取黑名单统计失败' })
  }
})

// 手动拉黑IP（仅管理员）
app.post('/api/admin/blacklist/block', authenticateToken, (req, res) => {
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以拉黑IP' })
  }
  
  const { ipAddress, reason, durationHours } = req.body
  
  if (!ipAddress) {
    return res.status(400).json({ message: '请提供IP地址' })
  }
  
  const result = manualBlockIp(ipAddress, reason || '手动拉黑', durationHours || 24)
  
  if (result.success) {
    res.json({ success: true, message: `IP ${ipAddress} 已被拉黑` })
  } else {
    res.status(500).json({ success: false, message: result.message })
  }
})

// 解除拉黑（仅管理员）
app.post('/api/admin/blacklist/unblock', authenticateToken, (req, res) => {
  if (req.user?.username !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以解除拉黑' })
  }
  
  const { ipAddress } = req.body
  
  if (!ipAddress) {
    return res.status(400).json({ message: '请提供IP地址' })
  }
  
  const result = unblockIp(ipAddress)
  
  if (result.success) {
    res.json({ success: true, message: `IP ${ipAddress} 已解除拉黑` })
  } else {
    res.status(500).json({ success: false, message: result.message })
  }
})

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Error:', err)
  res.status(err.status || 500).json({
    message: err.message || '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  })
})

// 初始化数据库和目录
async function initialize() {
  try {
    // 确保必要目录存在
    ensureDirectories()

    // 初始化数据库（better-sqlite3 是同步的）
    initDatabase()

    console.log('✓ 数据库初始化完成')

    // 执行封面图片压缩迁移（只执行一次）
    await migrateCompressCovers()

    // 执行访问日志表字段迁移（只执行一次）
    migrateAccessLogs()
    console.log('✓ 访问日志表迁移完成')

    // 初始化 Redis（可选，失败不影响主功能）
    try {
      await initRedis()
      console.log('✓ Redis 缓存初始化完成')
    } catch (error) {
      console.log('⚠ Redis 初始化失败，缓存功能降级为内存模式:', error.message)
    }

    // 初始化访问日志服务
    initLogger()
    console.log('✓ 访问日志服务已启动')

    // 初始化IP黑名单服务
    initIpBlacklistTable()
    console.log('✓ IP黑名单服务已启动')

    // 启动服务器
    app.listen(PORT, () => {
      console.log(`✓ 服务器运行在 http://localhost:${PORT}`)
      console.log(`✓ 数据路径: ${process.env.DATA_PATH}`)
      console.log(`✓ 数据库路径: ${process.env.DB_PATH}`)
    })
  } catch (error) {
    console.error('初始化失败:', error)
    process.exit(1)
  }
}

// 优雅关闭
process.on('SIGTERM', async () => {
  console.log('收到 SIGTERM 信号，正在关闭服务器...')
  await closeRedis()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('收到 SIGINT 信号，正在关闭服务器...')
  await closeRedis()
  process.exit(0)
})

initialize()
