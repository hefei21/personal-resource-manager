import crypto from 'node:crypto'

export const DEMO_SESSION_COOKIE = 'pr_demo_session'
export const DEMO_SESSION_TTL_MS = 30 * 60 * 1000

const MAX_ACTIVE_SESSIONS = 500
const MAX_RECORDS_PER_TYPE = 50
const MAX_FIELDS_PER_RECORD = 20
const MAX_STRING_LENGTH = 2_000
const sessions = new Map()

const baseline = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ id: 'doc-architecture', title: 'NAS 与 GPU Worker 架构说明', category: '项目文档', tags: ['架构', '演示'], fileType: 'markdown', size: 24576 }),
    Object.freeze({ id: 'doc-testing', title: '隔离测试与发布清单', category: '工程实践', tags: ['测试', 'CI/CD'], fileType: 'txt', size: 8192 })
  ]),
  books: Object.freeze([
    Object.freeze({ id: 'book-rag', title: '检索增强生成实践', author: 'Synthetic Author', category: '技术', progress: 42 }),
    Object.freeze({ id: 'book-nas', title: '个人 NAS 运维手册', author: 'Demo Studio', category: '工具', progress: 18 })
  ]),
  music: Object.freeze([
    Object.freeze({ id: 'music-focus', title: 'Focus Loop', artist: 'Synthetic Audio', album: 'Demo Sessions', duration: 186 }),
    Object.freeze({ id: 'music-night', title: 'NAS at Night', artist: 'Synthetic Audio', album: 'Demo Sessions', duration: 214 })
  ]),
  code: Object.freeze([
    Object.freeze({ id: 'code-prm', name: 'personal-resource-manager', language: 'Vue / Node.js', description: '个人数字资源管理与智能检索项目' }),
    Object.freeze({ id: 'code-worker', name: 'gpu-worker-sample', language: 'Python', description: '可离线 GPU Worker 协议示例' })
  ]),
  bookmarks: Object.freeze([
    Object.freeze({ id: 'bookmark-docs', title: '项目架构文档', url: 'https://example.invalid/architecture', category: '项目' }),
    Object.freeze({ id: 'bookmark-ci', title: 'CI 构建记录', url: 'https://example.invalid/ci', category: '工程' })
  ]),
  anime: Object.freeze([
    Object.freeze({ id: 'anime-one', title: 'Synthetic Journey', status: 'watching', rating: 8.2 }),
    Object.freeze({ id: 'anime-two', title: 'Container Days', status: 'planned', rating: 7.9 })
  ]),
  games: Object.freeze([
    Object.freeze({ id: 'game-one', title: 'Demo Factory', status: 'playing', playtime: 1260 }),
    Object.freeze({ id: 'game-two', title: 'NAS Builder', status: 'completed', playtime: 2840 })
  ]),
  notes: Object.freeze([
    Object.freeze({ id: 'note-welcome', title: '欢迎来到演示空间', content: '这里的修改只在当前演示会话中生效，并会自动过期。', completed: false }),
    Object.freeze({ id: 'note-isolation', title: '验证隔离覆盖层', content: '尝试新增、修改或删除条目，然后点击重置。', completed: true })
  ])
})

export const DEMO_RESOURCE_TYPES = Object.freeze(Object.keys(baseline))

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function clone(value) {
  return structuredClone(value)
}

function sanitizeInput(input) {
  const output = {}
  const entries = Object.entries(input || {}).slice(0, MAX_FIELDS_PER_RECORD)
  for (const [key, value] of entries) {
    if (key === 'id' || key === '__proto__' || key === 'constructor') continue
    if (typeof value === 'string') {
      output[key] = value.slice(0, MAX_STRING_LENGTH)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      output[key] = value
    } else if (Array.isArray(value)) {
      output[key] = value
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 20)
        .map((item) => typeof item === 'string'
          ? item.slice(0, MAX_STRING_LENGTH)
          : item)
    }
  }
  return output
}

