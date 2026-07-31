import express from 'express'
import bcrypt from 'bcryptjs'
import { getDatabase } from '../config/database.js'
import {
  authenticateToken,
  requireOwner
} from '../middlewares/auth.js'
import { loginLimiter } from '../middlewares/security.js'
import {
  OWNER_SESSION_COOKIE,
  clearOwnerSessionCookieOptions,
  createOwnerSession,
  ownerSessionCookieOptions,
  pruneOwnerSessions,
  revokeAllOwnerSessions,
  revokeOwnerSession
} from '../services/sessions.js'

const router = express.Router()

function getOwnerAuthDatabase() {
  return getDatabase({ user: { username: '__owner_auth__' } })
}

// 登录（应用严格的速率限制）
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, remember = false } = req.body

    console.log('登录请求:', { username })  // 只记录用户名，不记录密码

    if (!username || !password) {
      return res.status(400).json({ message: '用户名和密码不能为空' })
    }

    const db = getOwnerAuthDatabase()

    // 使用 better-sqlite3 的正确查询方式
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?')
    const user = stmt.get(username)

    if (!user) {
      console.log('登录失败: 用户名或密码错误', { username })
      return res.status(401).json({ message: '用户名或密码错误' })
    }

    const isMatch = await bcrypt.compare(password, user.password)
    
    if (!isMatch) {
      console.log('登录失败: 用户名或密码错误', { username })
      return res.status(401).json({ message: '用户名或密码错误' })
    }

    pruneOwnerSessions(db)
    const session = createOwnerSession(db, user, {
      remember: remember === true,
      userAgent: req.get('user-agent')
    })
    res.cookie(
      OWNER_SESSION_COOKIE,
      session.token,
      ownerSessionCookieOptions(req, remember === true)
    )

    console.log('登录成功', { username: user.username, userId: user.id })

    res.json({
      user: {
        id: user.id,
        username: user.username,
        principal: 'owner',
        isGuest: false
      }
    })
  } catch (error) {
    console.error('登录错误详情:', error)
    console.error('错误堆栈:', error.stack)
    // 生产环境不暴露错误详情
    res.status(500).json({ 
      message: '服务器错误',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    })
  }
})

// 登出
router.post('/logout', authenticateToken, (req, res) => {
  const sessionToken = req.cookies?.[OWNER_SESSION_COOKIE]
  if (sessionToken) {
    revokeOwnerSession(getOwnerAuthDatabase(), sessionToken)
  }
  res.clearCookie(
    OWNER_SESSION_COOKIE,
    clearOwnerSessionCookieOptions(req)
  )
  res.json({ message: '登出成功' })
})

// 检查认证状态
router.get('/check', authenticateToken, (req, res) => {
  res.json({ 
    authenticated: true, 
    user: req.user,
    principal: req.user.principal,
    isGuest: req.user.isGuest || false
  })
})

// 修改密码 - 仅管理员可用
router.post('/change-password', authenticateToken, requireOwner, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body
    const userId = req.user.id

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: '旧密码和新密码不能为空' })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: '新密码长度至少6位' })
    }

    const db = getOwnerAuthDatabase()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)

    if (!user) {
      return res.status(404).json({ message: '用户不存在' })
    }

    // 验证旧密码
    const isMatch = await bcrypt.compare(oldPassword, user.password)
    if (!isMatch) {
      return res.status(401).json({ message: '旧密码错误' })
    }

    // 加密新密码
    const hashedPassword = await bcrypt.hash(newPassword, 10)

    // 更新密码
    const updatePassword = db.transaction(() => {
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(
        hashedPassword,
        userId
      )
      revokeAllOwnerSessions(db, userId)
    })
    updatePassword()

    res.clearCookie(
      OWNER_SESSION_COOKIE,
      clearOwnerSessionCookieOptions(req)
    )
    res.json({
      message: '密码修改成功，请重新登录',
      reauthenticationRequired: true
    })
  } catch (error) {
    console.error('修改密码错误:', error)
    res.status(500).json({ message: '服务器错误', details: error.message })
  }
})

export default router
