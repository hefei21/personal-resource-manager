import express from 'express'
import {
  createDemoResource,
  createDemoSession,
  deleteDemoResource,
  DEMO_JOURNEYS,
  DEMO_RESOURCE_TYPES,
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_TTL_MS,
  getDemoSummary,
  listDemoResources,
  resetDemoSession,
  resolveDemoSession,
  revokeDemoSession,
  runDemoJourney,
  updateDemoResource
} from '../services/demoWorkspace.js'
import { getSourceOrigin, isTrustedRequestOrigin } from '../middlewares/requestOrigin.js'

const router = express.Router()
const SESSION_WINDOW_MS = 10 * 60 * 1000
const MAX_SESSION_CREATIONS_PER_WINDOW = 3
const sessionCreationWindows = new Map()
const sessionOperationWindows = new Map()

export function demoRequestBodyGuard(req, res, next) {
  const length = Number(req.get('content-length') || 0)
  const transferEncoding = req.get('transfer-encoding')
  const contentType = req.get('content-type') || ''
  if (length > 16 * 1024) {
    return res.status(413).json({ message: '演示请求体不能超过 16 KB', code: 'DEMO_BODY_TOO_LARGE' })
  }
  if (transferEncoding && !req.get('content-length')) {
    return res.status(411).json({ message: '演示请求必须声明 Content-Length', code: 'DEMO_LENGTH_REQUIRED' })
  }
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(contentType)) {
    return res.status(415).json({ message: '演示空间只接受 JSON 请求', code: 'DEMO_JSON_ONLY' })
  }
  next()
}

function requireDemoRequestOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const sourceOrigin = getSourceOrigin(req)
  if (!sourceOrigin) return res.status(403).json({ message: '无法验证演示请求来源', code: 'ORIGIN_REQUIRED' })
  if (!isTrustedRequestOrigin(req, sourceOrigin)) {
    return res.status(403).json({ message: '演示请求来源不受信任', code: 'ORIGIN_FORBIDDEN' })
  }
  next()
}

function limitSessionCreation(req, res, next) {
  const now = Date.now()
  const trustProxyIp = String(process.env.DEMO_TRUST_PROXY_IP || '').toLocaleLowerCase() === 'true'
  const key = trustProxyIp ? req.ip : (req.socket?.remoteAddress || 'unknown')
  const current = sessionCreationWindows.get(key)
  if (!current || current.resetAt <= now) {
    sessionCreationWindows.set(key, { count: 1, resetAt: now + SESSION_WINDOW_MS })
    return next()
  }
  if (current.count >= MAX_SESSION_CREATIONS_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    res.set('Retry-After', String(retryAfter))
    return res.status(429).json({ message: '演示会话创建过于频繁，请稍后重试', code: 'DEMO_RATE_LIMITED' })
  }
  current.count += 1
  next()
}

function limitDemoSession(kind, maximum) {
  return (req, res, next) => {
    const now = Date.now()
    const key = `${req.demoSession.id}:${kind}`
    const current = sessionOperationWindows.get(key)
    if (!current || current.resetAt <= now) {
      sessionOperationWindows.set(key, { count: 1, resetAt: now + 60_000 })
      return next()
    }
    if (current.count >= maximum) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ message: '当前演示会话操作过于频繁', code: 'DEMO_SESSION_RATE_LIMITED' })
    }
    current.count += 1
    next()
  }
}

const limitDemoRead = limitDemoSession('read', 60)
const limitDemoWrite = limitDemoSession('write', 10)
const limitDemoAnswer = limitDemoSession('answer', 6)
function limitDemoJourney(req, res, next) {
  return req.params.journeyId === 'answer'
    ? limitDemoAnswer(req, res, next)
    : limitDemoRead(req, res, next)
}

router.use((req, res, next) => {
  const configured = String(process.env.DEMO_ENABLED || '').toLocaleLowerCase()
  const disabled = configured === 'false' || (process.env.NODE_ENV === 'production' && configured !== 'true')
  if (disabled) {
    return res.status(503).json({ message: '演示空间暂时关闭', code: 'DEMO_DISABLED' })
  }
  next()
})
router.use(requireDemoRequestOrigin)

function secureRequest(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https'
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureRequest(req),
    path: '/',
    maxAge: DEMO_SESSION_TTL_MS
  }
}

function clearCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureRequest(req),
    path: '/'
  }
}

