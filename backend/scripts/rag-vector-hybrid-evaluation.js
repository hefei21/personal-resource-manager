import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
import { SEARCH_INDEX_MIGRATIONS } from '../src/config/searchIndexSchema.js'
import { chunkTokenizedSections } from '../src/services/ragPreflight.js'
import { evaluateRagRetrieval, normalizeRagQuerySet } from '../src/services/ragEvaluation.js'
import { createSearchIndexService } from '../src/services/searchIndexService.js'

const require = createRequire(import.meta.url)

const CHUNK_CONFIGURATION = Object.freeze({ maxTokens: 768, overlapTokens: 96 })
const MAX_BATCH = 256
const MAX_DIMENSIONS = 65_536
const MAX_PREFIX_BYTES = 4 * 1024
const MAX_CACHE_ENTRIES = 200_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const DANGEROUS_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const DEFAULT_FUSION_GRID = Object.freeze([
  Object.freeze({ rrfK: 20, ftsWeight: 0.25, vectorWeight: 0.75, maxPerSource: 3 }),
  Object.freeze({ rrfK: 20, ftsWeight: 0.5, vectorWeight: 0.5, maxPerSource: 3 }),
  Object.freeze({ rrfK: 60, ftsWeight: 0.25, vectorWeight: 0.75, maxPerSource: 3 }),
  Object.freeze({ rrfK: 60, ftsWeight: 0.5, vectorWeight: 0.5, maxPerSource: 3 }),
  Object.freeze({ rrfK: 60, ftsWeight: 0.75, vectorWeight: 0.25, maxPerSource: 2 })
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
  return crypto.createHash('sha256').update(value).digest('hex')
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function requiredText(value, fieldName, maxBytes = 512, { allowControls = false, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('RAG_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').trim()
  if ((!allowEmpty && !normalized) || byteLength(normalized) > maxBytes || (!allowControls && DANGEROUS_CONTROL.test(normalized))) {
    fail('RAG_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return normalized
}

function prefixText(value, fieldName) {
  if (typeof value !== 'string' || byteLength(value.normalize('NFKC')) > MAX_PREFIX_BYTES || DANGEROUS_CONTROL.test(value)) {
    fail('RAG_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return value.normalize('NFKC')
}

function positiveInteger(value, fieldName, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('RAG_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  return value
}

function finiteVector(value, dimensions, fieldName) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', `${fieldName} is invalid.`)
  }
  return Object.freeze([...value])
}

function validateHash(value, fieldName) {
  const normalized = requiredText(value, fieldName, 64).toLowerCase()
  if (!HASH_PATTERN.test(normalized)) fail('RAG_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  return normalized
}

function endpointFor(baseUrl) {
  const endpoint = new URL(baseUrl)
  const pathname = endpoint.pathname.replace(/\/$/u, '')
  endpoint.pathname = pathname.endsWith('/embeddings')
    ? pathname
    : pathname.endsWith('/v1') ? `${pathname}/embeddings` : `${pathname}/v1/embeddings`
  return endpoint.toString()
}

function normalizeFusionGrid(value) {
  const grid = value ?? DEFAULT_FUSION_GRID
  if (!Array.isArray(grid) || grid.length === 0 || grid.length > 32) fail('RAG_EVAL_CONFIG_INVALID', 'fusionGrid is invalid.')
  return Object.freeze(grid.map((item, index) => {
    if (!isPlainObject(item)) fail('RAG_EVAL_CONFIG_INVALID', `fusionGrid[${index}] is invalid.`)
    const rrfK = positiveInteger(item.rrfK, `fusionGrid[${index}].rrfK`, 10_000)
    const ftsWeight = Number(item.ftsWeight)
    const vectorWeight = Number(item.vectorWeight)
    const maxPerSource = positiveInteger(item.maxPerSource, `fusionGrid[${index}].maxPerSource`, 100)
    if (!Number.isFinite(ftsWeight) || ftsWeight < 0 || !Number.isFinite(vectorWeight) || vectorWeight < 0 ||
        ftsWeight + vectorWeight <= 0) fail('RAG_EVAL_CONFIG_INVALID', `fusionGrid[${index}] weights are invalid.`)
    return Object.freeze({ rrfK, ftsWeight, vectorWeight, maxPerSource })
  }))
}

export function normalizeRagVectorEvaluationConfig(options = {}) {
  if (!isPlainObject(options)) fail('RAG_EVAL_CONFIG_INVALID', 'options are invalid.')
  const baseUrl = requiredText(options.baseUrl, 'baseUrl', 2048)
  let parsed
  try { parsed = new URL(baseUrl) } catch { fail('RAG_EVAL_CONFIG_INVALID', 'baseUrl is invalid.') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    fail('RAG_EVAL_CONFIG_INVALID', 'baseUrl is not safe.')
  }
  const modelId = requiredText(options.modelId, 'modelId', 512)
  const revision = requiredText(options.revision ?? options.modelRevision, 'revision', 256)
  const dimensions = positiveInteger(options.dimensions, 'dimensions', MAX_DIMENSIONS)
  const batch = positiveInteger(options.batch, 'batch', MAX_BATCH)
  const docPrefix = prefixText(options.docPrefix ?? '', 'docPrefix')
  const queryPrefix = prefixText(options.queryPrefix ?? '', 'queryPrefix')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 60_000, 'timeoutMs', 5 * 60_000)
  const apiKey = options.apiKey === undefined || options.apiKey === null ? null : requiredText(options.apiKey, 'apiKey', 4096)
  const explicitConfigHash = options.configHash === undefined ? null : validateHash(options.configHash, 'configHash')
  const modelConfigHash = explicitConfigHash ?? sha256(stableJson({ modelId, revision, dimensions, docPrefix, queryPrefix }))
  const cachePath = options.cachePath === undefined || options.cachePath === null || options.cachePath === ''
    ? null
    : path.resolve(String(options.cachePath))
  if (!options.tokenizer || typeof options.tokenizer.encode !== 'function' || typeof options.tokenizer.decode !== 'function') {
    fail('RAG_EVAL_TOKENIZER_REQUIRED', 'tokenizer adapter is required.')
  }
  return Object.freeze({
    baseUrl: parsed.toString().replace(/\/$/u, ''),
    endpoint: endpointFor(parsed.toString()),
    modelId,
    revision,
    dimensions,
    batch,
    docPrefix,
    queryPrefix,
    timeoutMs,
    apiKey,
    modelConfigHash,
    cachePath,
    tokenizer: options.tokenizer,
    fusionGrid: normalizeFusionGrid(options.fusionGrid),
    iterations: positiveInteger(options.iterations ?? 1, 'iterations', 10),
    fetchImpl: options.fetchImpl ?? fetch,
    corpusDirectory: path.resolve(String(options.corpusDirectory ?? '.rag-evaluation-corpus'))
  })
}

function resolveManifestFile(root, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) fail('RAG_EVAL_CORPUS_INVALID', 'manifest source file is invalid.')
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, file)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail('RAG_EVAL_CORPUS_INVALID', 'manifest source file is invalid.')
  }
  return resolved
}

async function loadJson(urlOrPath, code) {
  try { return JSON.parse(await fs.readFile(urlOrPath, 'utf8')) } catch { fail(code, 'evaluation input is invalid.') }
}

async function readManifestCorpus(config, corpusFixture) {
  const fixture = corpusFixture ?? await loadJson(new URL('../test/fixtures/rag-evaluation-corpus.json', import.meta.url), 'RAG_EVAL_CORPUS_INVALID')
  if (!isPlainObject(fixture) || fixture.schemaVersion !== 1 || !Array.isArray(fixture.publicSources) || !Array.isArray(fixture.syntheticSources)) {
    fail('RAG_EVAL_CORPUS_INVALID', 'corpus fixture is invalid.')
  }
  const manifest = await loadJson(path.join(config.corpusDirectory, 'manifest.json'), 'RAG_EVAL_MANIFEST_INVALID')
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    fail('RAG_EVAL_MANIFEST_INVALID', 'corpus manifest is invalid.')
  }
  const publicById = new Map(fixture.publicSources.map((source) => [source.id, source]))
  if (publicById.size !== fixture.publicSources.length || manifest.sources.length !== publicById.size) {
    fail('RAG_EVAL_MANIFEST_INVALID', 'corpus manifest source count is invalid.')
  }
  const seen = new Set()
  const entries = []
  for (const manifestSource of manifest.sources) {
    if (!isPlainObject(manifestSource) || typeof manifestSource.id !== 'string' || seen.has(manifestSource.id) ||
        !Number.isSafeInteger(manifestSource.bytes) || manifestSource.bytes < 1 ||
        !HASH_PATTERN.test(String(manifestSource.sha256 ?? '').toLowerCase())) {
      fail('RAG_EVAL_MANIFEST_INVALID', 'corpus manifest source is invalid.')
    }
    const source = publicById.get(manifestSource.id)
    if (!source || !isPlainObject(source.entry)) fail('RAG_EVAL_MANIFEST_INVALID', 'corpus manifest source is unknown.')
    seen.add(manifestSource.id)
    const filePath = resolveManifestFile(config.corpusDirectory, manifestSource.file)
    let bytes
    try { bytes = await fs.readFile(filePath) } catch { fail('RAG_EVAL_MANIFEST_INVALID', 'corpus source is unavailable.') }
    if (bytes.length !== manifestSource.bytes || sha256(bytes) !== String(manifestSource.sha256).toLowerCase() || bytes.includes(0)) {
      fail('RAG_EVAL_MANIFEST_INVALID', 'corpus source hash is invalid.')
    }
    const body = bytes.toString('utf8')
    const chunks = chunkTokenizedSections([{ sectionPath: [source.id], text: body }], config.tokenizer, CHUNK_CONFIGURATION)
    for (const chunk of chunks) {
      entries.push(Object.freeze({
        ...source.entry,
        entryKey: `${source.entry.entryKey}:chunk:${chunk.ordinal}`,
        title: `${source.entry.title} [${chunk.ordinal + 1}/${chunks.length}]`,
        body: chunk.body,
        sourceKey: source.id,
        sourceHash: String(manifestSource.sha256).toLowerCase(),
        contentHash: chunk.bodySha256,
        indexStatus: 'ready'
      }))
    }
  }
  if (seen.size !== publicById.size) fail('RAG_EVAL_MANIFEST_INVALID', 'corpus manifest is incomplete.')
  for (const source of fixture.syntheticSources) {
    if (!isPlainObject(source) || !isPlainObject(source.entry) || typeof source.entry.body !== 'string' || !source.entry.body.trim()) {
      fail('RAG_EVAL_CORPUS_INVALID', 'synthetic source is invalid.')
    }
    const contentHash = sha256(source.entry.body)
    entries.push(Object.freeze({
      ...source.entry,
      sourceKey: source.id,
      sourceHash: contentHash,
      contentHash,
      indexStatus: source.entry.indexStatus ?? 'ready'
    }))
  }
  return Object.freeze({ entries: Object.freeze(entries), sourceCount: manifest.sources.length + fixture.syntheticSources.length })
}

function cacheKey(kind, sourceHash, contentHash, modelConfigHash) {
  return sha256(stableJson({ kind, sourceHash, contentHash, modelConfigHash }))
}

async function loadCache(cachePath) {
  const state = { schemaVersion: 1, entries: {}, stats: { hits: 0, misses: 0, stale: 0 } }
  if (!cachePath) return state
  let value
  try { value = JSON.parse(await fs.readFile(cachePath, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return state
    return state
  }
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !isPlainObject(value.entries)) return state
  const entries = Object.entries(value.entries).slice(0, MAX_CACHE_ENTRIES)
  for (const [key, entry] of entries) if (HASH_PATTERN.test(key) && isPlainObject(entry)) state.entries[key] = entry
  return state
}

function cacheVector(state, item, config, kind) {
  const key = cacheKey(kind, item.sourceHash, item.contentHash, config.modelConfigHash)
  const direct = state.entries[key]
  if (direct && direct.kind === kind && direct.sourceHash === item.sourceHash && direct.contentHash === item.contentHash &&
      direct.modelConfigHash === config.modelConfigHash) {
    try {
      state.stats.hits += 1
      return finiteVector(direct.vector, config.dimensions, 'cache.vector')
    } catch {
      delete state.entries[key]
    }
  }
  const stale = Object.values(state.entries).some((entry) => entry.kind === kind && entry.sourceHash === item.sourceHash &&
    entry.contentHash === item.contentHash && entry.modelConfigHash !== config.modelConfigHash)
  if (stale) state.stats.stale += 1
  state.stats.misses += 1
  return null
}

function putCacheVector(state, item, config, kind, vector) {
  const key = cacheKey(kind, item.sourceHash, item.contentHash, config.modelConfigHash)
  state.entries[key] = {
    kind,
    sourceHash: item.sourceHash,
    contentHash: item.contentHash,
    modelConfigHash: config.modelConfigHash,
    vector: [...vector]
  }
}

async function saveCache(cachePath, state) {
  if (!cachePath) return
  const directory = path.dirname(cachePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = `${cachePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, entries: state.entries })}\n`, { mode: 0o600 })
    await fs.rename(temporary, cachePath)
  } catch (error) {
    try { await fs.rm(temporary, { force: true }) } catch {}
    fail('RAG_EVAL_CACHE_WRITE_FAILED', 'vector cache could not be written.')
  }
}

async function requestEmbeddings(config, texts) {
  const controller = AbortSignal.timeout(config.timeoutMs)
  const headers = { accept: 'application/json', 'content-type': 'application/json' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
  let response
  try {
    response = await config.fetchImpl(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.modelId, input: texts.length === 1 ? texts[0] : texts, encoding_format: 'float' }),
      signal: controller
    })
  } catch {
    if (controller.aborted) fail('RAG_EVAL_EMBEDDING_TIMEOUT', 'embedding request timed out.')
    fail('RAG_EVAL_EMBEDDING_UNAVAILABLE', 'embedding endpoint is unavailable.')
  }
  if (!response?.ok) fail('RAG_EVAL_EMBEDDING_HTTP_FAILED', 'embedding endpoint rejected the request.')
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isSafeInteger(contentLength) && contentLength > MAX_RESPONSE_BYTES) fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response is too large.')
  let payload
  try { payload = await response.json() } catch { fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response is invalid.') }
  let serialized
  try { serialized = JSON.stringify(payload) } catch { fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response is invalid.') }
  if (typeof serialized !== 'string' || byteLength(serialized) > MAX_RESPONSE_BYTES) fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response is too large.')
  if (!isPlainObject(payload) || payload.model !== config.modelId || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
    fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response identity or count is invalid.')
  }
  const ordered = [...payload.data].sort((left, right) => Number(left?.index) - Number(right?.index))
  return Object.freeze(ordered.map((item, index) => {
    if (!isPlainObject(item) || Object.keys(item).some((key) => !['object', 'index', 'embedding'].includes(key)) ||
        item.index !== index || (item.object !== undefined && item.object !== 'embedding')) {
      fail('RAG_EVAL_EMBEDDING_RESPONSE_INVALID', 'embedding response item is invalid.')
    }
    return finiteVector(item.embedding, config.dimensions, `embedding.data[${index}]`)
  }))
}

async function embedItems(items, kind, prefix, config, cacheState, embeddingLatencies) {
  const vectors = new Map()
  const missing = []
  for (const item of items) {
    const cached = cacheVector(cacheState, item, config, kind)
    if (cached) vectors.set(item.id, cached)
    else missing.push(item)
  }
  let calls = 0
  for (let start = 0; start < missing.length; start += config.batch) {
    const batch = missing.slice(start, start + config.batch)
    const started = performance.now()
    const batchVectors = await requestEmbeddings(config, batch.map((item) => `${prefix}${item.text}`))
    embeddingLatencies.push(performance.now() - started)
    calls += 1
    batch.forEach((item, index) => {
      vectors.set(item.id, batchVectors[index])
      putCacheVector(cacheState, item, config, kind, batchVectors[index])
    })
  }
  return Object.freeze({ vectors, calls })
}

function tokenize(value) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und')
  const tokens = []
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const token = match[0]
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = [...token]
      tokens.push(...characters)
      for (let index = 0; index + 1 < characters.length; index += 1) tokens.push(`${characters[index]}${characters[index + 1]}`)
    } else tokens.push(token)
  }
  return [...new Set(tokens)].slice(0, 64)
}

