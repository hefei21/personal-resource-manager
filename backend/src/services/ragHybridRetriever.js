import crypto from 'node:crypto'

export const RAG_HYBRID_RETRIEVER_VERSION = 'rag-hybrid-retriever.v1'
export const RAG_HYBRID_MAX_CANDIDATES = 1_000
export const RAG_HYBRID_MAX_LIMIT = 100

export const RAG_HYBRID_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_HYBRID_INPUT_INVALID',
  CANDIDATE_INVALID: 'RAG_HYBRID_CANDIDATE_INVALID',
  FTS_CANDIDATE_INVALID: 'RAG_HYBRID_FTS_CANDIDATE_INVALID',
  VECTOR_SCHEMA_MISMATCH: 'RAG_HYBRID_VECTOR_SCHEMA_MISMATCH',
  VISIBILITY_REQUIRED: 'RAG_HYBRID_VISIBILITY_REQUIRED',
  VISIBILITY_FAILED: 'RAG_HYBRID_VISIBILITY_FAILED',
  CLIENT_CONTROL_FORBIDDEN: 'RAG_HYBRID_CLIENT_CONTROL_FORBIDDEN'
})

const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const SOURCE_ROUTES = Object.freeze({ document: '/documents', ebook: '/books', code_repository: '/code' })
const CHANNELS = Object.freeze(['fts', 'vector'])
const FORBIDDEN_CLIENT_CONTROLS = new Set([
  'filter', 'rawFilter', 'sourceAllowlist', 'activeSnapshotSources',
  'weights', 'rrfK', 'ftsWeight', 'vectorWeight', 'sourceCap',
  'maxPerSource', 'minDistinctSources', 'overlapGap', 'adjacentGap',
  'diversity', 'candidateLimit'
])
const HASH_PATTERN = /^[a-f0-9]{64}$/u

export class RagHybridRetrieverError extends Error {
  constructor(code, message = code, details = {}) {
    super(message)
    this.name = 'RagHybridRetrieverError'
    this.code = code
    Object.assign(this, details)
  }
}

function fail(code, message = code, details = {}) {
  throw new RagHybridRetrieverError(code, message, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function positiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  return value
}

function boundedInteger(value, fieldName, min, max, fallback) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function boundedNumber(value, fieldName, min, max, fallback) {
  const normalized = value === undefined ? fallback : value
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < min || normalized > max) {
    fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function requiredText(value, fieldName, maxLength = 256) {
  if (typeof value !== 'string') fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function safeJsonClone(value, fieldName) {
  if (!isPlainObject(value)) fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName} is invalid.`)
  try {
    const serialized = JSON.stringify(value)
    const clone = JSON.parse(serialized)
    if (!isPlainObject(clone)) throw new Error('not an object')
    return clone
  } catch {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName} is invalid.`)
  }
}

function compareText(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  return a < b ? -1 : a > b ? 1 : 0
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function encodeId(value) {
  return encodeURIComponent(String(value))
}

function sourceKey(candidate) {
  return `${candidate.sourceType}\u0000${candidate.sourceId}\u0000${candidate.sourceVersionId}`
}

function candidateKey(candidate) {
  return `${sourceKey(candidate)}\u0000${candidate.snapshotId}\u0000${candidate.chunkId}`
}

export function citationIdForCandidate(candidate) {
  if (!isPlainObject(candidate)) fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, 'candidate is invalid.')
  return `rag:${encodeId(candidate.sourceType)}:${encodeId(candidate.sourceId)}:${encodeId(candidate.sourceVersionId)}:${encodeId(candidate.snapshotId)}:${encodeId(candidate.chunkId)}`
}

function validateLocator(locator, candidate, fieldName) {
  const normalized = safeJsonClone(locator, fieldName)
  if (typeof normalized.route !== 'string' || normalized.route !== SOURCE_ROUTES[candidate.sourceType]) {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName}.route is invalid.`)
  }
  const ownerKey = candidate.sourceType === 'document'
    ? 'documentId'
    : candidate.sourceType === 'ebook' ? 'bookId' : 'repositoryId'
  if (normalized[ownerKey] !== candidate.sourceId) {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${fieldName}.${ownerKey} is invalid.`)
  }
  return Object.freeze(normalized)
}

