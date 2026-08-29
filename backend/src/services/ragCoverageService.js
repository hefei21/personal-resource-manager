const SOURCE_SPECS = Object.freeze([
  Object.freeze({ type: 'document', table: 'documents', titleColumn: 'title' }),
  Object.freeze({ type: 'ebook', table: 'books', titleColumn: 'title' }),
  Object.freeze({ type: 'code_repository', table: 'code_repositories', titleColumn: 'name' })
])

const COVERAGE_STATUSES = Object.freeze(['ready', 'partial', 'pending', 'stale', 'failed', 'missing'])

function hasTable(database, tableName) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(tableName))
}

function safeTitle(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  return normalized ? normalized.slice(0, 256) : fallback
}

function safeCount(value) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function publicErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,127}$/u.test(value) ? value : null
}

function coverageStatus(status) {
  const sourceStatus = status?.sourceState?.status
  if (sourceStatus === 'pending') return 'pending'
  if (sourceStatus === 'failed') return 'failed'
  if (sourceStatus === 'stale') return 'stale'
  if (sourceStatus === 'partial') return 'partial'
  if (sourceStatus === 'ready' && safeCount(status?.chunks?.count) > 0) return 'ready'
  return 'missing'
}

function projectCoverageItem(row, status) {
  const state = coverageStatus(status)
  const errorCode = publicErrorCode(
    status?.sourceState?.errorCode ?? status?.snapshot?.errorCode
  )
  return Object.freeze({
    source: Object.freeze({
      type: row.sourceType,
      id: row.sourceId,
      title: row.title
    }),
    status: state,
    chunkCount: safeCount(status?.chunks?.count),
    embeddingStatus: typeof status?.embedding?.status === 'string'
      ? status.embedding.status
      : 'missing',
    ...(errorCode ? { errorCode } : {}),
    ...(typeof status?.sourceState?.updatedAt === 'string'
      ? { updatedAt: status.sourceState.updatedAt }
      : {})
  })
}

function readRows(database, requestedType) {
  const rows = []
  for (const spec of SOURCE_SPECS) {
    if (requestedType && requestedType !== spec.type) continue
    if (!hasTable(database, spec.table)) continue
    const sourceRows = database.prepare(`
      SELECT id, ${spec.titleColumn} AS title
        FROM ${spec.table}
       ORDER BY id ASC
    `).all()
    for (const row of sourceRows) {
      const sourceId = Number(row.id)
      if (!Number.isSafeInteger(sourceId) || sourceId <= 0) continue
      rows.push(Object.freeze({
        sourceType: spec.type,
        sourceId,
        title: safeTitle(row.title, `${spec.type}:${sourceId}`)
      }))
    }
  }
  return rows
}

function summarize(items) {
  const counts = Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, 0]))
  for (const item of items) counts[item.status] += 1
  return Object.freeze({
    total: items.length,
    indexed: counts.ready + counts.partial,
    ...counts
  })
}

export async function readRagCoverage({
  database,
  checks,
  sourceStatusProvider,
  type = null,
  limit = 100,
  offset = 0,
  req
} = {}) {
  if (!database?.prepare || typeof sourceStatusProvider !== 'function') {
    throw new TypeError('RAG coverage dependencies are unavailable.')
  }
  const items = []
  for (const row of readRows(database, type)) {
    let status
    try {
      status = await Promise.resolve(sourceStatusProvider({
        database,
        req,
        checks,
        sourceType: row.sourceType,
        sourceId: row.sourceId
      }))
    } catch (error) {
      status = {
        sourceState: {
          status: 'failed',
          errorCode: publicErrorCode(error?.code) ?? 'RAG_SOURCE_STATUS_UNAVAILABLE'
        },
        chunks: { count: 0 },
        embedding: { status: 'missing' }
      }
    }
    // A null status means the authoritative lifecycle/visibility check did not
    // consider the domain row active. It must not appear in Owner RAG coverage.
    if (status === null || status === undefined) continue
    items.push(projectCoverageItem(row, status))
  }
  const summary = summarize(items)
  return Object.freeze({
    summary,
    data: Object.freeze(items.slice(offset, offset + limit)),
    total: items.length,
    limit,
    offset
  })
}

export default readRagCoverage
