import { ragVectorConfig } from '../config/index.js'
import {
  createRagEmbeddingCoordinator,
  RAG_EMBEDDING_TASK_TYPE,
  RAG_EMBEDDING_PROCESSOR_VERSION
} from './ragEmbeddingCoordinator.js'
import {
  createDefaultRagVectorStore,
  ensureRagActiveEmbeddingModel,
  readActiveRagEmbeddingModel,
  readRagWorkerAvailability
} from './ragQueryRuntime.js'

export const RAG_EMBEDDING_RUNTIME_VERSION = 'rag-embedding-runtime.v1'

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeActiveModel(value) {
  if (!isPlainObject(value)) return null
  const model = isPlainObject(value.model) ? value.model : value
  const embeddingModelId = value.embeddingModelId ?? value.embedding_model_id ?? value.id
  if (!Number.isSafeInteger(embeddingModelId) || embeddingModelId <= 0 || !isPlainObject(model)) return null
  return Object.freeze({ embeddingModelId, model: Object.freeze({ ...model }) })
}

function sameModelIdentity(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false
  return ['provider', 'modelId', 'modelRevision', 'dimensions', 'inputLimit',
    'distance', 'normalization', 'configHash'].every((field) => left[field] === right[field])
}

/**
 * The runtime is deliberately a thin composition layer.  Model activation,
 * vector endpoint/schema construction and write-side stale checks remain in
 * their existing services so query and indexing cannot drift apart.
 */
export class RagEmbeddingRuntime {
  #collectionReady = null

  constructor({ database, taskStore, coordinator, activeModel, vectorStore } = {}) {
    if (!database?.prepare || !coordinator || !activeModel) {
      throw new TypeError('RAG embedding runtime dependencies are invalid.')
    }
    this.database = database
    this.taskStore = taskStore ?? null
    this.coordinator = coordinator
    this.vectorStore = vectorStore ?? null
    this.embeddingModelId = activeModel.embeddingModelId
    this.model = activeModel.model
    this.activeModel = activeModel
  }

  async #ensureCollection() {
    if (!this.vectorStore || typeof this.vectorStore.ensureCollection !== 'function') return null
    if (!this.#collectionReady) {
      this.#collectionReady = Promise.resolve()
        .then(() => this.vectorStore.ensureCollection())
        .catch((error) => {
          this.#collectionReady = null
          throw error
        })
    }
    return this.#collectionReady
  }

  async enqueueBatch(options = {}) {
    await this.#ensureCollection()
    return this.coordinator.enqueueBatch(options)
  }

  async applyWorkerResult(options, result) {
    await this.#ensureCollection()
    return this.coordinator.applyWorkerResult(options, result)
  }

  async reconcile(options = {}) {
    await this.#ensureCollection()
    return this.coordinator.reconcile(options)
  }

  async recover(options = {}) {
    await this.#ensureCollection()
    return typeof this.coordinator.recover === 'function'
      ? this.coordinator.recover(options)
      : this.coordinator.reconcile(options)
  }
}

