// One server-owned policy shared by HTTP queries and evaluation. Client input
// may choose a source/limit, never RRF weights or a raw visibility filter.
export function ragRetrievalPolicy({ source = null, limit = 10, overrides = {} } = {}) {
  const base = { rrfK: 60, ftsWeight: 0.75, vectorWeight: 0.25, maxPerSource: 2, ...overrides }
  return Object.freeze(source
    ? { ...base, maxPerSource: Math.min(limit, 6), minDistinctSources: 1, adjacentGap: 0 }
    : base)
}