function sourceKey(entry) {
  return entry.sourceKey ?? entry.entryKey.split(':chunk:')[0]
}

function matchesFilters(entry, filters = {}) {
  const scope = filters.scope ?? 'owned'
  if (scope !== 'all' && entry.resultScope !== scope) return false
  const types = filters.type ?? filters.types
  if (types !== undefined) {
    const allowed = (Array.isArray(types) ? types : String(types).split(',')).map((value) => String(value).trim()).filter(Boolean)
    if (allowed.length > 0 && !allowed.includes(entry.resourceType)) return false
  }
  if (filters.status !== undefined && String(entry.status ?? '').toLowerCase() !== String(filters.status).toLowerCase()) return false
  return true
}

function ftsRank(entries, query, filters) {
  const terms = tokenize(query)
  const ranked = []
  for (const entry of entries) {
    if (!matchesFilters(entry, filters)) continue
    const text = `${entry.title}\n${entry.body}`.normalize('NFKC').toLocaleLowerCase('und')
    let score = 0
    for (const term of terms) if (text.includes(term)) score += 1
    if (score > 0) ranked.push({ entry, score })
  }
  ranked.sort((left, right) => right.score - left.score || left.entry.entryKey.localeCompare(right.entry.entryKey))
  return ranked.map((item) => item.entry)
}

