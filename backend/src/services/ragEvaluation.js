import { performance } from 'node:perf_hooks'

const QUERY_CATEGORIES = new Set([
  'exact_fact',
  'same_source_synthesis',
  'cross_source_synthesis',
  'version_conflict',
  'no_answer',
  'security'
])

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

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function normalizeTarget(target, path) {
  if (!isPlainObject(target) || !isPlainObject(target.locator)) throw new TypeError(`${path} is invalid`)
  const targetId = typeof target.targetId === 'string' && target.targetId.trim()
    ? target.targetId.trim()
    : (typeof target.entryKey === 'string' && target.entryKey.trim() ? target.entryKey.trim() : null)
  if (!targetId) throw new TypeError(`${path}.targetId is invalid`)
  return Object.freeze({
    targetId,
    entryKey: typeof target.entryKey === 'string' && target.entryKey.trim() ? target.entryKey.trim() : null,
    locator: Object.freeze({ ...target.locator })
  })
}

export function normalizeRagQuerySet(querySet) {
  if (!Array.isArray(querySet) || querySet.length < 60) throw new TypeError('querySet must contain at least 60 queries')
  const ids = new Set()
  return Object.freeze(querySet.map((item, index) => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.q !== 'string' || !item.q.trim() || !QUERY_CATEGORIES.has(item.category) ||
        !Array.isArray(item.expected) || !Array.isArray(item.forbidden)) {
      throw new TypeError(`querySet[${index}] is invalid`)
    }
    if (item.category === 'no_answer' && item.expected.length !== 0) {
      throw new TypeError(`querySet[${index}] no_answer query must not declare expected targets`)
    }
    if (!['no_answer', 'security'].includes(item.category) && item.expected.length === 0) {
      throw new TypeError(`querySet[${index}] must declare expected targets`)
    }
    ids.add(item.id)
    return Object.freeze({
      id: item.id,
      q: item.q,
      language: /[\u3400-\u9fff]/u.test(item.q) ? 'zh' : 'en',
      category: item.category,
      sourceTypes: Object.freeze(Array.isArray(item.sourceTypes) ? [...new Set(item.sourceTypes)] : []),
      filters: Object.freeze(isPlainObject(item.filters) ? { ...item.filters } : {}),
      expected: Object.freeze(item.expected.map((target, targetIndex) =>
        normalizeTarget(target, `querySet[${index}].expected[${targetIndex}]`))),
      forbidden: Object.freeze(item.forbidden.map((target, targetIndex) =>
        normalizeTarget(target, `querySet[${index}].forbidden[${targetIndex}]`)))
    })
  }))
}

function locatorMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => stableJson(actual?.[key]) === stableJson(value))
}

function matchesTarget(item, target) {
  return (target.entryKey !== null && item.entryKey === target.entryKey) || locatorMatches(item.locator, target.locator)
}

function queryMetrics(retrieved, query, k) {
  const top = retrieved.slice(0, k)
  const matched = new Map()
  top.forEach((item, rank) => {
    for (const target of query.expected) {
      if (!matched.has(target.targetId) && matchesTarget(item, target)) {
        matched.set(target.targetId, { item, target, rank })
        break
      }
    }
  })
  const relevant = [...matched.values()]
  const recall = query.expected.length === 0 ? (top.length === 0 ? 1 : 0) : relevant.length / query.expected.length
  const firstRank = relevant.length === 0 ? -1 : Math.min(...relevant.map(({ rank }) => rank))
  const dcg = relevant.reduce((sum, { rank }) => sum + (1 / Math.log2(rank + 2)), 0)
  const idealCount = Math.min(query.expected.length, k)
  let idealDcg = 0
  for (let rank = 0; rank < idealCount; rank += 1) idealDcg += 1 / Math.log2(rank + 2)
  const correctLocators = relevant.filter(({ item, target }) => locatorMatches(item.locator, target.locator)).length
  const forbiddenHits = query.forbidden.flatMap((target) => top.filter((item) => matchesTarget(item, target)))
  return Object.freeze({
    recall: round(recall),
    reciprocalRank: round(firstRank < 0 ? 0 : 1 / (firstRank + 1)),
    ndcg: round(query.expected.length === 0 ? recall : (idealDcg === 0 ? 0 : dcg / idealDcg)),
    locatorCorrect: correctLocators,
    relevantReturned: relevant.length,
    forbiddenHits: forbiddenHits.length,
    topKeys: Object.freeze(top.map((item) => item.entryKey))
  })
}

function average(rows, field) {
  return rows.length === 0 ? 0 : round(rows.reduce((sum, row) => sum + row[field], 0) / rows.length)
}

function groupReport(details, selector) {
  const groups = new Map()
  for (const detail of details) {
    for (const key of selector(detail)) {
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(detail)
    }
  }
  return Object.freeze(Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, rows]) => [
    key,
    Object.freeze({
      queryCount: rows.length,
      recallAt5: average(rows, 'recallAt5'),
      recallAt10: average(rows, 'recallAt10'),
      mrr: average(rows, 'reciprocalRank'),
      ndcgAt10: average(rows, 'ndcgAt10')
    })
  ])))
}

export function evaluateRagRetrieval(service, querySet, { iterations = 3 } = {}) {
  if (!service || typeof service.query !== 'function') throw new TypeError('service must expose query()')
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new TypeError('iterations is invalid')
  const queries = normalizeRagQuerySet(querySet)
  const latencies = []
  const details = []
  let locatorCorrect = 0
  let relevantReturned = 0
  let forbiddenHits = 0

  for (const query of queries) {
    let result
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now()
      result = service.query({ q: query.q, ...query.filters, limit: 10, offset: 0 })
      latencies.push(performance.now() - started)
    }
    const retrieved = Array.isArray(result?.data) ? result.data : []
    const at5 = queryMetrics(retrieved, query, 5)
    const at10 = queryMetrics(retrieved, query, 10)
    locatorCorrect += at10.locatorCorrect
    relevantReturned += at10.relevantReturned
    forbiddenHits += at10.forbiddenHits
    details.push(Object.freeze({
      id: query.id,
      category: query.category,
      language: query.language,
      answerable: query.expected.length > 0,
      sourceTypes: query.sourceTypes,
      recallAt5: at5.recall,
      recallAt10: at10.recall,
      reciprocalRank: at10.reciprocalRank,
      ndcgAt10: at10.ndcg,
      forbiddenHits: at10.forbiddenHits,
      topKeys: at10.topKeys
    }))
  }

  const noAnswer = details.filter((detail) => detail.category === 'no_answer')
  const answerable = details.filter((detail) => detail.answerable)
  return Object.freeze({
    queryCount: queries.length,
    answerableQueryCount: answerable.length,
    iterations,
    recallAt5: average(answerable, 'recallAt5'),
    recallAt10: average(answerable, 'recallAt10'),
    mrr: average(answerable, 'reciprocalRank'),
    ndcgAt10: average(answerable, 'ndcgAt10'),
    locatorAccuracy: round(relevantReturned === 0 ? 0 : locatorCorrect / relevantReturned),
    noAnswerAccuracy: average(noAnswer, 'recallAt10'),
    forbiddenHits,
    p50Ms: round(percentile(latencies, 0.5), 3),
    p95Ms: round(percentile(latencies, 0.95), 3),
    samples: latencies.length,
    byCategory: groupReport(details, (detail) => [detail.category]),
    byLanguage: groupReport(answerable, (detail) => [detail.language]),
    bySourceType: groupReport(answerable, (detail) => detail.sourceTypes),
    details: Object.freeze(details)
  })
}

export default evaluateRagRetrieval
