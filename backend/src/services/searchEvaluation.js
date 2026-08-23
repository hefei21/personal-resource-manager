import { performance } from 'node:perf_hooks'

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

function normalizeQuerySet(querySet) {
  if (!Array.isArray(querySet) || querySet.length === 0) throw new TypeError('querySet must be a non-empty array')
  return querySet.map((item, index) => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim() ||
        typeof item.q !== 'string' || !item.q.trim() || !Array.isArray(item.expected) || item.expected.length === 0) {
      throw new TypeError(`querySet[${index}] is invalid`)
    }
    const expected = item.expected.map((target, targetIndex) => {
      if (!isPlainObject(target) || !isPlainObject(target.locator) ||
          !((typeof target.entryKey === 'string' && target.entryKey.trim()) ||
            (typeof target.targetId === 'string' && target.targetId.trim()))) {
        throw new TypeError(`querySet[${index}].expected[${targetIndex}] is invalid`)
      }
      return Object.freeze({
        entryKey: typeof target.entryKey === 'string' && target.entryKey.trim() ? target.entryKey : null,
        targetId: typeof target.targetId === 'string' && target.targetId.trim() ? target.targetId : target.entryKey,
        locator: Object.freeze({ ...target.locator })
      })
    })
    const filters = isPlainObject(item.filters) ? Object.freeze({ ...item.filters }) : Object.freeze({})
    return Object.freeze({ id: item.id, q: item.q, filters, expected: Object.freeze(expected) })
  })
}

export function evaluateSearchIndex(service, querySet, { k = 5, iterations = 3 } = {}) {
  if (!service || typeof service.query !== 'function') throw new TypeError('service must expose query()')
  if (!Number.isSafeInteger(k) || k < 1 || k > 100) throw new TypeError('k is invalid')
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new TypeError('iterations is invalid')
  const queries = normalizeQuerySet(querySet)
  const latencies = []
  const details = []
  let recallSum = 0
  let reciprocalRankSum = 0
  let correctCitations = 0
  let returnedRelevant = 0

  for (const query of queries) {
    let result
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now()
      result = service.query({ q: query.q, ...query.filters, limit: k, offset: 0 })
      latencies.push(performance.now() - started)
    }
    const retrieved = result.data.slice(0, k)
    const locatorMatches = (actual, expected) => Object.entries(expected)
      .every(([key, value]) => stableJson(actual?.[key]) === stableJson(value))
    const matchesTarget = (item, target) =>
      (target.entryKey !== null && item.entryKey === target.entryKey) || locatorMatches(item.locator, target.locator)
    const matchedTargets = new Map()
    retrieved.forEach((item, rank) => {
      for (const target of query.expected) {
        if (!matchedTargets.has(target.targetId) && matchesTarget(item, target)) {
          matchedTargets.set(target.targetId, { item, target, rank })
          break
        }
      }
    })
    const relevant = [...matchedTargets.values()]
    const recall = relevant.length / query.expected.length
    recallSum += recall
    const firstRank = relevant.length > 0 ? Math.min(...relevant.map(({ rank }) => rank)) : -1
    reciprocalRankSum += firstRank < 0 ? 0 : 1 / (firstRank + 1)
    for (const { item, target } of relevant) {
      returnedRelevant += 1
      if (locatorMatches(item.locator, target.locator)) correctCitations += 1
    }
    details.push(Object.freeze({
      id: query.id,
      recallAtK: round(recall),
      reciprocalRank: round(firstRank < 0 ? 0 : 1 / (firstRank + 1)),
      expected: query.expected.length,
      retrievedRelevant: relevant.length,
      topKeys: Object.freeze(retrieved.map((item) => item.entryKey))
    }))
  }

  return Object.freeze({
    queryCount: queries.length,
    k,
    iterations,
    recallAtK: round(recallSum / queries.length),
    mrr: round(reciprocalRankSum / queries.length),
    citationAccuracy: round(returnedRelevant === 0 ? 0 : correctCitations / returnedRelevant),
    locatorAccuracy: round(returnedRelevant === 0 ? 0 : correctCitations / returnedRelevant),
    p50Ms: round(percentile(latencies, 0.5), 3),
    p95Ms: round(percentile(latencies, 0.95), 3),
    samples: latencies.length,
    details: Object.freeze(details)
  })
}

export function evaluateSearchModes(service, querySet, { modes = ['fts', 'symbol', 'hybrid'], ...options } = {}) {
  if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !['fts', 'symbol', 'hybrid'].includes(mode))) {
    throw new TypeError('modes are invalid')
  }
  const reports = Object.fromEntries(modes.map((mode) => [
    mode,
    evaluateSearchIndex(service, querySet.map((query) => ({
      ...query,
      filters: { ...(query.filters ?? {}), mode }
    })), options)
  ]))
  const baseline = reports.fts
  const hybrid = reports.hybrid
  return Object.freeze({
    modes: Object.freeze(reports),
    improvement: baseline && hybrid
      ? Object.freeze({
          recallAtK: round(hybrid.recallAtK - baseline.recallAtK),
          mrr: round(hybrid.mrr - baseline.mrr),
          locatorAccuracy: round(hybrid.locatorAccuracy - baseline.locatorAccuracy)
        })
      : null
  })
}

export default evaluateSearchIndex
