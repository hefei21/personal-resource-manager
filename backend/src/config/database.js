import fs from 'fs'
import path from 'path'
import { openDatabaseConnection } from './sqliteConnection.js'
import { runMigrationStartupGate } from './migrationStartupGate.js'
import { CREATE_RESOURCE_TRASH_SQL } from './resourceTrashSchema.js'
import { applicationMigrationRegistry } from './databaseMigrations.js'
import { createDatabaseBackupSync } from './databaseBackup.js'
import { ENSURE_STORAGE_COMMIT_OPERATIONS_SQL } from './storageCommitSchema.js'
import { BOOKS_STORAGE_TARGET_DDL } from './ebookStorageSchema.js'
import { MUSIC_STORAGE_TARGET_DDL } from './musicStorageSchema.js'
import { getContext } from '../utils/dbContext.js'
import {
  initializeOwner,
  retireLegacyTestUser
} from '../services/bootstrapSecurity.js'

const baseDbPath = process.env.DB_PATH || path.join(process.env.DATA_PATH, 'database', 'app.db')
const dbDir = path.dirname(baseDbPath)
const databaseBackupPath = process.env.DATABASE_BACKUP_PATH || path.join(dbDir, 'backups')

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

// 数据库连接池（按数据库路径存储）
const dbPool = new Map()

// 当前请求的 req 对象（用于在没有上下文时回退）
let currentReq = null

/**
 * 设置当前请求的 req 对象
 * @param {Object} req - Express 请求对象
 */
export function setCurrentReq(req) {
  currentReq = req
}

/**
 * 获取当前请求的 req 对象
 * @returns {Object|null} Express 请求对象
 */
export function getCurrentReq() {
  return currentReq
}

/**
 * 获取数据库连接
 * @param {Object|string} reqOrUsername - Express请求对象或用户名，为null时使用默认数据库或从上下文获取
 * @returns {Database} better-sqlite3 数据库实例
 */
function getDatabase(reqOrUsername = null) {
  let username = null
  
  // 如果传入的是请求对象
  if (reqOrUsername && typeof reqOrUsername === 'object' && reqOrUsername.user) {
    username = reqOrUsername.user.username
  } else if (typeof reqOrUsername === 'string') {
    // 如果传入的是用户名字符串
    username = reqOrUsername
  } else {
    // 尝试从上下文获取
    const context = getContext()
    if (context) {
      username = context.username
      // 如果没有 username 但有 req 对象，尝试从 req 获取
      if (!username && context.req && context.req.user) {
        username = context.req.user.username
      }
    }
    
    // 如果上下文没有 username，尝试从 currentReq 获取
    if (!username && currentReq && currentReq.user) {
      username = currentReq.user.username
    }
  }
  
  const dbPath = baseDbPath
  
  if (!dbPool.has(dbPath)) {
    const db = openDatabaseConnection(dbPath)
    console.log(`数据库已连接: ${dbPath}${username ? ` (用户: ${username})` : ''}`)
    dbPool.set(dbPath, db)
  }
  return dbPool.get(dbPath)
}

/**
 * 从请求中获取用户名
 * @param {Object} req - Express 请求对象
 * @returns {string|null} 用户名
 */
function getUsernameFromRequest(req) {
  if (req.user && req.user.username) {
    return req.user.username
  }
  return null
}

/**
 * 获取当前请求对应的数据库
 * @param {Object} req - Express 请求对象
 * @returns {Database} better-sqlite3 数据库实例
 */
function getDatabaseForRequest(req) {
  const username = getUsernameFromRequest(req)
  return getDatabase(username)
}

// 初始化数据库表
function initDatabase() {
  const mainDb = getDatabase()
  initDatabaseInstance(mainDb, 'main', () => {
    runMigrationStartupGate({
      database: mainDb,
      mainDbPath: baseDbPath,
      registry: applicationMigrationRegistry,
      beforeFirstExecution: ({ database, mainDbPath }) => {
        createDatabaseBackupSync({
          database,
          sourceDbPath: mainDbPath,
          backupRoot: databaseBackupPath,
          migrations: applicationMigrationRegistry.migrations
        })
      }
    })
  })
  return mainDb
}

/**
 * 初始化单个数据库实例
 * @param {Database} database - 数据库实例
 * @param {string} dbType - 数据库类型（main/test）
 * @param {Function|null} runBaseSchemaGate - 基础表创建后的同步 schema gate
 */
