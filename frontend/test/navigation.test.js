import test from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLICATION_NAVIGATION,
  GROUP_LANDING_NAVIGATION,
  MOBILE_BOTTOM_NAVIGATION,
  NAVIGATION_GROUPS,
  OWNER_NAVIGATION,
  PRIMARY_NAVIGATION,
  navigationForRoute,
  navigationItemsForGroup,
  navigationLandingForGroup,
  pageTitleForRoute,
  routeNavigationMeta
} from '../src/router/navigation.js'

const REQUIRED_FIELDS = [
  'routeName',
  'value',
  'path',
  'label',
  'title',
  'group',
  'pcIcon',
  'mobileIconPath',
  'mobile',
  'ownerOnly',
  'kind'
]

test('navigation registry has complete unique route identity', () => {
  for (const field of REQUIRED_FIELDS) {
    assert.ok(APPLICATION_NAVIGATION.every(item => item[field] !== undefined), field)
  }

  for (const field of ['routeName', 'value', 'path']) {
    const values = APPLICATION_NAVIGATION.map(item => item[field])
    assert.equal(new Set(values).size, values.length, `${field} must be unique`)
  }

  assert.ok(APPLICATION_NAVIGATION.every(item => NAVIGATION_GROUPS[item.group]))
})

test('confirmed information architecture labels and groups are registered', () => {
  const expected = {
    Dashboard: ['首页', 'home'],
    Search: ['统一搜索', 'workspace'],
    Documents: ['文档', 'library'],
    Blog: ['个人笔记', 'library'],
    Music: ['音频', 'library'],
    Books: ['电子书', 'library'],
    Code: ['代码知识库', 'library'],
    Bookmarks: ['书签', 'collection'],
    Anime: ['动漫', 'collection'],
    Games: ['游戏', 'collection'],
    Tasks: ['任务中心', 'workspace'],
    Logs: ['访问日志', 'system']
  }

  for (const [routeName, [label, group]] of Object.entries(expected)) {
    const item = navigationForRoute(routeName)
    assert.ok(item)
    assert.equal(item.label, label)
    assert.equal(item.title, label)
    assert.equal(item.group, group)
  }
})

test('owner and mobile boundaries keep logs out of mobile primary navigation', () => {
  const logs = navigationForRoute('Logs')

  assert.equal(logs.ownerOnly, true)
  assert.equal(logs.mobile, false)
  assert.ok(OWNER_NAVIGATION.includes(logs))
  assert.ok(!PRIMARY_NAVIGATION.includes(logs))
  assert.ok(PRIMARY_NAVIGATION.every(item => item.mobile && !item.ownerOnly))
})

test('group landings and mobile bottom navigation match the confirmed IA', () => {
  assert.equal(GROUP_LANDING_NAVIGATION.length, 5)
  assert.deepEqual(MOBILE_BOTTOM_NAVIGATION.map(item => item.label), [
    '首页', '资源库', '收藏', '工作台', '更多'
  ])
  assert.deepEqual(MOBILE_BOTTOM_NAVIGATION.map(item => item.path), [
    '/dashboard', '/library', '/collection', '/workspace', '/more'
  ])
  assert.equal(navigationLandingForGroup('library').routeName, 'LibraryHub')
  assert.equal(navigationLandingForGroup('system', { mobile: true }).routeName, 'MoreHub')
  assert.deepEqual(
    navigationItemsForGroup('workspace', { mobile: true }).map(item => item.routeName),
    ['Search', 'Tasks']
  )
  assert.deepEqual(navigationItemsForGroup('system'), [])
  assert.deepEqual(navigationItemsForGroup('system', { includeOwner: true }).map(item => item.routeName), ['Logs'])
})

test('route lookup and title fallback are deterministic', () => {
  const dashboard = navigationForRoute('Dashboard')

  assert.equal(navigationForRoute('dashboard'), dashboard)
  assert.equal(navigationForRoute('/dashboard'), dashboard)
  assert.equal(navigationForRoute({ name: 'Dashboard' }), dashboard)
  assert.equal(pageTitleForRoute('Dashboard'), '首页')
  assert.equal(pageTitleForRoute('UnknownRoute'), 'UnknownRoute')
  assert.equal(pageTitleForRoute(), '')
  assert.deepEqual(routeNavigationMeta('UnknownRoute'), {})

  const blogMeta = routeNavigationMeta('Blog')
  assert.equal(blogMeta.title, '个人笔记')
  assert.equal(blogMeta.group, 'library')
  assert.equal(blogMeta.navigation, navigationForRoute('Blog'))
})
