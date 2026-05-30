/**
 * 访问日志表迁移脚本
 * 创建 access_logs 表用于存储用户访问日志
 */

import { getDatabase } from './src/config/database.js'

export async function migrate() {
  const db = getDatabase()
  
  try {
    // 检查表是否已存在
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='access_logs'"
    ).get()
    
    if (tableExists) {
      console.log('[迁移] access_logs 表已存在，跳过创建')
      return
    }
    
    // 创建访问日志表
    db.exec(`
      CREATE TABLE access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        method TEXT,
        path TEXT,
        query TEXT,
        status_code INTEGER,
        response_time INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    
    // 创建索引
    db.exec(`CREATE INDEX idx_access_logs_user_id ON access_logs(user_id)`)
    db.exec(`CREATE INDEX idx_access_logs_created_at ON access_logs(created_at)`)
    db.exec(`CREATE INDEX idx_access_logs_ip ON access_logs(ip_address)`)
    
    console.log('[迁移] access_logs 表创建成功')
  } catch (error) {
    console.error('[迁移] 访问日志表创建失败:', error)
    throw error
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => {
    console.log('迁移完成')
    process.exit(0)
  }).catch((error) => {
    console.error('迁移失败:', error)
    process.exit(1)
  })
}
