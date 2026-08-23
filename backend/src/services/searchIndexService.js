import { createHash } from 'node:crypto'

import {
  SEARCH_INDEX_ENTRY_TABLE,
  SEARCH_INDEX_FTS_TABLE,
  SEARCH_INDEX_SCHEMA_VERSION,
  SEARCH_INDEX_STATE_TABLE
} from '../config/searchIndexSchema.js'

const RESOURCE_TYPES = new Set([
  'document',
  'ebook',
  'ebook_chapter',
  'code_repository',
  'code_file',
  'note',
  'audio'
])
const RESULT_SCOPES = new Set(['owned', 'external'])
const INDEX_STATUSES = new Set(['ready', 'metadata_only', 'stale'])
const MAX_QUERY_LENGTH = 256
const MAX_BODY_LENGTH = 1024 * 1024
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
const CJK_SEQUENCE = /\p{Script=Han}+/gu
const SEARCH_TOKEN = /[\p{L}\p{N}_-]+/gu
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u
const POSIX_FILESYSTEM_PATH = /^\/(?!documents(?:\/|$)|books(?:\/|$)|code(?:\/|$)|blog(?:\/|$)|music(?:\/|$))/u

export const SEARCH_INDEX_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'SEARCH_INPUT_INVALID',
  INDEX_MISSING: 'SEARCH_INDEX_MISSING',
  INDEX_UNAVAILABLE: 'SEARCH_INDEX_UNAVAILABLE',
  REFRESH_FAILED: 'SEARCH_INDEX_REFRESH_FAILED'
})

