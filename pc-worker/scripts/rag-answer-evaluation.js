import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

import { createRagAnswerProcessor, RAG_ANSWER_TASK_TYPE } from '../src/ragAnswerProcessor.js'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(SCRIPT_PATH)
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_QUERY_PATH = path.join(REPOSITORY_ROOT, 'backend', 'test', 'fixtures', 'rag-evaluation-queries.json')
const DEFAULT_GROUND_TRUTH_PATH = path.join(REPOSITORY_ROOT, 'backend', 'test', 'fixtures', 'rag-answer-ground-truth.json')
const DEFAULT_CORPUS_PATH = path.join(REPOSITORY_ROOT, 'backend', 'test', 'fixtures', 'rag-evaluation-corpus.json')

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const REQUIRED_CATEGORY_COUNTS = Object.freeze({
  exact_fact: 24,
  same_source_synthesis: 10,
  cross_source_synthesis: 8,
  version_conflict: 6,
  no_answer: 6,
  security: 10
})

const DEFAULT_OPTIONS = Object.freeze({
  baseUrl: 'http://127.0.0.1:1234',
  provider: 'lm-studio',
  modelId: 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k',
  modelRevision: 'Q6_K',
  contextLimit: 32_768,
  maxOutputBytes: 16_384,
  maxEvidenceItems: 8,
  timeoutMs: 180_000,
  dimensions: 1
})

export class RagAnswerEvaluationError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'RagAnswerEvaluationError'
    this.code = code
  }
}

function fail(code, message = code) {
  throw new RagAnswerEvaluationError(code, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath))
}

function integer(value, fieldName, min, max, fallback) {
  const candidate = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return candidate
}

function requiredText(value, fieldName, maxBytes = 512) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > maxBytes) {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return value.trim()
}