async function createFtsRanker(entries) {
  let database
  try {
    const Database = require('better-sqlite3')
    database = new Database(':memory:')
    const registry = createMigrationRegistry(SEARCH_INDEX_MIGRATIONS)
    ensureMigrationControlTables(database)
    executeMigrationBatch({ database, registry, plan: createMigrationPlan(registry, []), lock: { state: 'active' } })
    const service = createSearchIndexService({ database, collectEntries: async () => entries })
    await service.refresh({ rebuild: true })
    const byKey = new Map(entries.map((entry) => [entry.entryKey, entry]))
    return {
      engine: 'sqlite-fts5',
      rank(query, filters) {
        const result = service.query({ q: query, ...filters, limit: 100, offset: 0 })
        return result.data.map((item) => byKey.get(item.entryKey)).filter(Boolean)
      },
      close() { database.close() }
    }
  } catch {
    try { database?.close() } catch {}
    return { engine: 'deterministic-token-overlap', rank: (query, filters) => ftsRank(entries, query, filters), close() {} }
  }
}

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}

function vectorRank(entries, queryVector, vectors, filters) {
  return entries.filter((entry) => matchesFilters(entry, filters)).sort((left, right) => {
    const difference = cosine(vectors.get(left.entryKey), queryVector) - cosine(vectors.get(right.entryKey), queryVector)
    return difference !== 0 ? -difference : left.entryKey.localeCompare(right.entryKey)
  })
}

