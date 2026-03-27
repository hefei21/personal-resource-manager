import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const dbPath = process.env.DB_PATH || path.join(process.env.DATA_PATH || '.', 'database', 'app.db')

console.log('数据库路径:', dbPath)

if (!fs.existsSync(dbPath)) {
  console.log('❌ 数据库文件不存在，请先启动后端服务初始化数据库')
  process.exit(1)
}

const db = new Database(dbPath)

try {
  console.log('\n🔍 检查 documents 表结构...')

  // 获取表结构
  const columns = db.prepare("PRAGMA table_info(documents)").all()
  console.log('当前字段:', columns.map(c => ({ name: c.name, type: c.type })))

  // 检查并添加 subcategory 字段
  const hasSubcategory = columns.some(col => col.name === 'subcategory')
  if (!hasSubcategory) {
    console.log('✅ 添加 subcategory 字段...')
    db.exec('ALTER TABLE documents ADD COLUMN subcategory TEXT')
    console.log('✓ subcategory 字段添加成功')
  } else {
    console.log('✓ subcategory 字段已存在')
  }

  // 检查 version 字段类型
  const versionCol = columns.find(col => col.name === 'version')
  if (versionCol) {
    console.log('version 字段当前类型:', versionCol.type)
    
    if (versionCol.type !== 'REAL') {
      console.log('⚠️  version 字段类型不是 REAL，需要修改...')
      
      // 创建新表
      console.log('创建新表结构...')
      db.exec(`
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

      // 迁移数据
      console.log('迁移数据...')
      const migrateStmt = db.prepare(`
        INSERT INTO documents_new (id, title, category, tags, file_path, version, created_at, updated_at)
        SELECT id, title, category, tags, file_path, 
          CASE 
            WHEN typeof(version) = 'integer' THEN CAST(version AS REAL)
            ELSE version
          END,
          created_at, updated_at
        FROM documents
      `)
      const result = migrateStmt.run()
      console.log(`迁移了 ${result.changes} 条记录`)

      // 删除旧表
      console.log('删除旧表...')
      db.exec('DROP TABLE documents')

      // 重命名新表
      console.log('重命名表...')
      db.exec('ALTER TABLE documents_new RENAME TO documents')
      console.log('✓ version 字段类型修改成功')
    } else {
      console.log('✓ version 字段类型正确')
    }
  } else {
    console.log('❌ version 字段不存在')
  }

  // 验证表结构
  console.log('\n🔍 验证更新后的表结构...')
  const newColumns = db.prepare("PRAGMA table_info(documents)").all()
  console.log('更新后字段:', newColumns.map(c => ({ name: c.name, type: c.type })))

  // 统计文档数量
  const count = db.prepare('SELECT COUNT(*) as count FROM documents').get()
  console.log(`\n📊 文档总数: ${count.count}`)

  console.log('\n✅ 数据库修复完成！')

} catch (error) {
  console.error('❌ 修复失败:', error)
  console.error('错误详情:', error.message)
  process.exit(1)
} finally {
  db.close()
}
