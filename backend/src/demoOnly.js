import express from 'express'
import cookieParser from 'cookie-parser'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { securityHeaders } from './middlewares/security.js'
import demoRoutes, { demoRequestBodyGuard } from './routes/demo.js'

const DEFAULT_MAX_INFLIGHT = 32

function parseMaxInflight(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 128
    ? parsed
    : DEFAULT_MAX_INFLIGHT
}

export function createDemoOnlyApp({ maxInflight = parseMaxInflight(process.env.DEMO_MAX_INFLIGHT) } = {}) {
  const app = express()
  let inflight = 0

  app.disable('x-powered-by')
  if (String(process.env.DEMO_TRUST_PROXY_IP || '').toLocaleLowerCase() === 'true') {
    app.set('trust proxy', 1)
  }
  app.use(securityHeaders)
  app.use((_request, response, next) => {
    if (inflight >= maxInflight) {
      response.set('Retry-After', '1')
      return response.status(503).json({
        message: '演示空间当前繁忙，请稍后重试',
        code: 'DEMO_BUSY'
      })
    }
    inflight += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      inflight = Math.max(0, inflight - 1)
    }
    response.once('finish', release)
    response.once('close', release)
    next()
  })
  app.use(cookieParser())
  app.use('/api/demo', demoRequestBodyGuard)
  app.use(express.json({ limit: '16kb' }))

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', mode: 'demo-only' })
  })
  app.use('/api/demo', demoRoutes)
  app.use((_request, response) => {
    response.status(404).json({ message: 'Not found', code: 'DEMO_ROUTE_NOT_FOUND' })
  })

  return app
}

export function startDemoOnlyServer({ port = Number(process.env.PORT || 3000) } = {}) {
  return createDemoOnlyApp().listen(port, () => {
    console.log(`Demo-only server listening on port ${port}`)
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startDemoOnlyServer()
}
