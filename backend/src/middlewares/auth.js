import jwt from 'jsonwebtoken'
import { runWithContext } from '../utils/dbContext.js'
import { getDatabase, setCurrentReq } from '../config/database.js'
import {
  OWNER_SESSION_COOKIE,
  resolveOwnerSession
} from '../services/sessions.js'

// 强制从环境变量读取JWT密钥，拒绝使用默认值
const JWT_SECRET = process.env.JWT_SECRET
export const PRINCIPALS = Object.freeze({
  OWNER: 'owner',
  DEMO: 'demo'
})

function getOwnerAuthDatabase() {
  return getDatabase({ user: { username: '__owner_auth__' } })
}

if (!JWT_SECRET) {
  console.error('错误: JWT_SECRET 环境变量未设置')
  console.error('请在 .env 文件或环境变量中设置 JWT_SECRET')
  console.error('示例: JWT_SECRET=your-random-secret-key-at-least-32-characters')
  process.exit(1)
}

if (JWT_SECRET === 'your-secret-key' || JWT_SECRET.length < 32) {
  console.error('错误: JWT_SECRET 不能使用默认值或太短')
  console.error('请设置一个至少32个字符的随机字符串')
  process.exit(1)
}

function attachPrincipal(req, res, next, user, auth) {
  const principal = user.principal ||
    (user.isGuest ? PRINCIPALS.DEMO : PRINCIPALS.OWNER)
  req.user = {
    ...user,
    principal,
    isGuest: principal === PRINCIPALS.DEMO
  }
  req.auth = auth

  setCurrentReq(req)
  res.on('finish', () => {
    setCurrentReq(null)
  })

  const context = {
    username: req.user.username || null,
    userId: req.user.id || null,
    principal,
    isGuest: req.user.isGuest,
    req
  }

  runWithContext(context, next)
}

export function authenticateToken(req, res, next) {
  const sessionToken = req.cookies?.[OWNER_SESSION_COOKIE]
  if (sessionToken) {
    try {
      const session = resolveOwnerSession(getOwnerAuthDatabase(), sessionToken)
      if (!session) {
        return res.status(401).json({
          message: '会话已过期，请重新登录',
          code: 'SESSION_INVALID'
        })
      }
      return attachPrincipal(req, res, next, session.user, {
        type: 'owner_session',
        tokenHash: session.tokenHash
      })
    } catch (error) {
      console.error('验证服务端会话失败:', error.message)
      return res.status(500).json({ message: '认证服务暂不可用' })
    }
  }

  // 优先从 Authorization 头获取 token，其次从 URL 参数获取
  const authHeader = req.headers['authorization']
  let token = authHeader && authHeader.split(' ')[1]
  
  // 如果头中没有，尝试从 URL 参数获取
  if (!token && req.query.token) {
    token = req.query.token
  }

  if (!token) {
    return res.status(401).json({ message: '需要认证' })
  }

  try {
    const user = jwt.verify(token, JWT_SECRET)
    return attachPrincipal(req, res, next, user, {
      type: req.query.token ? 'legacy_query_jwt' : 'legacy_bearer_jwt'
    })
  } catch {
    return res.status(403).json({ message: '无效的令牌' })
  }
}

/**
 * 要求写权限 - 拒绝游客的所有写操作
 * 必须在 authenticateToken 之后使用
 */
export function requireWritePermission(req, res, next) {
  return requireOwner(req, res, next)
}

/**
 * Require the authenticated data owner.
 * Legacy non-guest tokens are normalized to owner by authenticateToken.
 */
export function requireOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: '需要认证' })
  }
  
  if (req.user.principal !== PRINCIPALS.OWNER) {
    return res.status(403).json({ 
      message: '仅资源所有者可执行此操作',
      code: 'OWNER_REQUIRED'
    })
  }
  
  next()
}

export function generateToken(user, isGuest = false) {
  const principal = isGuest ? PRINCIPALS.DEMO : PRINCIPALS.OWNER
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username,
      principal,
      isGuest: principal === PRINCIPALS.DEMO
    },
    JWT_SECRET,
    { expiresIn: isGuest ? '24h' : (process.env.JWT_EXPIRE || '30d') }  // 游客 token 24小时，普通用户30天
  )
}