function capBySource(entries, maxPerSource, limit = 10) {
  const counts = new Map()
  const selected = []
  for (const entry of entries) {
    const key = sourceKey(entry)
    const count = counts.get(key) ?? 0
    if (count >= maxPerSource) continue
    counts.set(key, count + 1)
    selected.push(entry)
    if (selected.length >= limit) break
  }
  return selected
}

function fuseRanks(fts, vector, options) {
  const scores = new Map()
  const add = (entries, weight) => entries.forEach((entry, rank) => {
    scores.set(entry.entryKey, (scores.get(entry.entryKey) ?? 0) + weight / (options.rrfK + rank + 1))
  })
  add(fts, options.ftsWeight)
  add(vector, options.vectorWeight)
  const byKey = new Map([...fts, ...vector].map((entry) => [entry.entryKey, entry]))
  return [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([key]) => byKey.get(key))
}

function percentile(values, ratio) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function addLatency(report, embeddingLatencies) {
  return Object.freeze({
    ...report,
    embeddingP50Ms: Math.round(percentile(embeddingLatencies, 0.5) * 1000) / 1000,
    embeddingP95Ms: Math.round(percentile(embeddingLatencies, 0.95) * 1000) / 1000
  })
}

function rankReport(entries, normalizedQueries, ranker, iterations) {
  const byQuery = new Map(normalizedQueries.map((query) => [query.q, query]))
  const service = {
    query(input) {
      const query = byQuery.get(input.q)
      if (!query) return { data: [] }
      const ranked = ranker(query.q, query.filters)
      return { data: ranked.slice(0, 10).map((entry) => ({ entryKey: entry.entryKey, locator: entry.locator })) }
    }
  }
  return evaluateRagRetrieval(service, normalizedQueries, { iterations })
}

