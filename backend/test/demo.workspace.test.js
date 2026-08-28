import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import {
  createDemoResource,
  createDemoSession,
  deleteDemoResource,
  DEMO_SESSION_TTL_MS,
  DEMO_JOURNEYS,
  listDemoResources,
  resetDemoSession,
  resolveDemoSession,
  runDemoJourney,
  updateDemoResource
} from '../src/services/demoWorkspace.js'
import demoRoutes, { demoRequestBodyGuard } from '../src/routes/demo.js'

test('demo sessions are opaque, isolated and expire', () => {
  const now = 1_000_000
  const first = createDemoSession(now)
  const second = createDemoSession(now)

  assert.notEqual(first.token, second.token)
  assert.equal(first.token.includes(first.session.id), false)
  assert.ok(resolveDemoSession(first.token, now + 1))
  assert.equal(resolveDemoSession(first.token, now + DEMO_SESSION_TTL_MS), null)
})

test('demo overlay mutations never cross session boundaries', () => {
  const first = createDemoSession()
  const second = createDemoSession()
  const firstSession = resolveDemoSession(first.token)
  const secondSession = resolveDemoSession(second.token)

  const originalFirst = listDemoResources(firstSession, 'notes')
  const originalSecond = listDemoResources(secondSession, 'notes')
  assert.deepEqual(originalFirst.items, originalSecond.items)

  const created = createDemoResource(firstSession, 'notes', {
    title: '仅当前会话可见',
    content: 'temporary'
  })
  updateDemoResource(firstSession, 'notes', 'note-welcome', {
    title: '已在覆盖层修改'
  })
  deleteDemoResource(firstSession, 'notes', 'note-isolation')

  const changedFirst = listDemoResources(firstSession, 'notes')
  const unchangedSecond = listDemoResources(secondSession, 'notes')
  assert.equal(changedFirst.total, 2)
  assert.ok(changedFirst.items.some((item) => item.id === created.id))
  assert.equal(
    changedFirst.items.find((item) => item.id === 'note-welcome').title,
    '已在覆盖层修改'
  )
  assert.deepEqual(unchangedSecond.items, originalSecond.items)
})

test('reset discards overlay and restores immutable baseline', () => {
  const created = createDemoSession()
  const session = resolveDemoSession(created.token)
  const baseline = listDemoResources(session, 'bookmarks')

  deleteDemoResource(session, 'bookmarks', 'bookmark-docs')
  createDemoResource(session, 'bookmarks', {
    title: '临时书签',
    url: 'https://example.invalid/temporary'
  })
  assert.notDeepEqual(listDemoResources(session, 'bookmarks').items, baseline.items)

  resetDemoSession(session)
  assert.deepEqual(listDemoResources(session, 'bookmarks').items, baseline.items)
})

test('unsupported resource types are rejected without fallback access', () => {
  const created = createDemoSession()
  const session = resolveDemoSession(created.token)

  assert.throws(
    () => listDemoResources(session, 'production-database'),
    (error) => error.code === 'DEMO_TYPE_NOT_FOUND'
  )
})

test('four guided journeys return deterministic interaction, contract and evidence layers', () => {
  const created = createDemoSession()
  const session = resolveDemoSession(created.token)

  assert.deepEqual(DEMO_JOURNEYS.map((journey) => journey.id), [
    'discovery', 'answer', 'task', 'lifecycle'
  ])

  const discovery = runDemoJourney(session, 'discovery', { query: 'Worker 架构' })
  assert.equal(discovery.simulated, true)
  assert.match(discovery.retrievalMode, /FTS/)
  assert.ok(discovery.results.some((result) => result.type === 'documents'))
  assert.ok(discovery.evidence.productionContract)
  assert.ok(discovery.evidence.verification.length > 0)

  const refused = runDemoJourney(session, 'answer', { scenario: 'injection' })
  assert.equal(refused.status, 'refused')
  assert.equal(refused.citations.length, 0)
  assert.ok(refused.pipeline.includes('拒答'))

  const offline = runDemoJourney(session, 'task', { scenario: 'offline' })
  assert.ok(offline.states.includes('late_result_rejected'))
  assert.equal(offline.task.attempt, 2)

  createDemoResource(session, 'notes', { title: '旅程覆盖层' })
  const lifecycle = runDemoJourney(session, 'lifecycle')
  assert.ok(lifecycle.changedTypes.includes('notes'))
  assert.equal(lifecycle.overlayChanges, 1)
})

test('demo body guard rejects oversized, chunked and form requests before JSON parsing', () => {
  function invoke(headers) {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this },
      json(payload) { this.payload = payload; return this }
    }
    let continued = false
    demoRequestBodyGuard({ get: (name) => headers[name.toLocaleLowerCase()] }, response, () => { continued = true })
    return { response, continued }
  }

  assert.equal(invoke({ 'content-length': String(16 * 1024 + 1) }).response.statusCode, 413)
  assert.equal(invoke({ 'transfer-encoding': 'chunked' }).response.statusCode, 411)
  assert.equal(invoke({ 'content-type': 'multipart/form-data; boundary=x' }).response.statusCode, 415)
  assert.equal(invoke({ 'content-length': '128', 'content-type': 'application/json' }).continued, true)
})

test('demo routes require same-origin writes and enforce per-IP and answer limits', async (context) => {
  const app = express()
  app.set('trust proxy', 1)
  app.use('/api/demo', demoRequestBodyGuard)
  app.use(express.json({ limit: '16kb' }))
  app.use(cookieParser())
  app.use('/api/demo', demoRoutes)
  const server = app.listen(0, '127.0.0.1')
  context.after(() => server.close())
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const missingOrigin = await fetch(`${baseUrl}/api/demo/sessions`, { method: 'POST' })
  assert.equal(missingOrigin.status, 403)

  let cookie = ''
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${baseUrl}/api/demo/sessions`, {
      method: 'POST',
      headers: { origin: baseUrl, 'x-forwarded-for': `203.0.113.${index + 1}` }
    })
    assert.equal(response.status, 201)
    cookie = response.headers.get('set-cookie').split(';', 1)[0]
  }
  const limitedSession = await fetch(`${baseUrl}/api/demo/sessions`, {
    method: 'POST',
    headers: { origin: baseUrl, 'x-forwarded-for': '203.0.113.200' }
  })
  assert.equal(limitedSession.status, 429)
  assert.ok(limitedSession.headers.get('retry-after'))

  for (let index = 0; index < 6; index += 1) {
    const response = await fetch(`${baseUrl}/api/demo/journeys/answer/run`, {
      method: 'POST',
      headers: { origin: baseUrl, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'answer' })
    })
    assert.equal(response.status, 200)
  }
  const limitedAnswer = await fetch(`${baseUrl}/api/demo/journeys/answer/run`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'answer' })
  })
  assert.equal(limitedAnswer.status, 429)
  assert.equal((await limitedAnswer.json()).code, 'DEMO_SESSION_RATE_LIMITED')
})
