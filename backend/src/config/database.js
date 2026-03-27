import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'

const dbPath = process.env.DB_PATH || path.join(process.env.DATA_PATH, 'database', 'app.db')
const dbDir = path.dirname(dbPath)

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

// 获取数据库连接（同步）
let db = null

function getDatabase() {
  if (!db) {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    console.log(`数据库已连接: ${dbPath}`)
  }
  return db
}

// 初始化数据库表
function initDatabase() {
  const database = getDatabase()

  // 先创建所有表
  const tables = [
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
    `CREATE TABLE IF NOT EXISTS music (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration INTEGER DEFAULT 0,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      file_type TEXT,
      cover_image TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

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
      local_path TEXT NOT NULL,
      type TEXT DEFAULT 'git',
      last_sync TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,

    // 书签表
    `CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      description TEXT,
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
    `CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      year TEXT,
      publisher TEXT,
      isbn TEXT,
      description TEXT,
      cover_image TEXT,
      category_id INTEGER,
      file_path TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER DEFAULT 0,
      total_pages INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_read_at DATETIME,
      FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE SET NULL
    )`,

    // 阅读进度表
    `CREATE TABLE IF NOT EXISTS reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL UNIQUE,
      current_page INTEGER DEFAULT 0,
      current_chapter TEXT,
      progress REAL DEFAULT 0,
      font_size INTEGER DEFAULT 16,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    )`,

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
    )`
  ]

  tables.forEach(sql => {
    database.exec(sql)
  })

  // 创建索引以优化查询性能
  const indexes = [
    // 音乐表索引
    'CREATE INDEX IF NOT EXISTS idx_music_artist ON music(artist)',
    'CREATE INDEX IF NOT EXISTS idx_music_album ON music(album)',
    'CREATE INDEX IF NOT EXISTS idx_music_title ON music(title)',
    'CREATE INDEX IF NOT EXISTS idx_music_created_at ON music(created_at)',
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
    'CREATE INDEX IF NOT EXISTS idx_blog_post_tags_tag_id ON blog_post_tags(tag_id)'
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

  // 为现有数据库添加新字段（在表创建之后）
  try {
    // 检查并添加 subcategory 字段到 documents 表
    const columns = database.prepare("PRAGMA table_info(documents)").all()
    const hasSubcategory = columns.some(col => col.name === 'subcategory')

    if (!hasSubcategory) {
      console.log('添加 subcategory 字段到 documents 表...')
      database.exec('ALTER TABLE documents ADD COLUMN subcategory TEXT')
      console.log('✓ subcategory 字段添加成功')
    }

    // 检查 version 字段类型，如果不是 REAL 则修改
    const versionCol = columns.find(col => col.name === 'version')
    if (versionCol && versionCol.type !== 'REAL') {
      console.log('修改 version 字段类型为 REAL...')
      // SQLite 不支持直接修改列类型，需要重建表
      database.exec(`
        CREATE TABLE documents_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          category TEXT,
          subcategory TEXT,
          tags TEXT,
          file_path TEXT NOT NULL,
          version REAL DEFAULT 1.0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
      database.exec(`
        INSERT INTO documents_new (id, title, category, tags, file_path, version, created_at, updated_at)
        SELECT id, title, category, tags, file_path, CAST(version AS REAL), created_at, updated_at
        FROM documents
      `)
      database.exec('DROP TABLE documents')
      database.exec('ALTER TABLE documents_new RENAME TO documents')
      console.log('✓ version 字段类型修改成功')
    }

    // 检查并添加 sort_order 字段到 categories 表
    const categoryColumns = database.prepare("PRAGMA table_info(categories)").all()
    const hasSortOrder = categoryColumns.some(col => col.name === 'sort_order')

    if (!hasSortOrder) {
      console.log('添加 sort_order 字段到 categories 表...')
      database.exec('ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0')
      console.log('✓ sort_order 字段添加成功')
    }

    // 检查并添加 content_cache 字段到 books 表（用于缓存解析结果）
    const bookColumns = database.prepare("PRAGMA table_info(books)").all()
    const hasContentCache = bookColumns.some(col => col.name === 'content_cache')

    if (!hasContentCache) {
      console.log('添加 content_cache 字段到 books 表...')
      database.exec('ALTER TABLE books ADD COLUMN content_cache TEXT')
      console.log('✓ content_cache 字段添加成功')
    }

    // 检查并添加动漫表新字段
    const animeColumns = database.prepare("PRAGMA table_info(anime)").all()
    const animeNewFields = [
      { name: 'name_cn', sql: 'ALTER TABLE anime ADD COLUMN name_cn TEXT' },
      { name: 'name_original', sql: 'ALTER TABLE anime ADD COLUMN name_original TEXT' },
      { name: 'rating_count', sql: 'ALTER TABLE anime ADD COLUMN rating_count INTEGER DEFAULT 0' },
      { name: 'air_date', sql: 'ALTER TABLE anime ADD COLUMN air_date TEXT' },
      { name: 'eps', sql: 'ALTER TABLE anime ADD COLUMN eps INTEGER DEFAULT 0' },
      { name: 'eps_total', sql: 'ALTER TABLE anime ADD COLUMN eps_total INTEGER DEFAULT 0' },
      { name: 'author', sql: 'ALTER TABLE anime ADD COLUMN author TEXT' },
      { name: 'director', sql: 'ALTER TABLE anime ADD COLUMN director TEXT' },
      { name: 'studio', sql: 'ALTER TABLE anime ADD COLUMN studio TEXT' },
      { name: 'infobox', sql: 'ALTER TABLE anime ADD COLUMN infobox TEXT' },
      { name: 'characters', sql: 'ALTER TABLE anime ADD COLUMN characters TEXT' },
      { name: 'staff', sql: 'ALTER TABLE anime ADD COLUMN staff TEXT' },
      { name: 'user_rating', sql: 'ALTER TABLE anime ADD COLUMN user_rating INTEGER DEFAULT 0' }
    ]

    for (const field of animeNewFields) {
      const hasField = animeColumns.some(col => col.name === field.name)
      if (!hasField) {
        console.log(`添加 ${field.name} 字段到 anime 表...`)
        database.exec(field.sql)
        console.log(`✓ ${field.name} 字段添加成功`)
      }
    }

    // 检查并添加 icon 字段到 bookmarks 表
    const bookmarkColumns = database.prepare("PRAGMA table_info(bookmarks)").all()
    console.log('bookmarks 表当前字段:', bookmarkColumns.map(c => c.name).join(', '))
    
    const hasIcon = bookmarkColumns.some(col => col.name === 'icon')
    if (!hasIcon) {
      console.log('添加 icon 字段到 bookmarks 表...')
      database.exec('ALTER TABLE bookmarks ADD COLUMN icon TEXT')
      console.log('✓ icon 字段添加成功')
    } else {
      console.log('✓ icon 字段已存在')
    }
    
    // 检查并添加 icon_data 字段到 bookmarks 表（存储图标base64数据）
    const hasIconData = bookmarkColumns.some(col => col.name === 'icon_data')
    if (!hasIconData) {
      console.log('添加 icon_data 字段到 bookmarks 表...')
      database.exec('ALTER TABLE bookmarks ADD COLUMN icon_data TEXT')
      console.log('✓ icon_data 字段添加成功')
    }
    
    // 检查并添加 cover_image_data 字段到 anime 表（复用前面已声明的 animeColumns）
    console.log('anime 表当前字段:', animeColumns.map(c => c.name).join(', '))

    const hasCoverImageData = animeColumns.some(col => col.name === 'cover_image_data')
    if (!hasCoverImageData) {
      console.log('添加 cover_image_data 字段到 anime 表...')
      database.exec('ALTER TABLE anime ADD COLUMN cover_image_data TEXT')
      console.log('✓ cover_image_data 字段添加成功')
    }

    // 检查并添加成就字段到 games 表
    const gameColumns = database.prepare("PRAGMA table_info(games)").all()
    console.log('games 表当前字段:', gameColumns.map(c => c.name).join(', '))

    const gameNewFields = [
      { name: 'achievements_total', sql: 'ALTER TABLE games ADD COLUMN achievements_total INTEGER DEFAULT 0' },
      { name: 'achievements_completed', sql: 'ALTER TABLE games ADD COLUMN achievements_completed INTEGER DEFAULT 0' }
    ]

    for (const field of gameNewFields) {
      const hasField = gameColumns.some(col => col.name === field.name)
      if (!hasField) {
        console.log(`添加 ${field.name} 字段到 games 表...`)
        database.exec(field.sql)
        console.log(`✓ ${field.name} 字段添加成功`)
      }
    }

    // 检查并添加 music 表新字段（支持新版音乐管理）
    const musicColumns = database.prepare("PRAGMA table_info(music)").all()
    console.log('music 表当前字段:', musicColumns.map(c => c.name).join(', '))

    const musicNewFields = [
      { name: 'artist', sql: 'ALTER TABLE music ADD COLUMN artist TEXT' },
      { name: 'album', sql: 'ALTER TABLE music ADD COLUMN album TEXT' },
      { name: 'duration', sql: 'ALTER TABLE music ADD COLUMN duration INTEGER DEFAULT 0' },
      { name: 'file_size', sql: 'ALTER TABLE music ADD COLUMN file_size INTEGER DEFAULT 0' },
      { name: 'file_type', sql: 'ALTER TABLE music ADD COLUMN file_type TEXT' },
      { name: 'cover_image', sql: 'ALTER TABLE music ADD COLUMN cover_image TEXT' }
    ]

    for (const field of musicNewFields) {
      const hasField = musicColumns.some(col => col.name === field.name)
      if (!hasField) {
        console.log(`添加 ${field.name} 字段到 music 表...`)
        database.exec(field.sql)
        console.log(`✓ ${field.name} 字段添加成功`)
      }
    }

    // 检查并迁移代码仓库表结构
    const codeColumns = database.prepare("PRAGMA table_info(code_repositories)").all()
    console.log('code_repositories 表当前字段:', codeColumns.map(c => c.name).join(', '))

    const hasLocalPath = codeColumns.some(col => col.name === 'local_path')
    if (!hasLocalPath) {
      console.log('迁移代码仓库表结构...')
      // 删除旧表，创建新表
      database.exec(`
        CREATE TABLE code_repositories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          description TEXT,
          local_path TEXT NOT NULL DEFAULT '',
          type TEXT DEFAULT 'git',
          last_sync TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
      // 迁移数据
      database.exec(`
        INSERT INTO code_repositories_new (id, name, url, description, created_at, updated_at)
        SELECT id, name, url, description, created_at, updated_at FROM code_repositories
      `)
      database.exec('DROP TABLE code_repositories')
      database.exec('ALTER TABLE code_repositories_new RENAME TO code_repositories')
      console.log('✓ 代码仓库表结构迁移完成')
    }

    // 检查并添加 confirmed 字段到 todos 表
    const todosColumns = database.prepare("PRAGMA table_info(todos)").all()
    console.log('todos 表当前字段:', todosColumns.map(c => c.name).join(', '))
    
    const hasConfirmed = todosColumns.some(col => col.name === 'confirmed')
    if (!hasConfirmed) {
      console.log('添加 confirmed 字段到 todos 表...')
      database.exec('ALTER TABLE todos ADD COLUMN confirmed INTEGER DEFAULT 0')
      console.log('✓ confirmed 字段添加成功')
    }

    // 删除 code_versions 表（不再需要）
    try {
      database.exec('DROP TABLE IF EXISTS code_versions')
      console.log('✓ 已删除 code_versions 表')
    } catch (e) {
      // 表可能不存在，忽略错误
    }
  } catch (error) {
    console.error('数据库字段更新失败:', error)
    // 不中断程序，继续初始化
  }

  // 创建默认用户
  const defaultUsername = process.env.DEFAULT_USERNAME || 'admin'
  const defaultPassword = process.env.DEFAULT_PASSWORD || 'admin123'
  console.log(`创建默认用户: ${defaultUsername}, 密码: ${defaultPassword}`)

  const hashedPassword = bcrypt.hashSync(defaultPassword, 10)
  console.log('密码哈希:', hashedPassword)

  const stmt = database.prepare(
    `INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`
  )

  try {
    const result = stmt.run(defaultUsername, hashedPassword)
    console.log('插入用户结果:', result)
    console.log(`✓ 默认用户已创建: ${defaultUsername}`)
  } catch (error) {
    console.error('创建用户失败:', error)
    console.error('错误详情:', error.message)
  }

  // 初始化私密空间默认密码
  const defaultPrivatePassword = process.env.PRIVATE_PASSWORD || '123456'
  const hashedPrivatePassword = bcrypt.hashSync(defaultPrivatePassword, 10)
  const privateStmt = database.prepare(
    `INSERT OR IGNORE INTO private_settings (id, password) VALUES (1, ?)`
  )
  try {
    privateStmt.run(hashedPrivatePassword)
    console.log(`✓ 私密空间默认密码已设置: ${defaultPrivatePassword}`)
  } catch (error) {
    console.error('设置私密空间密码失败:', error)
  }

  return database
}

// 获取数据库实例
export { getDatabase, initDatabase }