export async function runRagVectorHybridEvaluation(options = {}) {
  const config = normalizeRagVectorEvaluationConfig(options)
  const queries = normalizeRagQuerySet(options.querySet ?? await loadJson(new URL('../test/fixtures/rag-evaluation-queries.json', import.meta.url), 'RAG_EVAL_QUERY_SET_INVALID'))
  const corpus = await readManifestCorpus(config, options.corpusFixture)
  const cacheState = await loadCache(config.cachePath)
  const embeddingLatencies = []
  const documentItems = corpus.entries.map((entry) => ({
    id: entry.entryKey,
    sourceHash: entry.sourceHash,
    contentHash: entry.contentHash,
    sourceKey: sourceKey(entry),
    text: entry.body
  }))
  const queryItems = queries.map((query) => ({
    id: query.id,
    sourceHash: sha256(query.q),
    contentHash: sha256(query.q),
    text: query.q
  }))
  const documents = await embedItems(documentItems, 'document', config.docPrefix, config, cacheState, embeddingLatencies)
  const queryVectors = await embedItems(queryItems, 'query', config.queryPrefix, config, cacheState, embeddingLatencies)
  const vectors = new Map(documentItems.map((item) => [item.id, documents.vectors.get(item.id)]))
  const normalizedQueries = queries
  const fts = await createFtsRanker(corpus.entries)
  const vectorRanker = (queryText, filters) => {
    const query = normalizedQueries.find((item) => item.q === queryText)
    const vector = queryVectors.vectors.get(query.id)
    return capBySource(vectorRank(corpus.entries, vector, vectors, filters), 3)
  }
  const vectorReport = addLatency(rankReport(corpus.entries, normalizedQueries, vectorRanker, config.iterations), embeddingLatencies)
  const hybridReports = config.fusionGrid.map((fusion) => {
    const ranker = (queryText, filters) => {
      const query = normalizedQueries.find((item) => item.q === queryText)
      const vector = queryVectors.vectors.get(query.id)
      const lexical = fts.rank(queryText, filters)
      const semantic = vectorRank(corpus.entries, vector, vectors, filters)
      return capBySource(fuseRanks(lexical, semantic, fusion), fusion.maxPerSource)
    }
    const report = addLatency(rankReport(corpus.entries, normalizedQueries, ranker, config.iterations), embeddingLatencies)
    return Object.freeze({ ...fusion, report })
  })
  fts.close()
  await saveCache(config.cachePath, cacheState)
  return Object.freeze({
    schemaVersion: 1,
    configuration: Object.freeze({
      chunker: CHUNK_CONFIGURATION,
      modelId: config.modelId,
      revision: config.revision,
      dimensions: config.dimensions,
      batch: config.batch,
      docPrefix: config.docPrefix,
      queryPrefix: config.queryPrefix,
      modelConfigHash: config.modelConfigHash
    }),
    corpus: Object.freeze({ sourceCount: corpus.sourceCount, chunkCount: corpus.entries.length, ftsEngine: fts.engine }),
    cache: Object.freeze({ ...cacheState.stats, documentCalls: documents.calls, queryCalls: queryVectors.calls }),
    modes: Object.freeze({
      vector: vectorReport,
      hybrid: Object.freeze(hybridReports)
    })
  })
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) fail('RAG_EVAL_CONFIG_INVALID', 'unsupported command argument.')
    const key = argument.slice(2).replaceAll('-', '')
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('RAG_EVAL_CONFIG_INVALID', 'command argument requires a value.')
    values[key] = argv[++index]
  }
  return values
}

