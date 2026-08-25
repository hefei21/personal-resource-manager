import { collectLoadedModels } from './telemetry.js'
import { readFile } from 'node:fs/promises'

export const RAG_RERANKER_MODEL_ID = 'BAAI/bge-reranker-v2-m3'
export const RAG_RERANKER_MODEL_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
export const RERANKER_MODEL_DIR = 'D:\\PRManagerAI\\models\\bge-reranker-v2-m3'
export const RERANKER_MANIFEST_PATH = `${RERANKER_MODEL_DIR}\\.prmanager-reranker-manifest.json`
const RAG_RERANKER_PROVIDER = 'hugging-face-tei'
const RAG_RERANKER_DIMENSIONS = 1
const RAG_RERANKER_INPUT_LIMIT = 512
const RAG_RERANKER_CONFIG_HASH = '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'

// This is an attestation of the exact files the explicit Windows preparation
// script permits. The worker never trusts values supplied only by a local
// manifest; all hashes and lengths below are code-pinned.
export const RERANKER_REQUIRED_FILES = Object.freeze({
  'config.json': Object.freeze({ length: 795, sha256: '13DCD6C31D9FEC9D1D8E158702072F62D7FA7D312A64B9FE057BEC9A08CFE41A' }),
  'model.safetensors': Object.freeze({ length: 2_271_071_852, sha256: 'D9E3E081FAFF1EEFB84019509B2F5558FD74C1A05A2C7DB22F74174FCEDB5286' }),
  'sentencepiece.bpe.model': Object.freeze({ length: 5_069_051, sha256: 'CFC8146ABE2A0488E9E2A0C56DE7952F7C11AB059ECA145A0A727AFCE0DB2865' }),
  'special_tokens_map.json': Object.freeze({ length: 964, sha256: '8C785ABEBEA9AE3257B61681B4E6FD8365CEAFDE980C21970D001E834CF10835' }),
  'tokenizer.json': Object.freeze({ length: 17_098_273, sha256: '69564B696052886ED0AC63FA393E928384E0F8CAADA38C1F4864A9BFBF379C15' }),
  'tokenizer_config.json': Object.freeze({ length: 1_173, sha256: '7E4C1CC848840AECCDD763458C18DD525EB0F795C992E00EBE9C28554E7DB2D4' })
})
export const RERANKER_MANIFEST_SHA256 = '3b0f3c138d07d98b4325e19856124ef874d3f34cb488bc35247e3d2132649fb9'

const MODEL_KINDS = Object.freeze(['answer', 'embedding', 'reranker'])
const LOADED_MODEL_KINDS = new Set(['answer', 'embedding'])
const JITTER_RATIO = 0.2
const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_MAX_BACKOFF_MS = 60_000

function configuredModel(config) {
  return config && typeof config === 'object' && typeof config.baseUrl === 'string' &&
    typeof config.modelId === 'string' && config.baseUrl !== '' && config.modelId !== ''
}

function configuredReranker(config) {
  return config && typeof config === 'object' && typeof (config.endpoint ?? config.baseUrl) === 'string' &&
    (config.endpoint ?? config.baseUrl) !== '' && config.modelId === RAG_RERANKER_MODEL_ID &&
    config.modelRevision === RAG_RERANKER_MODEL_REVISION && config.provider === RAG_RERANKER_PROVIDER &&
    config.dimensions === RAG_RERANKER_DIMENSIONS && config.inputLimit === RAG_RERANKER_INPUT_LIMIT &&
    config.configHash === RAG_RERANKER_CONFIG_HASH
}

function boundedRandom(random) {
  try {
    const value = Number(random())
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5
  } catch {
    return 0.5
  }
}

function jitteredDelay(baseMs, random) {
  const factor = 1 - JITTER_RATIO + (2 * JITTER_RATIO * boundedRandom(random))
  return Math.max(1_000, Math.round(baseMs * factor))
}

function loadedModelMatches(entry, modelId) {
  if (typeof entry === 'string') return entry === modelId
  if (!entry || typeof entry !== 'object') return false
  return [entry.modelKey, entry.identifier, entry.id].some((value) => typeof value === 'string' && value === modelId)
}

function probeKind(config, loadedModels) {
  return Array.isArray(loadedModels) && loadedModels.some((entry) => loadedModelMatches(entry, config.modelId))
    ? { ready: true, reason: null }
    : { ready: false, reason: 'model_not_loaded' }
}

function identityValue(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key].trim() !== '') return payload[key].trim()
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) {
      const nested = payload[key].model_id ?? payload[key].modelId ?? payload[key].id ?? payload[key].name
      if (typeof nested === 'string' && nested.trim() !== '') return nested.trim()
    }
  }
  return null
}

function rerankerModelTypeStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unknown'
  const raw = payload.model_type ?? payload.modelType
  if (typeof raw === 'string') return raw === 'reranker' ? 'matched' : 'model_type_mismatch'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown'
  if (Object.hasOwn(raw, 'reranker')) return 'matched'
  if (Object.hasOwn(raw, 'embedding') || Object.hasOwn(raw, 'classifier')) return 'model_type_mismatch'
  return 'unknown'
}

