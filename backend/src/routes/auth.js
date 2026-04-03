import express from 'express'
import bcrypt from 'bcryptjs'
import { getDatabase } from '../config/database.js'
import { authenticateToken, generateToken, requireWritePermission } from '../middlewares/auth.js'

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

    const token = generateToken(user, false)  // 管理员登录，isGuest = false
    console.log('生成的 token:', token)

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        isGuest: false
      }
    })
  } catch (error) {
    console.error('登录错误详情:', error)
    console.error('错误堆栈:', error.stack)
    res.status(500).json({ message: '服务器错误', details: error.message })
  }
})

// 游客登录
router.post('/guest-login', (req, res) => {
  try {
    // 创建虚拟游客用户
    const guestUser = {
      id: 'guest',
      username: '游客'
    }
    
    const token = generateToken(guestUser, true)  // 游客登录，isGuest = true
    
    res.json({
      token,
      user: {
        id: 'guest',
        username: '游客',
        isGuest: true
      }
    })
  } catch (error) {
    console.error('游客登录错误:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 登出
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: '登出成功' })
})

// 检查认证状态
router.get('/check', authenticateToken, (req, res) => {
  res.json({ 
    authenticated: true, 
    user: req.user,
    isGuest: req.user.isGuest || false
  })
})

// 修改密码 - 仅管理员可用
router.post('/change-password', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body
    const userId = req.user.id

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: '旧密码和新密码不能为空' })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: '新密码长度至少6位' })
    }

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    // 验证旧密码
    const isMatch = bcrypt.compareSync(oldPassword, user.password)
    if (!isMatch) {
      return res.status(401).json({ message: '旧密码错误' })
    }

    // 加密新密码
    const hashedPassword = bcrypt.hashSync(newPassword, 10)

    // 更新密码
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, userId)

    res.json({ message: '密码修改成功' })
  } catch (error) {
    console.error('修改密码错误:', error)
    res.status(500).json({ message: '服务器错误', details: error.message })
  }
})

export default router
