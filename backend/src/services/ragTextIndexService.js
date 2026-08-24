import crypto from 'node:crypto'

import {
  RAG_CHUNK_FTS_TABLE,
  RAG_CHUNK_TABLE,
  RAG_SOURCE_SNAPSHOT_TABLE,
  RAG_SOURCE_STATE_TABLE
} from '../config/ragIndexSchema.js'
import {
  chunkRagSource,
  normalizeRagChunkerOptions,
  RAG_CHUNKER_VERSION
} from './ragChunker.js'

const SOURCE_TYPES = new Set(['document', 'ebook', 'code_repository'])
const SOURCE_ROUTES = Object.freeze({
  document: '/documents',
  ebook: '/books',
  code_repository: '/code'
})
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const SNAPSHOT_COMPLETE_STATUSES = new Set(['text_ready', 'embedding_pending', 'ready', 'partial'])
const MAX_QUERY_LENGTH = 256
const MAX_QUERY_LIMIT = 100
const MAX_QUERY_OFFSET = 100_000
const MAX_QUERY_CANDIDATES = 5_000
const MAX_SOURCE_SECTIONS = 10_000
const MAX_SOURCE_CHUNKS = 100_000
const PUBLIC_LOCATOR_KEYS = new Set([
  'route', 'documentId', 'bookId', 'chapterIndex', 'repositoryId', 'path', 'line',
  'commit', 'versionId', 'sourceVersionId'
])
const SEARCH_TOKEN = /[\p{L}\p{N}_-]+/gu
const CJK_SEQUENCE = /\p{Script=Han}+/gu

export const RAG_TEXT_INDEX_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'RAG_TEXT_INDEX_INPUT_INVALID',
  SCHEMA_MISSING: 'RAG_TEXT_INDEX_SCHEMA_MISSING',
  COLLECTOR_INVALID: 'RAG_TEXT_INDEX_COLLECTOR_INVALID',
  SOURCE_INVALID: 'RAG_TEXT_INDEX_SOURCE_INVALID',
  CHUNK_INVALID: 'RAG_TEXT_INDEX_CHUNK_INVALID',
  SOURCE_FAILED: 'RAG_TEXT_INDEX_SOURCE_FAILED',
  QUERY_INVALID: 'RAG_TEXT_INDEX_QUERY_INVALID',
  VISIBILITY_FAILED: 'RAG_TEXT_INDEX_VISIBILITY_FAILED',
  INTERRUPTED: 'RAG_TEXT_INDEX_INTERRUPTED'
})

export class RagTextIndexError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RagTextIndexError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details) {
  throw new RagTextIndexError(code, message, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isPositiveInteger(value) {
  const normalized = typeof value === 'string' && /^[1-9]\d*$/u.test(value.trim())
    ? Number(value)
    : value
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null
}

function isNonNegativeInteger(value) {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value.trim())
    ? Number(value)
    : value
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null
}

function normalizeHash(value, fieldName) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value.toLowerCase())) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `${fieldName} is invalid.`)
  }
  return value.toLowerCase()
}

function requiredText(value, fieldName, maxLength = 512) {
  if (typeof value !== 'string') fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  if (!normalized || normalized.length > maxLength) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, `${fieldName} is invalid.`)
  }
  return normalized
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isPlainObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function asIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'timestamp is invalid.')
  return date.toISOString()
}

function tableExists(database, tableName) {
  return Boolean(database.prepare(
    'SELECT 1 FROM sqlite_schema WHERE name = ? LIMIT 1'
  ).get(tableName))
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SCHEMA_MISSING, 'RAG index database is unavailable.')
  }
  for (const table of [RAG_SOURCE_SNAPSHOT_TABLE, RAG_SOURCE_STATE_TABLE, RAG_CHUNK_TABLE, RAG_CHUNK_FTS_TABLE]) {
    if (!tableExists(database, table)) {
      fail(RAG_TEXT_INDEX_ERROR_CODES.SCHEMA_MISSING, `RAG index table ${table} is missing.`)
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_FAILED, 'RAG text indexing was cancelled.')
}

function normalizeError(value, fallbackSource) {
  if (!isPlainObject(value)) return null
  const code = typeof value.code === 'string' && /^[A-Z0-9][A-Z0-9_.-]{0,127}$/u.test(value.code)
    ? value.code
    : 'RAG_TEXT_INDEX_SOURCE_ERROR'
  const sourceType = value.sourceType ?? fallbackSource?.sourceType
  const sourceId = isPositiveInteger(value.sourceId ?? fallbackSource?.sourceId)
  return Object.freeze({
    code,
    ...(SOURCE_TYPES.has(sourceType) ? { sourceType } : {}),
    ...(sourceId ? { sourceId } : {})
  })
}