function requireType(type) {
  if (!DEMO_RESOURCE_TYPES.includes(type)) {
    const error = new Error('不支持的演示资源类型')
    error.code = 'DEMO_TYPE_NOT_FOUND'
    throw error
  }
}

function newOverlay() {
  return {
    records: new Map(),
    deleted: new Set()
  }
}

export function pruneDemoSessions(now = Date.now()) {
  for (const [hash, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(hash)
  }
  if (sessions.size <= MAX_ACTIVE_SESSIONS) return

  const oldest = [...sessions.entries()]
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, sessions.size - MAX_ACTIVE_SESSIONS)
  for (const [hash] of oldest) sessions.delete(hash)
}

export function createDemoSession(now = Date.now()) {
  pruneDemoSessions(now)
  const token = crypto.randomBytes(32).toString('base64url')
  const session = {
    id: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + DEMO_SESSION_TTL_MS,
    lastSeenAt: now,
    overlays: new Map()
  }
  sessions.set(tokenHash(token), session)
  return {
    token,
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }
  }
}

export function resolveDemoSession(token, now = Date.now()) {
  if (!token) return null
  const hash = tokenHash(token)
  const session = sessions.get(hash)
  if (!session || session.expiresAt <= now) {
    sessions.delete(hash)
    return null
  }
  session.lastSeenAt = now
  return session
}

export function revokeDemoSession(token) {
  if (token) sessions.delete(tokenHash(token))
}

export function resetDemoSession(session) {
  session.overlays.clear()
}

function overlayFor(session, type) {
  let overlay = session.overlays.get(type)
  if (!overlay) {
    overlay = newOverlay()
    session.overlays.set(type, overlay)
  }
  return overlay
}

export function listDemoResources(session, type, options = {}) {
  requireType(type)
  const overlay = overlayFor(session, type)
  const merged = new Map(baseline[type].map((record) => [record.id, clone(record)]))

  for (const id of overlay.deleted) merged.delete(id)
  for (const [id, record] of overlay.records) merged.set(id, clone(record))

  const query = String(options.query || '').trim().toLocaleLowerCase()
  const allItems = [...merged.values()].filter((record) => {
    if (!query) return true
    return JSON.stringify(record).toLocaleLowerCase().includes(query)
  })
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 20, 1), 100)
  const page = Math.max(Number(options.page) || 1, 1)
  const start = (page - 1) * pageSize

  return {
    items: allItems.slice(start, start + pageSize),
    total: allItems.length,
    page,
    pageSize
  }
}

export function createDemoResource(session, type, input) {
  requireType(type)
  if (listDemoResources(session, type, { pageSize: 100 }).total >= MAX_RECORDS_PER_TYPE) {
    const error = new Error('当前演示资源已达到会话上限')
    error.code = 'DEMO_LIMIT_REACHED'
    throw error
  }
  const overlay = overlayFor(session, type)
  const id = `demo-${crypto.randomUUID()}`
  const record = {
    ...sanitizeInput(input),
    id,
    demoCreated: true
  }
  overlay.records.set(id, record)
  return clone(record)
}

export function updateDemoResource(session, type, id, input) {
  requireType(type)
  const current = listDemoResources(session, type, { pageSize: 100 })
    .items.find((record) => record.id === id)
  if (!current) return null

  const record = {
    ...current,
    ...sanitizeInput(input),
    id,
    demoUpdated: true
  }
  const overlay = overlayFor(session, type)
  overlay.deleted.delete(id)
  overlay.records.set(id, record)
  return clone(record)
}

export function deleteDemoResource(session, type, id) {
  requireType(type)
  const exists = listDemoResources(session, type, { pageSize: 100 })
    .items.some((record) => record.id === id)
  if (!exists) return false

  const overlay = overlayFor(session, type)
  overlay.records.delete(id)
  overlay.deleted.add(id)
  return true
}

export function getDemoSummary(session) {
  return Object.fromEntries(
    DEMO_RESOURCE_TYPES.map((type) => [
      type,
      listDemoResources(session, type, { pageSize: 1 }).total
    ])
  )
}

export function demoSessionCountForTests() {
  return sessions.size
}
