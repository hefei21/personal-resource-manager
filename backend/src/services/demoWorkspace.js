import crypto from 'node:crypto'

export const DEMO_SESSION_COOKIE = 'pr_demo_session'
export const DEMO_SESSION_TTL_MS = 30 * 60 * 1000

const MAX_ACTIVE_SESSIONS = 100
const MAX_RECORDS_PER_TYPE = 50
const MAX_FIELDS_PER_RECORD = 20
const MAX_STRING_LENGTH = 2_000
const sessions = new Map()

export const DEMO_JOURNEYS = Object.freeze([
  Object.freeze({
    id: 'discovery',
    title: '跨资源发现',
    summary: '用一次查询定位文档、书籍、代码与个人笔记，并解释为什么命中。',
    expected: '看到资源类型、来源、定位信息和当前检索模式。',
    value: '证明统一搜索与 commit/章节定位不是多个列表的简单拼接。'
  }),
  Object.freeze({
    id: 'answer',
    title: '有证据的问答',
    summary: '比较正常回答、证据不足、提示注入和 Worker 离线四种确定性场景。',
    expected: '回答始终带引用；证据不足或越权请求会拒答。',
    value: '展示权限预过滤、Hybrid 检索、引用约束和 NAS 降级链路。'
  }),
  Object.freeze({
    id: 'task',
    title: '持久任务与恢复',
    summary: '观察任务成功和 Worker 失联后重新领取、拒绝迟到结果的状态线。',
    expected: '状态只按有限场景计算，不创建真实 Worker 任务。',
    value: '展示 lease、heartbeat、重试和幂等完成语义。'
  }),
  Object.freeze({
    id: 'lifecycle',
    title: '资源生命周期',
    summary: '修改合成资源、移入会话回收层、恢复基线并理解权威数据边界。',
    expected: '所有变化只属于当前会话，重置后完全消失。',
    value: '展示 staging、不可变原件、回收保护与可重建派生物。'
  })
])

const verificationEvidence = Object.freeze({
  discovery: Object.freeze(['FTS 与符号索引在 NAS 隔离环境回归通过', '代码结果绑定 commit 与行号定位']),
  answer: Object.freeze(['阶段 6C 完成 64 题受控评测', '引用、拒答、forbidden hits 与离线降级门均通过']),
  task: Object.freeze(['真实 NAS/PC 链路完成 clean、dirty、失联与恢复验收', '迟到 lease token 的结果被拒绝']),
  lifecycle: Object.freeze(['资源原件、不可变版本和回收保护已通过故障注入', '派生索引可重建且不替代权威数据'])
})