export class SearchIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SearchIndexError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details) {
  throw new SearchIndexError(code, message, details)
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
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function optionalText(value, fieldName, maxLength = MAX_BODY_LENGTH) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').replace(/\u0000/gu, '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function requiredText(value, fieldName, maxLength = 512) {
  const normalized = optionalText(value, fieldName, maxLength)
  if (!normalized) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is required.`)
  return normalized
}

function positiveInteger(value, fieldName, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function timestamp(value, fieldName) {
  if (value === undefined || value === null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  return date.toISOString()
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(value)
            return Array.isArray(parsed) ? parsed : value.split(',')
          } catch {
            return value.split(',')
          }
        })()
      : []
  const seen = new Set()
  const tags = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const normalized = item.normalize('NFKC').trim().slice(0, 80)
    const key = normalized.toLocaleLowerCase('und')
    if (normalized && !seen.has(key)) {
      seen.add(key)
      tags.push(normalized)
    }
  }
  return Object.freeze(tags.slice(0, 100))
}

function normalizeLocator(value) {
  if (!isPlainObject(value)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator is invalid.')
  const allowed = new Set(['route', 'documentId', 'bookId', 'chapterIndex', 'repositoryId', 'path', 'line', 'postId', 'musicId'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator contains unsupported fields.')
  }
  const locator = {}
  const route = requiredText(value.route, 'locator.route', 64)
  if (!/^\/(documents|books|code|blog|music)$/u.test(route)) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator.route is invalid.')
  }
  locator.route = route
  for (const key of ['documentId', 'bookId', 'repositoryId', 'postId', 'musicId']) {
    if (value[key] !== undefined) locator[key] = positiveInteger(value[key], `locator.${key}`)
  }
  if (value.chapterIndex !== undefined) {
    if (!Number.isSafeInteger(value.chapterIndex) || value.chapterIndex < 0) {
      fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator.chapterIndex is invalid.')
    }
    locator.chapterIndex = value.chapterIndex
  }
  if (value.line !== undefined) locator.line = positiveInteger(value.line, 'locator.line')
  if (value.path !== undefined) {
    const relativePath = requiredText(value.path, 'locator.path', 1024).replaceAll('\\', '/')
    if (relativePath.startsWith('/') || /^[A-Za-z]:\//u.test(relativePath) ||
        relativePath.split('/').some((part) => part === '..' || part === '.')) {
      fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator.path is invalid.')
    }
    locator.path = relativePath
  }
  const serialized = stableJson(locator)
  if (WINDOWS_ABSOLUTE_PATH.test(serialized) || POSIX_FILESYSTEM_PATH.test(serialized) || /storage_key|managed_storage_key/iu.test(serialized)) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'locator exposes an internal path.')
  }
  return Object.freeze(locator)
}

function cjkNgrams(value) {
  const grams = []
  for (const match of value.matchAll(CJK_SEQUENCE)) {
    const characters = [...match[0]]
    grams.push(...characters)
    for (let index = 0; index + 1 < characters.length; index += 1) {
      grams.push(`${characters[index]}${characters[index + 1]}`)
    }
  }
  return grams
}

export function buildSearchText(parts) {
  const visible = parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    .normalize('NFKC')
    .slice(0, MAX_BODY_LENGTH * 2)
  const grams = cjkNgrams(visible)
  return grams.length > 0 ? `${visible}\n${grams.join(' ')}` : visible
}

function normalizeEntry(value, indexedAt) {
  if (!isPlainObject(value)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'search entry is invalid.')
  const resourceType = requiredText(value.resourceType, 'resourceType', 64)
  if (!RESOURCE_TYPES.has(resourceType)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'resourceType is invalid.')
  const resultScope = value.resultScope ?? 'owned'
  if (!RESULT_SCOPES.has(resultScope)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'resultScope is invalid.')
  const tags = normalizeTags(value.tags)
  const locator = normalizeLocator(value.locator)
  const normalized = {
    entryKey: requiredText(value.entryKey, 'entryKey', 512),
    resourceType,
    resultScope,
    resourceId: positiveInteger(value.resourceId, 'resourceId', { optional: true }),
    domainId: positiveInteger(value.domainId, 'domainId'),
    parentDomainId: positiveInteger(value.parentDomainId, 'parentDomainId', { optional: true }),
    title: requiredText(value.title, 'title', 512),
    subtitle: optionalText(value.subtitle, 'subtitle', 1024),
    body: optionalText(value.body, 'body', MAX_BODY_LENGTH),
    tags,
    author: optionalText(value.author, 'author', 512),
    status: optionalText(value.status, 'status', 128),
    sourceKind: requiredText(value.sourceKind, 'sourceKind', 128),
    sourceLabel: optionalText(value.sourceLabel, 'sourceLabel', 512),
    locator,
    sourceUpdatedAt: timestamp(value.sourceUpdatedAt, 'sourceUpdatedAt'),
    indexStatus: value.indexStatus ?? 'ready',
    indexedAt
  }
  if (!INDEX_STATUSES.has(normalized.indexStatus)) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'indexStatus is invalid.')
  }
  normalized.searchText = buildSearchText([
    normalized.title,
    normalized.subtitle,
    normalized.body,
    normalized.tags,
    normalized.author,
    normalized.sourceLabel
  ])
  normalized.sourceFingerprint = sha256(stableJson({
    schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
    ...normalized,
    indexedAt: undefined,
    searchText: normalized.searchText
  }))
  return Object.freeze(normalized)
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(SEARCH_INDEX_ERROR_CODES.INDEX_UNAVAILABLE, 'Search index database is unavailable.')
  }
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name))
}

function ensureFtsObjects(database) {
  assertDatabase(database)
  if (!tableExists(database, SEARCH_INDEX_ENTRY_TABLE) || !tableExists(database, SEARCH_INDEX_STATE_TABLE)) {
    fail(SEARCH_INDEX_ERROR_CODES.INDEX_MISSING, 'Search index schema is missing.')
  }
  const ftsExisted = tableExists(database, SEARCH_INDEX_FTS_TABLE)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_search_entries_type_scope ON search_index_entries(resource_type, result_scope);
    CREATE INDEX IF NOT EXISTS idx_search_entries_status ON search_index_entries(status);
    CREATE INDEX IF NOT EXISTS idx_search_entries_updated_at ON search_index_entries(source_updated_at);
    CREATE INDEX IF NOT EXISTS idx_search_entries_resource ON search_index_entries(resource_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
      search_text,
      content='search_index_entries',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `)
  if (!ftsExisted) database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('rebuild')").run()
}

