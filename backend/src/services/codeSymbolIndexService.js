import { createHash } from 'node:crypto'

import {
  CODE_SYMBOL_ENTRY_TABLE,
  CODE_SYMBOL_SCHEMA_VERSION,
  CODE_SYMBOL_SNAPSHOT_TABLE,
  CODE_SYMBOL_STATE_TABLE
} from '../config/codeSymbolIndexSchema.js'
import {
  CODE_SYMBOL_EXTRACTOR_VERSION,
  extractCodeSymbols
} from './codeSymbolExtractor.js'

export const CODE_SYMBOL_STRATEGY_VERSION = 'symbols-v1'

const MAX_QUERY_LENGTH = 256
const MAX_BRANCH_LENGTH = 512
const MAX_PATH_LENGTH = 2048
const MAX_FILES_PER_REPOSITORY = 5000
const MAX_FILE_CHARACTERS = 1024 * 1024
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const CONTENT_HASH = /^[0-9a-f]{64}$/u
const SAFE_SOURCE_KINDS = new Set(['managed_git', 'git_nas'])

export const CODE_SYMBOL_INDEX_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'CODE_SYMBOL_INPUT_INVALID',
  SCHEMA_MISSING: 'CODE_SYMBOL_SCHEMA_MISSING',
  REFRESH_FAILED: 'CODE_SYMBOL_REFRESH_FAILED',
  CANCELLED: 'CODE_SYMBOL_CANCELLED'
})

export class CodeSymbolIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'CodeSymbolIndexError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details) {
  throw new CodeSymbolIndexError(code, message, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isPlainObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function positiveInteger(value, fieldName) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function safeText(value, fieldName, maxLength, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null
  if (typeof value !== 'string') fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').replace(/\u0000/gu, '').trim()
  if (!normalized) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  return normalized.slice(0, maxLength)
}

function safeRelativePath(value) {
  const normalized = safeText(value, 'path', MAX_PATH_LENGTH).replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) ||
      normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'path is invalid.')
  }
  return normalized
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name))
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.SCHEMA_MISSING, 'Code symbol index database is unavailable.')
  }
}

