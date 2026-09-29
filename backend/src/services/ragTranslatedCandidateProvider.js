// Request-local wrapper: translations influence recall only, never scope or evidence.
export function createTranslatedCandidateProvider({ candidateProvider, translationService, signal, maxCandidates = 50 }) {
  if (typeof candidateProvider !== 'function' || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 50) {
    throw new TypeError('Invalid candidate provider')
  }
  let translation, originalQuery
  const merge = lists => {
    const result = [], seen = new Set()
    for (let rank = 0; rank < maxCandidates && result.length < maxCandidates; rank++) {
      for (const list of lists) {
        const item = list?.[rank]
        if (!item) continue
        const key = JSON.stringify([item.sourceType, item.sourceId, item.snapshotId, item.chunkId])
        if (!seen.has(key) && result.length < maxCandidates) { seen.add(key); result.push(item) }
      }
    }
    // Scores from different queries are incomparable. Preserve the evaluated
    // original-first round-robin ordering before downstream channel ranking.
    return result.map((item, index) => ({ ...item, score: 1 / (index + 1) }))
  }
  return async options => {
    signal?.throwIfAborted()
    if (!translationService) return candidateProvider({ ...options, signal })
    if (!translation) {
      originalQuery = options.query
      translation = Promise.resolve().then(() => translationService.translate({ query: originalQuery, signal }))
        .catch(error => { if (signal?.aborted) throw error; return { queries: [originalQuery] } })
    }
    if (options.query !== originalQuery) throw new TypeError('Provider is request scoped')
    const value = await translation
    signal?.throwIfAborted()
    const queries = value?.status === 'enhanced' && Array.isArray(value.queries) && value.queries[0] === originalQuery &&
      value.queries.length <= 3 && value.queries.every(q => typeof q === 'string' && q.length <= 1024)
      ? [...new Set(value.queries)] : [originalQuery]
    if (queries.length === 1) return candidateProvider({ ...options, signal })
    const outputs = []
    for (const query of queries) {
      signal?.throwIfAborted()
      try {
        const output = await candidateProvider({ ...options, query, signal, limit: maxCandidates })
        signal?.throwIfAborted()
        if (!Array.isArray(output?.ftsCandidates)) throw new TypeError('Invalid candidates')
        outputs.push(output)
      } catch (error) {
        signal?.throwIfAborted()
        if (!outputs.length) throw error
        // Extra recall is optional. Do not suppress a failure of original recall.
      }
    }
    if (outputs.length === 1) return outputs[0]
    const first = outputs[0]
    return { ...first, ftsCandidates: merge(outputs.map(output => output.ftsCandidates)),
      ...(first.vectorError || !Array.isArray(first.vectorCandidates) ? {} : { vectorCandidates: merge(outputs.filter(output => !output.vectorError).map(output => output.vectorCandidates ?? [])) }) }
  }
}
