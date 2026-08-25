import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODEL_ID = 'BAAI/bge-reranker-v2-m3'
const MODEL_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
const CANDIDATE_LIMIT = 10
const FINAL_LIMIT = 5
const MAX_LENGTH = 512
const SCORE_TYPE = 'raw_logit'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const DANGEROUS_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const QUERY_CATEGORIES = new Set([
  'exact_fact',
  'same_source_synthesis',
  'cross_source_synthesis',
  'version_conflict',
  'no_answer',
  'security'
])
const PRIMARY_CATEGORIES = Object.freeze([
  'exact_fact',
  'same_source_synthesis',
  'cross_source_synthesis',
  'version_conflict',
  'security'
])

function fail(code, message = code) {
  const error = new Error(message)
  error.code = code
  throw error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isPlainObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function requiredText(value, fieldName, maxBytes = 512, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('RAG_RERANK_CONFIG_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if ((!allowEmpty && !normalized) || byteLength(normalized) > maxBytes || DANGEROUS_CONTROL.test(normalized)) {
    fail('RAG_RERANK_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function finiteNumber(value, fieldName, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) fail('RAG_RERANK_CONFIG_INVALID', `${fieldName} is invalid.`)
  return number
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function normalizeHash(value, fieldName) {
  const normalized = requiredText(value, fieldName, 64).toLowerCase()
  if (!HASH_PATTERN.test(normalized)) fail('RAG_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function normalizeLocator(value, fieldName) {
  if (!isPlainObject(value)) fail('RAG_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  try {
    const serialized = stableJson(value)
    if (byteLength(serialized) > 16 * 1024 || DANGEROUS_CONTROL.test(serialized)) {
      fail('RAG_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
    }
  } catch {
    fail('RAG_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  }
  return Object.freeze({ ...value })
}

function normalizeTarget(value, fieldName) {
  if (!isPlainObject(value) || !isPlainObject(value.locator)) fail('RAG_RERANK_INPUT_INVALID', `${fieldName} is invalid.`)
  const targetId = typeof value.targetId === 'string' && value.targetId.trim()
    ? value.targetId.trim()
    : (typeof value.entryKey === 'string' && value.entryKey.trim() ? value.entryKey.trim() : null)
  if (!targetId) fail('RAG_RERANK_INPUT_INVALID', `${fieldName}.targetId is invalid.`)
  return Object.freeze({
    targetId,
    entryKey: typeof value.entryKey === 'string' && value.entryKey.trim() ? value.entryKey.trim() : null,
    locator: normalizeLocator(value.locator, `${fieldName}.locator`)
  })
}

function normalizeQueries(querySet) {
  if (!Array.isArray(querySet) || querySet.length === 0) fail('RAG_RERANK_INPUT_INVALID', 'querySet is invalid.')
  const ids = new Set()
  return Object.freeze(querySet.map((item, index) => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.q !== 'string' || !item.q.trim() || !QUERY_CATEGORIES.has(item.category) ||
        !Array.isArray(item.expected) || !Array.isArray(item.forbidden)) {
      fail('RAG_RERANK_INPUT_INVALID', `querySet[${index}] is invalid.`)
    }
    if (item.category === 'no_answer' && item.expected.length !== 0) {
      fail('RAG_RERANK_INPUT_INVALID', `querySet[${index}] no_answer query must not declare expected targets.`)
    }
    if (item.category !== 'no_answer' && item.expected.length === 0 && item.category !== 'security') {
      fail('RAG_RERANK_INPUT_INVALID', `querySet[${index}] expected targets are required.`)
    }
    ids.add(item.id)
    return Object.freeze({
      id: item.id.trim(),
      q: requiredText(item.q, `querySet[${index}].q`, 16 * 1024),
      queryHash: sha256(item.q.normalize('NFKC')),
      category: item.category,
      language: /[\u3400-\u9fff]/u.test(item.q) ? 'zh' : 'en',
      sourceTypes: Object.freeze(Array.isArray(item.sourceTypes) ? [...new Set(item.sourceTypes.map(String))] : []),
      expected: Object.freeze(item.expected.map((target, targetIndex) => normalizeTarget(target, `querySet[${index}].expected[${targetIndex}]`))),
      forbidden: Object.freeze(item.forbidden.map((target, targetIndex) => normalizeTarget(target, `querySet[${index}].forbidden[${targetIndex}]`)))
    })
  }))
}

function normalizeCandidateSet(value, query, index) {
  if (!isPlainObject(value) || value.queryId !== query.id || !Array.isArray(value.candidates) ||
      value.candidates.length < 1 || value.candidates.length > CANDIDATE_LIMIT) {
    fail('RAG_RERANK_INPUT_INVALID', `candidateSets[${index}] is invalid.`)
  }
  const ids = new Set()
  const candidates = value.candidates.map((item, candidateIndex) => {
    if (!isPlainObject(item)) fail('RAG_RERANK_INPUT_INVALID', `candidateSets[${index}].candidates[${candidateIndex}] is invalid.`)
    const id = requiredText(item.id ?? item.entryKey, `candidateSets[${index}].candidates[${candidateIndex}].id`, 2048)
    if (ids.has(id)) fail('RAG_RERANK_INPUT_INVALID', `candidateSets[${index}] contains duplicate candidate ids.`)
    ids.add(id)
    const text = requiredText(item.text, `candidateSets[${index}].candidates[${candidateIndex}].text`, 4 * 1024 * 1024)
    const textHash = item.textHash === undefined ? sha256(text) : normalizeHash(item.textHash, `candidateSets[${index}].candidates[${candidateIndex}].textHash`)
    if (textHash !== sha256(text)) fail('RAG_RERANK_INPUT_INVALID', `candidateSets[${index}] candidate text hash is invalid.`)
    const locator = normalizeLocator(item.locator, `candidateSets[${index}].candidates[${candidateIndex}].locator`)
    const hybridScore = item.hybridScore === undefined ? null : finiteNumber(item.hybridScore, `candidateSets[${index}].candidates[${candidateIndex}].hybridScore`)
    return Object.freeze({
      id,
      idHash: sha256(id),
      text,
      textHash,
      locator,
      hybridScore
    })
  })
  return Object.freeze({
    queryId: query.id,
    queryHash: query.queryHash,
    baselineLatencyMs: value.baselineLatencyMs === undefined ? null : finiteNumber(value.baselineLatencyMs, `candidateSets[${index}].baselineLatencyMs`, { min: 0 }),
    candidates: Object.freeze(candidates),
    candidateSetHash: sha256(stableJson(candidates.map((candidate) => ({ id: candidate.id, textHash: candidate.textHash, hybridScore: candidate.hybridScore }))))
  })
}

function normalizeEndpoint(baseUrl) {
  const value = requiredText(baseUrl, 'baseUrl', 2048)
  let parsed
  try { parsed = new URL(value) } catch { fail('RAG_RERANK_CONFIG_INVALID', 'baseUrl is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    fail('RAG_RERANK_CONFIG_INVALID', 'baseUrl is not safe.')
  }
  return parsed.toString().replace(/\/$/u, '')
}

export const RERANKER_EVALUATION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  modelId: MODEL_ID,
  revision: MODEL_REVISION,
  maxLength: MAX_LENGTH,
  scoreType: SCORE_TYPE,
  candidateLimit: CANDIDATE_LIMIT,
  finalLimit: FINAL_LIMIT,
  modelIdentityHash: sha256(stableJson({ modelId: MODEL_ID, revision: MODEL_REVISION, maxLength: MAX_LENGTH, scoreType: SCORE_TYPE }))
})

export function normalizeRagRerankerEvaluationConfig(options = {}) {
  if (!isPlainObject(options)) fail('RAG_RERANK_CONFIG_INVALID', 'options are invalid.')
  if (options.modelId !== undefined && options.modelId !== MODEL_ID) fail('RAG_RERANK_CONFIG_INVALID', 'modelId is not the pinned candidate.')
  if (options.revision !== undefined && options.revision !== MODEL_REVISION) fail('RAG_RERANK_CONFIG_INVALID', 'revision is not the pinned candidate.')
  if (options.maxLength !== undefined && options.maxLength !== MAX_LENGTH) fail('RAG_RERANK_CONFIG_INVALID', 'maxLength is not the pinned candidate.')
  if (options.scoreType !== undefined && options.scoreType !== SCORE_TYPE) fail('RAG_RERANK_CONFIG_INVALID', 'scoreType is not supported.')
  if (options.candidateLimit !== undefined && options.candidateLimit !== CANDIDATE_LIMIT) fail('RAG_RERANK_CONFIG_INVALID', 'candidateLimit is fixed at 10.')
  if (options.finalLimit !== undefined && options.finalLimit !== FINAL_LIMIT) fail('RAG_RERANK_CONFIG_INVALID', 'finalLimit is fixed at 5.')
  const queries = normalizeQueries(options.querySet)
  if (!Array.isArray(options.candidateSets) || options.candidateSets.length !== queries.length) {
    fail('RAG_RERANK_INPUT_INVALID', 'candidateSets are incomplete.')
  }
  const queryById = new Map(queries.map((query) => [query.id, query]))
  const seen = new Set()
  const candidateSets = options.candidateSets.map((candidateSet, index) => {
    const query = queryById.get(candidateSet?.queryId)
    if (!query || seen.has(query.id)) fail('RAG_RERANK_INPUT_INVALID', 'candidateSets contain an unknown or duplicate query.')
    seen.add(query.id)
    return normalizeCandidateSet(candidateSet, query, index)
  })
  if (seen.size !== queries.length) fail('RAG_RERANK_INPUT_INVALID', 'candidateSets are incomplete.')
  const baselineP95Ms = options.baselineP95Ms === undefined || options.baselineP95Ms === null
    ? null
    : finiteNumber(options.baselineP95Ms, 'baselineP95Ms', { min: 0 })
  const timeoutMs = finiteNumber(options.timeoutMs ?? 60_000, 'timeoutMs', { min: 1, max: 5 * 60_000 })
  const reranker = options.reranker
  if (typeof reranker !== 'function' && !reranker?.rerank) fail('RAG_RERANK_CONFIG_INVALID', 'reranker adapter is required.')
  const closeReranker = typeof reranker?.close === 'function'
    ? reranker.close.bind(reranker)
    : null
  return Object.freeze({
    ...RERANKER_EVALUATION_CONTRACT,
    queries,
    candidateSets: Object.freeze(candidateSets),
    baselineP95Ms,
    timeoutMs,
    reranker: typeof reranker === 'function' ? reranker : reranker.rerank,
    closeReranker
  })
}

function normalizeScores(value, candidates) {
  const payload = Array.isArray(value) ? { scores: value } : value
  if (!isPlainObject(payload) || !Array.isArray(payload.scores) || payload.scores.length !== candidates.length) {
    fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response scores are invalid.')
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const seen = new Set()
  const scores = payload.scores.map((item, index) => {
    const id = typeof item === 'number' ? candidates[index].id : item?.id
    const score = typeof item === 'number' ? item : (item?.score ?? item?.logit)
    if (typeof id !== 'string' || !byId.has(id) || seen.has(id) || !Number.isFinite(Number(score))) {
      fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response identity or score is invalid.')
    }
    seen.add(id)
    return Object.freeze({ id, score: Number(score) })
  })
  if (seen.size !== candidates.length) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response dropped a candidate.')
  if (payload.model !== undefined && payload.model !== MODEL_ID) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response model identity is invalid.')
  if (payload.revision !== undefined && payload.revision !== MODEL_REVISION) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response revision identity is invalid.')
  if (payload.scoreType !== undefined && payload.scoreType !== SCORE_TYPE) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response score type is invalid.')
  return Object.freeze(scores)
}

async function requestJson(fetchImpl, endpoint, body, timeoutMs) {
  const controller = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller
    })
  } catch {
    fail(controller.aborted ? 'RAG_RERANK_TIMEOUT' : 'RAG_RERANK_UNAVAILABLE', 'reranker endpoint is unavailable.')
  }
  if (!response?.ok) fail('RAG_RERANK_HTTP_FAILED', 'reranker endpoint rejected the request.')
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isSafeInteger(contentLength) && contentLength > MAX_RESPONSE_BYTES) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response is too large.')
  let payload
  try { payload = await response.json() } catch { fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response is invalid.') }
  let serialized
  try { serialized = JSON.stringify(payload) } catch { fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response is invalid.') }
  if (typeof serialized !== 'string' || byteLength(serialized) > MAX_RESPONSE_BYTES) fail('RAG_RERANK_RESPONSE_INVALID', 'reranker response is too large.')
  return payload
}

export function createHttpReranker(options = {}) {
  const baseUrl = normalizeEndpoint(options.baseUrl)
  const endpoint = baseUrl.endsWith('/rerank') ? baseUrl : `${baseUrl}/rerank`
  const timeoutMs = finiteNumber(options.timeoutMs ?? 60_000, 'timeoutMs', { min: 1, max: 5 * 60_000 })
  const fetchImpl = options.fetchImpl ?? fetch
  if (typeof fetchImpl !== 'function') fail('RAG_RERANK_CONFIG_INVALID', 'fetchImpl is invalid.')
  return async ({ query, candidates, configuration }) => {
    const payload = await requestJson(fetchImpl, endpoint, {
      model: configuration.modelId,
      revision: configuration.revision,
      max_length: configuration.maxLength,
      score_type: configuration.scoreType,
      query,
      documents: candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
      return_documents: false
    }, timeoutMs)
    return normalizeScores(payload, candidates)
  }
}

function readRunnerLine(state) {
  if (state.lines.length > 0) return Promise.resolve(state.lines.shift())
  if (state.closed) return Promise.reject(new Error('runner closed'))
  return new Promise((resolve, reject) => state.waiters.push({ resolve, reject }))
}

export function createStdinReranker(options = {}) {
  const command = requiredText(options.command, 'command', 4096)
  const args = options.args === undefined ? [] : options.args
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.length > 4096 || DANGEROUS_CONTROL.test(value))) {
    fail('RAG_RERANK_CONFIG_INVALID', 'args are invalid.')
  }
  const timeoutMs = finiteNumber(options.timeoutMs ?? 60_000, 'timeoutMs', { min: 1, max: 5 * 60_000 })
  const spawnImpl = options.spawnImpl ?? spawn
  let child
  let readline
  let state
  let startPromise

  function rejectWaiters(error) {
    state?.waiters.splice(0).forEach(({ reject }) => reject(error))
  }

  async function start() {
    if (child) return
    child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false })
    if (!child?.stdin || !child?.stdout || typeof child.once !== 'function') {
      fail('RAG_RERANK_RUNNER_INVALID', 'stdin runner process is invalid.')
    }
    state = { lines: [], waiters: [], closed: false }
    readline = createInterface({ input: child.stdout })
    readline.on('line', (line) => {
      if (byteLength(line) > MAX_RESPONSE_BYTES) return rejectWaiters(new Error('runner response is too large'))
      const waiter = state.waiters.shift()
      if (waiter) waiter.resolve(line)
      else state.lines.push(line)
    })
    const close = () => {
      state.closed = true
      rejectWaiters(new Error('runner closed'))
    }
    child.once('error', close)
    child.once('close', close)
  }

  async function rerank({ query, candidates, configuration }) {
    if (!startPromise) startPromise = start().catch((error) => {
      child = null
      startPromise = null
      throw error
    })
    await startPromise
    if (state.closed) fail('RAG_RERANK_RUNNER_FAILED', 'stdin runner closed.')
    const body = JSON.stringify({
      model: configuration.modelId,
      revision: configuration.revision,
      max_length: configuration.maxLength,
      score_type: configuration.scoreType,
      query,
      documents: candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
      return_documents: false
    })
    try {
      child.stdin.write(`${body}\n`)
    } catch {
      fail('RAG_RERANK_RUNNER_FAILED', 'stdin runner rejected the request.')
    }
    let line
    let timeoutHandle
    try {
      line = await Promise.race([
        readRunnerLine(state),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        })
      ])
    } catch (error) {
      fail(error?.message === 'timeout' ? 'RAG_RERANK_TIMEOUT' : 'RAG_RERANK_RUNNER_FAILED', 'stdin runner did not return a valid response.')
    } finally {
      clearTimeout(timeoutHandle)
    }
    let payload
    try { payload = JSON.parse(line) } catch { fail('RAG_RERANK_RESPONSE_INVALID', 'stdin runner response is invalid.') }
    return normalizeScores(payload, candidates)
  }

  rerank.close = async () => {
    try { readline?.close() } catch {}
    try { child?.kill() } catch {}
    if (state) {
      state.closed = true
      rejectWaiters(new Error('runner closed'))
    }
    child = null
    startPromise = null
  }
  return rerank
}

function locatorMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => stableJson(actual?.[key]) === stableJson(value))
}

function matchesTarget(candidate, target) {
  return (target.entryKey !== null && candidate.id === target.entryKey) || locatorMatches(candidate.locator, target.locator)
}

function queryMetrics(ranked, query, k) {
  const top = ranked.slice(0, k)
  const matched = new Map()
  top.forEach((candidate, rank) => {
    for (const target of query.expected) {
      if (!matched.has(target.targetId) && matchesTarget(candidate, target)) {
        matched.set(target.targetId, { candidate, target, rank })
        break
      }
    }
  })
  const relevant = [...matched.values()]
  const recall = query.expected.length === 0 ? (top.length === 0 ? 1 : 0) : relevant.length / query.expected.length
  const firstRank = relevant.length === 0 ? -1 : Math.min(...relevant.map(({ rank }) => rank))
  const locatorCorrect = relevant.filter(({ candidate, target }) => locatorMatches(candidate.locator, target.locator)).length
  const forbiddenHits = query.forbidden.reduce((count, target) => count + top.filter((candidate) => matchesTarget(candidate, target)).length, 0)
  return {
    recall,
    reciprocalRank: firstRank < 0 ? 0 : 1 / (firstRank + 1),
    locatorCorrect,
    relevantReturned: relevant.length,
    forbiddenHits,
    top
  }
}