function ensureSchema(database) {
  assertDatabase(database)
  for (const table of [CODE_SYMBOL_SNAPSHOT_TABLE, CODE_SYMBOL_ENTRY_TABLE, CODE_SYMBOL_STATE_TABLE]) {
    if (!tableExists(database, table)) {
      fail(CODE_SYMBOL_INDEX_ERROR_CODES.SCHEMA_MISSING, 'Code symbol index schema is missing.')
    }
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_symbol_snapshots_repository ON code_symbol_snapshots(repository_id, indexed_at);
    CREATE INDEX IF NOT EXISTS idx_code_symbol_entries_snapshot ON code_symbol_entries(snapshot_id, relative_path, start_line);
    CREATE INDEX IF NOT EXISTS idx_code_symbol_entries_name ON code_symbol_entries(name, qualified_name);
    CREATE INDEX IF NOT EXISTS idx_code_symbol_entries_repository ON code_symbol_entries(repository_id, commit_hash);
    CREATE INDEX IF NOT EXISTS idx_code_symbol_state_active ON code_symbol_repository_state(active_snapshot_id);
  `)
}

function normalizeFile(value) {
  if (!isPlainObject(value)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'file is invalid.')
  const relativePath = safeRelativePath(value.path)
  if (typeof value.content !== 'string' || value.content.length > MAX_FILE_CHARACTERS) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'file content is invalid.')
  }
  const contentHash = value.contentHash === undefined
    ? sha256(value.content)
    : safeText(value.contentHash, 'contentHash', 64).toLocaleLowerCase('und')
  if (!CONTENT_HASH.test(contentHash)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'contentHash is invalid.')
  if (sha256(value.content) !== contentHash) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'contentHash does not match content.')
  return Object.freeze({ path: relativePath, content: value.content, contentHash })
}

function normalizeSnapshot(value) {
  if (!isPlainObject(value)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'snapshot is invalid.')
  const repositoryId = positiveInteger(value.repositoryId, 'repositoryId')
  const sourceKind = safeText(value.sourceKind, 'sourceKind', 64)
  if (!SAFE_SOURCE_KINDS.has(sourceKind)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'sourceKind is invalid.')
  const branch = safeText(value.branch, 'branch', MAX_BRANCH_LENGTH, { optional: true })
  const commit = safeText(value.commit, 'commit', 64).toLocaleLowerCase('und')
  if (!COMMIT_HASH.test(commit)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'commit is invalid.')
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES_PER_REPOSITORY) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'files are invalid.')
  }
  const files = value.files.map(normalizeFile).sort((left, right) => left.path.localeCompare(right.path))
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'files contain duplicate paths.')
  }
  const errors = Array.isArray(value.errors)
    ? value.errors.map((error) => Object.freeze({
        code: safeText(error?.code, 'error.code', 128),
        path: error?.path === undefined ? null : safeRelativePath(error.path)
      }))
    : []
  return Object.freeze({ repositoryId, sourceKind, branch, commit, files: Object.freeze(files), errors: Object.freeze(errors) })
}

function normalizeCollection(value) {
  const source = Array.isArray(value) ? { snapshots: value, errors: [] } : value
  if (!isPlainObject(source) || !Array.isArray(source.snapshots)) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'snapshot collector returned invalid data.')
  }
  const snapshots = source.snapshots.map(normalizeSnapshot)
  if (new Set(snapshots.map((snapshot) => snapshot.repositoryId)).size !== snapshots.length) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'snapshot collector returned duplicate repositories.')
  }
  const errors = Array.isArray(source.errors)
    ? source.errors.map((error) => Object.freeze({
        repositoryId: positiveInteger(error?.repositoryId, 'error.repositoryId'),
        code: safeText(error?.code, 'error.code', 128)
      }))
    : []
  return Object.freeze({ snapshots: Object.freeze(snapshots), errors: Object.freeze(errors) })
}

function normalizeQuery(input) {
  if (!isPlainObject(input)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'query is invalid.')
  const keyword = safeText(input.q ?? input.keyword, 'q', MAX_QUERY_LENGTH)
  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit)
  const offset = input.offset === undefined ? 0 : Number(input.offset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
    fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'pagination is invalid.')
  }
  const rawTypes = input.types ?? input.type
  const types = rawTypes === undefined || rawTypes === null || rawTypes === ''
    ? []
    : (Array.isArray(rawTypes) ? rawTypes : String(rawTypes).split(','))
      .map((value) => String(value).trim()).filter(Boolean)
  const optional = (value, fieldName, maxLength = 256) =>
    value === undefined || value === null || value === '' ? null : safeText(value, fieldName, maxLength)
  const scope = input.scope ?? 'owned'
  if (!['owned', 'external', 'all'].includes(scope)) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'scope is invalid.')
  const asTimestamp = (value, fieldName) => {
    if (value === undefined || value === null || value === '') return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
    return date.toISOString()
  }
  return Object.freeze({
    keyword,
    normalized: keyword.toLocaleLowerCase('und'),
    limit,
    offset,
    types: Object.freeze(types),
    scope,
    tag: optional(input.tag, 'tag', 80),
    author: optional(input.author, 'author'),
    status: optional(input.status, 'status', 128),
    source: optional(input.source, 'source', 128),
    dateFrom: asTimestamp(input.dateFrom, 'dateFrom'),
    dateTo: asTimestamp(input.dateTo, 'dateTo')
  })
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function publicResult(row) {
  const stale = row.repository_status === 'failed' || row.repository_status === 'indexing'
  const locator = Object.freeze({
    route: '/code',
    repositoryId: Number(row.repository_id),
    path: row.relative_path,
    line: Number(row.start_line),
    commit: row.commit_hash
  })
  return Object.freeze({
    id: `symbol:${row.id}`,
    entryKey: `code-symbol:${row.repository_id}:${row.commit_hash}:${row.relative_path}:${row.kind}:${row.start_line}:${row.qualified_name}`,
    resourceType: 'code_file',
    scope: 'owned',
    resourceId: null,
    domainId: Number(row.repository_id),
    parentDomainId: Number(row.repository_id),
    title: row.qualified_name,
    subtitle: `${row.repository_name} · ${row.relative_path}:${row.start_line}`,
    tags: Object.freeze([row.language, row.kind]),
    author: null,
    status: row.source_kind === 'git_nas' ? 'read_only' : 'active',
    source: Object.freeze({ kind: row.source_kind, label: row.repository_name }),
    locator,
    indexStatus: stale ? 'stale' : row.snapshot_status,
    updatedAt: row.indexed_at,
    matchedFields: Object.freeze(Number(row.match_rank) <= 1 ? ['symbol'] : ['qualifiedName']),
    snippet: row.signature || row.qualified_name,
    score: 1 / (1 + Number(row.match_rank)),
    commit: row.commit_hash,
    symbol: Object.freeze({
      name: row.name,
      qualifiedName: row.qualified_name,
      kind: row.kind,
      language: row.language,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line)
    })
  })
}

export class CodeSymbolIndexService {
  constructor({ database, collectSnapshots, now = () => new Date() } = {}) {
    assertDatabase(database)
    if (collectSnapshots !== undefined && typeof collectSnapshots !== 'function') {
      fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'collectSnapshots is invalid.')
    }
    if (typeof now !== 'function') fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'now is invalid.')
    this.database = database
    this.collectSnapshots = collectSnapshots
    this.now = now
  }

  getStatus() {
    if (!tableExists(this.database, CODE_SYMBOL_STATE_TABLE) || !tableExists(this.database, CODE_SYMBOL_SNAPSHOT_TABLE)) {
      return Object.freeze({ status: 'missing', schemaVersion: CODE_SYMBOL_SCHEMA_VERSION, repositoryCount: 0, symbolCount: 0, staleCount: 0 })
    }
    const summary = this.database.prepare(`
      SELECT COUNT(*) AS repository_count,
             COALESCE(SUM(CASE WHEN state.status IN ('failed', 'indexing') AND state.active_snapshot_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS stale_count,
             COALESCE(SUM(snapshot.symbol_count), 0) AS symbol_count,
             COALESCE(SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
             COALESCE(SUM(CASE WHEN state.status = 'partial' THEN 1 ELSE 0 END), 0) AS partial_count
        FROM code_symbol_repository_state state
        LEFT JOIN code_symbol_snapshots snapshot ON snapshot.id = state.active_snapshot_id
    `).get()
    const repositoryCount = Number(summary.repository_count)
    const failedCount = Number(summary.failed_count)
    const partialCount = Number(summary.partial_count)
    return Object.freeze({
      status: failedCount > 0 ? 'partial' : partialCount > 0 ? 'partial' : repositoryCount > 0 ? 'ready' : 'empty',
      schemaVersion: CODE_SYMBOL_SCHEMA_VERSION,
      repositoryCount,
      symbolCount: Number(summary.symbol_count),
      staleCount: Number(summary.stale_count),
      failedCount,
      partialCount
    })
  }

  recordFailure(repositoryId, code, at) {
    this.database.prepare(`
      INSERT INTO code_symbol_repository_state (
        repository_id, schema_version, status, last_started_at, last_error_code, updated_at
      ) VALUES (?, ?, 'failed', ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        status = 'failed', last_started_at = excluded.last_started_at,
        last_error_code = excluded.last_error_code, updated_at = excluded.updated_at
    `).run(repositoryId, CODE_SYMBOL_SCHEMA_VERSION, at, String(code || CODE_SYMBOL_INDEX_ERROR_CODES.REFRESH_FAILED).slice(0, 128), at)
  }

  refreshSnapshot(rawSnapshot, { rebuild = false } = {}) {
    ensureSchema(this.database)
    const snapshot = normalizeSnapshot(rawSnapshot)
    const startedAt = this.now().toISOString()
    this.database.prepare(`
      INSERT INTO code_symbol_repository_state (
        repository_id, schema_version, status, last_started_at, last_error_code, updated_at
      ) VALUES (?, ?, 'indexing', ?, NULL, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        status = 'indexing', last_started_at = excluded.last_started_at,
        last_error_code = NULL, updated_at = excluded.updated_at
    `).run(snapshot.repositoryId, CODE_SYMBOL_SCHEMA_VERSION, startedAt, startedAt)

    try {
      const active = this.database.prepare(`
        SELECT snapshot.*
          FROM code_symbol_repository_state state
          JOIN code_symbol_snapshots snapshot ON snapshot.id = state.active_snapshot_id
         WHERE state.repository_id = ?
      `).get(snapshot.repositoryId)
      if (!rebuild && snapshot.errors.length === 0 && Number(active?.error_count ?? 0) === 0 &&
          active?.commit_hash === snapshot.commit &&
          active?.extractor_version === CODE_SYMBOL_EXTRACTOR_VERSION &&
          active?.strategy_version === CODE_SYMBOL_STRATEGY_VERSION) {
        const completedAt = this.now().toISOString()
        this.database.transaction(() => {
          this.database.prepare('UPDATE code_symbol_snapshots SET branch = ? WHERE id = ?').run(snapshot.branch, active.id)
          this.database.prepare(`
            UPDATE code_symbol_repository_state
               SET status = ?, last_completed_at = ?, last_error_code = NULL, updated_at = ?
             WHERE repository_id = ?
          `).run(active.status, completedAt, completedAt, snapshot.repositoryId)
        })()
        return Object.freeze({ repositoryId: snapshot.repositoryId, status: active.status, skipped: true, fileCount: active.file_count, symbolCount: active.symbol_count, errorCount: active.error_count })
      }

      const entries = []
      const extractionErrors = [...snapshot.errors]
      for (const file of snapshot.files) {
        try {
          const symbols = extractCodeSymbols({ filePath: file.path, content: file.content })
          for (const symbol of symbols) {
            entries.push(Object.freeze({
              ...symbol,
              contentHash: file.contentHash,
              sourceFingerprint: sha256(stableJson({
                extractorVersion: CODE_SYMBOL_EXTRACTOR_VERSION,
                strategyVersion: CODE_SYMBOL_STRATEGY_VERSION,
                repositoryId: snapshot.repositoryId,
                commit: snapshot.commit,
                contentHash: file.contentHash,
                ...symbol
              }))
            }))
          }
        } catch {
          extractionErrors.push(Object.freeze({ code: 'CODE_SYMBOL_FILE_PARTIAL', path: file.path }))
        }
      }
      entries.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.qualifiedName.localeCompare(right.qualifiedName))
      const completedAt = this.now().toISOString()
      const status = extractionErrors.length > 0 ? 'partial' : 'ready'
      let snapshotId
      this.database.transaction(() => {
        const oldSnapshotIds = this.database.prepare('SELECT id FROM code_symbol_snapshots WHERE repository_id = ?').all(snapshot.repositoryId).map((row) => row.id)
        if (oldSnapshotIds.length > 0) {
          const placeholders = oldSnapshotIds.map(() => '?').join(', ')
          this.database.prepare(`DELETE FROM code_symbol_entries WHERE snapshot_id IN (${placeholders})`).run(...oldSnapshotIds)
          this.database.prepare(`DELETE FROM code_symbol_snapshots WHERE id IN (${placeholders})`).run(...oldSnapshotIds)
        }
        const inserted = this.database.prepare(`
          INSERT INTO code_symbol_snapshots (
            repository_id, source_kind, branch, commit_hash, extractor_version, strategy_version,
            status, file_count, symbol_count, error_count, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          snapshot.repositoryId, snapshot.sourceKind, snapshot.branch, snapshot.commit,
          CODE_SYMBOL_EXTRACTOR_VERSION, CODE_SYMBOL_STRATEGY_VERSION, status,
          snapshot.files.length, entries.length, extractionErrors.length, completedAt
        )
        snapshotId = Number(inserted.lastInsertRowid)
        const insertEntry = this.database.prepare(`
          INSERT INTO code_symbol_entries (
            snapshot_id, repository_id, commit_hash, relative_path, content_hash, language,
            name, qualified_name, kind, signature, start_line, end_line, source_fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const entry of entries) {
          insertEntry.run(
            snapshotId, snapshot.repositoryId, snapshot.commit, entry.path, entry.contentHash, entry.language,
            entry.name, entry.qualifiedName, entry.kind, entry.signature,
            entry.startLine, entry.endLine, entry.sourceFingerprint
          )
        }
        this.database.prepare(`
          UPDATE code_symbol_repository_state
             SET active_snapshot_id = ?, status = ?, last_completed_at = ?,
                 last_error_code = ?, updated_at = ?
           WHERE repository_id = ?
        `).run(snapshotId, status, completedAt, extractionErrors[0]?.code ?? null, completedAt, snapshot.repositoryId)
      })()
      return Object.freeze({ repositoryId: snapshot.repositoryId, snapshotId, status, skipped: false, fileCount: snapshot.files.length, symbolCount: entries.length, errorCount: extractionErrors.length })
    } catch (error) {
      const failedAt = this.now().toISOString()
      const code = error instanceof CodeSymbolIndexError ? error.code : CODE_SYMBOL_INDEX_ERROR_CODES.REFRESH_FAILED
      this.recordFailure(snapshot.repositoryId, code, failedAt)
      if (error instanceof CodeSymbolIndexError) throw error
      throw new CodeSymbolIndexError(CODE_SYMBOL_INDEX_ERROR_CODES.REFRESH_FAILED, 'Code symbol snapshot refresh failed.', { cause: error })
    }
  }

  async refresh({ rebuild = false, signal, onProgress = async () => {} } = {}) {
    ensureSchema(this.database)
    if (typeof this.collectSnapshots !== 'function') fail(CODE_SYMBOL_INDEX_ERROR_CODES.INPUT_INVALID, 'collectSnapshots is required.')
    if (signal?.aborted) fail(CODE_SYMBOL_INDEX_ERROR_CODES.CANCELLED, 'Code symbol refresh was cancelled.')
    const collected = normalizeCollection(await this.collectSnapshots({ database: this.database, signal, onProgress }))
    const startedAt = this.now().toISOString()
    for (const error of collected.errors) this.recordFailure(error.repositoryId, error.code, startedAt)
    const results = []
    for (let index = 0; index < collected.snapshots.length; index += 1) {
      if (signal?.aborted) fail(CODE_SYMBOL_INDEX_ERROR_CODES.CANCELLED, 'Code symbol refresh was cancelled.')
      const snapshot = collected.snapshots[index]
      try {
        results.push(this.refreshSnapshot(snapshot, { rebuild }))
      } catch (error) {
        results.push(Object.freeze({
          repositoryId: snapshot.repositoryId,
          status: 'failed',
          skipped: false,
          fileCount: 0,
          symbolCount: 0,
          errorCount: 1,
          errorCode: error.code ?? CODE_SYMBOL_INDEX_ERROR_CODES.REFRESH_FAILED
        }))
      }
      await onProgress(Math.round(((index + 1) / Math.max(1, collected.snapshots.length)) * 100))
    }
    const repositoryCount = results.length + collected.errors.length
    const errorCount = collected.errors.length + results.reduce((sum, result) => sum + result.errorCount, 0)
    return Object.freeze({
      status: errorCount > 0 ? 'partial' : 'ready',
      repositoryCount,
      refreshed: results.filter((result) => !result.skipped && result.status !== 'failed').length,
      skipped: results.filter((result) => result.skipped).length,
      fileCount: results.reduce((sum, result) => sum + result.fileCount, 0),
      symbolCount: results.reduce((sum, result) => sum + result.symbolCount, 0),
      errorCount,
      results: Object.freeze(results)
    })
  }

  query(input = {}) {
    const query = normalizeQuery(input)
    const empty = () => Object.freeze({
      query: query.keyword,
      data: Object.freeze([]),
      total: 0,
      limit: query.limit,
      offset: query.offset,
      index: this.getStatus()
    })
    if (!tableExists(this.database, CODE_SYMBOL_ENTRY_TABLE) || !tableExists(this.database, CODE_SYMBOL_STATE_TABLE)) {
      return empty()
    }
    if (query.scope === 'external' || query.author ||
        (query.types.length > 0 && !query.types.some((type) => type === 'code_file' || type === 'code_repository'))) return empty()
    if (query.source && !SAFE_SOURCE_KINDS.has(query.source)) return empty()
    if (query.status && !['active', 'read_only'].includes(query.status)) return empty()
    const exact = query.normalized
    const prefix = `${escapeLike(query.normalized)}%`
    const contains = `%${escapeLike(query.normalized)}%`
    const parameters = [exact, exact, prefix, prefix, contains, contains]
    const matchRank = `CASE
      WHEN lower(entry.name) = ? THEN 0
      WHEN lower(entry.qualified_name) = ? THEN 1
      WHEN lower(entry.name) LIKE ? ESCAPE '\\' THEN 2
      WHEN lower(entry.qualified_name) LIKE ? ESCAPE '\\' THEN 3
      WHEN lower(entry.name) LIKE ? ESCAPE '\\' THEN 4
      WHEN lower(entry.qualified_name) LIKE ? ESCAPE '\\' THEN 5
      ELSE 6 END`
    const clauses = ["(lower(entry.name) LIKE ? ESCAPE '\\' OR lower(entry.qualified_name) LIKE ? ESCAPE '\\')"]
    const whereParameters = [contains, contains]
    if (query.source) {
      clauses.push('snapshot.source_kind = ?')
      whereParameters.push(query.source)
    }
    if (query.status) {
      clauses.push("snapshot.source_kind = ?")
      whereParameters.push(query.status === 'read_only' ? 'git_nas' : 'managed_git')
    }
    if (query.tag) {
      clauses.push('(lower(entry.language) = lower(?) OR lower(entry.kind) = lower(?))')
      whereParameters.push(query.tag, query.tag)
    }
    if (query.dateFrom) {
      clauses.push('snapshot.indexed_at >= ?')
      whereParameters.push(query.dateFrom)
    }
    if (query.dateTo) {
      clauses.push('snapshot.indexed_at <= ?')
      whereParameters.push(query.dateTo)
    }
    const fromWhere = `
      FROM code_symbol_entries entry
      JOIN code_symbol_repository_state state
        ON state.repository_id = entry.repository_id AND state.active_snapshot_id = entry.snapshot_id
      JOIN code_symbol_snapshots snapshot ON snapshot.id = entry.snapshot_id
      JOIN code_repositories repository ON repository.id = entry.repository_id
     WHERE ${clauses.join(' AND ')}
    `
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count ${fromWhere}`).get(...whereParameters)?.count ?? 0)
    const rows = this.database.prepare(`
      SELECT entry.*, repository.name AS repository_name,
             state.status AS repository_status, snapshot.status AS snapshot_status,
             snapshot.source_kind, snapshot.indexed_at,
             ${matchRank} AS match_rank
        ${fromWhere}
       ORDER BY match_rank ASC, length(entry.qualified_name) ASC,
                entry.repository_id ASC, entry.relative_path ASC, entry.start_line ASC
       LIMIT ? OFFSET ?
    `).all(...parameters, ...whereParameters, query.limit, query.offset)
    return Object.freeze({
      query: query.keyword,
      data: Object.freeze(rows.map(publicResult)),
      total,
      limit: query.limit,
      offset: query.offset,
      index: this.getStatus()
    })
  }
}

export function createCodeSymbolIndexService(options) {
  return new CodeSymbolIndexService(options)
}

export { ensureSchema as ensureCodeSymbolIndexRuntimeSchema, normalizeSnapshot as normalizeCodeSymbolSnapshot }
export default createCodeSymbolIndexService