function dedupeErrors(errors) {
  const output = []
  const seen = new Set()
  for (const value of errors) {
    const error = normalizeError(value)
    if (!error) continue
    const key = `${error.code}\u0000${error.sourceType ?? ''}\u0000${error.sourceId ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      output.push(error)
    }
  }
  return Object.freeze(output)
}

function normalizeLocatorPart(value, fieldName) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `${fieldName} is invalid.`)
  }
  return value
}

function publicLocator(...parts) {
  const locator = {}
  for (const part of parts) {
    if (!isPlainObject(part)) continue
    for (const [key, value] of Object.entries(part)) {
      if (!PUBLIC_LOCATOR_KEYS.has(key)) continue
      const normalized = normalizeLocatorPart(value, `locator.${key}`)
      if (normalized !== undefined) locator[key] = normalized
    }
  }
  if (typeof locator.route !== 'string' || !Object.values(SOURCE_ROUTES).includes(locator.route)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'locator.route is invalid.')
  }
  return locator
}

function assertLocatorOwner(locator, sourceType, sourceId, fieldName) {
  const key = sourceType === 'document' ? 'documentId' : sourceType === 'ebook' ? 'bookId' : 'repositoryId'
  const ownerId = isPositiveInteger(locator[key])
  if (locator.route !== SOURCE_ROUTES[sourceType] || ownerId !== sourceId) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `${fieldName} does not identify the source.`)
  }
}

function normalizeSectionPath(value, fallback) {
  const path = value === undefined ? fallback : value
  if (!Array.isArray(path) || path.length > 32 || path.some((part) => typeof part !== 'string' || !part.trim())) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'sectionPath is invalid.')
  }
  return Object.freeze(path.map((part) => part.normalize('NFKC').trim()))
}

function normalizeSource(source) {
  if (!isPlainObject(source)) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'source is invalid.')
  const sourceType = source.sourceType ?? source.source_type
  if (!SOURCE_TYPES.has(sourceType)) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'sourceType is invalid.')
  const sourceId = isPositiveInteger(source.sourceId ?? source.source_id)
  if (!sourceId) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'sourceId is invalid.')
  const sourceVersionId = requiredText(source.sourceVersionId ?? source.source_version_id, 'sourceVersionId', 512)
  const sourceContentSha256 = normalizeHash(
    source.sourceContentSha256 ?? source.source_content_sha256,
    'sourceContentSha256'
  )
  const extractorVersion = requiredText(source.extractorVersion ?? source.extractor_version, 'extractorVersion', 128)
  const sections = source.sections
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > MAX_SOURCE_SECTIONS) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'source.sections is invalid.')
  }
  const baseLocator = source.baseLocator ?? source.base_locator
  if (!isPlainObject(baseLocator)) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'source.baseLocator is invalid.')
  const normalizedBaseLocator = publicLocator(baseLocator)
  if (normalizedBaseLocator.route !== SOURCE_ROUTES[sourceType]) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, 'source.baseLocator route does not match sourceType.')
  }
  assertLocatorOwner(normalizedBaseLocator, sourceType, sourceId, 'source.baseLocator')
  const sourceErrors = dedupeErrors(Array.isArray(source.errors) ? source.errors : [])
  return Object.freeze({
    sourceType,
    sourceId,
    sourceVersionId,
    sourceContentSha256,
    extractorVersion,
    title: typeof source.title === 'string' && source.title.trim() ? source.title.normalize('NFKC').trim().slice(0, 512) : `${sourceType}:${sourceId}`,
    sections: Object.freeze(sections.map((section, index) => normalizeSection(section, index, normalizedBaseLocator, sourceType, sourceId))),
    baseLocator: Object.freeze(normalizedBaseLocator),
    errors: sourceErrors
  })
}

function normalizeSection(section, index, baseLocator, sourceType, sourceId) {
  if (!isPlainObject(section)) fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `source.sections[${index}] is invalid.`)
  const format = requiredText(section.format, `source.sections[${index}].format`, 64).toLowerCase()
  if (!new Set(['markdown', 'html', 'txt', 'ebook', 'repository_document']).has(format)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `source.sections[${index}].format is invalid.`)
  }
  const text = section.text ?? section.body
  if (typeof text !== 'string' || !text.trim()) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `source.sections[${index}].text is empty.`)
  }
  const locator = publicLocator(baseLocator, section.locator)
  if (locator.route !== SOURCE_ROUTES[sourceType]) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.SOURCE_INVALID, `source.sections[${index}].locator route does not match sourceType.`)
  }
  assertLocatorOwner(locator, sourceType, sourceId, `source.sections[${index}].locator`)
  const sectionPath = normalizeSectionPath(section.sectionPath, [])
  return Object.freeze({
    format,
    text,
    title: typeof section.title === 'string' && section.title.trim() ? section.title.normalize('NFKC').trim().slice(0, 512) : null,
    locator: Object.freeze(locator),
    sectionPath
  })
}

function normalizeCollected(collected) {
  if (!isPlainObject(collected) || !Array.isArray(collected.sources) || !Array.isArray(collected.errors ?? [])) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.COLLECTOR_INVALID, 'RAG source collector output is invalid.')
  }
  const sources = collected.sources.map(normalizeSource)
  const keys = new Set()
  for (const source of sources) {
    const key = `${source.sourceType}:${source.sourceId}`
    if (keys.has(key)) fail(RAG_TEXT_INDEX_ERROR_CODES.COLLECTOR_INVALID, 'RAG source collector returned a duplicate source.')
    keys.add(key)
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    errors: dedupeErrors(collected.errors)
  })
}

function errorsForSource(source, collectedErrors) {
  return dedupeErrors([
    ...source.errors,
    ...collectedErrors.filter((error) => error.sourceType === source.sourceType && error.sourceId === source.sourceId)
  ])
}

function normalizeChunkerIdentity({ chunker, chunkerOptions, chunkerVersion, chunkerConfigHash }) {
  const configuredVersion = chunkerVersion ?? chunker?.config?.chunkerVersion ?? RAG_CHUNKER_VERSION
  const config = chunker?.config
  const configuredHash = chunkerConfigHash ?? config?.configHash
  if (configuredHash !== undefined) {
    return Object.freeze({
      chunkerVersion: requiredText(configuredVersion, 'chunkerVersion', 128),
      chunkerConfigHash: normalizeHash(configuredHash, 'chunkerConfigHash')
    })
  }
  if (chunker === chunkRagSource) {
    const normalized = normalizeRagChunkerOptions(chunkerOptions)
    return Object.freeze({
      chunkerVersion: RAG_CHUNKER_VERSION,
      chunkerConfigHash: normalizeHash(normalized.configHash, 'chunkerConfigHash')
    })
  }
  return Object.freeze({
    chunkerVersion: requiredText(configuredVersion, 'chunkerVersion', 128),
    chunkerConfigHash: sha256(stableJson({ chunkerVersion: configuredVersion, chunkerOptions }))
  })
}

function normalizeChunkReport(report, source, section, reportIndex, identity) {
  if (!isPlainObject(report) || !Array.isArray(report.chunks)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunker report ${reportIndex} is invalid.`)
  }
  const chunkerVersion = requiredText(report.chunkerVersion ?? identity.chunkerVersion, 'chunkerVersion', 128)
  const chunkerConfigHash = normalizeHash(report.configHash ?? identity.chunkerConfigHash, 'chunkerConfigHash')
  const chunks = report.chunks
  if (chunks.length === 0) fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `section ${reportIndex} produced no chunks.`)
  return Object.freeze({
    chunkerVersion,
    chunkerConfigHash,
    chunks: Object.freeze(chunks.map((chunk, index) => normalizeChunk(chunk, source, section, reportIndex, index)))
  })
}

