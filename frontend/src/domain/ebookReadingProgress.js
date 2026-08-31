const PENDING_PREFIX = 'pr-manager:ebook-progress-pending:v1:'
const CLIENT_KEY = 'pr-manager:ebook-progress-client:v1'

function safeStorage(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null
}

function identifier(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}:${random}`
}

function clientIdentifier(storage) {
  const target = safeStorage(storage)
  if (!target) return identifier('client')
  try {
    const existing = target.getItem(CLIENT_KEY)
    if (existing) return existing
    const created = identifier('client')
    target.setItem(CLIENT_KEY, created)
    return created
  } catch {
    return identifier('client')
  }
}

function normalizeProgress(value = {}) {
  const chapterFraction = value.chapterFraction === null || value.chapterFraction === undefined
    ? null
    : Math.min(1, Math.max(0, Number(value.chapterFraction) || 0))
  return Object.freeze({
    currentPage: Math.max(0, Math.trunc(Number(value.currentPage) || 0)),
    cfi: value.cfi ? String(value.cfi) : null,
    progress: Math.min(100, Math.max(0, Math.round((Number(value.progress) || 0) * 100) / 100)),
    fontSize: Number.isSafeInteger(Number(value.fontSize)) ? Number(value.fontSize) : 16,
    chapterFraction,
    revision: Math.max(0, Math.trunc(Number(value.revision) || 0)),
    updatedAt: value.updatedAt || null
  })
}

// Overall percentage and chapter index are the durable, cross-client locator.
// CFI remains a best-effort fine anchor because sanitizers, fonts and EPUB
// markup can legitimately change the rendered DOM between sessions.
export function deriveEbookChapterFraction(progress, currentPage, totalChapters) {
  const total = Math.max(1, Math.trunc(Number(totalChapters) || 1))
  const page = Math.min(total - 1, Math.max(0, Math.trunc(Number(currentPage) || 0)))
  return deriveWeightedEbookChapterFraction(progress, page, Array.from({ length: total }, () => 1)) ?? 0
}

export function deriveWeightedEbookChapterFraction(progress, currentPage, chapterWeights) {
  const weights = Array.isArray(chapterWeights)
    ? chapterWeights.map(value => Math.max(0, Number(value) || 0))
    : []
  const page = Math.trunc(Number(currentPage))
  if (page < 0 || page >= weights.length || weights[page] <= 0) return null
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  if (totalWeight <= 0) return null
  const absolute = Math.min(100, Math.max(0, Number(progress) || 0)) / 100 * totalWeight
  const chapterStart = weights.slice(0, page).reduce((sum, value) => sum + value, 0)
  const fraction = (absolute - chapterStart) / weights[page]
  if (fraction < -0.001 || fraction > 1.001) return null
  return Math.min(1, Math.max(0, fraction))
}

export function isEbookCfiForChapter(cfi, chapterId) {
  if (!cfi || !chapterId) return false
  return String(cfi).startsWith(`epubcfi([${String(chapterId)}]!`)
}

function pendingKey(bookId) {
  return `${PENDING_PREFIX}${bookId}`
}

export class EbookProgressConflictError extends Error {
  constructor(local, remote) {
    super('Reading progress changed on another client.')
    this.name = 'EbookProgressConflictError'
    this.code = 'EBOOK_PROGRESS_CONFLICT'
    this.local = local
    this.remote = remote
  }
}

export class EbookReadingProgressSync {
  constructor({ bookId, api, storage = globalThis.localStorage, onStatus = () => {} } = {}) {
    if (!Number.isSafeInteger(Number(bookId)) || Number(bookId) <= 0) throw new TypeError('bookId is invalid.')
    if (!api || typeof api.getProgress !== 'function' || typeof api.saveProgress !== 'function') {
      throw new TypeError('ebook progress API is invalid.')
    }
    this.bookId = Number(bookId)
    this.api = api
    this.storage = safeStorage(storage)
    this.onStatus = onStatus
    this.clientId = clientIdentifier(this.storage)
    this.remote = normalizeProgress()
    this.pending = null
    this.conflict = null
    this.drainPromise = null
    this.disposed = false
  }

  status(name, details = {}) {
    this.onStatus(Object.freeze({ name, ...details }))
  }

  readPending() {
    if (!this.storage) return null
    try {
      const parsed = JSON.parse(this.storage.getItem(pendingKey(this.bookId)) || 'null')
      if (!parsed || typeof parsed !== 'object' || !parsed.position || !parsed.mutationId) return null
      return {
        position: normalizeProgress(parsed.position),
        mutationId: String(parsed.mutationId),
        baseRevision: Math.max(0, Math.trunc(Number(parsed.baseRevision) || 0)),
        force: parsed.force === true
      }
    } catch {
      return null
    }
  }

  persistPending(value) {
    if (!this.storage) return
    try {
      if (!value) this.storage.removeItem(pendingKey(this.bookId))
      else this.storage.setItem(pendingKey(this.bookId), JSON.stringify(value))
    } catch {}
  }

  async load() {
    const response = await this.api.getProgress(this.bookId)
    this.remote = normalizeProgress(response.data)
    const persisted = this.readPending()
    if (persisted) {
      if (persisted.baseRevision === this.remote.revision || persisted.force) {
        this.pending = persisted
        void this.ensureDrain().catch(() => {})
      } else {
        this.conflict = Object.freeze({ local: persisted.position, remote: this.remote })
        this.status('conflict', this.conflict)
      }
    } else {
      this.status('synced', { progress: this.remote })
    }
    return this.remote
  }

  queue(position) {
    if (this.disposed) return Promise.resolve(this.remote)
    // 位置跨设备同步；字体等外观设置保留服务端兼容值，不用当前设备偏好覆盖其他设备。
    const normalized = normalizeProgress({ ...position, fontSize: this.remote.fontSize, revision: this.remote.revision })
    const job = {
      position: normalized,
      mutationId: identifier(this.clientId),
      baseRevision: this.remote.revision,
      force: false
    }
    if (this.conflict) {
      this.conflict = Object.freeze({ ...this.conflict, local: normalized })
      this.persistPending(job)
      this.status('conflict', this.conflict)
      return Promise.reject(new EbookProgressConflictError(normalized, this.conflict.remote))
    }
    this.pending = job
    this.persistPending(job)
    return this.ensureDrain()
  }

  ensureDrain() {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => { this.drainPromise = null })
    }
    return this.drainPromise
  }

  async drain() {
    while (this.pending && !this.disposed && !this.conflict) {
      const job = this.pending
      this.pending = null
      this.status('saving', { progress: job.position })
      try {
        const response = await this.api.saveProgress(this.bookId, {
          currentPage: job.position.currentPage,
          cfi: job.position.cfi,
          progress: job.position.progress,
          chapterFraction: job.position.chapterFraction,
          fontSize: job.position.fontSize,
          revision: this.remote.revision,
          mutationId: job.mutationId,
          force: job.force
        })
        this.remote = normalizeProgress(response.data?.data || response.data)
        if (!this.pending) this.persistPending(null)
        this.status('synced', { progress: this.remote })
      } catch (error) {
        if (error.response?.status === 409 && error.response?.data?.code === 'EBOOK_PROGRESS_CONFLICT') {
          const remote = normalizeProgress(error.response.data.latest)
          const local = this.pending?.position || job.position
          this.remote = remote
          this.pending = null
          this.conflict = Object.freeze({ local, remote })
          this.persistPending({ ...job, position: local, baseRevision: job.baseRevision })
          this.status('conflict', this.conflict)
          throw new EbookProgressConflictError(local, remote)
        }
        this.pending = this.pending || job
        this.persistPending(this.pending)
        this.status('offline', { progress: this.pending.position, error })
        throw error
      }
    }
    return this.remote
  }

  async resolveConflict(choice) {
    if (!this.conflict) return this.remote
    if (choice === 'remote') {
      const remote = this.conflict.remote
      this.conflict = null
      this.pending = null
      this.persistPending(null)
      this.remote = remote
      this.status('synced', { progress: remote })
      return remote
    }
    if (choice !== 'local') throw new TypeError('Conflict choice is invalid.')
    const local = this.conflict.local
    this.conflict = null
    this.pending = {
      position: local,
      mutationId: identifier(this.clientId),
      baseRevision: this.remote.revision,
      force: true
    }
    this.persistPending(this.pending)
    return this.ensureDrain()
  }

  async flush() {
    if (this.conflict) throw new EbookProgressConflictError(this.conflict.local, this.conflict.remote)
    if (this.pending) return this.ensureDrain()
    return this.drainPromise || this.remote
  }

  dispose() {
    this.disposed = true
  }
}

export function createEbookReadingProgressSync(options) {
  return new EbookReadingProgressSync(options)
}