function average(rows, selector) {
  return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + selector(row), 0) / rows.length
}

function metricReport(queries, rankedById, latencies, details) {
  const answerable = queries.filter((query) => query.expected.length > 0)
  const rawRows = queries.map((query) => {
    const at5 = queryMetrics(rankedById.get(query.id) ?? [], query, FINAL_LIMIT)
    return { query, at5 }
  })
  const rawAnswerable = rawRows.filter(({ query }) => query.expected.length > 0)
  const rawNoAnswer = rawRows.filter(({ query }) => query.category === 'no_answer')
  const rawByCategory = Object.fromEntries([...new Set(queries.map((query) => query.category))].sort().map((category) => {
    const rows = rawRows.filter(({ query }) => query.category === category)
    const categoryAnswerable = rows.filter(({ query }) => query.expected.length > 0)
    return [category, {
      recallAt5: average(categoryAnswerable, ({ at5 }) => at5.recall),
      mrrAt5: average(categoryAnswerable, ({ at5 }) => at5.reciprocalRank)
    }]
  }))
  const rawLocatorCorrect = rawRows.reduce((sum, { at5 }) => sum + at5.locatorCorrect, 0)
  const rawRelevantReturned = rawRows.reduce((sum, { at5 }) => sum + at5.relevantReturned, 0)
  const rawForbiddenHits = rawRows.reduce((sum, { at5 }) => sum + at5.forbiddenHits, 0)
  const raw = {
    mrrAt5: average(rawAnswerable, ({ at5 }) => at5.reciprocalRank),
    p95Ms: percentile(latencies, 0.95),
    locatorAccuracy: rawRelevantReturned === 0 ? 0 : rawLocatorCorrect / rawRelevantReturned,
    forbiddenHits: rawForbiddenHits,
    byCategory: rawByCategory
  }
  const byCategory = {}
  for (const category of [...new Set(queries.map((query) => query.category))].sort()) {
    const rows = details.filter((detail) => detail.category === category)
    const categoryQueries = queries.filter((query) => query.category === category)
    byCategory[category] = {
      queryCount: rows.length,
      answerableQueryCount: categoryQueries.filter((query) => query.expected.length > 0).length,
      recallAt5: round(average(rows.filter((row) => row.answerable), (row) => row.recallAt5)),
      mrrAt5: round(average(rows.filter((row) => row.answerable), (row) => row.reciprocalRankAt5)),
      noAnswerAccuracy: round(average(rows.filter((row) => !row.answerable), (row) => row.recallAt5))
    }
  }
  const report = {
    queryCount: queries.length,
    answerableQueryCount: answerable.length,
    recallAt5: round(average(rawAnswerable, ({ at5 }) => at5.recall)),
    mrrAt5: round(raw.mrrAt5),
    noAnswerAccuracy: round(average(rawNoAnswer, ({ at5 }) => at5.recall)),
    locatorAccuracy: round(raw.locatorAccuracy),
    forbiddenHits: raw.forbiddenHits,
    p50Ms: round(percentile(latencies, 0.5), 3),
    p95Ms: round(raw.p95Ms, 3),
    samples: latencies.length,
    byCategory: Object.freeze(byCategory)
  }
  Object.defineProperty(report, '_raw', { value: Object.freeze(raw), enumerable: false })
  return Object.freeze(report)
}