export function normalizeSearchQuery(input = {}) {
  if (!isPlainObject(input)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'Search query is invalid.')
  const keyword = requiredText(input.q ?? input.keyword, 'q', MAX_QUERY_LENGTH)
  const tokens = keyword.normalize('NFKC').toLocaleLowerCase('und').match(SEARCH_TOKEN) ?? []
  if (tokens.length === 0) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'q is invalid.')
  const matchTokens = []
  for (const token of tokens) {
    const cjk = [...token.matchAll(CJK_SEQUENCE)]
    if (cjk.length === 1 && cjk[0][0] === token) {
      const characters = [...token]
      if (characters.length === 1) matchTokens.push(characters[0])
      else for (let index = 0; index + 1 < characters.length; index += 1) matchTokens.push(`${characters[index]}${characters[index + 1]}`)
    } else {
      matchTokens.push(token)
    }
  }
  const uniqueTokens = [...new Set(matchTokens)].slice(0, 32)
  const ftsQuery = uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ')
  const rawTypes = input.types ?? input.type
  const types = rawTypes === undefined || rawTypes === null || rawTypes === ''
    ? []
    : (Array.isArray(rawTypes) ? rawTypes : String(rawTypes).split(','))
      .map((value) => String(value).trim())
      .filter(Boolean)
  if (types.some((type) => !RESOURCE_TYPES.has(type))) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'type filter is invalid.')
  const scope = input.scope ?? 'owned'
  if (scope !== 'all' && !RESULT_SCOPES.has(scope)) fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'scope is invalid.')
  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit)
  const offset = input.offset === undefined ? 0 : Number(input.offset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
    fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'pagination is invalid.')
  }
  return Object.freeze({
    keyword,
    ftsQuery,
    matchTokens: Object.freeze(uniqueTokens),
    types: Object.freeze([...new Set(types)]),
    scope,
    tag: optionalText(input.tag, 'tag', 80),
    author: optionalText(input.author, 'author', 256),
    status: optionalText(input.status, 'status', 128),
    source: optionalText(input.source, 'source', 128),
    dateFrom: timestamp(input.dateFrom, 'dateFrom'),
    dateTo: timestamp(input.dateTo, 'dateTo'),
    limit,
    offset
  })
}

function rowToResult(row, query) {
  const fields = [
    ['title', row.title],
    ['subtitle', row.subtitle],
    ['body', row.body],
    ['tags', (JSON.parse(row.tags ?? '[]')).join(' ')],
    ['author', row.author],
    ['source', row.source_label]
  ]
  const normalizedKeyword = query.keyword.normalize('NFKC').toLocaleLowerCase('und')
  const matchedFields = fields
    .filter(([, value]) => typeof value === 'string' && (
      value.normalize('NFKC').toLocaleLowerCase('und').includes(normalizedKeyword) ||
      query.matchTokens.some((token) => value.normalize('NFKC').toLocaleLowerCase('und').includes(token))
    ))
    .map(([name]) => name)
  const snippetSource = row.body || row.subtitle || row.title
  const lowerSnippet = snippetSource.normalize('NFKC').toLocaleLowerCase('und')
  const positions = [normalizedKeyword, ...query.matchTokens]
    .map((token) => lowerSnippet.indexOf(token))
    .filter((position) => position >= 0)
  const position = positions.length > 0 ? Math.min(...positions) : 0
  const start = Math.max(0, position - 60)
  const snippet = `${start > 0 ? '…' : ''}${snippetSource.slice(start, start + 180)}${start + 180 < snippetSource.length ? '…' : ''}`
  const locator = JSON.parse(row.locator_json)
  if (row.resource_type === 'code_file' && row.body && positions.length > 0) {
    locator.line = row.body.slice(0, Math.min(...positions)).split('\n').length
  }
  return Object.freeze({
    id: row.id,
    entryKey: row.entry_key,
    resourceType: row.resource_type,
    scope: row.result_scope,
    resourceId: row.resource_id,
    domainId: row.domain_id,
    parentDomainId: row.parent_domain_id,
    title: row.title,
    subtitle: row.subtitle,
    tags: Object.freeze(JSON.parse(row.tags ?? '[]')),
    author: row.author,
    status: row.status,
    source: Object.freeze({ kind: row.source_kind, label: row.source_label }),
    locator: Object.freeze(locator),
    indexStatus: row.index_status,
    updatedAt: row.source_updated_at,
    matchedFields: Object.freeze(matchedFields),
    snippet,
    score: Number.isFinite(row.rank) ? -row.rank : 0
  })
}

