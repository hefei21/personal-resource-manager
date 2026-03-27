import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken } from '../middlewares/auth.js'

const router = express.Router()

// 获取指定日期的待办事项
router.get('/', authenticateToken, (req, res) => {
  try {
    const { date } = req.query
    const db = getDatabase()
    
    let sql = 'SELECT id, text, date, completed, confirmed, created_at, updated_at FROM todos WHERE 1=1'
    const params = []
    
    if (date) {
      sql += ' AND date = ?'
      params.push(date)
    }
    
    sql += ' ORDER BY created_at ASC'
    
    const stmt = db.prepare(sql)
    const rows = stmt.all(params)
    res.json({ data: rows })
  } catch (error) {
    console.error('获取待办事项失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取月份范围内的待办事项
router.get('/month', authenticateToken, (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const db = getDatabase()
    
    let sql = 'SELECT id, text, date, completed, confirmed, created_at, updated_at FROM todos WHERE date >= ? AND date <= ? ORDER BY date, created_at ASC'
    const stmt = db.prepare(sql)
    const rows = stmt.all(startDate, endDate)
    res.json({ data: rows })
  } catch (error) {
    console.error('获取月份待办事项失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 创建待办事项
router.post('/', authenticateToken, (req, res) => {
  try {
    const { text, date, completed = 0, confirmed = 0 } = req.body
    const db = getDatabase()
    
    const stmt = db.prepare(
      'INSERT INTO todos (text, date, completed, confirmed) VALUES (?, ?, ?, ?)'
    )
    const result = stmt.run(text, date, completed ? 1 : 0, confirmed ? 1 : 0)
    res.json({ id: result.lastInsertRowid, message: '创建成功' })
  } catch (error) {
    console.error('创建待办事项失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新待办事项
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const { text, completed, confirmed } = req.body
    const db = getDatabase()
    
    const stmt = db.prepare(
      'UPDATE todos SET text = ?, completed = ?, confirmed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    )
    stmt.run(text, completed ? 1 : 0, confirmed ? 1 : 0, req.params.id)
    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新待办事项失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除待办事项
router.delete('/:id', authenticateToken, (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('DELETE FROM todos WHERE id = ?')
    stmt.run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除待办事项失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

export default router
