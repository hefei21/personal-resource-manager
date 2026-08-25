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
import { initRedis, closeRedis, isRedisConnected } from './utils/redis.js'
import { migrateCompressCovers } from './utils/migration.js'
import { migrate as migrateAccessLogs } from '../migrate-access-logs.js'
import { getTaskRuntime, startTaskRuntime, stopTaskRuntime } from './services/taskRuntime.js'
import {
  reconcileRagEmbeddingRuntime,
  startRagEmbeddingReconcileLoop
} from './services/ragEmbeddingRuntime.js'
import './services/nasScanTaskProcessor.js'
import './services/resourceDomainImportTaskProcessor.js'
import './services/gitNasTaskProcessor.js'
import './services/searchIndexTaskProcessor.js'
import './services/ragIndexTaskProcessor.js'

// 导入安全中间件
import {
  securityHeaders,
  globalLimiter,
  readLimiter,
  slowQueryDetector
} from './middlewares/security.js'
import {
  enforceOwnerRequestOrigin,
  isTrustedRequestOrigin
} from './middlewares/requestOrigin.js'



// 导入路由
import authRoutes from './routes/auth.js'
import demoRoutes from './routes/demo.js'
import documentsRoutes from './routes/documents.js'
import privateSpaceRetiredRoutes from './routes/privateSpaceRetired.js'
import musicRoutes from './routes/music.js'
import booksRoutes from './routes/books.js'
import codeRoutes from './routes/code.js'
import bookmarksRoutes from './routes/bookmarks.js'
import animeRoutes from './routes/anime.js'
import gamesRoutes from './routes/games.js'
import searchRoutes from './routes/search.js'
import ragRoutes from './routes/rag.js'
import bookSearchRoutes from './routes/bookSearch.js'
import todosRoutes from './routes/todos.js'
import blogRoutes from './routes/blog.js'
import storageConsistencyRoutes from './routes/storageConsistency.js'
import privateSpaceMigrationRoutes from './routes/privateSpaceMigration.js'
import tasksRoutes from './routes/tasks.js'
import nasScanRootsRoutes from './routes/nasScanRoots.js'
import resourceDomainImportsRoutes from './routes/resourceDomainImports.js'
import gitNasRepositoriesRoutes from './routes/gitNasRepositories.js'
import { createPcWorkerAgentRouter, createPcWorkerOwnerRouter } from './routes/pcWorkers.js'
import { getDatabase } from './config/database.js'
import { authenticateToken, requireOwner } from './middlewares/auth.js'
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
let ragEmbeddingReconcileLoop = null
const PORT = process.env.PORT || 3000

// 信任代理配置
app.set('trust proxy', 1)

// IP黑名单检查（暂时禁用）
// app.use(ipBlacklistMiddleware)

// 安全中间件
app.use(securityHeaders)
app.use(cors((req, callback) => {
  const sourceOrigin = req.get('origin')
  const allowOrigin = sourceOrigin &&
    isTrustedRequestOrigin(req, sourceOrigin)

  callback(null, {
    origin: allowOrigin ? sourceOrigin : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'Accept', 'Origin', 'Authorization', 'X-Worker-Lease'],
    exposedHeaders: ['Content-Range', 'X-Content-Range', 'X-Content-Sha256', 'ETag'],
    maxAge: 86400
  })
}))

// 请求体解析
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(cookieParser())
app.use(enforceOwnerRequestOrigin)

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// 静态文件服务 - 映射 /uploads 到 uploads 目录
const uploadsPath = process.env.UPLOADS_PATH || '/app/data/uploads'
console.log('[Static] Uploads path:', uploadsPath)
console.log('[Static] Screenshots exists:', fs.existsSync(path.join(uploadsPath, 'screenshots')))
app.use(
  '/uploads',
  authenticateToken,
  requireOwner,
  express.static(uploadsPath)
)

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
    const isConnected = isRedisConnected()
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

// 旧任意 URL 网络诊断已下线，避免形成通用 SSRF 代理。
app.get(
  '/api/proxy-test',
  authenticateToken,
  requireOwner,
  (req, res) => {
    res.status(410).json({
      message: '任意 URL 网络诊断已下线',
      code: 'NETWORK_DIAGNOSTIC_RETIRED'
    })
  }
)

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
        total: db.prepare('SELECT COUNT(*) as count FROM blog_posts').get()?.count || 0
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
// 演示空间必须在生产访问日志之前挂载，避免演示流量写入生产数据库。
app.use('/api/demo', demoRoutes)

// 访问日志中间件（记录所有 API 请求）
app.use('/api', accessLogger)

app.use('/api/auth', authRoutes)

