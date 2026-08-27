/**
 * Application navigation metadata.
 *
 * Routes remain the compatibility boundary for existing deep links.  This
 * registry owns the user-facing information architecture and the platform
 * visibility rules so layouts do not need to duplicate them.
 */

export const NAVIGATION_GROUPS = Object.freeze({
  home: Object.freeze({ key: 'home', label: '首页', order: 0 }),
  library: Object.freeze({ key: 'library', label: '资源库', order: 1 }),
  collection: Object.freeze({ key: 'collection', label: '收藏', order: 2 }),
  workspace: Object.freeze({ key: 'workspace', label: '工作台', order: 3 }),
  system: Object.freeze({ key: 'system', label: '系统', order: 4 })
})

const moduleItems = [
  {
    routeName: 'Dashboard',
    value: 'dashboard',
    path: '/dashboard',
    label: '首页',
    title: '首页',
    group: 'home',
    pcIcon: 'dashboard',
    mobileIconPath: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Search',
    value: 'search',
    path: '/search',
    label: '统一搜索',
    title: '统一搜索',
    group: 'workspace',
    pcIcon: 'search',
    mobileIconPath: 'M9.5 3a6.5 6.5 0 104.05 11.58L19.97 21 21 19.97l-6.42-6.42A6.5 6.5 0 009.5 3zm0 2a4.5 4.5 0 110 9 4.5 4.5 0 010-9z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Documents',
    value: 'documents',
    path: '/documents',
    label: '文档',
    title: '文档',
    group: 'library',
    pcIcon: 'file',
    mobileIconPath: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Blog',
    value: 'blog',
    path: '/blog',
    label: '个人笔记',
    title: '个人笔记',
    group: 'library',
    pcIcon: 'edit-1',
    mobileIconPath: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Music',
    value: 'music',
    path: '/music',
    label: '音频',
    title: '音频',
    group: 'library',
    pcIcon: 'music',
    mobileIconPath: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Books',
    value: 'books',
    path: '/books',
    label: '电子书',
    title: '电子书',
    group: 'library',
    pcIcon: 'book',
    mobileIconPath: 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Code',
    value: 'code',
    path: '/code',
    label: '代码知识库',
    title: '代码知识库',
    group: 'library',
    pcIcon: 'code',
    mobileIconPath: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Bookmarks',
    value: 'bookmarks',
    path: '/bookmarks',
    label: '书签',
    title: '书签',
    group: 'collection',
    pcIcon: 'bookmark',
    mobileIconPath: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Anime',
    value: 'anime',
    path: '/anime',
    label: '动漫',
    title: '动漫',
    group: 'collection',
    pcIcon: 'video',
    mobileIconPath: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Games',
    value: 'games',
    path: '/games',
    label: '游戏',
    title: '游戏',
    group: 'collection',
    pcIcon: 'gamepad',
    mobileIconPath: 'M15 7.5V2H9v5.5l3 3 3-3zM7.5 9H2v6h5.5l3-3-3-3zM9 16.5V22h6v-5.5l-3-3-3 3zM16.5 9l-3 3 3 3H22V9h-5.5z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Tasks',
    value: 'tasks',
    path: '/tasks',
    label: '任务中心',
    title: '任务中心',
    group: 'workspace',
    pcIcon: 'list-dashes',
    mobileIconPath: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z',
    mobile: true,
    ownerOnly: false,
    kind: 'module'
  },
  {
    routeName: 'Logs',
    value: 'logs',
    path: '/logs',
    label: '访问日志',
    title: '访问日志',
    group: 'system',
    pcIcon: 'chart',
    mobileIconPath: 'M5 9h3v10H5V9zm5.5-4h3v14h-3V5zM16 12h3v7h-3v-7z',
    mobile: false,
    ownerOnly: true,
    kind: 'module'
  }
]