function rerankerIdentityStatus(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unknown'
  const modelType = rerankerModelTypeStatus(payload)
  if (modelType !== 'matched') return modelType
  const servedModelName = identityValue(payload, ['served_model_name', 'servedModelName'])
  if (servedModelName !== null && servedModelName !== config.modelId) return 'model_identity_mismatch'
  const modelId = identityValue(payload, ['model_id', 'modelId', 'model'])
  const localModelPath = '/models/reranker'
  if (modelId !== null && modelId !== config.modelId && modelId !== localModelPath) return 'model_identity_mismatch'
  const revision = identityValue(payload, ['revision', 'model_revision', 'modelRevision', 'model_sha', 'sha'])
  if (revision !== null && revision !== config.modelRevision) return 'model_identity_mismatch'
  if (servedModelName === null && modelId === null) return 'unknown'
  return modelId === localModelPath ? 'local_model_path' : 'matched'
}

function manifestCanonicalValue(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const files = {}
  for (const relativePath of Object.keys(RERANKER_REQUIRED_FILES)) {
    const item = manifest.files?.[relativePath]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    files[relativePath] = {
      length: Number(item.length),
      sha256: typeof item.sha256 === 'string' ? item.sha256.toUpperCase() : ''
    }
  }
  return { modelId: manifest.modelId, revision: manifest.revision, files }
}

function manifestMatchesPinnedIdentity(manifest, config) {
  const canonical = manifestCanonicalValue(manifest)
  if (!canonical || canonical.modelId !== config.modelId || canonical.revision !== config.modelRevision) return false
  const expectedFiles = Object.keys(RERANKER_REQUIRED_FILES)
  const manifestFiles = manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files)
    ? Object.keys(manifest.files)
    : []
  if (manifestFiles.length !== expectedFiles.length || manifestFiles.some((file) => !expectedFiles.includes(file))) return false
  for (const relativePath of expectedFiles) {
    const expected = RERANKER_REQUIRED_FILES[relativePath]
    const actual = canonical.files[relativePath]
    if (actual.length !== expected.length || actual.sha256 !== expected.sha256) return false
  }
  return typeof manifest.manifestSha256 === 'string' && manifest.manifestSha256.toLowerCase() === RERANKER_MANIFEST_SHA256
}

async function readRerankerManifest(config) {
  const manifestPath = typeof config?.manifestPath === 'string' && config.manifestPath.trim() !== ''
    ? config.manifestPath
    : RERANKER_MANIFEST_PATH
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function rerankerReadinessEndpoints(config) {
  if (typeof config.infoEndpoint === 'string' && typeof config.healthEndpoint === 'string') {
    return { infoEndpoint: config.infoEndpoint, healthEndpoint: config.healthEndpoint }
  }
  try {
    const parsed = new URL(config.baseUrl ?? config.endpoint)
    const pathname = parsed.pathname.replace(/\/+$/u, '')
    const servicePath = pathname.endsWith('/rerank') ? pathname.slice(0, -'/rerank'.length) : pathname
    const info = new URL(parsed.toString())
    const health = new URL(parsed.toString())
    info.pathname = `${servicePath || ''}/info` || '/info'
    health.pathname = `${servicePath || ''}/health` || '/health'
    info.search = ''
    info.hash = ''
    health.search = ''
    health.hash = ''
    return { infoEndpoint: info.toString().replace(/\/$/u, ''), healthEndpoint: health.toString().replace(/\/$/u, '') }
  } catch {
    return { infoEndpoint: null, healthEndpoint: null }
  }
}

async function readReadinessResponse(fetchImpl, endpoint, timeoutMs) {
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return { ok: false, reason: 'endpoint_unavailable', payload: null }
  }
  if (!response?.ok) return { ok: false, reason: 'endpoint_unhealthy', payload: null }
  if (typeof response.json !== 'function') return { ok: true, reason: null, payload: null }
  try {
    return { ok: true, reason: null, payload: await response.json() }
  } catch {
    return { ok: true, reason: null, payload: null }
  }
}

async function probeReranker(config, fetchImpl, manifestProvider = readRerankerManifest) {
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 30_000
  const endpoints = rerankerReadinessEndpoints(config)
  if (!endpoints.infoEndpoint || !endpoints.healthEndpoint) return { ready: false, reason: 'endpoint_invalid' }
  const info = await readReadinessResponse(fetchImpl, endpoints.infoEndpoint, timeoutMs)
  if (!info.ok) {
    // /health is diagnostic only. It can never establish model identity, so a
    // healthy endpoint cannot make this capability ready when /info is down.
    await readReadinessResponse(fetchImpl, endpoints.healthEndpoint, timeoutMs)
    return { ready: false, reason: 'info_unavailable' }
  }
  const identity = rerankerIdentityStatus(info.payload, config)
  if (identity === 'model_identity_mismatch' || identity === 'model_type_mismatch') return { ready: false, reason: identity }
  if (identity === 'unknown') return { ready: false, reason: 'model_identity_unverified' }
  let manifest = null
  try {
    manifest = await manifestProvider(config)
  } catch {
    manifest = null
  }
  if (!manifestMatchesPinnedIdentity(manifest, config)) {
    return { ready: false, reason: 'manifest_invalid' }
  }
  return { ready: true, reason: null }
}