function readWorkerState(database, now) {
  if (!tableExists(database, 'pc_workers')) return Object.freeze({ required: false, status: 'unavailable' })
  const cutoff = new Date(now.getTime() - 120_000).toISOString()
  const online = database.prepare(`
    SELECT COUNT(*) AS count FROM pc_workers
     WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at >= ?
  `).get(cutoff)?.count ?? 0
  return Object.freeze({ required: false, status: online > 0 ? 'online' : 'offline' })
}

export class SearchIndexService {
  constructor({ database, collectEntries, now = () => new Date() } = {}) {
    assertDatabase(database)
    if (typeof collectEntries !== 'function') fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'collectEntries is required.')
    if (typeof now !== 'function') fail(SEARCH_INDEX_ERROR_CODES.INPUT_INVALID, 'now is invalid.')
    this.database = database
    this.collectEntries = collectEntries
    this.now = now
  }

  getStatus() {
    if (!tableExists(this.database, SEARCH_INDEX_STATE_TABLE) || !tableExists(this.database, SEARCH_INDEX_FTS_TABLE)) {
      return Object.freeze({ status: 'missing', schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, entryCount: 0, errorCount: 0 })
    }
    const row = this.database.prepare('SELECT * FROM search_index_state WHERE id = 1').get()
    if (!row) return Object.freeze({ status: 'missing', schemaVersion: SEARCH_INDEX_SCHEMA_VERSION, entryCount: 0, errorCount: 0 })
    return Object.freeze({
      status: row.status,
      schemaVersion: row.schema_version,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      entryCount: row.entry_count,
      errorCount: row.error_count,
      lastErrorCode: row.last_error_code,
      pcWorker: readWorkerState(this.database, this.now())
    })
  }

  async refresh({ rebuild = false, includeCodeFiles = true, signal, onProgress = async () => {} } = {}) {
    ensureFtsObjects(this.database)
    if (signal?.aborted) fail(SEARCH_INDEX_ERROR_CODES.REFRESH_FAILED, 'Search index refresh was cancelled.')
    const startedAt = this.now().toISOString()
    this.database.prepare(`
      UPDATE search_index_state
         SET status = 'rebuilding', last_started_at = ?, last_error_code = NULL, updated_at = ?
       WHERE id = 1
    `).run(startedAt, startedAt)
    try {
      const collected = await this.collectEntries({
        database: this.database,
        includeCodeFiles,
        signal,
        onProgress
      })
      const sourceEntries = Array.isArray(collected) ? collected : collected?.entries
      const errors = Array.isArray(collected?.errors) ? collected.errors : []
      if (!Array.isArray(sourceEntries)) fail(SEARCH_INDEX_ERROR_CODES.REFRESH_FAILED, 'Search source collector returned invalid data.')
      const indexedAt = this.now().toISOString()
      const normalizedEntries = sourceEntries.map((entry) => normalizeEntry(entry, indexedAt))
      const keys = new Set()
      for (const entry of normalizedEntries) {
        if (keys.has(entry.entryKey)) fail(SEARCH_INDEX_ERROR_CODES.REFRESH_FAILED, 'Search source collector returned duplicate keys.')
        keys.add(entry.entryKey)
      }
      const upsert = this.database.prepare(`
        INSERT INTO search_index_entries (
          entry_key, resource_type, result_scope, resource_id, domain_id, parent_domain_id,
          title, subtitle, body, tags, author, status, source_kind, source_label,
          search_text, locator_json, source_fingerprint, source_updated_at, index_status, indexed_at
        ) VALUES (
          @entryKey, @resourceType, @resultScope, @resourceId, @domainId, @parentDomainId,
          @title, @subtitle, @body, @tagsJson, @author, @status, @sourceKind, @sourceLabel,
          @searchText, @locatorJson, @sourceFingerprint, @sourceUpdatedAt, @indexStatus, @indexedAt
        )
        ON CONFLICT(entry_key) DO UPDATE SET
          resource_type = excluded.resource_type,
          result_scope = excluded.result_scope,
          resource_id = excluded.resource_id,
          domain_id = excluded.domain_id,
          parent_domain_id = excluded.parent_domain_id,
          title = excluded.title,
          subtitle = excluded.subtitle,
          body = excluded.body,
          tags = excluded.tags,
          author = excluded.author,
          status = excluded.status,
          source_kind = excluded.source_kind,
          source_label = excluded.source_label,
          search_text = excluded.search_text,
          locator_json = excluded.locator_json,
          source_fingerprint = excluded.source_fingerprint,
          source_updated_at = excluded.source_updated_at,
          index_status = excluded.index_status,
          indexed_at = excluded.indexed_at
        WHERE search_index_entries.source_fingerprint <> excluded.source_fingerprint
      `)
      const existingEntries = new Map(this.database.prepare(
        'SELECT id, entry_key, source_fingerprint, search_text FROM search_index_entries'
      ).all().map((row) => [row.entry_key, row]))
      let inserted = 0
      let updated = 0
      let skipped = 0
      let deleted = 0
      this.database.transaction(() => {
        if (rebuild) {
          deleted += this.database.prepare('DELETE FROM search_index_entries').run().changes
          this.database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('rebuild')").run()
        }
        for (const entry of normalizedEntries) {
          const previous = rebuild ? null : existingEntries.get(entry.entryKey)
          if (previous?.source_fingerprint === entry.sourceFingerprint) {
            skipped += 1
            continue
          }
          if (previous) {
            this.database.prepare(`
              INSERT INTO search_index_fts(search_index_fts, rowid, search_text)
              VALUES ('delete', ?, ?)
            `).run(previous.id, previous.search_text)
          }
          const result = upsert.run({
            ...entry,
            tagsJson: JSON.stringify(entry.tags),
            locatorJson: JSON.stringify(entry.locator)
          })
          const currentId = this.database.prepare('SELECT id FROM search_index_entries WHERE entry_key = ?').get(entry.entryKey)?.id
          this.database.prepare('INSERT INTO search_index_fts(rowid, search_text) VALUES (?, ?)')
            .run(currentId, entry.searchText)
          if (!previous) inserted += result.changes > 0 ? 1 : 0
          else updated += result.changes > 0 ? 1 : 0
        }
        if (!rebuild) {
          for (const [entryKey, previous] of existingEntries) {
            if (!keys.has(entryKey)) {
              this.database.prepare(`
                INSERT INTO search_index_fts(search_index_fts, rowid, search_text)
                VALUES ('delete', ?, ?)
              `).run(previous.id, previous.search_text)
              deleted += this.database.prepare('DELETE FROM search_index_entries WHERE entry_key = ?').run(entryKey).changes
            }
          }
        }
        this.database.prepare("INSERT INTO search_index_fts(search_index_fts) VALUES ('optimize')").run()
      })()
      const entryCount = this.database.prepare('SELECT COUNT(*) AS count FROM search_index_entries').get().count
      const completedAt = this.now().toISOString()
      const finalStatus = errors.length > 0 ? 'partial' : 'ready'
      this.database.prepare(`
        UPDATE search_index_state
           SET status = ?, last_completed_at = ?, entry_count = ?, error_count = ?,
               last_error_code = ?, updated_at = ?
         WHERE id = 1
      `).run(finalStatus, completedAt, entryCount, errors.length, errors[0]?.code ?? null, completedAt)
      await onProgress(100)
      return Object.freeze({ status: finalStatus, inserted, updated, skipped, deleted, entryCount, errorCount: errors.length })
    } catch (error) {
      const failedAt = this.now().toISOString()
      const code = error instanceof SearchIndexError ? error.code : SEARCH_INDEX_ERROR_CODES.REFRESH_FAILED
      this.database.prepare(`
        UPDATE search_index_state
           SET status = 'failed', error_count = error_count + 1, last_error_code = ?, updated_at = ?
         WHERE id = 1
      `).run(code, failedAt)
      if (error instanceof SearchIndexError) throw error
      throw new SearchIndexError(SEARCH_INDEX_ERROR_CODES.REFRESH_FAILED, 'Search index refresh failed.', { cause: error })
    }
  }

  query(input = {}) {
    const query = normalizeSearchQuery(input)
    if (!tableExists(this.database, SEARCH_INDEX_FTS_TABLE)) {
      fail(SEARCH_INDEX_ERROR_CODES.INDEX_MISSING, 'Search index is missing.')
    }
    const clauses = ['search_index_fts MATCH ?']
    const parameters = [query.ftsQuery]
    if (query.scope !== 'all') {
      clauses.push('e.result_scope = ?')
      parameters.push(query.scope)
    }
    if (query.types.length > 0) {
      clauses.push(`e.resource_type IN (${query.types.map(() => '?').join(', ')})`)
      parameters.push(...query.types)
    }
    if (query.tag) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(COALESCE(e.tags, '[]')) WHERE lower(value) = lower(?))")
      parameters.push(query.tag)
    }
    for (const [field, value] of [['e.author', query.author], ['e.status', query.status], ['e.source_kind', query.source]]) {
      if (value) {
        clauses.push(`lower(${field}) = lower(?)`)
        parameters.push(value)
      }
    }
    if (query.dateFrom) {
      clauses.push('e.source_updated_at >= ?')
      parameters.push(query.dateFrom)
    }
    if (query.dateTo) {
      clauses.push('e.source_updated_at <= ?')
      parameters.push(query.dateTo)
    }
    const fromWhere = `
        FROM search_index_fts
        JOIN search_index_entries e ON e.id = search_index_fts.rowid
       WHERE ${clauses.join(' AND ')}
    `
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count ${fromWhere}`).get(...parameters)?.count ?? 0)
    const grouped = this.database.prepare(`
      SELECT e.resource_type AS resource_type, COUNT(*) AS count ${fromWhere}
       GROUP BY e.resource_type
    `).all(...parameters)
    const rows = this.database.prepare(`
      SELECT e.*, bm25(search_index_fts) AS rank
        ${fromWhere}
       ORDER BY rank ASC, e.source_updated_at DESC, e.id ASC
       LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, query.offset)
    const results = Object.freeze(rows.map((row) => rowToResult(row, query)))
    const summary = Object.fromEntries([...RESOURCE_TYPES].map((type) => [type, 0]))
    for (const row of grouped) summary[row.resource_type] = Number(row.count)
    const status = this.getStatus()
    return Object.freeze({
      query: query.keyword,
      data: results,
      total,
      limit: query.limit,
      offset: query.offset,
      summary: Object.freeze(summary),
      index: status,
      externalDiscovery: Object.freeze({ enabled: false, status: 'not_configured' })
    })
  }
}

export function createSearchIndexService(options) {
  return new SearchIndexService(options)
}

export { ensureFtsObjects as ensureSearchIndexRuntimeSchema, normalizeEntry as normalizeSearchIndexEntry }
export default createSearchIndexService
