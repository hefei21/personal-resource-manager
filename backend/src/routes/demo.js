import express from 'express'
import {
  createDemoResource,
  createDemoSession,
  deleteDemoResource,
  DEMO_RESOURCE_TYPES,
  DEMO_SESSION_COOKIE,
  DEMO_SESSION_TTL_MS,
  getDemoSummary,
  listDemoResources,
  resetDemoSession,
  resolveDemoSession,
  revokeDemoSession,
  updateDemoResource
} from '../services/demoWorkspace.js'

const router = express.Router()

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

router.post('/sessions', (req, res) => {
  const previousToken = req.cookies?.[DEMO_SESSION_COOKIE]
  if (previousToken) revokeDemoSession(previousToken)

  const created = createDemoSession()
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

router.get('/session', requireDemoSession, (req, res) => {
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

router.post('/reset', requireDemoSession, (req, res) => {
  resetDemoSession(req.demoSession)
  res.json({
    message: '演示空间已恢复为初始状态',
    summary: getDemoSummary(req.demoSession)
  })
})

router.get('/summary', requireDemoSession, (req, res) => {
  res.json({ summary: getDemoSummary(req.demoSession) })
})

router.get('/resources/:type', requireDemoSession, (req, res) => {
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

router.post('/resources/:type', requireDemoSession, (req, res) => {
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

router.put('/resources/:type/:id', requireDemoSession, (req, res) => {
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

router.delete('/resources/:type/:id', requireDemoSession, (req, res) => {
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