function normalizeBase(candidate, channel, index) {
  if (!isPlainObject(candidate)) fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${channel}[${index}] is invalid.`)
  const payload = channel === 'vector' && isPlainObject(candidate.payload) ? candidate.payload : candidate
  if (channel === 'vector' && payload !== candidate) {
    for (const field of ['chunkId', 'snapshotId', 'sourceType', 'sourceId', 'sourceVersionId']) {
      if (Object.hasOwn(candidate, field) && Object.hasOwn(payload, field) && candidate[field] !== payload[field]) {
        fail(RAG_HYBRID_ERROR_CODES.VECTOR_SCHEMA_MISMATCH, `${channel}[${index}] identity disagrees with payload.`)
      }
    }
  }
  const chunkId = positiveInteger(candidate.chunkId ?? payload.chunkId, `${channel}[${index}].chunkId`)
  const snapshotId = positiveInteger(candidate.snapshotId ?? payload.snapshotId, `${channel}[${index}].snapshotId`)
  const sourceType = requiredText(candidate.sourceType ?? payload.sourceType, `${channel}[${index}].sourceType`, 32)
  if (!SOURCE_TYPES.has(sourceType)) fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${channel}[${index}].sourceType is invalid.`)
  const sourceId = positiveInteger(candidate.sourceId ?? payload.sourceId, `${channel}[${index}].sourceId`)
  const sourceVersionId = requiredText(candidate.sourceVersionId ?? payload.sourceVersionId, `${channel}[${index}].sourceVersionId`)
  const sourceContentSha256 = candidate.sourceContentSha256 ?? payload.sourceContentSha256
  if (sourceContentSha256 !== undefined && (typeof sourceContentSha256 !== 'string' || !HASH_PATTERN.test(sourceContentSha256))) {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${channel}[${index}].sourceContentSha256 is invalid.`)
  }
  const score = candidate.score
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    fail(RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID, `${channel}[${index}].score is invalid.`)
  }
  const locator = candidate.locator
    ? validateLocator(candidate.locator, { sourceType, sourceId }, `${channel}[${index}].locator`)
    : null
  const ordinal = candidate.ordinal === undefined ? null : boundedInteger(candidate.ordinal, `${channel}[${index}].ordinal`, 0, 1_000_000_000, 0)
  const body = channel === 'fts' && typeof candidate.body === 'string' ? candidate.body : null
  const title = typeof candidate.title === 'string' ? candidate.title : null
  return {
    channel,
    chunkId,
    snapshotId,
    sourceType,
    sourceId,
    sourceVersionId,
    sourceContentSha256: sourceContentSha256 ?? null,
    locator,
    body,
    title,
    ordinal,
    score,
    key: null
  }
}

function normalizeChannelCandidates(candidates, channel) {
  if (!Array.isArray(candidates) || candidates.length > RAG_HYBRID_MAX_CANDIDATES) {
    fail(channel === 'fts' ? RAG_HYBRID_ERROR_CODES.FTS_CANDIDATE_INVALID : RAG_HYBRID_ERROR_CODES.VECTOR_SCHEMA_MISMATCH,
      `${channel} candidates are invalid.`)
  }
  const normalized = candidates.map((candidate, index) => normalizeBase(candidate, channel, index))
  normalized.sort((left, right) => right.score - left.score || compareCandidateIdentity(left, right))
  return normalized.map((candidate, index) => ({ ...candidate, rank: index + 1, key: candidateKey(candidate) }))
}

function compareCandidateIdentity(left, right) {
  return compareText(left.sourceType, right.sourceType) ||
    left.sourceId - right.sourceId ||
    compareText(left.sourceVersionId, right.sourceVersionId) ||
    left.snapshotId - right.snapshotId ||
    left.chunkId - right.chunkId ||
    compareText(left.sourceContentSha256, right.sourceContentSha256)
}

function mergeCandidates(fts, vectors) {
  const merged = new Map()
  for (const candidate of [...fts, ...vectors]) {
    const existing = merged.get(candidate.key)
    if (!existing) {
      merged.set(candidate.key, {
        ...candidate,
        channels: [candidate.channel],
        ranks: { [candidate.channel]: candidate.rank },
        scores: { [candidate.channel]: candidate.score }
      })
      continue
    }
    if (existing.sourceContentSha256 && candidate.sourceContentSha256 &&
        existing.sourceContentSha256 !== candidate.sourceContentSha256) {
      if (candidate.channel === 'fts' && existing.channel !== 'fts') {
        merged.set(candidate.key, {
          ...candidate,
          channels: ['fts'],
          ranks: { fts: candidate.rank },
          scores: { fts: candidate.score }
        })
      }
      continue
    }
    const preferred = existing.channel === 'fts' || candidate.channel !== 'fts' ? existing : candidate
    existing.channel = preferred.channel
    existing.sourceContentSha256 = preferred.sourceContentSha256 ?? existing.sourceContentSha256
    existing.locator = preferred.locator ?? existing.locator
    existing.body = preferred.body ?? existing.body
    existing.title = preferred.title ?? existing.title
    if (!existing.channels.includes(candidate.channel)) existing.channels.push(candidate.channel)
    existing.ranks[candidate.channel] = candidate.rank
    existing.scores[candidate.channel] = candidate.score
  }
  return [...merged.values()]
}

function fuseNormalized(fts, vectors, config) {
  const merged = mergeCandidates(fts, vectors)
  return merged.map((candidate) => {
    const score = CHANNELS.reduce((sum, channel) => {
      const rank = candidate.ranks[channel]
      if (rank === undefined) return sum
      const weight = channel === 'fts' ? config.ftsWeight : config.vectorWeight
      return sum + weight / (config.rrfK + rank)
    }, 0)
    return { ...candidate, fusedScore: score }
  }).sort((left, right) => right.fusedScore - left.fusedScore ||
    right.channels.length - left.channels.length ||
    (left.ranks.fts ?? Number.MAX_SAFE_INTEGER) - (right.ranks.fts ?? Number.MAX_SAFE_INTEGER) ||
    (left.ranks.vector ?? Number.MAX_SAFE_INTEGER) - (right.ranks.vector ?? Number.MAX_SAFE_INTEGER) ||
    compareCandidateIdentity(left, right))
}

function locatorRange(locator) {
  if (!isPlainObject(locator)) return null
  const startLine = locator.startLine
  const endLine = locator.endLine
  if (Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine > 0 && endLine >= startLine) {
    return { start: startLine, end: endLine, kind: 'line' }
  }
  const startParagraph = locator.paragraphIndex
  const endParagraph = locator.paragraphEndIndex ?? startParagraph
  if (Number.isSafeInteger(startParagraph) && Number.isSafeInteger(endParagraph) && startParagraph >= 0 && endParagraph >= startParagraph) {
    return { start: startParagraph, end: endParagraph, kind: 'paragraph' }
  }
  return null
}

function sameSection(left, right) {
  const leftPath = JSON.stringify(left.locator?.sectionPath ?? null)
  const rightPath = JSON.stringify(right.locator?.sectionPath ?? null)
  return leftPath === rightPath
}

function overlapsOrAdjacent(left, right, adjacentGap) {
  if (sourceKey(left) !== sourceKey(right) || left.snapshotId !== right.snapshotId) return false
  if (!sameSection(left, right) && locatorRange(left.locator)?.kind === 'paragraph') return false
  const leftRange = locatorRange(left.locator)
  const rightRange = locatorRange(right.locator)
  if (leftRange && rightRange && leftRange.kind === rightRange.kind) {
    return rightRange.start <= leftRange.end + adjacentGap && leftRange.start <= rightRange.end + adjacentGap
  }
  if (left.ordinal !== null && right.ordinal !== null) return Math.abs(left.ordinal - right.ordinal) <= 1
  return false
}

function sourceCountKey(candidate) {
  return sourceKey(candidate)
}

function selectDiverse(sorted, config, limit) {
  const selected = []
  const counts = new Map()
  const canSelect = (candidate) => {
    const source = sourceCountKey(candidate)
    if ((counts.get(source) ?? 0) >= config.maxPerSource) return false
    return !selected.some((item) => overlapsOrAdjacent(item, candidate, config.adjacentGap))
  }
  const add = (candidate) => {
    selected.push(candidate)
    const source = sourceCountKey(candidate)
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }

  const sources = []
  for (const candidate of sorted) {
    const source = sourceCountKey(candidate)
    if (!sources.includes(source)) sources.push(source)
  }
  const diversityTarget = Math.min(config.minDistinctSources, sources.length, limit)
  for (const source of sources) {
    if (selected.length >= diversityTarget) break
    const candidate = sorted.find((item) => sourceCountKey(item) === source && canSelect(item))
    if (candidate) add(candidate)
  }
  for (const candidate of sorted) {
    if (selected.length >= limit) break
    if (!selected.includes(candidate) && canSelect(candidate)) add(candidate)
  }
  return selected
}

function publicCandidate(candidate) {
  if (!candidate.locator) return null
  const output = {
    citationId: citationIdForCandidate(candidate),
    chunkId: candidate.chunkId,
    snapshotId: candidate.snapshotId,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    sourceVersionId: candidate.sourceVersionId,
    ...(candidate.sourceContentSha256 === null ? {} : { sourceContentSha256: candidate.sourceContentSha256 }),
    ...(candidate.title === null ? {} : { title: candidate.title }),
    ...(candidate.body === null ? {} : { body: candidate.body }),
    ordinal: candidate.ordinal,
    locator: candidate.locator,
    score: candidate.fusedScore,
    retrieval: Object.freeze({
      channels: Object.freeze([...candidate.channels].sort(compareText)),
      fusion: 'rrf',
      ranks: Object.freeze({ ...candidate.ranks })
    })
  }
  return Object.freeze(output)
}

function vectorDegradedReason(error) {
  const code = String(error?.code ?? error?.reason ?? error ?? '').toUpperCase()
  if (code.includes('TIMEOUT')) return 'vector_timeout'
  if (code.includes('SCHEMA') || code.includes('COLLECTION') || code.includes('RESPONSE')) return 'vector_schema_mismatch'
  if (code.includes('UNAVAILABLE') || code.includes('CANCEL')) return 'vector_unavailable'
  return 'vector_unavailable'
}

function rejectClientControls(input) {
  if (!isPlainObject(input)) fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'retrieval input is invalid.')
  for (const key of FORBIDDEN_CLIENT_CONTROLS) {
    if (Object.hasOwn(input, key)) fail(RAG_HYBRID_ERROR_CODES.CLIENT_CONTROL_FORBIDDEN, `${key} is server-controlled.`)
  }
}

function normalizeConfig(config = {}) {
  if (!isPlainObject(config)) fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'config is invalid.')
  return Object.freeze({
    rrfK: boundedNumber(config.rrfK, 'config.rrfK', 1, 1_000_000, 60),
    ftsWeight: boundedNumber(config.ftsWeight, 'config.ftsWeight', 0, 1_000_000, 1),
    vectorWeight: boundedNumber(config.vectorWeight, 'config.vectorWeight', 0, 1_000_000, 1),
    maxPerSource: boundedInteger(config.maxPerSource, 'config.maxPerSource', 1, 100, 3),
    minDistinctSources: boundedInteger(config.minDistinctSources, 'config.minDistinctSources', 0, 100, 2),
    adjacentGap: boundedInteger(config.adjacentGap, 'config.adjacentGap', 0, 100, 1),
    defaultLimit: boundedInteger(config.defaultLimit, 'config.defaultLimit', 1, RAG_HYBRID_MAX_LIMIT, 10)
  })
}

export function fuseRagCandidates({ ftsCandidates = [], vectorCandidates = [], config = {} } = {}) {
  const normalizedConfig = normalizeConfig(config)
  const fts = normalizeChannelCandidates(ftsCandidates, 'fts')
  const vectors = normalizeChannelCandidates(vectorCandidates, 'vector')
  return Object.freeze(fuseNormalized(fts, vectors, normalizedConfig).map((candidate) => publicCandidate(candidate)).filter(Boolean))
}

export class RagHybridRetriever {
  constructor({
    config = {},
    authoritativeVisibility = null,
    authoritativeActiveSnapshot = null,
    authoritativeCheck = null,
    candidateResolver = null
  } = {}) {
    if (authoritativeVisibility !== null && typeof authoritativeVisibility !== 'function') {
      fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'authoritativeVisibility is invalid.')
    }
    if (authoritativeActiveSnapshot !== null && typeof authoritativeActiveSnapshot !== 'function') {
      fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'authoritativeActiveSnapshot is invalid.')
    }
    if (authoritativeCheck !== null && typeof authoritativeCheck !== 'function') {
      fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'authoritativeCheck is invalid.')
    }
    if (candidateResolver !== null && typeof candidateResolver !== 'function') {
      fail(RAG_HYBRID_ERROR_CODES.INPUT_INVALID, 'candidateResolver is invalid.')
    }
    this.config = normalizeConfig(config)
    this.authoritativeVisibility = authoritativeVisibility ?? authoritativeCheck
    this.authoritativeActiveSnapshot = authoritativeActiveSnapshot
    this.candidateResolver = candidateResolver
  }

  #ensureVisibility() {
    if (!this.authoritativeVisibility && !this.authoritativeActiveSnapshot) {
      fail(RAG_HYBRID_ERROR_CODES.VISIBILITY_REQUIRED, 'authoritative visibility/active snapshot checks are required.')
    }
  }

  async #authorize(candidate, context) {
    let hydrated = candidate
    if (!hydrated.locator && this.candidateResolver) {
      const resolved = await this.candidateResolver(candidate, context)
      if (isPlainObject(resolved)) hydrated = { ...candidate, ...resolved }
    }
    if (!hydrated.locator) return null
    hydrated = { ...hydrated, locator: validateLocator(hydrated.locator, hydrated, 'candidate.locator') }
    if (this.authoritativeActiveSnapshot) {
      const active = await this.authoritativeActiveSnapshot(hydrated, context)
      if (active !== true && !(isPlainObject(active) && active.visible === true)) return null
    }
    if (this.authoritativeVisibility) {
      const visible = await this.authoritativeVisibility(hydrated, context)
      if (visible !== true && !(isPlainObject(visible) && visible.visible === true)) return null
      if (isPlainObject(visible) && isPlainObject(visible.candidate)) {
        hydrated = { ...hydrated, ...visible.candidate }
        hydrated.locator = validateLocator(hydrated.locator, hydrated, 'candidate.locator')
      }
    }
    return hydrated
  }

  async #authorizeAll(candidates, context) {
    const visible = []
    for (const candidate of candidates) {
      try {
        const authorized = await this.#authorize(candidate, context)
        if (authorized) visible.push(authorized)
      } catch (error) {
        if (error instanceof RagHybridRetrieverError && error.code === RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID) throw error
        fail(RAG_HYBRID_ERROR_CODES.VISIBILITY_FAILED, 'authoritative visibility check failed.')
      }
    }
    return visible
  }

  async retrieve(input = {}) {
    rejectClientControls(input)
    this.#ensureVisibility()
    const limit = boundedInteger(input.limit, 'limit', 1, RAG_HYBRID_MAX_LIMIT, this.config.defaultLimit)
    const offset = boundedInteger(input.offset, 'offset', 0, 1_000_000_000, 0)
    if (!Array.isArray(input.ftsCandidates)) fail(RAG_HYBRID_ERROR_CODES.FTS_CANDIDATE_INVALID, 'ftsCandidates are required.')
    let fts
    try {
      fts = normalizeChannelCandidates(input.ftsCandidates, 'fts')
    } catch (error) {
      throw error
    }
    let vectors = []
    let degraded = false
    let degradedReason = null
    if (input.vectorError !== undefined && input.vectorError !== null) {
      degraded = true
      degradedReason = vectorDegradedReason(input.vectorError)
    } else if (input.vectorCandidates === undefined) {
      degraded = true
      degradedReason = 'vector_unavailable'
    } else {
      try {
        vectors = normalizeChannelCandidates(input.vectorCandidates ?? [], 'vector')
      } catch (error) {
        if (error?.code !== RAG_HYBRID_ERROR_CODES.VECTOR_SCHEMA_MISMATCH && error?.code !== RAG_HYBRID_ERROR_CODES.CANDIDATE_INVALID) throw error
        degraded = true
        degradedReason = 'vector_schema_mismatch'
        vectors = []
      }
    }

    if (vectors.length > 0 && !this.candidateResolver && vectors.some((candidate) => candidate.locator === null)) {
      degraded = true
      degradedReason = 'vector_schema_mismatch'
      vectors = []
    }

    const preAuthorized = await this.#authorizeAll([...fts, ...vectors], {
      query: input.query ?? input.q ?? null,
      mode: degraded ? 'fts' : 'hybrid',
      source: 'rag-hybrid-retriever'
    })
    const authorizedFts = preAuthorized.filter((candidate) => candidate.channel === 'fts')
    const authorizedVectors = preAuthorized.filter((candidate) => candidate.channel === 'vector')
    const fused = fuseNormalized(authorizedFts, degraded ? [] : authorizedVectors, this.config)
    const selected = selectDiverse(fused, this.config, Math.min(RAG_HYBRID_MAX_CANDIDATES, offset + limit))
    const finalAuthorized = await this.#authorizeAll(selected, {
      query: input.query ?? input.q ?? null,
      mode: degraded ? 'fts' : 'hybrid',
      final: true,
      source: 'rag-hybrid-retriever'
    })
    const data = finalAuthorized.map(publicCandidate).filter(Boolean).slice(offset, offset + limit)
    const mode = degraded ? 'fts' : 'hybrid'
    return Object.freeze({
      query: input.query ?? input.q ?? null,
      data: Object.freeze(data),
      total: finalAuthorized.length,
      limit,
      offset,
      retrieval: Object.freeze({
        mode,
        degraded,
        ...(degradedReason === null ? {} : { degradedReason }),
        fusion: 'rrf'
      })
    })
  }

  query(input = {}) {
    return this.retrieve(input)
  }
}

export function createRagHybridRetriever(options) {
  return new RagHybridRetriever(options)
}

export default createRagHybridRetriever