function normalizeChunk(chunk, source, section, reportIndex, chunkIndex) {
  if (!isPlainObject(chunk)) fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} is invalid.`)
  if (typeof chunk.body !== 'string' || !chunk.body.trim()) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} body is invalid.`)
  }
  const body = chunk.body.replace(/\r\n?/gu, '\n').trim()
  const bodySha256 = normalizeHash(chunk.bodySha256 ?? sha256(body), 'chunkSha256')
  if (bodySha256 !== sha256(body)) fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} hash mismatches body.`)
  const tokenCountMode = chunk.tokenCountMode ?? 'deferred'
  if (tokenCountMode !== 'actual' && tokenCountMode !== 'deferred') {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} token mode is invalid.`)
  }
  const tokenCount = chunk.tokenCount === null || chunk.tokenCount === undefined
    ? null
    : isNonNegativeInteger(chunk.tokenCount)
  if (chunk.tokenCount !== null && chunk.tokenCount !== undefined && tokenCount === null) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} token count is invalid.`)
  }
  const startLine = isPositiveInteger(chunk.startLine ?? chunk.locatorPatch?.startLine)
  const endLine = isPositiveInteger(chunk.endLine ?? chunk.locatorPatch?.endLine)
  if (!startLine || !endLine || endLine < startLine) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} locator range is invalid.`)
  }
  const paragraphIndex = isNonNegativeInteger(chunk.paragraphIndex ?? chunk.locatorPatch?.paragraphIndex)
  if (paragraphIndex === null) fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} paragraph locator is invalid.`)
  const paragraphEndIndex = chunk.paragraphEndIndex ?? chunk.locatorPatch?.paragraphEndIndex
  const normalizedParagraphEnd = paragraphEndIndex === undefined ? undefined : isNonNegativeInteger(paragraphEndIndex)
  if (paragraphEndIndex !== undefined && (normalizedParagraphEnd === null || normalizedParagraphEnd < paragraphIndex)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, `chunk ${reportIndex}:${chunkIndex} paragraph range is invalid.`)
  }
  const sectionPath = normalizeSectionPath(chunk.sectionPath, section.sectionPath)
  const locator = publicLocator(source.baseLocator, section.locator)
  locator.sectionPath = sectionPath
  locator.startLine = startLine
  locator.endLine = endLine
  locator.paragraphIndex = paragraphIndex
  if (normalizedParagraphEnd !== undefined) locator.paragraphEndIndex = normalizedParagraphEnd
  const title = section.title ?? sectionPath.at(-1) ?? source.title
  return Object.freeze({
    ordinal: chunk.ordinal,
    body,
    bodySha256,
    tokenCount,
    tokenCountMode,
    title: requiredText(title, 'chunk.title', 512),
    sectionPath,
    locator: Object.freeze(locator)
  })
}

function buildChunks(source, chunker, chunkerOptions, identity) {
  const reports = []
  const chunks = []
  for (const [index, section] of source.sections.entries()) {
    const input = {
      format: section.format,
      body: section.text,
      locator: section.locator,
      sectionPath: section.sectionPath
    }
    const result = typeof chunker === 'function'
      ? chunker(input, chunkerOptions)
      : chunker?.chunk?.(input)
    reports.push(result)
  }
  return Promise.all(reports).then((resolvedReports) => {
    let chunkerVersion = null
    let chunkerConfigHash = null
    for (const [index, report] of resolvedReports.entries()) {
      const normalized = normalizeChunkReport(report, source, source.sections[index], index, identity)
      if (chunkerVersion === null) chunkerVersion = normalized.chunkerVersion
      if (chunkerConfigHash === null) chunkerConfigHash = normalized.chunkerConfigHash
      if (chunkerVersion !== normalized.chunkerVersion || chunkerConfigHash !== normalized.chunkerConfigHash) {
        fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'chunker identity changed within one source.')
      }
      chunks.push(...normalized.chunks)
    }
    if (chunks.length === 0 || chunks.length > MAX_SOURCE_CHUNKS) {
      fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'source produced an invalid chunk count.')
    }
    return Object.freeze({
      chunkerVersion,
      chunkerConfigHash,
      chunks: Object.freeze(chunks.map((chunk, ordinal) => Object.freeze({ ...chunk, ordinal })))
    })
  })
}

function ftsDeleteForSnapshot(database, snapshotId) {
  database.prepare(`
    INSERT INTO ${RAG_CHUNK_FTS_TABLE}( ${RAG_CHUNK_FTS_TABLE}, rowid, title, section_path_json, body )
    SELECT 'delete', id, title, section_path_json, body
      FROM ${RAG_CHUNK_TABLE}
     WHERE snapshot_id = ?
  `).run(snapshotId)
}

function createSnapshotIdentity(source, identity) {
  return {
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    sourceContentSha256: source.sourceContentSha256,
    extractorVersion: source.extractorVersion,
    chunkerVersion: identity.chunkerVersion,
    chunkerConfigHash: identity.chunkerConfigHash
  }
}

function beginAttempt(database, source, identity, now, { rebuild = false } = {}) {
  const identityValues = createSnapshotIdentity(source, identity)
  let result
  database.transaction(() => {
    const existing = database.prepare(`
      SELECT snapshot.id, snapshot.status, state.active_snapshot_id
        FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
        LEFT JOIN ${RAG_SOURCE_STATE_TABLE} state
          ON state.source_type = snapshot.source_type AND state.source_id = snapshot.source_id
       WHERE snapshot.source_type = @sourceType
         AND snapshot.source_id = @sourceId
         AND snapshot.source_version_id = @sourceVersionId
         AND snapshot.source_content_sha256 = @sourceContentSha256
         AND snapshot.extractor_version = @extractorVersion
         AND snapshot.chunker_version = @chunkerVersion
         AND snapshot.chunker_config_hash = @chunkerConfigHash
       ORDER BY snapshot.id DESC
       LIMIT 1
    `).get(identityValues)
    const activeComplete = existing && existing.active_snapshot_id === existing.id && SNAPSHOT_COMPLETE_STATUSES.has(existing.status)
    if (activeComplete && !rebuild) {
      result = Object.freeze({ snapshotId: existing.id, skipped: true })
      return
    }
    let snapshotId
    if (activeComplete && rebuild) {
      snapshotId = existing.id
    } else if (existing) {
      snapshotId = existing.id
      database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
           SET status = 'building', chunk_count = 0, error_count = 0,
               last_error_code = NULL, completed_at = NULL
         WHERE id = ?
      `).run(snapshotId)
    } else {
      snapshotId = Number(database.prepare(`
        INSERT INTO ${RAG_SOURCE_SNAPSHOT_TABLE} (
          source_type, source_id, source_version_id, source_content_sha256,
          extractor_version, chunker_version, chunker_config_hash,
          status, created_at
        ) VALUES (
          @sourceType, @sourceId, @sourceVersionId, @sourceContentSha256,
          @extractorVersion, @chunkerVersion, @chunkerConfigHash,
          'building', @createdAt
        )
      `).run({ ...identityValues, createdAt: now }).lastInsertRowid)
    }
    database.prepare(`
      INSERT INTO ${RAG_SOURCE_STATE_TABLE} (
        source_type, source_id, last_attempt_snapshot_id, status,
        last_started_at, last_error_code, updated_at
      ) VALUES (@sourceType, @sourceId, @snapshotId, 'building', @now, NULL, @now)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        last_attempt_snapshot_id = excluded.last_attempt_snapshot_id,
        status = 'building',
        last_started_at = excluded.last_started_at,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run({ sourceType: source.sourceType, sourceId: source.sourceId, snapshotId, now })
    result = Object.freeze({
      snapshotId,
      skipped: false,
      forcedActiveRebuild: Boolean(activeComplete && rebuild),
      previousStatus: activeComplete && rebuild ? existing.status : null
    })
  })()
  return result
}

function markIndexing(database, source, snapshotId, now) {
  database.transaction(() => {
    database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE}
         SET status = 'indexing', updated_at = ?
       WHERE source_type = ? AND source_id = ? AND last_attempt_snapshot_id = ?
    `).run(now, source.sourceType, source.sourceId, snapshotId)
  })()
}