async function loadTokenizer(modulePath, modelPath) {
  if (!modulePath || !modelPath) fail('RAG_EVAL_TOKENIZER_REQUIRED', 'tokenizer module and model path are required.')
  let moduleValue
  try { moduleValue = await import(pathToFileURL(path.resolve(modulePath)).href) } catch { fail('RAG_EVAL_TOKENIZER_REQUIRED', 'tokenizer module is unavailable.') }
  const AutoTokenizer = moduleValue.AutoTokenizer ?? moduleValue.default?.AutoTokenizer
  if (!AutoTokenizer || typeof AutoTokenizer.from_pretrained !== 'function') fail('RAG_EVAL_TOKENIZER_REQUIRED', 'tokenizer adapter is unavailable.')
  let tokenizer
  try { tokenizer = await AutoTokenizer.from_pretrained(path.resolve(modelPath), { local_files_only: true }) } catch { fail('RAG_EVAL_TOKENIZER_REQUIRED', 'tokenizer model is unavailable.') }
  return {
    encode(text) { return tokenizer.encode(text, { add_special_tokens: false }) },
    decode(tokens) { return tokenizer.decode(tokens, { skip_special_tokens: false }) }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const tokenizer = await loadTokenizer(args.tokenizermodule ?? process.env.TRANSFORMERS_MODULE, args.tokenizerpath ?? process.env.EMBEDDING_MODEL_PATH)
  const report = await runRagVectorHybridEvaluation({
    corpusDirectory: args.corpusdir ?? process.env.RAG_CORPUS_DIRECTORY ?? '.rag-evaluation-corpus',
    cachePath: args.cachepath ?? process.env.RAG_VECTOR_CACHE_PATH ?? '.rag-vector-cache.json',
    baseUrl: args.baseurl ?? process.env.EMBEDDINGS_BASE_URL,
    modelId: args.modelid ?? process.env.EMBEDDING_MODEL_ID,
    revision: args.revision ?? process.env.EMBEDDING_MODEL_REVISION,
    dimensions: Number(args.dimensions ?? process.env.EMBEDDING_DIMENSIONS),
    batch: Number(args.batch ?? process.env.EMBEDDING_BATCH),
    docPrefix: args.docprefix ?? process.env.EMBEDDING_DOC_PREFIX ?? '',
    queryPrefix: args.queryprefix ?? process.env.EMBEDDING_QUERY_PREFIX ?? '',
    configHash: args.confighash ?? process.env.EMBEDDING_CONFIG_HASH,
    apiKey: args.apikey ?? process.env.EMBEDDING_API_KEY,
    tokenizer
  })
  process.stdout.write(`RAG_VECTOR_HYBRID_EVALUATION ${JSON.stringify(report)}\n`)
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'RAG_EVAL_FAILED'}\n`)
    process.exitCode = 1
  })
}