function detailsFor(queries, rankedById, scoreByQuery) {
  return Object.freeze(queries.map((query) => {
    const ranked = rankedById.get(query.id) ?? []
    const at5 = queryMetrics(ranked, query, FINAL_LIMIT)
    const scores = scoreByQuery.get(query.id) ?? new Map()
    return Object.freeze({
      id: query.id,
      queryHash: query.queryHash,
      category: query.category,
      language: query.language,
      answerable: query.expected.length > 0,
      recallAt5: round(at5.recall),
      reciprocalRankAt5: round(at5.reciprocalRank),
      locatorCorrect: at5.locatorCorrect,
      relevantReturned: at5.relevantReturned,
      forbiddenHits: at5.forbiddenHits,
      topIds: Object.freeze(at5.top.map((candidate) => candidate.id)),
      topIdHashes: Object.freeze(at5.top.map((candidate) => candidate.idHash)),
      topScores: Object.freeze(at5.top.map((candidate) => scores.get(candidate.id) ?? null))
    })
  }))
}

function compareReports(baseline, reranked) {
  const categoryRegression = {}
  let categoryGate = true
  for (const category of PRIMARY_CATEGORIES) {
    const before = baseline._raw.byCategory[category]?.recallAt5 ?? 0
    const after = reranked._raw.byCategory[category]?.recallAt5 ?? 0
    const regression = Math.max(0, before - after)
    categoryRegression[category] = { baseline: before, reranked: after, regression: round(regression), threshold: 0.1 }
    if (regression > 0.1) categoryGate = false
  }
  const mrrGain = reranked._raw.mrrAt5 - baseline._raw.mrrAt5
  const p95Limit = baseline._raw.p95Ms * 2
  const reasons = []
  if (mrrGain < 0.05) reasons.push('mrr_gain_below_threshold')
  if (reranked._raw.p95Ms > p95Limit) reasons.push('p95_latency_above_2x_baseline')
  if (reranked._raw.locatorAccuracy !== 1) reasons.push('locator_accuracy_below_1')
  if (reranked._raw.forbiddenHits !== 0) reasons.push('forbidden_hits_present')
  if (!categoryGate) reasons.push('primary_category_recall_regression')
  return Object.freeze({
    mrrGain: round(mrrGain),
    p95LimitMs: round(p95Limit, 3),
    categoryRegression: Object.freeze(categoryRegression),
    gate: Object.freeze({
      continueReranker: reasons.length === 0,
      decision: reasons.length === 0 ? 'continue_reranker' : 'stop_reranker',
      reasons: Object.freeze(reasons),
      thresholds: Object.freeze({ mrrGain: 0.05, p95Multiplier: 2, locatorAccuracy: 1, forbiddenHits: 0, primaryCategoryRecallRegression: 0.1 })
    })
  })
}