function writeAttempt(database, source, snapshotId, identity, built, sourceErrors, now) {
  const status = sourceErrors.length > 0 ? 'partial' : 'text_ready'
  const stateStatus = sourceErrors.length > 0 ? 'partial' : 'active'
  const transaction = database.transaction(() => {
    ftsDeleteForSnapshot(database, snapshotId)
    database.prepare(`DELETE FROM ${RAG_CHUNK_TABLE} WHERE snapshot_id = ?`).run(snapshotId)
    database.prepare(`
      UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
         SET chunker_version = ?, chunker_config_hash = ?, status = 'building',
             chunk_count = 0, error_count = 0, last_error_code = NULL, completed_at = NULL
       WHERE id = ?
    `).run(built.chunkerVersion, built.chunkerConfigHash, snapshotId)

    const insertChunk = database.prepare(`
      INSERT INTO ${RAG_CHUNK_TABLE} (
        snapshot_id, ordinal, chunk_sha256, body, token_count, token_count_mode,
        title, section_path_json, locator_json, previous_chunk_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = database.prepare(`
      INSERT INTO ${RAG_CHUNK_FTS_TABLE}(rowid, title, section_path_json, body)
      VALUES (?, ?, ?, ?)
    `)
    const updateNext = database.prepare(`UPDATE ${RAG_CHUNK_TABLE} SET next_chunk_id = ? WHERE id = ?`)
    let previousChunkId = null
    for (const chunk of built.chunks) {
      const sectionPathJson = JSON.stringify(chunk.sectionPath)
      const locatorJson = JSON.stringify(chunk.locator)
      const currentChunkId = Number(insertChunk.run(
        snapshotId,
        chunk.ordinal,
        chunk.bodySha256,
        chunk.body,
        chunk.tokenCount,
        chunk.tokenCountMode,
        chunk.title,
        sectionPathJson,
        locatorJson,
        previousChunkId
      ).lastInsertRowid)
      insertFts.run(currentChunkId, chunk.title, sectionPathJson, chunk.body)
      if (previousChunkId !== null) updateNext.run(currentChunkId, previousChunkId)
      previousChunkId = currentChunkId
    }
    const oldActive = database.prepare(`
      SELECT active_snapshot_id
        FROM ${RAG_SOURCE_STATE_TABLE}
       WHERE source_type = ? AND source_id = ?
    `).get(source.sourceType, source.sourceId)?.active_snapshot_id ?? null
    if (oldActive !== null && oldActive !== snapshotId) {
      database.prepare(`
        UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
           SET status = 'stale', completed_at = COALESCE(completed_at, ?)
         WHERE id = ?
      `).run(now, oldActive)
    }
    database.prepare(`
      UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
         SET status = ?, chunk_count = ?, error_count = ?,
             last_error_code = ?, completed_at = ?
       WHERE id = ?
    `).run(status, built.chunks.length, sourceErrors.length, sourceErrors[0]?.code ?? null, now, snapshotId)
    database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE}
         SET active_snapshot_id = ?, last_attempt_snapshot_id = ?, status = ?,
             last_error_code = ?, last_completed_at = ?, updated_at = ?
       WHERE source_type = ? AND source_id = ?
    `).run(
      snapshotId,
      snapshotId,
      stateStatus,
      sourceErrors[0]?.code ?? null,
      now,
      now,
      source.sourceType,
      source.sourceId
    )
    database.prepare(`INSERT INTO ${RAG_CHUNK_FTS_TABLE}(${RAG_CHUNK_FTS_TABLE}) VALUES ('optimize')`).run()
  })
  transaction()
  return Object.freeze({ snapshotId, status, chunkCount: built.chunks.length, errorCount: sourceErrors.length })
}