// API 路由（authenticateToken 中间件会自动设置数据库上下文）
const ownerOnly = [authenticateToken, requireOwner]
app.use('/api/documents', ...ownerOnly, privateSpaceRetiredRoutes, documentsRoutes)
app.use('/api/music', ...ownerOnly, musicRoutes)
app.use('/api/ebooks', ...ownerOnly, booksRoutes)
app.use('/api/code', ...ownerOnly, codeRoutes)
app.use('/api/bookmarks', ...ownerOnly, bookmarksRoutes)
app.use('/api/anime', ...ownerOnly, animeRoutes)
app.use('/api/games', ...ownerOnly, gamesRoutes)
app.use('/api/search', ...ownerOnly, searchRoutes)
app.use('/api/rag', ...ownerOnly, ragRoutes)
app.use('/api/book-search', ...ownerOnly, bookSearchRoutes)
app.use('/api/todos', ...ownerOnly, todosRoutes)
app.use('/api/blog', ...ownerOnly, blogRoutes)
app.use('/api/storage-consistency', ...ownerOnly, storageConsistencyRoutes)
app.use('/api/private-space-migration', ...ownerOnly, privateSpaceMigrationRoutes)
app.use('/api/tasks', ...ownerOnly, tasksRoutes)
app.use('/api/nas-scan-roots', ...ownerOnly, nasScanRootsRoutes)
app.use('/api/resource-domain-imports', ...ownerOnly, resourceDomainImportsRoutes)
app.use('/api/git-nas-repositories', ...ownerOnly, gitNasRepositoriesRoutes)
app.use('/api/pc-workers', ...ownerOnly, createPcWorkerOwnerRouter())
app.use('/api/pc-worker-agent', createPcWorkerAgentRouter())

// 管理员访问日志接口
app.get('/api/admin/logs', authenticateToken, requireOwner, (req, res) => {
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
app.get('/api/admin/logs/stats', authenticateToken, requireOwner, (req, res) => {
  try {
    const stats = getLogStats()
    res.json({ data: stats })
  } catch (error) {
    console.error('获取日志统计失败:', error)
    res.status(500).json({ message: '获取日志统计失败' })
  }
})

// Redis缓存监控接口
app.get('/api/cache/stats', authenticateToken, requireOwner, async (req, res) => {
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
app.post('/api/cache/clear', authenticateToken, requireOwner, async (req, res) => {
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
app.get('/api/admin/blacklist', authenticateToken, requireOwner, (req, res) => {
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
app.get('/api/admin/blacklist/stats', authenticateToken, requireOwner, (req, res) => {
  try {
    const stats = getBlacklistStats()
    res.json({ data: stats })
  } catch (error) {
    console.error('获取黑名单统计失败:', error)
    res.status(500).json({ message: '获取黑名单统计失败' })
  }
})

// 手动拉黑IP（仅管理员）
app.post('/api/admin/blacklist/block', authenticateToken, requireOwner, (req, res) => {
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
app.post('/api/admin/blacklist/unblock', authenticateToken, requireOwner, (req, res) => {
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
async function reconcileRagEmbeddingStartup(database) {
  try {
    const taskStore = getTaskRuntime().getStore()
    const report = await reconcileRagEmbeddingRuntime({ database, taskStore, enqueue: true, maxBatches: 1 })
    if (!report || !['recovered', 'stale', 'missing', 'enqueued'].every((field) => Object.hasOwn(report, field))) return
    console.log('[RAG] embedding startup reconcile completed', {
      recovered: report.recovered,
      stale: report.stale,
      missing: report.missing,
      enqueued: report.enqueued.length
    })
  } catch (error) {
    // Embeddings are an optional acceleration path.  A Qdrant/Worker outage
    // must leave the task runtime and FTS path available during boot.
    console.warn('[RAG] embedding startup reconcile degraded', error?.code ?? 'RAG_EMBEDDING_RECONCILE_FAILED')
  }
}

async function initialize() {
  try {
    // 确保必要目录存在
    ensureDirectories()

    // 初始化数据库（better-sqlite3 是同步的）
    const database = initDatabase()
    startTaskRuntime({ database })
    void reconcileRagEmbeddingStartup(database)
    ragEmbeddingReconcileLoop = startRagEmbeddingReconcileLoop({
      database,
      taskStore: getTaskRuntime().getStore()
    })

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
  ragEmbeddingReconcileLoop?.stop?.()
  await stopTaskRuntime()
  await closeRedis()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('收到 SIGINT 信号，正在关闭服务器...')
  ragEmbeddingReconcileLoop?.stop?.()
  await stopTaskRuntime()
  await closeRedis()
  process.exit(0)
})

initialize()