export async function runRagRerankerEvaluation(options = {}) {
  const config = normalizeRagRerankerEvaluationConfig(options)
  const baselineRankedById = new Map()
  const rerankedById = new Map()
  const baselineScoreByQuery = new Map()
  const scoreByQuery = new Map()
  const baselineLatencies = []
  const rerankedLatencies = []
  let candidateSetPreserved = true
  try {
    for (const candidateSet of config.candidateSets) {
      const query = config.queries.find((item) => item.id === candidateSet.queryId)
      const candidates = [...candidateSet.candidates]
      baselineRankedById.set(query.id, candidates)
      baselineScoreByQuery.set(query.id, new Map(candidates.map((candidate) => [candidate.id, candidate.hybridScore])))
      const baselineLatency = candidateSet.baselineLatencyMs ?? config.baselineP95Ms ?? 0
      baselineLatencies.push(baselineLatency)
      const started = performance.now()
      const rawScores = await config.reranker({
        query: query.q,
        candidates,
        configuration: config
      })
      const elapsed = performance.now() - started
      const scores = normalizeScores(rawScores, candidates)
      const scoreMap = new Map(scores.map((item) => [item.id, item.score]))
      scoreByQuery.set(query.id, scoreMap)
      const reranked = [...candidates].sort((left, right) => {
        const difference = scoreMap.get(right.id) - scoreMap.get(left.id)
        return difference !== 0 ? difference : candidates.indexOf(left) - candidates.indexOf(right)
      })
      const baselineIds = candidates.map((candidate) => candidate.id).sort()
      const rerankedIds = reranked.map((candidate) => candidate.id).sort()
      if (stableJson(baselineIds) !== stableJson(rerankedIds)) candidateSetPreserved = false
      rerankedById.set(query.id, reranked)
      rerankedLatencies.push(baselineLatency + elapsed)
    }
  } finally {
    if (config.closeReranker) await config.closeReranker()
  }
  const baselineDetails = detailsFor(config.queries, baselineRankedById, baselineScoreByQuery)
  const rerankedDetails = detailsFor(config.queries, rerankedById, scoreByQuery)
  const baseline = metricReport(config.queries, baselineRankedById, baselineLatencies, baselineDetails)
  const reranked = metricReport(config.queries, rerankedById, rerankedLatencies, rerankedDetails)
  const comparison = compareReports(baseline, reranked)
  const reasons = [...comparison.gate.reasons]
  if (!candidateSetPreserved) reasons.push('candidate_set_not_preserved')
  if (config.baselineP95Ms === null && !config.candidateSets.every((candidateSet) => candidateSet.baselineLatencyMs !== null)) {
    reasons.push('baseline_latency_missing')
  }
  const continueReranker = reasons.length === 0
  return Object.freeze({
    schemaVersion: 1,
    configuration: Object.freeze({
      modelId: config.modelId,
      revision: config.revision,
      maxLength: config.maxLength,
      scoreType: config.scoreType,
      candidateLimit: config.candidateLimit,
      finalLimit: config.finalLimit,
      modelIdentityHash: config.modelIdentityHash
    }),
    input: Object.freeze({
      queryCount: config.queries.length,
      candidateSetCount: config.candidateSets.length,
      candidateSetHashes: Object.freeze(config.candidateSets.map((candidateSet) => candidateSet.candidateSetHash)),
      candidateSetPreserved
    }),
    baseline,
    reranked,
    comparison: Object.freeze({
      ...comparison,
      gate: Object.freeze({
        ...comparison.gate,
        continueReranker,
        decision: continueReranker ? 'continue_reranker' : 'stop_reranker',
        reasons: Object.freeze(reasons)
      })
    }),
    details: Object.freeze({ baseline: baselineDetails, reranked: rerankedDetails })
  })
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail('RAG_RERANK_CONFIG_INVALID', 'command argument requires a value.')
    }
    values[argument.slice(2).replaceAll('-', '')] = argv[++index]
  }
  return values
}