function markFailed(database, source, snapshotId, error, now) {
  const code = error?.code && /^[A-Z0-9][A-Z0-9_.-]{0,127}$/u.test(error.code)
    ? error.code
    : RAG_TEXT_INDEX_ERROR_CODES.SOURCE_FAILED
  database.transaction(() => {
    database.prepare(`
      UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
         SET status = 'failed', error_count = CASE WHEN error_count < 1 THEN 1 ELSE error_count END,
             last_error_code = ?, completed_at = ?
       WHERE id = ?
    `).run(code, now, snapshotId)
    database.prepare(`
      UPDATE ${RAG_SOURCE_STATE_TABLE}
         SET status = 'failed', last_error_code = ?, updated_at = ?
       WHERE source_type = ? AND source_id = ? AND last_attempt_snapshot_id = ?
    `).run(code, now, source.sourceType, source.sourceId, snapshotId)
  })()
  return Object.freeze({ code, sourceType: source.sourceType, sourceId: source.sourceId })
}

function restoreAfterForcedRebuildFailure(database, source, attempt, error, now) {
  const code = error?.code && /^[A-Z0-9][A-Z0-9_.-]{0,127}$/u.test(error.code)
    ? error.code
    : RAG_TEXT_INDEX_ERROR_CODES.SOURCE_FAILED
  const stateStatus = attempt.previousStatus === 'partial' ? 'partial' : 'active'
  database.prepare(`
    UPDATE ${RAG_SOURCE_STATE_TABLE}
       SET status = ?, last_error_code = ?, updated_at = ?
     WHERE source_type = ? AND source_id = ? AND last_attempt_snapshot_id = ?
  `).run(stateStatus, code, now, source.sourceType, source.sourceId, attempt.snapshotId)
  return Object.freeze({ code, sourceType: source.sourceType, sourceId: source.sourceId })
}

