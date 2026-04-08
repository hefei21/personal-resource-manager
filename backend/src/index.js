import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import dotenv from 'dotenv'
import path from 'path'

// 加载环境变量
dotenv.config()

// 导入配置
import { initDatabase } from './config/database.js'
import { ensureDirectories } from './config/storage.js'
import { initRedis, closeRedis } from './utils/redis.js'
import { migrateCompressCovers } from './utils/migration.js'

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

const app = express()
const PORT = process.env.PORT || 3000

// 中间件
app.use(cors({
  origin: true, // 允许所有来源（适用于反向代理场景）
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400
}))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(cookieParser())

// 请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  next()
})

// 静态文件服务
app.use('/uploads', express.static(path.join(process.env.UPLOADS_PATH, './uploads')))

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 代理测试接口（支持自定义URL测试）
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

// 统计接口 - 优化仪表盘性能
app.get('/api/stats', authenticateToken, (req, res) => {
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
app.use('/api/auth', authRoutes)
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

    // 初始化 Redis（可选，失败不影响主功能）
    try {
      await initRedis()
      console.log('✓ Redis 缓存初始化完成')
    } catch (error) {
      console.log('⚠ Redis 初始化失败，缓存功能降级为内存模式:', error.message)
    }

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