async function readInput(inputPath) {
  try {
    const serialized = inputPath
      ? await fs.readFile(path.resolve(inputPath), 'utf8')
      : await new Promise((resolve, reject) => {
          let value = ''
          process.stdin.setEncoding('utf8')
          process.stdin.on('data', (chunk) => { value += chunk })
          process.stdin.once('end', () => resolve(value))
          process.stdin.once('error', reject)
        })
    return JSON.parse(serialized)
  } catch {
    fail('RAG_RERANK_INPUT_INVALID', 'evaluation input is invalid.')
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const input = await readInput(args.input)
  let reranker
  if ((args.runner ?? 'http') === 'http') {
    reranker = createHttpReranker({ baseUrl: args.baseurl, timeoutMs: Number(args.timeoutms ?? 60_000) })
  } else if (args.runner === 'stdin') {
    let runnerArgs = []
    if (args.runnerargs) {
      try { runnerArgs = JSON.parse(args.runnerargs) } catch { fail('RAG_RERANK_CONFIG_INVALID', 'runnerArgs is invalid.') }
    }
    reranker = createStdinReranker({ command: args.runnercommand, args: runnerArgs, timeoutMs: Number(args.timeoutms ?? 60_000) })
  } else {
    fail('RAG_RERANK_CONFIG_INVALID', 'runner is invalid.')
  }
  const report = await runRagRerankerEvaluation({
    querySet: input.querySet ?? input.queries,
    candidateSets: input.candidateSets,
    baselineP95Ms: input.baselineP95Ms,
    reranker
  })
  process.stdout.write(`RAG_RERANKER_EVALUATION ${JSON.stringify(report)}\n`)
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'RAG_RERANK_FAILED'}\n`)
    process.exitCode = 1
  })
}