function sourceResult(source, result, errors = []) {
  return Object.freeze({
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    snapshotId: result.snapshotId,
    status: result.status ?? (result.skipped ? 'skipped' : 'failed'),
    skipped: Boolean(result.skipped),
    chunkCount: result.chunkCount ?? 0,
    errorCount: errors.length,
    errors: Object.freeze([...errors])
  })
}

function normalizeQuery(input) {
  const raw = typeof input === 'string' ? input : input?.q ?? input?.keyword
  if (typeof raw !== 'string') fail(RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID, 'query is required.')
  const keyword = raw.normalize('NFKC').trim()
  if (!keyword || keyword.length > MAX_QUERY_LENGTH) fail(RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID, 'query is invalid.')
  const tokens = keyword.match(SEARCH_TOKEN) ?? []
  const expanded = []
  for (const token of tokens) {
    const cjk = token.match(CJK_SEQUENCE)
    if (cjk?.length === 1 && cjk[0] === token) {
      const characters = [...token]
      expanded.push(...characters)
      for (let index = 0; index + 1 < characters.length; index += 1) expanded.push(`${characters[index]}${characters[index + 1]}`)
    } else expanded.push(token)
  }
  const unique = [...new Set(expanded)].slice(0, 32)
  if (unique.length === 0) fail(RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID, 'query has no searchable terms.')
  const sourceType = typeof input === 'object' && input?.sourceType !== undefined ? input.sourceType : null
  if (sourceType !== null && !SOURCE_TYPES.has(sourceType)) fail(RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID, 'sourceType is invalid.')
  const limit = input?.limit === undefined ? 20 : Number(input.limit)
  const offset = input?.offset === undefined ? 0 : Number(input.offset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_QUERY_OFFSET) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.QUERY_INVALID, 'query pagination is invalid.')
  }
  return Object.freeze({
    keyword,
    sourceType,
    limit,
    offset,
    ftsQuery: unique.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' AND ')
  })
}

