import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'

process.env.DATA_PATH ||= path.resolve(
  import.meta.dirname,
  '../../.codex/test-runtime/blog-authorization'
)

const { default: blogRouter } = await import('../src/routes/blog.js')

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/blog', blogRouter)

  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  try {
    const { port } = server.address()
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('every personal-note endpoint rejects anonymous access', async () => {
  await withServer(async (baseUrl) => {
    const requests = [
      ['GET', '/posts'],
      ['GET', '/posts/1'],
      ['POST', '/posts'],
      ['PUT', '/posts/1'],
      ['DELETE', '/posts/1'],
      ['GET', '/categories'],
      ['GET', '/categories/all'],
      ['POST', '/categories'],
      ['PUT', '/categories/1'],
      ['DELETE', '/categories/1'],
      ['GET', '/tags'],
      ['POST', '/tags'],
      ['PUT', '/tags/1'],
      ['DELETE', '/tags/1']
    ]

    for (const [method, route] of requests) {
      const response = await fetch(`${baseUrl}/api/blog${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}'
      })
      assert.equal(response.status, 401, `${method} ${route}`)
    }
  })
})

test('demo cookies never grant access to personal notes', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/blog/posts`, {
      headers: { cookie: 'pr_demo_session=opaque-demo-session' }
    })
    assert.equal(response.status, 401)
  })
})
