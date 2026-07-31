import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDemoResource,
  createDemoSession,
  deleteDemoResource,
  DEMO_SESSION_TTL_MS,
  listDemoResources,
  resetDemoSession,
  resolveDemoSession,
  updateDemoResource
} from '../src/services/demoWorkspace.js'

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