const baseline = Object.freeze({
  documents: Object.freeze([
    Object.freeze({ id: 'doc-architecture', title: 'NAS 与 GPU Worker 架构说明', category: '项目文档', tags: ['架构', '演示'], fileType: 'markdown', size: 24576 }),
    Object.freeze({ id: 'doc-testing', title: '隔离测试与发布清单', category: '工程实践', tags: ['测试', 'CI/CD'], fileType: 'txt', size: 8192 })
  ]),
  books: Object.freeze([
    Object.freeze({ id: 'book-rag', title: 'Worker 恢复架构与检索实践', author: 'Synthetic Author', category: '技术', progress: 42 }),
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
    Object.freeze({ id: 'note-isolation', title: 'Worker 恢复检查', content: '验证 Worker 离线、任务恢复与会话隔离覆盖层。', completed: true })
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
}

export function createDemoSession(now = Date.now()) {
  pruneDemoSessions(now)
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    const error = new Error('演示空间当前已满，请稍后重试')
    error.code = 'DEMO_CAPACITY_REACHED'
    throw error
  }
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

function journeyEvidence(id) {
  return {
    productionContract: {
      discovery: 'Owner 运行面先做权限过滤，再查询 NAS FTS、可选 Vector/Reranker 与 commit 绑定符号索引。',
      answer: 'Owner 运行面只组织已授权证据；模型、向量库或 Worker 离线时保留 NAS FTS 与可打开引用。',
      task: '生产任务持久化 attempt、lease、heartbeat 与输入指纹；旧 token 和迟到结果不能覆盖新状态。',
      lifecycle: '生产写入先 staging，再以 hash 和不可变版本提交；回收保护到期前可恢复，派生物可重建。'
    }[id],
    verification: verificationEvidence[id],
    boundary: '历史验收摘要，不是当前访客的实时生产状态。'
  }
}

function resultLocator(type, record) {
  const locators = {
    documents: '第 2 页 · 架构章节',
    books: '第 4 章 · 恢复设计',
    code: 'main@7f3a2c1 · src/worker.js:48',
    notes: '个人笔记 · 运维标签'
  }
  return locators[type] || record.category || '资源详情'
}

export function runDemoJourney(session, journeyId, input = {}, now = Date.now()) {
  const journey = DEMO_JOURNEYS.find((item) => item.id === journeyId)
  if (!journey) {
    const error = new Error('不支持的演示旅程')
    error.code = 'DEMO_JOURNEY_NOT_FOUND'
    throw error
  }

  if (journeyId === 'discovery') {
    const query = String(input.query || 'Worker 恢复架构').trim().slice(0, 80)
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const preferredTypes = ['documents', 'books', 'code', 'notes']
    let results = preferredTypes.flatMap((type) => listDemoResources(session, type, { pageSize: 50 }).items
      .filter((record) => {
        const text = JSON.stringify(record).toLocaleLowerCase()
        return terms.length === 0 || terms.some((term) => text.includes(term))
      })
      .map((record) => ({
        id: record.id,
        type,
        title: record.title || record.name,
        locator: resultLocator(type, record),
        source: type === 'code' ? 'commit 绑定符号索引' : 'NAS 合成语料',
        why: terms.length ? `命中查询词：${terms.filter((term) => JSON.stringify(record).toLocaleLowerCase().includes(term)).join('、')}` : '类型过滤命中'
      })))
    if (results.length === 0) {
      results = preferredTypes.flatMap((type) => listDemoResources(session, type, { pageSize: 1 }).items.map((record) => ({
        id: record.id,
        type,
        title: record.title || record.name,
        locator: resultLocator(type, record),
        source: type === 'code' ? 'commit 绑定符号索引' : 'NAS 合成语料',
        why: '合成演示使用可解释的类型回退结果'
      })))
    }
    return { journey, simulated: true, query, retrievalMode: 'NAS FTS + commit 绑定符号索引', results: results.slice(0, 6), evidence: journeyEvidence(journeyId) }
  }

  if (journeyId === 'answer') {
    const scenario = ['answer', 'unknown', 'injection', 'offline'].includes(input.scenario) ? input.scenario : 'answer'
    const outcomes = {
      answer: { status: 'answered', answer: 'NAS 保存权威数据；GPU Worker 可以离线。Worker 恢复后会重新领取到期任务，旧 lease 的迟到结果不会覆盖新状态。', mode: 'Hybrid + 可选 Reranker + 确定性模板', citations: ['NAS 与 GPU Worker 架构说明 · 第 2 页', '隔离测试与发布清单 · 恢复章节'] },
      unknown: { status: 'refused', answer: '现有合成证据不足，无法回答这个问题。', mode: '证据阈值拒答', citations: [] },
      injection: { status: 'refused', answer: '请求试图绕过证据与权限边界，已拒绝。', mode: '权限预过滤 + 提示注入门', citations: [] },
      offline: { status: 'answered', answer: 'Worker 离线时不执行生成或重排，但 NAS FTS 仍返回可打开的引用式结果。', mode: 'NAS FTS 降级（模拟）', citations: ['NAS 与 GPU Worker 架构说明 · 离线边界'] }
    }
    return { journey, simulated: true, scenario, ...outcomes[scenario], pipeline: ['权限预过滤', scenario === 'offline' ? 'NAS FTS' : 'FTS / Vector', scenario === 'offline' ? '跳过 Reranker' : 'RRF / 可选 Reranker', '引用约束', outcomes[scenario].status === 'refused' ? '拒答' : '确定性模板'], evidence: journeyEvidence(journeyId) }
  }

  if (journeyId === 'task') {
    const scenario = input.scenario === 'offline' ? 'offline' : 'success'
    const states = scenario === 'offline'
      ? ['pending', 'leased', 'running', 'heartbeat_lost', 'lease_expired', 'pending', 're_leased', 'late_result_rejected', 'succeeded']
      : ['pending', 'leased', 'running', 'succeeded']
    return { journey, simulated: true, scenario, startedAt: new Date(now).toISOString(), states, task: { processor: 'rag.content.extract@demo', attempt: scenario === 'offline' ? 2 : 1, maxAttempts: 3, heartbeatAge: scenario === 'offline' ? 'lease 已过期' : '< 5s', inputFingerprint: 'sha256:demo…7a2c' }, evidence: journeyEvidence(journeyId) }
  }

  const changedTypes = [...session.overlays.keys()]
  return { journey, simulated: true, changedTypes, overlayChanges: changedTypes.length, summary: getDemoSummary(session), layers: ['权威原件：生产环境不可由演示修改', '会话覆盖层：当前访客的临时增删改', '派生索引：可重建，不作为权威数据'], evidence: journeyEvidence(journeyId) }
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
  const overlay = session.overlays.get(type) || newOverlay()
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