function requireDemoSession(req, res, next) {
  const session = resolveDemoSession(req.cookies?.[DEMO_SESSION_COOKIE])
  if (!session) {
    return res.status(401).json({
      message: '演示会话不存在或已过期',
      code: 'DEMO_SESSION_REQUIRED'
    })
  }
  req.demoSession = session
  req.user = {
    id: session.id,
    username: '演示访客',
    principal: 'demo',
    isGuest: true
  }
  next()
}

router.post('/sessions', limitSessionCreation, (req, res) => {
  const previousToken = req.cookies?.[DEMO_SESSION_COOKIE]
  if (previousToken) revokeDemoSession(previousToken)

  let created
  try {
    created = createDemoSession()
  } catch (error) {
    if (error.code === 'DEMO_CAPACITY_REACHED') {
      res.set('Retry-After', '60')
      return res.status(503).json({ message: error.message, code: error.code })
    }
    throw error
  }
  res.cookie(DEMO_SESSION_COOKIE, created.token, cookieOptions(req))
  res.status(201).json({
    user: {
      id: created.session.id,
      username: '演示访客',
      principal: 'demo',
      isGuest: true
    },
    expiresAt: new Date(created.session.expiresAt).toISOString(),
    resourceTypes: DEMO_RESOURCE_TYPES
  })
})

router.get('/session', requireDemoSession, limitDemoRead, (req, res) => {
  res.json({
    authenticated: true,
    user: req.user,
    expiresAt: new Date(req.demoSession.expiresAt).toISOString()
  })
})

router.delete('/session', (req, res) => {
  revokeDemoSession(req.cookies?.[DEMO_SESSION_COOKIE])
  res.clearCookie(DEMO_SESSION_COOKIE, clearCookieOptions(req))
  res.json({ message: '演示会话已结束' })
})

router.post('/reset', requireDemoSession, limitDemoWrite, (req, res) => {
  resetDemoSession(req.demoSession)
  res.json({
    message: '演示空间已恢复为初始状态',
    summary: getDemoSummary(req.demoSession)
  })
})

router.get('/summary', requireDemoSession, limitDemoRead, (req, res) => {
  res.json({ summary: getDemoSummary(req.demoSession) })
})

router.get('/journeys', requireDemoSession, limitDemoRead, (req, res) => {
  res.json({ journeys: DEMO_JOURNEYS })
})

router.post('/journeys/:journeyId/run', requireDemoSession, limitDemoJourney, (req, res) => {
  try {
    res.json(runDemoJourney(req.demoSession, req.params.journeyId, req.body))
  } catch (error) {
    if (error.code === 'DEMO_JOURNEY_NOT_FOUND') {
      return res.status(404).json({ message: error.message, code: error.code })
    }
    throw error
  }
})

router.get('/resources/:type', requireDemoSession, limitDemoRead, (req, res) => {
  try {
    res.json(listDemoResources(req.demoSession, req.params.type, {
      query: req.query.query,
      page: req.query.page,
      pageSize: req.query.pageSize
    }))
  } catch (error) {
    if (error.code === 'DEMO_TYPE_NOT_FOUND') {
      return res.status(404).json({ message: error.message })
    }
    throw error
  }
})

router.post('/resources/:type', requireDemoSession, limitDemoWrite, (req, res) => {
  try {
    const title = String(req.body?.title || req.body?.name || '').trim()
    if (!title) return res.status(400).json({ message: '标题不能为空' })
    res.status(201).json(createDemoResource(req.demoSession, req.params.type, req.body))
  } catch (error) {
    if (error.code === 'DEMO_LIMIT_REACHED') {
      return res.status(429).json({ message: error.message })
    }
    if (error.code === 'DEMO_TYPE_NOT_FOUND') {
      return res.status(404).json({ message: error.message })
    }
    throw error
  }
})

router.put('/resources/:type/:id', requireDemoSession, limitDemoWrite, (req, res) => {
  try {
    const updated = updateDemoResource(
      req.demoSession,
      req.params.type,
      req.params.id,
      req.body
    )
    if (!updated) return res.status(404).json({ message: '演示资源不存在' })
    res.json(updated)
  } catch (error) {
    if (error.code === 'DEMO_TYPE_NOT_FOUND') {
      return res.status(404).json({ message: error.message })
    }
    throw error
  }
})

router.delete('/resources/:type/:id', requireDemoSession, limitDemoWrite, (req, res) => {
  try {
    if (!deleteDemoResource(req.demoSession, req.params.type, req.params.id)) {
      return res.status(404).json({ message: '演示资源不存在' })
    }
    res.json({ message: '已从当前演示会话移除' })
  } catch (error) {
    if (error.code === 'DEMO_TYPE_NOT_FOUND') {
      return res.status(404).json({ message: error.message })
    }
    throw error
  }
})

export default router
