import { createCodeSymbolIndexService } from './codeSymbolIndexService.js'
import { createSearchIndexService, normalizeSearchQuery } from './searchIndexService.js'

const MODES = new Set(['fts', 'symbol', 'hybrid'])
const RRF_CONSTANT = 60
const SYMBOL_WEIGHT = 1.2
const MAX_CANDIDATES = 100

function modeFor(input) {
  const mode = input?.mode === undefined || input?.mode === '' ? 'hybrid' : String(input.mode).trim().toLowerCase()
  if (!MODES.has(mode)) {
    const error = new TypeError('Search mode is invalid.')
    error.code = 'SEARCH_INPUT_INVALID'
    throw error
  }
  return mode
}

function combinedStatus(ftsService, symbolService) {
  return Object.freeze({
    ...ftsService.getStatus(),
    symbols: symbolService.getStatus(),
    retrieval: Object.freeze({ defaultMode: 'hybrid', fusion: 'rrf', rrfConstant: RRF_CONSTANT, symbolWeight: SYMBOL_WEIGHT })
  })
}

function symbolResponse(ftsService, symbolService, input) {
  const result = symbolService.query(input)
  const summary = Object.freeze({
    document: 0,
    ebook: 0,
    ebook_chapter: 0,
    code_repository: 0,
    code_file: result.total,
    note: 0,
    audio: 0
  })
  return Object.freeze({
    query: result.query,
    data: result.data,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    summary,
    index: combinedStatus(ftsService, symbolService),
    retrieval: Object.freeze({ mode: 'symbol', degraded: false }),
    externalDiscovery: Object.freeze({ enabled: false, status: 'not_configured' })
  })
}

function fuseResults(ftsResults, symbolResults) {
  const candidates = new Map()
  const add = (item, rank, channel, weight) => {
    const key = item.entryKey
    const previous = candidates.get(key) ?? { item, score: 0, channels: [] }
    previous.score += weight / (RRF_CONSTANT + rank + 1)
    if (!previous.channels.includes(channel)) previous.channels.push(channel)
    candidates.set(key, previous)
  }
  ftsResults.forEach((item, index) => add(item, index, 'fts', 1))
  symbolResults.forEach((item, index) => add(item, index, 'symbol', SYMBOL_WEIGHT))
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || String(left.item.entryKey).localeCompare(String(right.item.entryKey)))
    .map(({ item, score, channels }) => Object.freeze({
      ...item,
      score,
      retrieval: Object.freeze({ channels: Object.freeze(channels), fusion: 'rrf' })
    }))
}

export class HybridSearchService {
  constructor({ database, collectEntries, ftsService, symbolService } = {}) {
    this.ftsService = ftsService ?? createSearchIndexService({ database, collectEntries })
    this.symbolService = symbolService ?? createCodeSymbolIndexService({ database })
    if (!this.ftsService || typeof this.ftsService.query !== 'function' || typeof this.ftsService.getStatus !== 'function') {
      throw new TypeError('ftsService is invalid')
    }
    if (!this.symbolService || typeof this.symbolService.query !== 'function' || typeof this.symbolService.getStatus !== 'function') {
      throw new TypeError('symbolService is invalid')
    }
  }

  getStatus() {
    return combinedStatus(this.ftsService, this.symbolService)
  }

  query(input = {}) {
    const mode = modeFor(input)
    if (mode === 'fts') {
      const result = this.ftsService.query(input)
      return Object.freeze({ ...result, index: combinedStatus(this.ftsService, this.symbolService), retrieval: Object.freeze({ mode: 'fts', degraded: false }) })
    }
    if (mode === 'symbol') return symbolResponse(this.ftsService, this.symbolService, input)

    const normalized = normalizeSearchQuery(input)
    if (normalized.offset + normalized.limit > MAX_CANDIDATES) {
      const result = this.ftsService.query(input)
      return Object.freeze({
        ...result,
        index: combinedStatus(this.ftsService, this.symbolService),
        retrieval: Object.freeze({ mode: 'fts', degraded: true, reason: 'deep_pagination' })
      })
    }
    const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(20, (normalized.offset + normalized.limit) * 2))
    const candidateInput = { ...input, limit: candidateLimit, offset: 0 }
    const fts = this.ftsService.query(candidateInput)
    const symbols = this.symbolService.query(candidateInput)
    if (symbols.index.status === 'missing') {
      const fallback = this.ftsService.query(input)
      return Object.freeze({
        ...fallback,
        index: combinedStatus(this.ftsService, this.symbolService),
        retrieval: Object.freeze({ mode: 'fts', degraded: true, reason: 'symbol_index_missing' })
      })
    }
    const fused = fuseResults(fts.data, symbols.data)
    const data = Object.freeze(fused.slice(normalized.offset, normalized.offset + normalized.limit))
    const summary = Object.freeze({
      ...fts.summary,
      code_file: Number(fts.summary?.code_file ?? 0) + symbols.total
    })
    return Object.freeze({
      query: normalized.keyword,
      data,
      total: fts.total + symbols.total,
      limit: normalized.limit,
      offset: normalized.offset,
      summary,
      index: combinedStatus(this.ftsService, this.symbolService),
      retrieval: Object.freeze({ mode: 'hybrid', degraded: false, fusion: 'rrf', candidateLimit }),
      externalDiscovery: fts.externalDiscovery
    })
  }
}

export function createHybridSearchService(options) {
  return new HybridSearchService(options)
}

export default createHybridSearchService
