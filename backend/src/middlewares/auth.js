import { runWithContext } from '../utils/dbContext.js'
import { getDatabase, setCurrentReq } from '../config/database.js'
import {
  OWNER_SESSION_COOKIE,
  resolveOwnerSession
} from '../services/sessions.js'

export const PRINCIPALS = Object.freeze({
  OWNER: 'owner',
  DEMO: 'demo'
})

function getOwnerAuthDatabase() {
  return getDatabase({ user: { username: '__owner_auth__' } })
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
  if (
    req.user?.principal === PRINCIPALS.OWNER &&
    req.auth?.type === 'owner_session'
  ) {
    return next()
  }

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

  return res.status(401).json({ message: '需要所有者会话' })
}

export function optionalAuthentication(req, res, next) {
  if (!req.cookies?.[OWNER_SESSION_COOKIE]) return next()
  return authenticateToken(req, res, next)
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
 * Production routes only accept a revocable owner session.
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