export function createRagEmbeddingRuntime({
  database,
  taskStore = null,
  vectorStore = null,
  vectorConfig = ragVectorConfig,
  vectorStoreFactory = createDefaultRagVectorStore,
  modelResolver = null,
  coordinatorFactory = createRagEmbeddingCoordinator,
  workerAvailable = null,
  ...coordinatorOptions
} = {}) {
  // A disabled or incomplete vector contract must not activate a coordinator
  // and must leave the text/FTS path usable by itself.
  if (!database?.prepare || vectorConfig?.enabled !== true || typeof vectorStoreFactory !== 'function' ||
      typeof coordinatorFactory !== 'function') return null
  const activeModel = normalizeActiveModel(modelResolver
    ? modelResolver({ database })
    : typeof database.transaction === 'function'
      ? ensureRagActiveEmbeddingModel(database, vectorConfig)
      : readActiveRagEmbeddingModel(database))
  if (!activeModel) return null

  let resolvedVectorStore = vectorStore
  if (!resolvedVectorStore) {
    try {
      resolvedVectorStore = vectorStoreFactory({
        database,
        model: activeModel.model,
        modelConfig: activeModel.model,
        config: vectorConfig
      })
    } catch {
      return null
    }
  }
  if (!resolvedVectorStore) return null
  if (resolvedVectorStore.modelConfig !== undefined &&
      !sameModelIdentity(resolvedVectorStore.modelConfig, activeModel.model)) return null

  const resolvedWorkerAvailable = typeof workerAvailable === 'function'
    ? workerAvailable
    : (context = {}) => readRagWorkerAvailability({
      database,
      taskType: context.taskType ?? RAG_EMBEDDING_TASK_TYPE,
      processorVersion: context.processorVersion ?? RAG_EMBEDDING_PROCESSOR_VERSION,
      model: context.model ?? activeModel.model
    })
  let coordinator
  try {
    coordinator = coordinatorFactory({
      database,
      taskStore,
      vectorStore: resolvedVectorStore,
      workerAvailable: resolvedWorkerAvailable,
      ...coordinatorOptions,
      activeModelIdResolver: () => readActiveRagEmbeddingModel(database)?.embeddingModelId ?? null
    })
  } catch {
    return null
  }
  if (!coordinator || typeof coordinator.enqueueBatch !== 'function' ||
      typeof coordinator.applyWorkerResult !== 'function' ||
      typeof coordinator.reconcile !== 'function') return null
  return new RagEmbeddingRuntime({ database, taskStore, coordinator, activeModel, vectorStore: resolvedVectorStore })
}

export async function reconcileRagEmbeddingRuntime({
  database,
  taskStore = null,
  runtimeFactory = createRagEmbeddingRuntime,
  enqueue = true,
  maxBatches = 1
} = {}) {
  if (typeof runtimeFactory !== 'function') return Object.freeze({ status: 'unavailable' })
  const runtime = await Promise.resolve(runtimeFactory({ database, taskStore }))
  if (!runtime || typeof runtime.reconcile !== 'function') return Object.freeze({ status: 'disabled' })
  return runtime.reconcile({ enqueue, maxBatches })
}

export const RAG_EMBEDDING_RECONCILE_INTERVAL_MS = 60_000

/**
 * Keep pending/stale embedding work recoverable without making the NAS task
 * runtime or FTS path depend on a live Worker/Qdrant endpoint.  The timer is
 * explicitly closable, does not keep Node alive, and never lets a reconcile
 * error escape into the application event loop.
 */
export function startRagEmbeddingReconcileLoop({
  database,
  taskStore = null,
  runtimeFactory = createRagEmbeddingRuntime,
  intervalMs = RAG_EMBEDDING_RECONCILE_INTERVAL_MS,
  enabled = ragVectorConfig.enabled,
  logger = console
} = {}) {
  const noop = Object.freeze({
    active: false,
    runNow: async () => Object.freeze({ status: 'disabled' }),
    stop: () => {}
  })
  if (enabled !== true || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 ||
      typeof runtimeFactory !== 'function') return noop

  let stopped = false
  let running = null
  const runNow = async () => {
    if (stopped) return Object.freeze({ status: 'stopped' })
    if (running) return running
    running = reconcileRagEmbeddingRuntime({ database, taskStore, runtimeFactory })
      .catch((error) => {
        try { logger?.warn?.('[RAG] embedding reconcile degraded', error?.code ?? 'RAG_EMBEDDING_RECONCILE_FAILED') } catch {}
        return Object.freeze({ status: 'degraded', errorCode: error?.code ?? 'RAG_EMBEDDING_RECONCILE_FAILED' })
      })
      .finally(() => { running = null })
    return running
  }
  const timer = setInterval(() => { void runNow() }, intervalMs)
  timer.unref?.()
  return Object.freeze({
    active: true,
    runNow,
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    }
  })
}

export default createRagEmbeddingRuntime

export { ensureRagActiveEmbeddingModel }