const groupLandingItems = [
  {
    routeName: 'LibraryHub', value: 'library', path: '/library', label: '资源库', title: '资源库',
    group: 'library', pcIcon: 'folder',
    mobileIconPath: 'M4 4h6l2 2h8v14H4V4zm2 4v10h12V8H6z',
    mobile: true, ownerOnly: false, kind: 'group'
  },
  {
    routeName: 'CollectionHub', value: 'collection', path: '/collection', label: '收藏', title: '收藏',
    group: 'collection', pcIcon: 'star',
    mobileIconPath: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z',
    mobile: true, ownerOnly: false, kind: 'group'
  },
  {
    routeName: 'WorkspaceHub', value: 'workspace', path: '/workspace', label: '工作台', title: '工作台',
    group: 'workspace', pcIcon: 'list-dashes',
    mobileIconPath: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10-2h4v2h-4V4z',
    mobile: true, ownerOnly: false, kind: 'group'
  },
  {
    routeName: 'SystemHub', value: 'system', path: '/system', label: '系统', title: '系统',
    group: 'system', pcIcon: 'setting',
    mobileIconPath: 'M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.35 7.35 0 00-1.69-.98L15 3.27h-4l-.35 2.66c-.61.25-1.17.59-1.69.98l-2.49-1-2 3.46 2.11 1.65c-.05.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65 2 3.46 2.49-1c.52.4 1.08.73 1.69.98L11 20.73h4l.35-2.66c.61-.25 1.17-.58 1.69-.98l2.49 1 2-3.46-2.1-1.65zM13 15.5A3.5 3.5 0 1113 8a3.5 3.5 0 010 7.5z',
    mobile: false, ownerOnly: false, kind: 'group'
  },
  {
    routeName: 'MoreHub', value: 'more', path: '/more', label: '更多', title: '更多',
    group: 'system', pcIcon: 'more',
    mobileIconPath: 'M6 10a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4zm6 0a2 2 0 100 4 2 2 0 000-4z',
    mobile: true, ownerOnly: false, kind: 'group'
  }
]

export const APPLICATION_NAVIGATION = Object.freeze(
  [...moduleItems, ...groupLandingItems].map(item => Object.freeze(item))
)

export const PRIMARY_NAVIGATION = Object.freeze(
  APPLICATION_NAVIGATION.filter(item => item.kind === 'module' && !item.ownerOnly)
)

export const OWNER_NAVIGATION = Object.freeze(
  APPLICATION_NAVIGATION.filter(item => item.kind === 'module' && item.ownerOnly)
)

export const GROUP_LANDING_NAVIGATION = Object.freeze(
  APPLICATION_NAVIGATION.filter(item => item.kind === 'group')
)

export const MOBILE_BOTTOM_NAVIGATION = Object.freeze([
  APPLICATION_NAVIGATION.find(item => item.routeName === 'Dashboard'),
  ...['LibraryHub', 'CollectionHub', 'WorkspaceHub', 'MoreHub']
    .map(routeName => APPLICATION_NAVIGATION.find(item => item.routeName === routeName))
])

const byRouteName = new Map(APPLICATION_NAVIGATION.map(item => [item.routeName, item]))
const byValue = new Map(APPLICATION_NAVIGATION.map(item => [item.value, item]))
const byPath = new Map(APPLICATION_NAVIGATION.map(item => [item.path, item]))

function routeLookupCandidates(route) {
  if (typeof route === 'string') return [route]
  if (!route || typeof route !== 'object') return []
  return [route.routeName, route.name, route.value, route.path].filter(Boolean)
}

/** Resolve a navigation item from a route name, value, path, or route object. */
export function navigationForRoute(route) {
  for (const candidate of routeLookupCandidates(route)) {
    const item = byRouteName.get(candidate) || byValue.get(candidate) || byPath.get(candidate)
    if (item) return item
  }
  return undefined
}

/** Return the user-facing title, falling back to a supplied route name. */
export function pageTitleForRoute(route) {
  const item = navigationForRoute(route)
  if (item) return item.title
  if (typeof route === 'string') return route
  return route?.name || route?.routeName || ''
}

export function navigationItemsForGroup(group, { mobile = false, includeOwner = false } = {}) {
  return APPLICATION_NAVIGATION.filter(item => (
    item.kind === 'module' &&
    item.group === group &&
    (includeOwner || !item.ownerOnly) &&
    (!mobile || item.mobile)
  ))
}

export function navigationLandingForGroup(group, { mobile = false } = {}) {
  const routeName = mobile && group === 'system' ? 'MoreHub' : `${group[0]?.toUpperCase()}${group.slice(1)}Hub`
  return GROUP_LANDING_NAVIGATION.find(item => item.routeName === routeName)
}

/** Convert a navigation item into route metadata without exposing mutable state. */
export function routeNavigationMeta(route) {
  const item = navigationForRoute(route)
  if (!item) return {}
  return {
    ...item,
    navigation: item
  }
}