function rowToResult(row) {
  let sectionPath
  let locator
  try {
    sectionPath = JSON.parse(row.section_path_json)
    locator = JSON.parse(row.locator_json)
  } catch {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'stored locator is invalid.')
  }
  if (!Array.isArray(sectionPath) || !isPlainObject(locator)) {
    fail(RAG_TEXT_INDEX_ERROR_CODES.CHUNK_INVALID, 'stored locator shape is invalid.')
  }
  return Object.freeze({
    chunkId: row.chunk_id,
    snapshotId: row.snapshot_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    sourceContentSha256: row.source_content_sha256,
    title: row.title,
    body: row.body,
    sectionPath: Object.freeze(sectionPath),
    locator: Object.freeze(locator),
    tokenCount: row.token_count,
    tokenCountMode: row.token_count_mode,
    ordinal: row.ordinal,
    score: Number.isFinite(row.rank) ? -row.rank : 0
  })
}

function readVisible(row, visibility, context) {
  if (!visibility) return true
  try {
    const result = visibility(row, context)
    if (result && typeof result.then === 'function') {
      fail(RAG_TEXT_INDEX_ERROR_CODES.VISIBILITY_FAILED, 'visibility callback must be synchronous for query().')
    }
    return result === true
  } catch (error) {
    if (error instanceof RagTextIndexError) throw error
    fail(RAG_TEXT_INDEX_ERROR_CODES.VISIBILITY_FAILED, 'authoritative visibility check failed.')
  }
}