function initialState(config, configured = configuredModel(config)) {
  return {
    configured,
    ready: false,
    checkedAt: 0,
    nextProbeAt: 0,
    failureCount: 0,
    reason: null
  }
}

function publicState(state) {
  return Object.freeze({ ...state })
}

export class ModelReadiness {
  constructor({ answer = null, embedding = null, intervalMs = DEFAULT_INTERVAL_MS,
    reranker = null, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS, now = () => Date.now(),
    random = Math.random, loadedModelsProvider = collectLoadedModels, fetchImpl = fetch,
    rerankerManifestProvider = null } = {}) {
    this.configs = Object.freeze({ answer, embedding, reranker })
    this.loadedModelsProvider = loadedModelsProvider
    this.fetchImpl = fetchImpl
    this.rerankerManifestProvider = typeof rerankerManifestProvider === 'function'
      ? rerankerManifestProvider
      : readRerankerManifest
    this.intervalMs = Number.isSafeInteger(intervalMs) && intervalMs >= 1_000 ? intervalMs : DEFAULT_INTERVAL_MS
    this.maxBackoffMs = Number.isSafeInteger(maxBackoffMs) && maxBackoffMs >= this.intervalMs
      ? maxBackoffMs : Math.max(DEFAULT_MAX_BACKOFF_MS, this.intervalMs)
    this.now = now
    this.random = random
    this.states = Object.fromEntries(MODEL_KINDS.map((kind) => [kind, initialState(
      kind === 'reranker' ? this.configs[kind] : this.configs[kind],
      kind === 'reranker' ? configuredReranker(this.configs[kind]) : configuredModel(this.configs[kind])
    )]))
    this.inflight = null
    this.generation = 0
  }

  isReady(kind) {
    return MODEL_KINDS.includes(kind) && this.states[kind].configured && this.states[kind].ready
  }

  snapshot() {
    return Object.freeze(Object.fromEntries(MODEL_KINDS.map((kind) => [kind, publicState(this.states[kind])])))
  }

  due(kind, at = this.now()) {
    return MODEL_KINDS.includes(kind) && this.states[kind].configured && at >= this.states[kind].nextProbeAt
  }

  backoffDelay(failureCount) {
    const exponent = Math.min(Math.max(failureCount - 1, 0), 8)
    return jitteredDelay(Math.min(this.maxBackoffMs, this.intervalMs * (2 ** exponent)), this.random)
  }

  async refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight
    const at = this.now()
    const kinds = MODEL_KINDS.filter((kind) => this.states[kind].configured && (force || this.due(kind, at)))
    if (kinds.length === 0) return false
    this.inflight = this.refreshKinds(kinds)
    try { return await this.inflight } finally { this.inflight = null }
  }

  async refreshKinds(kinds) {
    let loadedModels = []
    if (kinds.some((kind) => LOADED_MODEL_KINDS.has(kind))) {
      try {
        loadedModels = await this.loadedModelsProvider()
      } catch {
        loadedModels = []
      }
    }
    let changed = false
    for (const kind of kinds) {
      const state = this.states[kind]
      const result = kind === 'reranker'
        ? await probeReranker(this.configs[kind], this.fetchImpl, this.rerankerManifestProvider)
        : probeKind(this.configs[kind], loadedModels)
      const wasReady = state.ready
      state.checkedAt = this.now()
      state.ready = result.ready
      state.reason = result.reason
      if (result.ready) {
        state.failureCount = 0
        state.nextProbeAt = state.checkedAt + jitteredDelay(this.intervalMs, this.random)
      } else {
        state.failureCount += 1
        state.nextProbeAt = state.checkedAt + this.backoffDelay(state.failureCount)
      }
      if (wasReady !== state.ready) changed = true
    }
    if (changed) this.generation += 1
    return changed
  }

  markUnavailable(kind, reason = 'processor_failed') {
    if (!MODEL_KINDS.includes(kind) || !this.states[kind].configured) return false
    const state = this.states[kind]
    const changed = state.ready
    state.ready = false
    state.reason = reason
    state.failureCount += 1
    state.checkedAt = this.now()
    state.nextProbeAt = state.checkedAt + this.backoffDelay(state.failureCount)
    if (changed) this.generation += 1
    return changed
  }
}

export function createModelReadiness(options) {
  return new ModelReadiness(options)
}

export function modelKindForTaskType(taskType) {
  if (taskType === 'rag.answer.generate') return 'answer'
  if (taskType === 'rag.embedding.generate' || taskType === 'rag.query.embed') return 'embedding'
  if (taskType === 'rag.rerank') return 'reranker'
  return null
}

export { MODEL_KINDS }
