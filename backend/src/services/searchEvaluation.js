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
      if (!isPlainObject(target) || typeof target.entryKey !== 'string' || !target.entryKey.trim() || !isPlainObject(target.locator)) {
        throw new TypeError(`querySet[${index}].expected[${targetIndex}] is invalid`)
      }
      return Object.freeze({ entryKey: target.entryKey, locator: Object.freeze({ ...target.locator }) })
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
  let correctCitations = 0
  let returnedRelevant = 0

  for (const query of queries) {
    let result
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const started = performance.now()
      result = service.query({ q: query.q, ...query.filters, limit: k, offset: 0 })
      latencies.push(performance.now() - started)
    }
    const expectedByKey = new Map(query.expected.map((target) => [target.entryKey, target]))
    const retrieved = result.data.slice(0, k)
    const relevant = retrieved.filter((item) => expectedByKey.has(item.entryKey))
    const recall = relevant.length / expectedByKey.size
    recallSum += recall
    for (const item of relevant) {
      returnedRelevant += 1
      if (stableJson(item.locator) === stableJson(expectedByKey.get(item.entryKey).locator)) correctCitations += 1
    }
    details.push(Object.freeze({
      id: query.id,
      recallAtK: round(recall),
      expected: expectedByKey.size,
      retrievedRelevant: relevant.length,
      topKeys: Object.freeze(retrieved.map((item) => item.entryKey))
    }))
  }

  return Object.freeze({
    queryCount: queries.length,
    k,
    iterations,
    recallAtK: round(recallSum / queries.length),
    citationAccuracy: round(returnedRelevant === 0 ? 0 : correctCitations / returnedRelevant),
    p50Ms: round(percentile(latencies, 0.5), 3),
    p95Ms: round(percentile(latencies, 0.95), 3),
    samples: latencies.length,
    details: Object.freeze(details)
  })
}

export default evaluateSearchIndex