function initDatabaseInstance(database, dbType = 'main', runBaseSchemaGate = null) {
  console.log(`\n========== 初始化 ${dbType} 数据库 ==========`)

  const shouldCreateReadingProgress = true

  // 先创建所有表
  const tables = [
    CREATE_RESOURCE_TRASH_SQL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),
    // 用户表
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 文档表
    `CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      tags TEXT,
      file_path TEXT NOT NULL,
      version REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 分类表（支持多层嵌套）
    `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      path TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
    )`,

    // 文档版本表
    `CREATE TABLE IF NOT EXISTS document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )`,

    // 音乐表
    MUSIC_STORAGE_TARGET_DDL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),

    // 歌单表
    `CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      cover_image TEXT,
      song_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 歌单歌曲关联表
    `CREATE TABLE IF NOT EXISTS playlist_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      music_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, music_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (music_id) REFERENCES music(id) ON DELETE CASCADE
    )`,

    // 代码仓库表（简化版）
    `CREATE TABLE IF NOT EXISTS code_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      local_path TEXT NOT NULL DEFAULT '',
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      languages TEXT DEFAULT '{}'
    )`,

    // 书签表
    `CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      description TEXT,
      icon TEXT,
      icon_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 动漫表
    `CREATE TABLE IF NOT EXISTS anime (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bangumi_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      name_cn TEXT,
      name_original TEXT,
      summary TEXT,
      cover_image TEXT,
      rating REAL,
      rating_count INTEGER DEFAULT 0,
      tags TEXT,
      air_date TEXT,
      eps INTEGER DEFAULT 0,
      eps_total INTEGER DEFAULT 0,
      author TEXT,
      director TEXT,
      studio TEXT,
      infobox TEXT,
      characters TEXT,
      staff TEXT,
      status TEXT DEFAULT 'none',
      is_favorite INTEGER DEFAULT 0,
      user_rating INTEGER DEFAULT 0,
      is_hidden INTEGER DEFAULT 0,
      cover_image_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 私密文件表
    `CREATE TABLE IF NOT EXISTS private_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 私密空间密码表
    `CREATE TABLE IF NOT EXISTS private_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 书籍分类表
    `CREATE TABLE IF NOT EXISTS book_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 书籍表
    BOOKS_STORAGE_TARGET_DDL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),

    // 阅读进度表
    ...(shouldCreateReadingProgress ? [
      `CREATE TABLE IF NOT EXISTS reading_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        user_id INTEGER,
        current_page INTEGER DEFAULT 0,
        cfi TEXT,
        progress REAL DEFAULT 0,
        font_size INTEGER DEFAULT 16,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(book_id, user_id)
      )`
    ] : []),

    // 书籍目录表
    `CREATE TABLE IF NOT EXISTS book_chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      start_position INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    )`,

    // 游戏表
    `CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_appid INTEGER UNIQUE,
      title TEXT NOT NULL,
      name_original TEXT,
      cover_image TEXT,
      cover_image_data TEXT,
      header_cover_image TEXT,
      header_cover_image_data TEXT,
      achievements_total INTEGER DEFAULT 0,
      achievements_completed INTEGER DEFAULT 0,
      description TEXT,
      developers TEXT,
      publishers TEXT,
      release_date TEXT,
      genres TEXT,
      tags TEXT,
      platforms TEXT,
      metacritic_score INTEGER,
      metacritic_url TEXT,
      playtime_forever INTEGER DEFAULT 0,
      playtime_2weeks INTEGER DEFAULT 0,
      last_played TEXT,
      status TEXT DEFAULT 'unplayed',
      user_rating INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // Steam 配置表
    `CREATE TABLE IF NOT EXISTS steam_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      steam_id TEXT,
      api_key TEXT,
      last_sync TEXT,
      auto_sync INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 游戏成就表
    `CREATE TABLE IF NOT EXISTS game_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL,
      achievement_id TEXT NOT NULL,
      name TEXT,
      description TEXT,
      icon TEXT,
      icon_gray TEXT,
      is_achieved INTEGER DEFAULT 0,
      unlock_time TEXT,
      global_percent REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(game_id, achievement_id),
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )`,

    // 待办事项表
    `CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      confirmed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 博客文章表
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      category_id INTEGER,
      status TEXT DEFAULT 'draft',
      is_top INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES blog_categories(id) ON DELETE SET NULL
    )`,

    // 博客分类表
    `CREATE TABLE IF NOT EXISTS blog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES blog_categories(id) ON DELETE CASCADE
    )`,

    // 博客标签表
    `CREATE TABLE IF NOT EXISTS blog_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT
    )`,

    // 博客文章-标签关联表
    `CREATE TABLE IF NOT EXISTS blog_post_tags (
      post_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, tag_id),
      FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES blog_tags(id) ON DELETE CASCADE
    )`,

    // 访问日志表
    `CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT,
      method TEXT,
      path TEXT,
      module TEXT,
      ip_address TEXT,
      ip_location TEXT,
      user_agent TEXT,
      request_body TEXT,
      response_status INTEGER,
      duration INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    ENSURE_STORAGE_COMMIT_OPERATIONS_SQL
  ]

  tables.forEach(sql => {
    database.exec(sql)
  })

  if (runBaseSchemaGate) {
    runBaseSchemaGate()
  }

  // 创建索引以提升查询性能
  const indexes = [
    // 音乐表索引
    'CREATE INDEX IF NOT EXISTS idx_music_artist ON music(artist)',
    'CREATE INDEX IF NOT EXISTS idx_music_album ON music(album)',
    'CREATE INDEX IF NOT EXISTS idx_music_title ON music(title)',
    'CREATE INDEX IF NOT EXISTS idx_music_created_at ON music(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_music_has_lyrics ON music(has_lyrics)',
    // 歌单歌曲关联表索引
    'CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist_id ON playlist_songs(playlist_id)',
    'CREATE INDEX IF NOT EXISTS idx_playlist_songs_music_id ON playlist_songs(music_id)',
    // 文档表索引
    'CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)',
    'CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title)',
    'CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at)',
    // 分类表索引
    'CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_categories_sort_order ON categories(sort_order)',
    // 博客文章表索引
    'CREATE INDEX IF NOT EXISTS idx_blog_posts_category_id ON blog_posts(category_id)',
    'CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status)',
    'CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at ON blog_posts(created_at)',
    // 博客分类表索引
    'CREATE INDEX IF NOT EXISTS idx_blog_categories_parent_id ON blog_categories(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_blog_categories_sort_order ON blog_categories(sort_order)',
    // 博客文章-标签关联表索引
    'CREATE INDEX IF NOT EXISTS idx_blog_post_tags_post_id ON blog_post_tags(post_id)',
    'CREATE INDEX IF NOT EXISTS idx_blog_post_tags_tag_id ON blog_post_tags(tag_id)',
    // 访问日志表索引
    'CREATE INDEX IF NOT EXISTS idx_access_logs_user_id ON access_logs(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_access_logs_action ON access_logs(action)'
  ]

  indexes.forEach(sql => {
    try {
      database.exec(sql)
    } catch (error) {
      // 索引创建失败不影响应用运行
      console.log('[索引创建] 警告:', error.message)
    }
  })

  console.log('✓ 数据库索引创建完成')

  if (retireLegacyTestUser(database, process.env)) {
    console.warn('✓ 已移除旧版固定测试账号')
  }
  const createdOwner = initializeOwner(database, process.env)
  if (createdOwner) {
    console.log(`✓ Owner 用户已创建: ${createdOwner}`)
  }

  // 创建索引以提升查询速度
  console.log('创建数据库索引...')

  // 辅助函数：安全创建索引（检查字段是否存在）
  const createIndexIfFieldExists = (tableName, fieldName, indexName) => {
    try {
      // 检查字段是否存在
      const columns = database.pragma(`table_info(${tableName})`)
      const fieldExists = columns.some(col => col.name === fieldName)

      if (fieldExists) {
        database.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${fieldName})`)
        console.log(`✓ 创建索引: ${indexName}`)
      } else {
        console.log(`⚠ 跳过索引 ${indexName}（字段 ${fieldName} 不存在）`)
      }
    } catch (error) {
      console.log(`⚠ 创建索引 ${indexName} 失败:`, error.message)
    }
  }

  try {
    // 音乐表索引
    createIndexIfFieldExists('music', 'title', 'idx_music_title')
    createIndexIfFieldExists('music', 'artist', 'idx_music_artist')
    createIndexIfFieldExists('music', 'album', 'idx_music_album')
    createIndexIfFieldExists('music', 'created_at', 'idx_music_created_at')

    // 文档表索引（注意：是 category 不是 category_id）
    createIndexIfFieldExists('documents', 'title', 'idx_documents_title')
    createIndexIfFieldExists('documents', 'category', 'idx_documents_category')

    // 书籍表索引
    createIndexIfFieldExists('books', 'title', 'idx_books_title')
    createIndexIfFieldExists('books', 'created_at', 'idx_books_created_at')

    // 动漫表索引
    createIndexIfFieldExists('anime', 'title', 'idx_anime_title')
    createIndexIfFieldExists('anime', 'status', 'idx_anime_status')

    console.log('✓ 数据库索引创建完成')
  } catch (error) {
    console.log('⚠ 索引创建过程出错:', error.message)
  }

  console.log(`========== ${dbType} 数据库初始化完成 ==========\n`)
  return database
}

/**
 * 为测试数据库插入示例数据
 * @param {Database} testDb - 测试数据库实例
 */
function insertTestData(testDb) {
  // 检查是否已有数据
  const checkStmt = testDb.prepare('SELECT COUNT(*) as count FROM documents')
  const { count } = checkStmt.get()
  if (count > 0) {
    console.log('✓ 测试数据库已有数据，跳过示例数据插入')
    return
  }
  
  console.log('正在插入示例数据到测试数据库...')
  
  // ========== 文档管理示例数据 ==========
  const docCategories = [
    { name: '技术文档', parent_id: null, path: '技术文档', level: 0 },
    { name: '前端开发', parent_id: 1, path: '技术文档/前端开发', level: 1 },
    { name: '后端开发', parent_id: 1, path: '技术文档/后端开发', level: 1 },
    { name: '工作资料', parent_id: null, path: '工作资料', level: 0 },
    { name: '学习笔记', parent_id: null, path: '学习笔记', level: 0 }
  ]
  
  const catStmt = testDb.prepare(`
    INSERT INTO categories (name, parent_id, path, level) VALUES (?, ?, ?, ?)
  `)
  docCategories.forEach(cat => catStmt.run(cat.name, cat.parent_id, cat.path, cat.level))
  
  const documents = [
    { title: 'Vue3 开发指南.pdf', category: '技术文档', subcategory: '前端开发', tags: 'Vue,前端,框架', file_path: '/docs/vue3-guide.pdf' },
    { title: 'React 最佳实践.pdf', category: '技术文档', subcategory: '前端开发', tags: 'React,前端,框架', file_path: '/docs/react-best-practices.pdf' },
    { title: 'Node.js 性能优化.pdf', category: '技术文档', subcategory: '后端开发', tags: 'Node.js,后端,性能', file_path: '/docs/nodejs-performance.pdf' },
    { title: '2024年度工作总结.docx', category: '工作资料', subcategory: '', tags: '工作,总结', file_path: '/docs/work-summary-2024.docx' },
    { title: 'JavaScript 高级程序设计读书笔记.pdf', category: '学习笔记', subcategory: '', tags: 'JS,读书笔记', file_path: '/docs/js-advanced-notes.pdf' },
    { title: 'Python 数据分析入门.pdf', category: '学习笔记', subcategory: '', tags: 'Python,数据', file_path: '/docs/python-data-analysis.pdf' }
  ]
  
  const docStmt = testDb.prepare(`
    INSERT INTO documents (title, category, subcategory, tags, file_path) VALUES (?, ?, ?, ?, ?)
  `)
  documents.forEach(doc => docStmt.run(doc.title, doc.category, doc.subcategory, doc.tags, doc.file_path))
  
  // ========== 音乐管理示例数据 ==========
  const playlists = [
    { name: '我的最爱', description: '最常听的歌曲合集' },
    { name: '工作专注', description: '适合工作时听的轻音乐' },
    { name: '运动健身', description: '跑步健身时听的音乐' }
  ]
  
  const playlistStmt = testDb.prepare(`
    INSERT INTO playlists (name, description) VALUES (?, ?)
  `)
  playlists.forEach(p => playlistStmt.run(p.name, p.description))
  
  const music = [
    { title: '告白气球', artist: '周杰伦', album: '周杰伦的床边故事', duration: 215, file_type: 'mp3' },
    { title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, file_type: 'mp3' },
    { title: '演员', artist: '薛之谦', album: '初学者', duration: 257, file_type: 'mp3' },
    { title: '成都', artist: '赵雷', album: '无法长大', duration: 336, file_type: 'flac' },
    { title: '夜空中最亮的星', artist: '逃跑计划', album: '世界', duration: 252, file_type: 'mp3' },
    { title: '平凡之路', artist: '朴树', album: '猎户星座', duration: 301, file_type: 'flac' },
    { title: '起风了', artist: '买辣椒也用券', album: '起风了', duration: 313, file_type: 'mp3' },
    { title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223, file_type: 'mp3' }
  ]
  
  const musicStmt = testDb.prepare(`
    INSERT INTO music (title, artist, album, duration, file_type) VALUES (?, ?, ?, ?, ?)
  `)
  music.forEach(m => musicStmt.run(m.title, m.artist, m.album, m.duration, m.file_type))
  
  // 关联歌单和歌曲
  const playlistSongs = [
    { playlist_id: 1, music_id: 1 }, { playlist_id: 1, music_id: 2 }, { playlist_id: 1, music_id: 4 },
    { playlist_id: 2, music_id: 5 }, { playlist_id: 2, music_id: 6 },
    { playlist_id: 3, music_id: 3 }, { playlist_id: 3, music_id: 7 }, { playlist_id: 3, music_id: 8 }
  ]
  
  const psStmt = testDb.prepare(`
    INSERT INTO playlist_songs (playlist_id, music_id) VALUES (?, ?)
  `)
  playlistSongs.forEach(ps => psStmt.run(ps.playlist_id, ps.music_id))
  
  // 更新歌单歌曲数量
  testDb.exec(`
    UPDATE playlists SET song_count = (
      SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = playlists.id
    )
  `)
  
  // ========== 书籍管理示例数据 ==========
  const bookCategories = [
    { name: '技术书籍' }, { name: '小说文学' }, { name: '商业管理' }
  ]
  
  const bookCatStmt = testDb.prepare(`
    INSERT INTO book_categories (name) VALUES (?)
  `)
  bookCategories.forEach(bc => bookCatStmt.run(bc.name))
  
  const books = [
    { title: '深入理解计算机系统', author: 'Randal E. Bryant', year: '2016', publisher: '机械工业出版社', category_id: 1 },
    { title: '三体', author: '刘慈欣', year: '2008', publisher: '重庆出版社', category_id: 2 },
    { title: '百年孤独', author: '加西亚·马尔克斯', year: '2011', publisher: '南海出版公司', category_id: 2 },
    { title: '从0到1', author: '彼得·蒂尔', year: '2015', publisher: '中信出版社', category_id: 3 },
    { title: '人类简史', author: '尤瓦尔·赫拉利', year: '2014', publisher: '中信出版社', category_id: 3 }
  ]
  
  const bookStmt = testDb.prepare(`
    INSERT INTO books (title, author, year, publisher, category_id, file_path, total_pages) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  books.forEach(b => bookStmt.run(b.title, b.author, b.year, b.publisher, b.category_id, '/books/' + b.title + '.pdf', Math.floor(Math.random() * 500) + 100))
  
  // ========== 代码仓库示例数据 ==========
  const codeRepos = [
    { name: 'personal-resource-manager', url: 'https://github.com/demo/personal-resource-manager', description: '个人资源管理系统', local_path: '/code/personal-resource-manager' },
    { name: 'vue-admin-template', url: 'https://github.com/demo/vue-admin-template', description: 'Vue3 后台管理模板', local_path: '/code/vue-admin-template' },
    { name: 'rust-web-server', url: 'https://github.com/demo/rust-web-server', description: 'Rust 编写的 Web 服务器', local_path: '/code/rust-web-server' },
    { name: 'python-ml-examples', url: 'https://github.com/demo/python-ml-examples', description: 'Python 机器学习示例', local_path: '/code/python-ml-examples' },
    { name: 'go-microservices', url: 'https://github.com/demo/go-microservices', description: 'Go 微服务架构示例', local_path: '/code/go-microservices' }
  ]
  
  const codeStmt = testDb.prepare(`
    INSERT INTO code_repositories (name, url, description, local_path) VALUES (?, ?, ?, ?)
  `)
  codeRepos.forEach(c => codeStmt.run(c.name, c.url, c.description, c.local_path))
  
  // ========== 书签管理示例数据 ==========
  const bookmarks = [
    { title: 'GitHub', url: 'https://github.com', category: '开发工具', tags: 'git,代码托管' },
    { title: 'Stack Overflow', url: 'https://stackoverflow.com', category: '开发工具', tags: '问答,编程' },
    { title: 'Vue.js 官方文档', url: 'https://vuejs.org', category: '技术文档', tags: 'Vue,前端' },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org', category: '技术文档', tags: 'Web,文档' },
    { title: '掘金', url: 'https://juejin.cn', category: '技术社区', tags: '社区,前端' },
    { title: '知乎', url: 'https://www.zhihu.com', category: '知识社区', tags: '问答,知识' },
    { title: '哔哩哔哩', url: 'https://www.bilibili.com', category: '娱乐', tags: '视频,弹幕' },
    { title: '网易云音乐', url: 'https://music.163.com', category: '音乐', tags: '音乐,娱乐' }
  ]
  
  const bookmarkStmt = testDb.prepare(`
    INSERT INTO bookmarks (title, url, category, tags) VALUES (?, ?, ?, ?)
  `)
  bookmarks.forEach(b => bookmarkStmt.run(b.title, b.url, b.category, b.tags))
  
  // ========== 博客文章示例数据 ==========
  const blogCategories = [
    { name: '技术分享' }, { name: '生活随笔' }, { name: '读书笔记' }
  ]
  
  const blogCatStmt = testDb.prepare(`
    INSERT INTO blog_categories (name) VALUES (?)
  `)
  blogCategories.forEach(bc => blogCatStmt.run(bc.name))
  
  const blogPosts = [
    { title: '2024年前端技术趋势展望', content: '本文将探讨2024年前端领域的技术发展趋势...', category_id: 1, status: 'published' },
    { title: '我的2024年度总结', content: '回顾这一年，收获颇丰...', category_id: 2, status: 'published' },
    { title: '读完《代码大全》有感', content: '这是一本值得反复阅读的经典著作...', category_id: 3, status: 'draft' },
    { title: 'Vue3 Composition API 最佳实践', content: '分享一些使用 Composition API 的心得体会...', category_id: 1, status: 'published' },
    { title: '周末露营记', content: '上周末和朋友去郊外露营，天气很好...', category_id: 2, status: 'published' }
  ]
  
  const blogStmt = testDb.prepare(`
    INSERT INTO blog_posts (title, content, category_id, status) VALUES (?, ?, ?, ?)
  `)
  blogPosts.forEach(bp => blogStmt.run(bp.title, bp.content, bp.category_id, bp.status))
  
  // ========== 动漫管理示例数据 ==========
  const animeList = [
    { bangumi_id: 100444, title: '进击的巨人', name_cn: '进击的巨人', rating: 9.0, eps_total: 75, status: 'completed', air_date: '2013-04-07' },
    { bangumi_id: 160209, title: '鬼灭之刃', name_cn: '鬼灭之刃', rating: 8.8, eps_total: 26, status: 'completed', air_date: '2019-04-06' },
    { bangumi_id: 137722, title: 'Re:从零开始的异世界生活', name_cn: 'Re:从零开始的异世界生活', rating: 8.5, eps_total: 50, status: 'watching', air_date: '2016-04-04' },
    { bangumi_id: 278826, title: '咒术回战', name_cn: '咒术回战', rating: 8.3, eps_total: 24, status: 'completed', air_date: '2020-10-03' },
    { bangumi_id: 265, title: '钢之炼金术师', name_cn: '钢之炼金术师', rating: 9.2, eps_total: 64, status: 'completed', air_date: '2009-04-05' },
    { bangumi_id: 101960, title: '约定的梦幻岛', name_cn: '约定的梦幻岛', rating: 8.6, eps_total: 23, status: 'completed', air_date: '2019-01-10' },
    { bangumi_id: 292222, title: '间谍过家家', name_cn: '间谍过家家', rating: 8.1, eps_total: 25, status: 'watching', air_date: '2022-04-09' },
    { bangumi_id: 18652, title: '命运石之门', name_cn: '命运石之门', rating: 9.1, eps_total: 24, status: 'completed', air_date: '2011-04-06' }
  ]
  
  const animeStmt = testDb.prepare(`
    INSERT INTO anime (bangumi_id, title, name_cn, rating, eps_total, status, air_date) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  animeList.forEach(a => animeStmt.run(a.bangumi_id, a.title, a.name_cn, a.rating, a.eps_total, a.status, a.air_date))
  
  // ========== 游戏管理示例数据 ==========
  const games = [
    { steam_appid: 730, title: 'Counter-Strike 2', developers: 'Valve', publishers: 'Valve', release_date: '2023-09-27', status: 'playing', playtime_forever: 2580, metacritic_score: 88 },
    { steam_appid: 570, title: 'Dota 2', developers: 'Valve', publishers: 'Valve', release_date: '2013-07-09', status: 'completed', playtime_forever: 5200, metacritic_score: 90 },
    { steam_appid: 1623730, title: 'Palworld', developers: 'Pocketpair', publishers: 'Pocketpair', release_date: '2024-01-19', status: 'playing', playtime_forever: 680, metacritic_score: 75 },
    { steam_appid: 292030, title: 'The Witcher 3: Wild Hunt', developers: 'CD PROJEKT RED', publishers: 'CD PROJEKT RED', release_date: '2015-05-18', status: 'completed', playtime_forever: 8900, metacritic_score: 93 },
    { steam_appid: 1091500, title: 'Cyberpunk 2077', developers: 'CD PROJEKT RED', publishers: 'CD PROJEKT RED', release_date: '2020-12-10', status: 'playing', playtime_forever: 4500, metacritic_score: 86 },
    { steam_appid: 1245620, title: 'ELDEN RING', developers: 'FromSoftware', publishers: 'Bandai Namco', release_date: '2022-02-25', status: 'playing', playtime_forever: 3200, metacritic_score: 96 },
    { steam_appid: 359550, title: 'Tom Clancy\'s Rainbow Six Siege', developers: 'Ubisoft', publishers: 'Ubisoft', release_date: '2015-12-01', status: 'playing', playtime_forever: 1200, metacritic_score: 79 },
    { steam_appid: 1085660, title: 'Destiny 2', developers: 'Bungie', publishers: 'Bungie', release_date: '2019-10-01', status: 'completed', playtime_forever: 2100, metacritic_score: 83 }
  ]
  
  const gameStmt = testDb.prepare(`
    INSERT INTO games (steam_appid, title, developers, publishers, release_date, status, playtime_forever, metacritic_score) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  games.forEach(g => gameStmt.run(g.steam_appid, g.title, g.developers, g.publishers, g.release_date, g.status, g.playtime_forever, g.metacritic_score))
  
  // ========== 待办事项示例数据 ==========
  const todos = [
    { text: '完成项目文档编写', date: new Date().toISOString().split('T')[0], completed: 0, confirmed: 1 },
    { text: '学习 TypeScript 高级特性', date: new Date().toISOString().split('T')[0], completed: 0, confirmed: 1 },
    { text: '整理书架', date: new Date().toISOString().split('T')[0], completed: 1, confirmed: 1 },
    { text: '购买生活用品', date: new Date(Date.now() + 86400000).toISOString().split('T')[0], completed: 0, confirmed: 0 },
    { text: '预订餐厅', date: new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0], completed: 0, confirmed: 0 },
    { text: '完成代码审查', date: new Date().toISOString().split('T')[0], completed: 1, confirmed: 1 },
    { text: '回复邮件', date: new Date().toISOString().split('T')[0], completed: 0, confirmed: 1 },
    { text: '健身锻炼', date: new Date().toISOString().split('T')[0], completed: 1, confirmed: 1 }
  ]
  
  const todoStmt = testDb.prepare(`
    INSERT INTO todos (text, date, completed, confirmed) VALUES (?, ?, ?, ?)
  `)
  todos.forEach(t => todoStmt.run(t.text, t.date, t.completed, t.confirmed))
  
  // ========== 私密文件示例数据 ==========
  const privateDocs = [
    { title: '个人财务记录.xlsx', size: 24576 },
    { title: '身份证复印件.pdf', size: 102400 },
    { title: '重要合同扫描件.pdf', size: 512000 }
  ]
  
  const privateStmt = testDb.prepare(`
    INSERT INTO private_documents (title, file_path, size) VALUES (?, ?, ?)
  `)
  privateDocs.forEach((pd, idx) => privateStmt.run(pd.title, `/private/doc${idx + 1}.${pd.title.split('.').pop()}`, pd.size))
  
  console.log('✓ 示例数据插入完成')
}

// 获取数据库实例
export { getDatabase, getDatabaseForRequest, initDatabase }