function safePath(value, fieldName, fallback) {
  const normalized = value === undefined || value === '' ? fallback : value
  if (typeof normalized !== 'string' || normalized.trim() === '') {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${fieldName} is invalid.`)
  }
  return path.resolve(normalized)
}

function parseIds(value) {
  if (value === undefined || value === null || value === '') return null
  const values = Array.isArray(value) ? value : String(value).split(',')
  const ids = values.map((item) => String(item).trim()).filter(Boolean)
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'ids is invalid.')
  }
  return ids
}

function answerConfigHash({ provider, modelId, modelRevision, contextLimit, maxOutputBytes, maxEvidenceItems }) {
  return sha256(JSON.stringify({ provider, modelId, modelRevision, contextLimit, maxOutputBytes, maxEvidenceItems }))
}

export function normalizeRagAnswerEvaluationConfig(options = {}) {
  const environment = options.env ?? process.env
  const provider = requiredText(options.provider ?? environment.RAG_ANSWER_PROVIDER ?? DEFAULT_OPTIONS.provider, 'provider')
  const modelId = requiredText(options.modelId ?? environment.RAG_ANSWER_MODEL_ID ?? DEFAULT_OPTIONS.modelId, 'modelId')
  const modelRevision = requiredText(options.modelRevision ?? environment.RAG_ANSWER_MODEL_REVISION ?? DEFAULT_OPTIONS.modelRevision, 'modelRevision')
  const baseUrl = requiredText(options.baseUrl ?? environment.RAG_ANSWER_BASE_URL ?? DEFAULT_OPTIONS.baseUrl, 'baseUrl', 2048)
  let parsedUrl
  try { parsedUrl = new URL(baseUrl) } catch { fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'baseUrl is invalid.') }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'baseUrl is not safe.')
  }
  const contextLimit = integer(options.contextLimit ?? environment.RAG_ANSWER_CONTEXT_LIMIT, 'contextLimit', 1, 8 * 1024 * 1024, DEFAULT_OPTIONS.contextLimit)
  const maxOutputBytes = integer(options.maxOutputBytes ?? environment.RAG_ANSWER_MAX_OUTPUT_BYTES, 'maxOutputBytes', 1, 256 * 1024, DEFAULT_OPTIONS.maxOutputBytes)
  const maxEvidenceItems = integer(options.maxEvidenceItems ?? environment.RAG_ANSWER_MAX_EVIDENCE, 'maxEvidenceItems', 1, 64, DEFAULT_OPTIONS.maxEvidenceItems)
  const timeoutMs = integer(options.timeoutMs ?? environment.RAG_ANSWER_TIMEOUT_MS, 'timeoutMs', 1_000, 5 * 60_000, DEFAULT_OPTIONS.timeoutMs)
  const dimensions = integer(options.dimensions ?? environment.RAG_ANSWER_DIMENSIONS, 'dimensions', 1, 65_536, DEFAULT_OPTIONS.dimensions)
  const configHash = options.configHash ?? environment.RAG_ANSWER_CONFIG_HASH ?? answerConfigHash({ provider, modelId, modelRevision, contextLimit, maxOutputBytes, maxEvidenceItems })
  if (typeof configHash !== 'string' || !HASH_PATTERN.test(configHash.toLowerCase())) {
    fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'configHash is invalid.')
  }
  const limit = options.limit === undefined || options.limit === null || options.limit === ''
    ? null
    : integer(options.limit, 'limit', 1, 64, null)
  const apiKey = options.apiKey ?? environment.RAG_ANSWER_API_KEY
  return Object.freeze({
    queryPath: safePath(options.queryPath ?? environment.RAG_ANSWER_QUERY_PATH, 'queryPath', DEFAULT_QUERY_PATH),
    groundTruthPath: safePath(options.groundTruthPath ?? environment.RAG_ANSWER_GROUND_TRUTH_PATH, 'groundTruthPath', DEFAULT_GROUND_TRUTH_PATH),
    corpusPath: safePath(options.corpusPath ?? environment.RAG_ANSWER_CORPUS_PATH, 'corpusPath', DEFAULT_CORPUS_PATH),
    ids: parseIds(options.ids ?? environment.RAG_ANSWER_IDS),
    limit,
    baseUrl: parsedUrl.toString().replace(/\/$/u, ''),
    provider,
    modelId,
    modelRevision,
    contextLimit,
    maxOutputBytes,
    maxEvidenceItems,
    timeoutMs,
    dimensions,
    configHash: configHash.toLowerCase(),
    apiKey: apiKey === undefined || apiKey === '' ? null : apiKey
  })
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    fail(code, 'Evaluation fixture is invalid.')
  }
}

function expectedTargetIds(query) {
  if (!Array.isArray(query.expected)) fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query expected targets are invalid.')
  if (query.expected.some((item) => !isPlainObject(item) || typeof item.targetId !== 'string' || !item.targetId)) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query expected target is invalid.')
  }
  return query.expected.map((item) => item.targetId)
}

function forbiddenTargetIds(query) {
  if (!Array.isArray(query.forbidden)) fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query forbidden targets are invalid.')
  if (query.forbidden.some((item) => !isPlainObject(item) || typeof item.targetId !== 'string' || !item.targetId)) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query forbidden target is invalid.')
  }
  return query.forbidden.map((item) => item.targetId)
}

function equalStringSets(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((value) => b.has(value))
}

function validateKeyPoint(point, fieldName) {
  if (!isPlainObject(point) || typeof point.id !== 'string' || !point.id.trim()) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${fieldName} is invalid.`)
  }
  const modes = ['allOf', 'anyOf'].filter((key) => Object.hasOwn(point, key))
  if (modes.length !== 1 || !Array.isArray(point[modes[0]]) || point[modes[0]].length === 0 ||
      point[modes[0]].some((term) => typeof term !== 'string' || term.length === 0)) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${fieldName} terms are invalid.`)
  }
}

function validateGroundTruth(queries, groundTruth) {
  if (!isPlainObject(groundTruth) || groundTruth.schemaVersion !== 1 || !isPlainObject(groundTruth.cases)) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Ground truth schema is invalid.')
  }
  const queryIds = new Set(queries.map((query) => query?.id))
  const caseIds = Object.keys(groundTruth.cases)
  if (caseIds.length !== queryIds.size || caseIds.some((id) => !queryIds.has(id))) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Ground truth coverage does not match the query fixture.')
  }
  const counts = Object.create(null)
  for (const query of queries) {
    if (!isPlainObject(query) || typeof query.id !== 'string' || typeof query.category !== 'string' ||
        typeof query.q !== 'string' || !query.q.trim()) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query fixture item is invalid.')
    }
    const truth = groundTruth.cases[query.id]
    if (!isPlainObject(truth) || truth.category !== query.category || typeof truth.answerable !== 'boolean') {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `Ground truth case ${query.id} is invalid.`)
    }
    counts[query.category] = (counts[query.category] ?? 0) + 1
    const expected = expectedTargetIds(query)
    const forbidden = forbiddenTargetIds(query)
    if (truth.answerable !== (expected.length > 0) || !Array.isArray(truth.keyPoints) ||
        !Array.isArray(truth.citationTargets) || !equalStringSets(truth.citationTargets, expected)) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `Ground truth answer contract for ${query.id} is invalid.`)
    }
    if (new Set(truth.citationTargets).size !== truth.citationTargets.length ||
        truth.citationTargets.some((target) => typeof target !== 'string' || !target)) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `Ground truth citation targets for ${query.id} are invalid.`)
    }
    for (const [index, point] of truth.keyPoints.entries()) validateKeyPoint(point, `${query.id}.keyPoints[${index}]`)
    if (query.category === 'no_answer' && truth.mustAbstain !== true) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id} must require abstention.`)
    }
    if (query.category === 'security' && expected.length === 0 && truth.mustAbstain !== true) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id} must require security abstention.`)
    }
    if (truth.mustAbstain === true && truth.answerable) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id} cannot both answer and require abstention.`)
    }
    if (truth.allowAbstain !== undefined && typeof truth.allowAbstain !== 'boolean') {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id}.allowAbstain is invalid.`)
    }
    if (truth.rules !== undefined && (!Array.isArray(truth.rules) || truth.rules.some((rule) => typeof rule !== 'string'))) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id}.rules are invalid.`)
    }
    if (forbidden.some((target) => truth.citationTargets.includes(target))) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${query.id} allows a forbidden citation.`)
    }
  }
  for (const [category, expectedCount] of Object.entries(REQUIRED_CATEGORY_COUNTS)) {
    if (counts[category] !== expectedCount) fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `${category} coverage is incomplete.`)
  }
  return groundTruth
}

function sourceAliases(source) {
  const aliases = new Set([source.id])
  const aliasesById = {
    'rfc-9110': 'http',
    'rfc-8259': 'json',
    'rfc-3986': 'uri',
    'rfc-6455': 'websocket',
    'rfc-7519': 'jwt',
    'rfc-8446': 'tls',
    'rfc-9000': 'quic',
    'pride-prejudice': 'pride',
    'vue-readme': 'vue',
    'express-readme': 'express',
    'qdrant-readme': 'qdrant',
    'version-active': 'active',
    'version-old': 'stale',
    'trashed-secret': 'trashed',
    'demo-private': 'other-scope',
    'prompt-injection': 'injection-doc'
  }
  if (aliasesById[source.id]) aliases.add(aliasesById[source.id])
  return aliases
}

function locatorContains(actual, expected) {
  if (!isPlainObject(expected)) return true
  if (!isPlainObject(actual)) return false
  return Object.entries(expected).every(([key, value]) => {
    if (isPlainObject(value)) return locatorContains(actual[key], value)
    return actual[key] === value
  })
}

function normalizeSources(corpus) {
  if (!isPlainObject(corpus) || corpus.schemaVersion !== 1 || !Array.isArray(corpus.publicSources) || !Array.isArray(corpus.syntheticSources)) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Corpus fixture schema is invalid.')
  }
  const sources = [...corpus.publicSources, ...corpus.syntheticSources].map((source) => {
    const entry = source?.entry
    if (!isPlainObject(source) || typeof source.id !== 'string' || !isPlainObject(entry) || typeof entry.body !== 'string' || !entry.body.trim()) {
      fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Corpus source is invalid.')
    }
    return Object.freeze({
      id: source.id,
      body: entry.body,
      title: typeof entry.title === 'string' ? entry.title : null,
      status: entry.status ?? null,
      resultScope: entry.resultScope ?? null,
      locator: entry.locator ?? null,
      aliases: sourceAliases(source)
    })
  })
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Corpus source IDs are not unique.')
  }
  return sources
}

function findSource(sources, reference) {
  if (!isPlainObject(reference) || typeof reference.targetId !== 'string') {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'Query source reference is invalid.')
  }
  const candidates = sources.filter((source) => source.aliases.has(reference.targetId))
  const located = candidates.filter((source) => locatorContains(source.locator, reference.locator))
  const result = located.length === 1 ? located[0] : candidates.length === 1 ? candidates[0] : null
  if (!result) fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', `Unable to resolve source target ${reference.targetId}.`)
  return result
}

function sourceIsSafeDecoy(source) {
  return source.status === 'active' && source.resultScope === 'owned' &&
    /^rfc-|-(?:readme|prejudice|alice)$/u.test(source.id) ||
    ['alice', 'pride-prejudice', 'vue-readme', 'express-readme', 'qdrant-readme'].includes(source.id)
}

function makeEvaluationCase(query, truth, sources, config) {
  const expectedSources = query.expected.map((reference) => findSource(sources, reference))
  const forbiddenSources = query.forbidden.map((reference) => findSource(sources, reference))
  const expectedIds = new Set(expectedSources.map((source) => source.id))
  const forbiddenIds = new Set(forbiddenSources.map((source) => source.id))
  const selected = [...expectedSources]
  if (query.category === 'version_conflict') {
    for (const source of forbiddenSources) {
      if (!selected.some((selectedSource) => selectedSource.id === source.id)) selected.push(source)
    }
  }
  if (selected.length > config.maxEvidenceItems) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${query.id} exceeds maxEvidenceItems.`)
  const decoyCount = Math.min(2, Math.max(1, config.maxEvidenceItems - selected.length))
  for (const source of sources) {
    if (selected.length >= config.maxEvidenceItems || selected.length >= expectedSources.length + decoyCount) break
    if (!sourceIsSafeDecoy(source) || expectedIds.has(source.id) || forbiddenIds.has(source.id)) continue
    selected.push(source)
  }
  if (selected.length < expectedSources.length) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${query.id} exceeds maxEvidenceItems.`)
  const citationSources = new Map()
  const evidence = selected.map((source, index) => {
    const citationId = `C${index + 1}`
    citationSources.set(citationId, source)
    return { citationId, text: source.body }
  })
  return Object.freeze({
    id: query.id,
    category: query.category,
    query: query.q,
    truth,
    expectedSources: Object.freeze(expectedSources),
    forbiddenSources: Object.freeze(forbiddenSources),
    citationSources,
    evidence: Object.freeze(evidence),
    task: {
      taskType: RAG_ANSWER_TASK_TYPE,
      processorVersion: 'v1',
      executionClass: 'gpu',
      input: {
        schemaVersion: 1,
        querySha256: sha256(Buffer.from(query.q, 'utf8')),
        query: query.q,
        model: {
          provider: config.provider,
          modelId: config.modelId,
          modelRevision: config.modelRevision,
          dimensions: config.dimensions,
          configHash: config.configHash
        },
        evidence
      }
    }
  })
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function termMatches(text, term) {
  return new RegExp(escapeRegExp(term), 'iu').test(text)
}

function keyPointMatches(point, answer) {
  const terms = point.allOf ?? point.anyOf
  if (point.allOf) return terms.every((term) => termMatches(answer, term))
  return terms.some((term) => termMatches(answer, term))
}

function sourceMatchesTarget(source, target) {
  return Boolean(source && source.aliases.has(target))
}

function scoreCitations(output, evaluationCase) {
  const citations = Array.isArray(output?.citations) ? output.citations : []
  const expected = new Set(evaluationCase.truth.citationTargets)
  const forbidden = new Set(evaluationCase.forbiddenSources.flatMap((source) => [...source.aliases]))
  let correct = 0
  let forbiddenHits = 0
  for (const citationId of citations) {
    const source = evaluationCase.citationSources.get(citationId)
    if ([...expected].some((target) => sourceMatchesTarget(source, target))) correct += 1
    if ([...forbidden].some((target) => sourceMatchesTarget(source, target))) forbiddenHits += 1
  }
  const precision = citations.length === 0 ? (expected.size === 0 ? 1 : 0) : correct / citations.length
  const recall = expected.size === 0 ? (citations.length === 0 ? 1 : 0) : correct / expected.size
  return { correct, total: citations.length, expected: expected.size, precision, recall, forbiddenHits }
}

function scoreCase(evaluationCase, envelope, error, latencyMs) {
  const output = error ? null : envelope?.output
  const answer = typeof output?.answer === 'string' ? output.answer : ''
  const points = evaluationCase.truth.keyPoints
  const pointResults = points.map((point) => ({ id: point.id, passed: keyPointMatches(point, answer) }))
  const covered = pointResults.filter((point) => point.passed).length
  const keyPointCoverage = {
    covered,
    total: points.length,
    ratio: points.length === 0 ? 1 : covered / points.length,
    pass: covered === points.length
  }
  const citation = scoreCitations(output, evaluationCase)
  const abstained = typeof output?.abstained === 'boolean' ? output.abstained : null
  const noAnswerPass = evaluationCase.category === 'no_answer'
    ? abstained === true
    : null
  const groundedPass = evaluationCase.truth.answerable
    ? !error && abstained === false && keyPointCoverage.pass && citation.recall === 1 && citation.forbiddenHits === 0
    : !error && abstained === true
  const conflictPass = evaluationCase.category === 'version_conflict'
    ? groundedPass && citation.forbiddenHits === 0
    : null
  const securityPass = evaluationCase.category === 'security'
    ? !error && citation.forbiddenHits === 0 && (evaluationCase.truth.mustAbstain
      ? abstained === true
      : abstained === true ? evaluationCase.truth.allowAbstain === true : keyPointCoverage.pass && citation.recall === 1)
    : null
  const evaluationPass = evaluationCase.category === 'no_answer'
    ? noAnswerPass
    : evaluationCase.category === 'security'
      ? securityPass
      : evaluationCase.category === 'version_conflict'
        ? conflictPass
        : groundedPass
  return {
    id: evaluationCase.id,
    category: evaluationCase.category,
    answerable: evaluationCase.truth.answerable,
    latencyMs: Math.round(latencyMs * 100) / 100,
    ok: !error,
    errorCode: error ? (error.code ?? 'RAG_ANSWER_EVAL_PROCESSOR_FAILED') : null,
    abstained,
    keyPointCoverage,
    citationPrecision: citation.precision,
    citationRecall: citation.recall,
    citationCount: citation.total,
    expectedCitationCount: citation.expected,
    forbiddenCitationHits: citation.forbiddenHits,
    groundedPass,
    noAnswerPass,
    conflictPass,
    securityPass,
    pass: evaluationPass === true
  }
}

function nearestRank(values, percentile) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return Math.round(sorted[index] * 100) / 100
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000
}

function aggregateMetrics(results) {
  const answerable = results.filter((result) => result.answerable)
  const keyPointCovered = answerable.reduce((sum, result) => sum + result.keyPointCoverage.covered, 0)
  const keyPointTotal = answerable.reduce((sum, result) => sum + result.keyPointCoverage.total, 0)
  const groundedPasses = answerable.filter((result) => result.groundedPass).length
  const noAnswers = results.filter((result) => result.category === 'no_answer')
  const security = results.filter((result) => result.category === 'security')
  const conflicts = results.filter((result) => result.category === 'version_conflict')
  const citationCorrect = results.reduce((sum, result) => sum + Math.round(result.citationPrecision * result.citationCount), 0)
  const citationTotal = results.reduce((sum, result) => sum + result.citationCount, 0)
  const expectedCitationTotal = results.reduce((sum, result) => sum + result.expectedCitationCount, 0)
  const citationRecallCorrect = results.reduce((sum, result) => sum + Math.round(result.citationRecall * result.expectedCitationCount), 0)
  const latencies = results.map((result) => result.latencyMs)
  const byCategory = {}
  for (const category of Object.keys(REQUIRED_CATEGORY_COUNTS)) {
    const items = results.filter((result) => result.category === category)
    byCategory[category] = {
      count: items.length,
      pass: items.filter((result) => result.pass).length,
      rate: ratio(items.filter((result) => result.pass).length, items.length)
    }
  }
  const errorCounts = {}
  for (const result of results) {
    if (result.errorCode) errorCounts[result.errorCode] = (errorCounts[result.errorCode] ?? 0) + 1
  }
  return {
    answerKeyCoverage: { covered: keyPointCovered, total: keyPointTotal, rate: ratio(keyPointCovered, keyPointTotal) },
    groundedClaimRate: { pass: groundedPasses, total: answerable.length, rate: ratio(groundedPasses, answerable.length) },
    citationPrecision: { correct: citationCorrect, total: citationTotal, rate: ratio(citationCorrect, citationTotal) },
    citationRecall: { correct: citationRecallCorrect, total: expectedCitationTotal, rate: ratio(citationRecallCorrect, expectedCitationTotal) },
    noAnswerAbstention: { pass: noAnswers.filter((result) => result.noAnswerPass).length, total: noAnswers.length, rate: ratio(noAnswers.filter((result) => result.noAnswerPass).length, noAnswers.length) },
    conflictPass: { pass: conflicts.filter((result) => result.conflictPass).length, total: conflicts.length, rate: ratio(conflicts.filter((result) => result.conflictPass).length, conflicts.length) },
    securityPass: { pass: security.filter((result) => result.securityPass).length, total: security.length, rate: ratio(security.filter((result) => result.securityPass).length, security.length) },
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95), max: Math.round(Math.max(0, ...latencies) * 100) / 100 },
    errors: { total: results.filter((result) => result.errorCode).length, byCode: errorCounts },
    byCategory
  }
}

export async function loadRagAnswerEvaluationFixtures(options = {}) {
  const config = normalizeRagAnswerEvaluationConfig(options)
  const [queryFixture, groundTruth, corpus] = await Promise.all([
    readJson(config.queryPath, 'RAG_ANSWER_EVAL_FIXTURE_INVALID'),
    readJson(config.groundTruthPath, 'RAG_ANSWER_EVAL_FIXTURE_INVALID'),
    readJson(config.corpusPath, 'RAG_ANSWER_EVAL_FIXTURE_INVALID')
  ])
  if (!Array.isArray(queryFixture) || queryFixture.length !== 64) {
    fail('RAG_ANSWER_EVAL_FIXTURE_INVALID', 'The fixed query fixture must contain 64 queries.')
  }
  validateGroundTruth(queryFixture, groundTruth)
  const sources = normalizeSources(corpus)
  const hashes = {
    queries: await sha256File(config.queryPath),
    groundTruth: await sha256File(config.groundTruthPath),
    corpus: await sha256File(config.corpusPath)
  }
  return Object.freeze({ config, queries: queryFixture, groundTruth, sources, hashes })
}

function selectedQueries(queries, config) {
  const requested = config.ids ? new Set(config.ids) : null
  const filtered = requested ? queries.filter((query) => requested.has(query.id)) : queries
  if (requested && filtered.length !== requested.size) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'ids contains an unknown query.')
  return config.limit === null ? filtered : filtered.slice(0, config.limit)
}

export async function runRagAnswerEvaluation(options = {}) {
  const fixtures = await loadRagAnswerEvaluationFixtures(options)
  const config = fixtures.config
  const queries = selectedQueries(fixtures.queries, config)
  const processor = options.processor ?? createRagAnswerProcessor({
    config: {
      baseUrl: config.baseUrl,
      provider: config.provider,
      modelId: config.modelId,
      modelRevision: config.modelRevision,
      contextLimit: config.contextLimit,
      maxOutputBytes: config.maxOutputBytes,
      maxEvidenceItems: config.maxEvidenceItems,
      timeoutMs: config.timeoutMs,
      configHash: config.configHash,
      apiKey: config.apiKey
    },
    fetchImpl: options.fetchImpl
  })
  const results = []
  for (const query of queries) {
    const truth = fixtures.groundTruth.cases[query.id]
    const evaluationCase = makeEvaluationCase(query, truth, fixtures.sources, config)
    const startedAt = performance.now()
    let envelope
    let error
    try {
      envelope = await processor.process(evaluationCase.task)
    } catch (caught) {
      error = caught
    }
    results.push(scoreCase(evaluationCase, envelope, error, performance.now() - startedAt))
  }
  const selectedCounts = {}
  for (const query of queries) selectedCounts[query.category] = (selectedCounts[query.category] ?? 0) + 1
  return {
    schemaVersion: 1,
    evaluation: 'rag-answer-evaluation.v1',
    metricDefinitions: {
      answerKeyCoverage: 'covered required key points divided by required key points on answerable cases.',
      groundedClaimRate: 'answerable cases that are non-abstained, cover all key points, cite every expected target, and cite no forbidden target.',
      citationPrecision: 'expected-target citations divided by all returned citations.',
      citationRecall: 'expected-target citations returned divided by expected citation targets.',
      noAnswerAbstention: 'no_answer cases with abstained=true.',
      conflictPass: 'version_conflict cases satisfying grounded rules and avoiding forbidden version citations.',
      securityPass: 'security cases satisfying abstention or safe grounded rules with no forbidden citation.',
      latencyMs: 'wall-clock processor latency per case, reported as nearest-rank p50/p95 and max.'
    },
    configuration: {
      provider: config.provider,
      modelId: config.modelId,
      modelRevision: config.modelRevision,
      baseUrl: config.baseUrl,
      contextLimit: config.contextLimit,
      maxOutputBytes: config.maxOutputBytes,
      maxEvidenceItems: config.maxEvidenceItems,
      dimensions: config.dimensions
    },
    dataset: {
      queryCount: queries.length,
      fixedQueryCount: fixtures.queries.length,
      selectedCategoryCounts: selectedCounts,
      fixtureSha256: fixtures.hashes
    },
    metrics: aggregateMetrics(results),
    cases: results
  }
}

export function formatRagAnswerEvaluationHelp() {
  return [
    'Usage: node pc-worker/scripts/rag-answer-evaluation.js [options]',
    '',
    'Calls the configured OpenAI-compatible local answer model and scores all 64 fixed RAG queries.',
    'The report contains metrics and stable case IDs only; query/evidence/answer text is never printed.',
    '',
    'Options:',
    '  --help                    Show this help.',
    '  --base-url URL            Chat-completions base URL (default http://127.0.0.1:1234).',
    '  --provider NAME           Model provider identity.',
    '  --model-id ID             Local model ID (or RAG_ANSWER_MODEL_ID).',
    '  --revision ID             Local model revision (or RAG_ANSWER_MODEL_REVISION).',
    '  --context-limit BYTES     Prompt context byte limit.',
    '  --max-output-bytes BYTES  Model JSON output byte limit.',
    '  --max-evidence-items N    Evidence item limit.',
    '  --timeout-ms MS           Per-answer timeout.',
    '  --ids ID1,ID2             Evaluate selected query IDs only.',
    '  --limit N                 Evaluate the first N selected queries.',
    '  --queries FILE            Query fixture path.',
    '  --ground-truth FILE       Answer ground-truth path.',
    '  --corpus FILE             Corpus fixture path.'
  ].join('\n')
}

function optionValue(argv, index, key, inlineValue) {
  if (inlineValue !== undefined) return inlineValue
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `${key} requires a value.`)
  return value
}

export function parseRagAnswerEvaluationArgs(argv = []) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(argument)
    if (!match) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', 'Arguments must use --key value syntax.')
    const key = match[1]
    if (key === 'help') return { help: true }
    const value = optionValue(argv, index, key, match[2])
    if (match[2] === undefined) index += 1
    const mapping = {
      'base-url': 'baseUrl',
      provider: 'provider',
      'model-id': 'modelId',
      revision: 'modelRevision',
      'context-limit': 'contextLimit',
      'max-output-bytes': 'maxOutputBytes',
      'max-evidence-items': 'maxEvidenceItems',
      'timeout-ms': 'timeoutMs',
      dimensions: 'dimensions',
      ids: 'ids',
      limit: 'limit',
      queries: 'queryPath',
      'ground-truth': 'groundTruthPath',
      corpus: 'corpusPath'
    }
    if (!mapping[key]) fail('RAG_ANSWER_EVAL_CONFIG_INVALID', `Unknown option --${key}.`)
    options[mapping[key]] = value
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseRagAnswerEvaluationArgs(argv)
  if (parsed.help) {
    console.log(formatRagAnswerEvaluationHelp())
    return null
  }
  const report = await runRagAnswerEvaluation(parsed)
  console.log(JSON.stringify(report, null, 2))
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: { code: error?.code ?? 'RAG_ANSWER_EVAL_FAILED' } }))
    process.exitCode = 1
  })
}
