import express from 'express'
import bcrypt from 'bcryptjs'
import { getDatabase } from '../config/database.js'
import { authenticateToken, generateToken } from '../middlewares/auth.js'

const router = express.Router()

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body

    console.log('登录请求:', { username, password })

    if (!username || !password) {
      return res.status(400).json({ message: '用户名和密码不能为空' })
    }

    const db = getDatabase()
    console.log('数据库连接成功:', db)

    // 使用 better-sqlite3 的正确查询方式
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?')
    const user = stmt.get(username)
    console.log('查询用户结果:', user)

    if (!user) {
      console.log('用户不存在:', username)
      return res.status(401).json({ message: '用户名或密码错误' })
    }

    console.log('用户密码哈希:', user.password)
    const isMatch = bcrypt.compareSync(password, user.password)
    console.log('密码匹配结果:', isMatch)
    
    if (!isMatch) {
      console.log('密码不匹配')
      return res.status(401).json({ message: '用户名或密码错误' })
    }

    const token = generateToken(user)
    console.log('生成的 token:', token)

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username
      }
    })
  } catch (error) {
    console.error('登录错误详情:', error)
    console.error('错误堆栈:', error.stack)
    res.status(500).json({ message: '服务器错误', details: error.message })
  }
})

// 登出
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: '登出成功' })
})

// 检查认证状态
router.get('/check', authenticateToken, (req, res) => {
  res.json({ authenticated: true, user: req.user })
})

export default router
