/**
 * 迁移脚本：删除 reading_progress 表的旧字段
 * - 删除 character_offset 字段
 * - 删除 current_chapter 字段
 * 
 * 运行方式：node backend/migrations/remove_old_progress_fields.js
 */

const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, '../data/books.db')

function migrate() {
  console.log('🗑️ 开始删除旧进度管理字段...')
  
  const db = new Database(DB_PATH)
  
  try {
    // 开始事务
    db.exec('BEGIN TRANSACTION')
    
    // 检查表是否存在
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_progress'").get()
    if (!tableCheck) {
      console.log('⚠️ reading_progress 表不存在，跳过迁移')
      db.exec('COMMIT')
      return
    }
    
    // 获取当前表结构
    const columns = db.prepare("PRAGMA table_info(reading_progress)").all()
    const columnNames = columns.map(c => c.name)
    console.log('📋 当前表字段:', columnNames.join(', '))
    
    // 检查是否需要迁移
    const hasCharacterOffset = columnNames.includes('character_offset')
    const hasCurrentChapter = columnNames.includes('current_chapter')
    
    if (!hasCharacterOffset && !hasCurrentChapter) {
      console.log('✅ 旧字段已删除，无需迁移')
      db.exec('COMMIT')
      return
    }
    
    console.log('🗑️ 删除旧字段: character_offset, current_chapter')
    
    // SQLite 不支持直接删除列，需要重建表
    // 1. 创建新表（不包含旧字段）
    db.exec(`
      CREATE TABLE reading_progress_new (
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
      )
    `)
    
    // 2. 复制数据（旧字段数据丢弃，进度重置为0）
    db.exec(`
      INSERT INTO reading_progress_new (
        id, book_id, user_id, current_page, cfi, progress, font_size, created_at, updated_at
      )
      SELECT 
        id, book_id, user_id, 0, NULL, 0, 
        COALESCE(font_size, 16), 
        created_at, 
        updated_at
      FROM reading_progress
    `)
    
    // 3. 删除旧表
    db.exec('DROP TABLE reading_progress')
    
    // 4. 重命名新表
    db.exec('ALTER TABLE reading_progress_new RENAME TO reading_progress')
    
    // 5. 创建索引
    db.exec('CREATE INDEX IF NOT EXISTS idx_reading_progress_book_id ON reading_progress(book_id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_reading_progress_user_id ON reading_progress(user_id)')
    
    // 提交事务
    db.exec('COMMIT')
    
    console.log('✅ 迁移完成！')
    console.log('📊 数据说明：')
    console.log('  - 所有书籍的阅读进度已重置为0（从头开始）')
    console.log('  - 字体大小设置已保留')
    console.log('  - 创建/更新时间已保留')
    
    // 验证新表结构
    const newColumns = db.prepare("PRAGMA table_info(reading_progress)").all()
    console.log('📋 新表字段:', newColumns.map(c => c.name).join(', '))
    
  } catch (error) {
    db.exec('ROLLBACK')
    console.error('❌ 迁移失败:', error)
    throw error
  } finally {
    db.close()
  }
}

// 执行迁移
migrate().catch(console.error)