export class RagTextIndexService {
  constructor({
    database,
    collectSources,
    chunker = chunkRagSource,
    chunkerOptions = {},
    chunkerVersion,
    chunkerConfigHash,
    authoritativeVisibility,
    visibility,
    now = () => new Date()
  } = {}) {
    assertDatabase(database)
    if (collectSources !== undefined && typeof collectSources !== 'function') {
      fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'collectSources must be a function.')
    }
    if (typeof chunker !== 'function' && typeof chunker?.chunk !== 'function') {
      fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'chunker must be a function or chunk() provider.')
    }
    if (typeof now !== 'function') fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'now must be a function.')
    if (authoritativeVisibility !== undefined && typeof authoritativeVisibility !== 'function') {
      fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'authoritativeVisibility must be a function.')
    }
    if (visibility !== undefined && typeof visibility !== 'function') {
      fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'visibility must be a function.')
    }
    this.database = database
    this.collectSources = collectSources
    this.chunker = chunker
    this.chunkerOptions = chunkerOptions
    this.chunkerIdentity = normalizeChunkerIdentity({ chunker, chunkerOptions, chunkerVersion, chunkerConfigHash })
    this.visibility = authoritativeVisibility ?? visibility ?? null
    this.now = now
  }

  recoverInterruptedAttempts() {
    const now = asIsoTimestamp(this.now())
    let recovered = 0
    const transaction = this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT snapshot.id, snapshot.source_type, snapshot.source_id,
               state.active_snapshot_id, state.id AS state_id
          FROM ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot
          LEFT JOIN ${RAG_SOURCE_STATE_TABLE} state
            ON state.last_attempt_snapshot_id = snapshot.id
         WHERE snapshot.status = 'building'
            OR state.status IN ('building', 'indexing')
      `).all()
      for (const row of rows) {
        this.database.prepare(`
          UPDATE ${RAG_SOURCE_SNAPSHOT_TABLE}
             SET status = 'failed', error_count = CASE WHEN error_count < 1 THEN 1 ELSE error_count END,
                 last_error_code = ?, completed_at = ?
           WHERE id = ? AND status <> 'failed'
        `).run(RAG_TEXT_INDEX_ERROR_CODES.INTERRUPTED, now, row.id)
        if (row.state_id !== undefined && row.state_id !== null) {
          this.database.prepare(`
            UPDATE ${RAG_SOURCE_STATE_TABLE}
               SET status = ?, last_error_code = ?, updated_at = ?
             WHERE id = ?
          `).run(
            row.active_snapshot_id === null ? 'failed' : 'active',
            RAG_TEXT_INDEX_ERROR_CODES.INTERRUPTED,
            now,
            row.state_id
          )
        }
        recovered += 1
      }
    })
    transaction()
    return Object.freeze({ recovered })
  }

  recover() {
    return this.recoverInterruptedAttempts()
  }

  recoverStartup() {
    return this.recoverInterruptedAttempts()
  }

  recoverInterrupted() {
    return this.recoverInterruptedAttempts()
  }

  async refresh({ collected, sources, errors, rebuild = false, signal, onProgress = async () => {} } = {}) {
    assertDatabase(this.database)
    if (typeof rebuild !== 'boolean') fail(RAG_TEXT_INDEX_ERROR_CODES.INPUT_INVALID, 'rebuild must be a boolean.')
    this.recoverInterruptedAttempts()
    throwIfAborted(signal)
    let report = collected ?? (sources === undefined ? undefined : { sources, errors: errors ?? [] })
    if (report === undefined) {
      if (typeof this.collectSources !== 'function') {
        fail(RAG_TEXT_INDEX_ERROR_CODES.COLLECTOR_INVALID, 'collectSources is required when collected output is not supplied.')
      }
      report = await this.collectSources({ database: this.database, signal, onProgress })
    }
    const normalized = normalizeCollected(report)
    const allErrors = [...normalized.errors]
    const results = []
    let completed = 0
    await onProgress(0)
    for (const source of normalized.sources) {
      throwIfAborted(signal)
      const sourceErrors = errorsForSource(source, normalized.errors)
      let attempt
      try {
        attempt = beginAttempt(this.database, source, this.chunkerIdentity, asIsoTimestamp(this.now()), { rebuild })
        if (attempt.skipped) {
          results.push(sourceResult(source, attempt, sourceErrors))
        } else {
          markIndexing(this.database, source, attempt.snapshotId, asIsoTimestamp(this.now()))
          const built = await buildChunks(source, this.chunker, this.chunkerOptions, this.chunkerIdentity)
          const writeResult = writeAttempt(
            this.database,
            source,
            attempt.snapshotId,
            this.chunkerIdentity,
            built,
            sourceErrors,
            asIsoTimestamp(this.now())
          )
          results.push(sourceResult(source, writeResult, sourceErrors))
        }
      } catch (error) {
        if (!attempt?.snapshotId) throw error
        const failure = attempt.forcedActiveRebuild
          ? restoreAfterForcedRebuildFailure(this.database, source, attempt, error, asIsoTimestamp(this.now()))
          : markFailed(this.database, source, attempt.snapshotId, error, asIsoTimestamp(this.now()))
        allErrors.push(failure)
        results.push(sourceResult(source, { snapshotId: attempt.snapshotId, status: 'failed' }, [failure]))
      }
      allErrors.push(...sourceErrors)
      completed += 1
      await onProgress(normalized.sources.length === 0 ? 100 : Math.round((completed / normalized.sources.length) * 100))
    }
    if (normalized.sources.length === 0) await onProgress(100)
    const failed = results.filter((result) => result.status === 'failed').length
    const partial = failed > 0 || allErrors.length > 0 || results.some((result) => result.status === 'partial')
    return Object.freeze({
      status: partial ? 'partial' : 'ready',
      sourceCount: normalized.sources.length,
      indexedCount: results.filter((result) => result.status === 'text_ready' || result.status === 'partial').length,
      skippedCount: results.filter((result) => result.skipped).length,
      failedCount: failed,
      errorCount: allErrors.length,
      errors: Object.freeze([...dedupeErrors(allErrors)]),
      sources: Object.freeze(results)
    })
  }

  async index(collected, options = {}) {
    return this.refresh({ ...options, collected })
  }

  query(input = {}) {
    const query = normalizeQuery(input)
    const candidateLimit = Math.min(MAX_QUERY_CANDIDATES, Math.max(query.limit + query.offset, (query.limit + query.offset) * 10))
    const clauses = [
      `${RAG_CHUNK_FTS_TABLE} MATCH ?`,
      `state.active_snapshot_id = snapshot.id`,
      `snapshot.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')`
    ]
    const parameters = [query.ftsQuery]
    if (query.sourceType) {
      clauses.push('snapshot.source_type = ?')
      parameters.push(query.sourceType)
    }
    const rows = this.database.prepare(`
      SELECT chunks.id AS chunk_id, chunks.snapshot_id, chunks.ordinal,
             chunks.body, chunks.token_count, chunks.token_count_mode,
             chunks.section_path_json, chunks.locator_json,
             snapshot.source_type, snapshot.source_id, snapshot.source_version_id,
             snapshot.source_content_sha256, fts.title, bm25(${RAG_CHUNK_FTS_TABLE}) AS rank
        FROM ${RAG_CHUNK_FTS_TABLE} fts
        JOIN ${RAG_CHUNK_TABLE} chunks ON chunks.id = fts.rowid
        JOIN ${RAG_SOURCE_SNAPSHOT_TABLE} snapshot ON snapshot.id = chunks.snapshot_id
        JOIN ${RAG_SOURCE_STATE_TABLE} state
          ON state.source_type = snapshot.source_type AND state.source_id = snapshot.source_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY rank ASC, chunks.id ASC
       LIMIT ?
    `).all(...parameters, candidateLimit)
    const visible = []
    for (const row of rows) {
      const result = rowToResult(row)
      if (readVisible(result, this.visibility, { database: this.database, query })) visible.push(result)
    }
    const paged = visible.slice(query.offset, query.offset + query.limit)
    return Object.freeze({
      query: query.keyword,
      data: Object.freeze(paged),
      total: visible.length,
      limit: query.limit,
      offset: query.offset
    })
  }

  search(input = {}) {
    return this.query(input)
  }
}

export function createRagTextIndexService(options) {
  return new RagTextIndexService(options)
}

export default createRagTextIndexService
