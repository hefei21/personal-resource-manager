import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { load } from 'cheerio'

import { getDocumentStorageRuntime } from './documentStorageRuntime.js'
import { getResourceStorageRuntime } from './resourceStorageRuntime.js'
import {
  createGitNasReadOnlyRunner,
  inspectGitNasSnapshot,
  inspectReadOnlyGitSnapshot,
  readGitNasFile
} from './gitNasRepositoryService.js'
import { resolveManagedRepositoryPath, resolveRepositoryEntry } from './repositorySecurity.js'
import { isSensitiveCodeFile, safeCodeText } from './searchSourceCollector.js'

export const RAG_SOURCE_EXTRACTOR_VERSION = 'rag-source.v1'

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu
const MAX_CONTENT_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const MAX_REPOSITORY_FILE_BYTES = 512 * 1024
const MAX_REPOSITORY_FILES = 5000
const ALLOWED_REPOSITORY_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.rst', '.adoc', '.asciidoc', '.txt'
])
const ALLOWED_REPOSITORY_BASENAMES = new Set(['readme', 'notice'])
const DOCUMENT_FORMATS = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.txt', 'txt']
])

class RagSourceFailure extends Error {
  constructor(code) {
    super(code)
    this.name = 'RagSourceFailure'
    this.code = code
  }
}

function fail(code) {
  throw new RagSourceFailure(code)
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail('RAG_SOURCE_CANCELLED')
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isPositiveId(value) {
  const id = typeof value === 'string' && /^[1-9]\d*$/u.test(value.trim()) ? Number(value) : value
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function isNonNegativeInteger(value) {
  const number = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function isHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value.toLowerCase())
}

function normalizeHash(value) {
  return isHash(value) ? value.toLowerCase() : null
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isPlainObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function safeTitle(value, fallback) {
  const title = typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : ''
  return (title || fallback).slice(0, 256)
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('RAG_SOURCE_REPOSITORY_PATH_UNSAFE')
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) {
    fail('RAG_SOURCE_REPOSITORY_PATH_UNSAFE')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('RAG_SOURCE_REPOSITORY_PATH_UNSAFE')
  return parts.join('/')
}

function isAllowedRepositoryDocument(value) {
  let relativePath
  try { relativePath = safeRelativePath(value) } catch { return false }
  if (isSensitiveCodeFile(relativePath)) return false
  const basename = path.posix.basename(relativePath).toLocaleLowerCase('und')
  const extension = path.posix.extname(basename)
  return ALLOWED_REPOSITORY_EXTENSIONS.has(extension) ||
    ALLOWED_REPOSITORY_BASENAMES.has(path.posix.basename(basename, extension))
}

function stripMarkup(value) {
  if (typeof value !== 'string') fail('RAG_SOURCE_CONTENT_NOT_TEXT')
  const text = /<[/!A-Za-z][^>]*>/u.test(value)
    ? load(`<body>${value}</body>`)('body').text()
    : value
  return text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function textFromBuffer(buffer, { html = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) {
    fail('RAG_SOURCE_CONTENT_NOT_TEXT')
  }
  const text = buffer.toString('utf8')
  const replacementCount = [...text].filter((character) => character === '\ufffd').length
  if (replacementCount > Math.max(4, text.length * 0.01)) fail('RAG_SOURCE_CONTENT_NOT_TEXT')
  const normalized = html ? stripMarkup(text) : stripMarkup(text)
  if (!normalized) fail('RAG_SOURCE_CONTENT_EMPTY')
  return normalized
}

function sourceError(code, sourceType, sourceId) {
  return Object.freeze({ code, sourceType, sourceId })
}

function addSourceError(errors, code, sourceType, sourceId) {
  if (!errors.some((error) => error.code === code)) errors.push(sourceError(code, sourceType, sourceId))
}

function errorCode(error, sourceType) {
  const code = String(error?.code ?? '')
  if (code === 'RAG_SOURCE_CANCELLED') return code
  if (code.startsWith('RAG_SOURCE_')) return code
  if (code.includes('HASH') || code.includes('INTEGRITY') || code.includes('COLLISION')) {
    return 'RAG_SOURCE_CONTENT_HASH_MISMATCH'
  }
  if (code.includes('TOO_LARGE') || code.includes('SIZE')) return 'RAG_SOURCE_CONTENT_TOO_LARGE'
  if (code.includes('MISSING') || code.includes('UNAVAILABLE') || code.includes('REFERENCE')) {
    return 'RAG_SOURCE_CONTENT_UNAVAILABLE'
  }
  if (sourceType === 'document') return 'RAG_SOURCE_DOCUMENT_FAILED'
  if (sourceType === 'ebook') return 'RAG_SOURCE_EBOOK_FAILED'
  return 'RAG_SOURCE_REPOSITORY_FAILED'
}

function hasTable(database, tableName) {
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName))
  } catch {
    return false
  }
}

function resourceJoins(database, domainType) {
  const hasLinks = hasTable(database, 'resource_domain_links')
  const hasResources = hasTable(database, 'resources')
  const hasTrash = hasTable(database, 'resource_trash_entries')
  const joins = []
  const predicates = []
  if (hasLinks) {
    joins.push(`LEFT JOIN resource_domain_links resource_link
      ON resource_link.domain_type = '${domainType}' AND resource_link.domain_id = domain_source.id`)
    if (hasResources) {
      joins.push(`LEFT JOIN resources linked_resource ON linked_resource.id = resource_link.resource_id`)
      predicates.push(`(
        resource_link.resource_id IS NULL OR (
          linked_resource.id IS NOT NULL
          AND linked_resource.resource_type = '${domainType}'
          AND linked_resource.lifecycle_status = 'active'
        )
      )`)
    } else {
      // A link without its authoritative resource row cannot be treated as active.
      predicates.push('(resource_link.resource_id IS NULL)')
    }
  }
  if (hasTrash) {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM resource_trash_entries resource_trash
       WHERE resource_trash.resource_type = '${domainType}'
         AND resource_trash.resource_id = domain_source.id
    )`)
  }
  return {
    joins: joins.join('\n'),
    where: predicates.length > 0 ? predicates.join('\n AND ') : '1 = 1',
    hasLinks,
    hasResources
  }
}

function documentRows(database) {
  if (!hasTable(database, 'documents')) return []
  const versions = hasTable(database, 'document_versions')
  const trash = hasTable(database, 'resource_trash_entries')
  const security = resourceJoins(database, 'document')
  const versionJoin = versions ? `LEFT JOIN document_versions current_version ON current_version.id = (
    SELECT candidate_version.id
      FROM document_versions candidate_version
     WHERE candidate_version.document_id = domain_source.id
       AND CAST(candidate_version.version AS REAL) = CAST(domain_source.version AS REAL)
     ORDER BY candidate_version.id DESC
     LIMIT 1
  )` : ''
  const versionTrash = versions && trash ? `AND (
    current_version.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM resource_trash_entries version_trash
       WHERE version_trash.resource_type = 'document_version'
         AND version_trash.resource_id = current_version.id
    )
  )` : ''
  const versionFields = versions ? `
           current_version.id AS current_version_id,
           current_version.version AS current_version_number,
           current_version.file_path AS current_version_file_path,
           current_version.storage_key AS current_version_storage_key,
           current_version.content_sha256 AS current_version_content_sha256,
           current_version.content_bytes AS current_version_content_bytes
  ` : `
           NULL AS current_version_id,
           NULL AS current_version_number,
           NULL AS current_version_file_path,
           NULL AS current_version_storage_key,
           NULL AS current_version_content_sha256,
           NULL AS current_version_content_bytes
  `
  return database.prepare(`
    SELECT domain_source.*,
           ${security.hasLinks ? 'resource_link.resource_id' : 'NULL'} AS resource_id,
           ${versionFields}
      FROM documents domain_source
      ${security.joins}
      ${versionJoin}
     WHERE ${security.where}
       ${versionTrash}
     ORDER BY domain_source.id
  `).all()
}

function ebookRows(database) {
  if (!hasTable(database, 'books')) return []
  const security = resourceJoins(database, 'ebook')
  const resourceVersions = security.hasLinks && hasTable(database, 'resource_versions') && hasTable(database, 'content_objects')
  const versionJoins = resourceVersions ? `
      LEFT JOIN resource_versions current_resource_version
        ON current_resource_version.resource_id = resource_link.resource_id
       AND current_resource_version.is_current = 1
      LEFT JOIN content_objects current_content_object
        ON current_content_object.id = current_resource_version.content_object_id
  ` : ''
  const versionFields = resourceVersions ? `
           current_resource_version.id AS current_resource_version_id,
           current_resource_version.version_number AS current_resource_version_number,
           current_content_object.sha256 AS current_content_sha256,
           current_content_object.bytes AS current_content_bytes,
           current_content_object.managed_storage_key AS current_storage_key,
  ` : `
           NULL AS current_resource_version_id,
           NULL AS current_resource_version_number,
           NULL AS current_content_sha256,
           NULL AS current_content_bytes,
           NULL AS current_storage_key,
  `
  return database.prepare(`
    SELECT domain_source.*,
           ${security.hasLinks ? 'resource_link.resource_id' : 'NULL'} AS resource_id,
           ${versionFields}
           ${security.hasResources ? 'linked_resource.lifecycle_status' : 'NULL'} AS linked_resource_lifecycle_status
      FROM books domain_source
      ${security.joins}
      ${versionJoins}
     WHERE ${security.where}
     ORDER BY domain_source.id
  `).all()
}

function chapterRows(database) {
  if (!hasTable(database, 'book_chapters')) return []
  return database.prepare(`
    SELECT id, book_id, title, chapter_index
      FROM book_chapters
     ORDER BY book_id, chapter_index, id
  `).all()
}

function repositoryRows(database) {
  if (!hasTable(database, 'code_repositories')) return []
  const security = resourceJoins(database, 'code_repository')
  return database.prepare(`
    SELECT domain_source.*, ${security.hasLinks ? 'resource_link.resource_id' : 'NULL'} AS resource_id
      FROM code_repositories domain_source
      ${security.joins}
     WHERE ${security.where}
     ORDER BY domain_source.id
  `).all()
}

async function readVerifiedContent(contentService, row, { kind, signal } = {}) {
  if (!contentService || typeof contentService.stat !== 'function' ||
      typeof contentService.createReadStream !== 'function') {
    fail('RAG_SOURCE_CONTENT_UNAVAILABLE')
  }
  throwIfAborted(signal)
  const options = kind ? { kind } : undefined
  const metadata = await contentService.stat(row, options)
  const statBytes = Number(metadata?.bytes)
  if (!Number.isSafeInteger(statBytes) || statBytes < 0 || statBytes > MAX_CONTENT_BYTES) {
    fail('RAG_SOURCE_CONTENT_TOO_LARGE')
  }
  const expectedBytes = Number.isSafeInteger(row.content_bytes) && row.content_bytes >= 0
    ? row.content_bytes
    : null
  if (expectedBytes !== null && expectedBytes !== statBytes) fail('RAG_SOURCE_CONTENT_HASH_MISMATCH')
  const expectedHash = normalizeHash(row.content_sha256)
  const metadataHash = normalizeHash(metadata?.sha256)
  const streamResult = kind
    ? await contentService.createReadStream(row, {}, options)
    : await contentService.createReadStream(row, {})
  const stream = streamResult?.stream ?? streamResult
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail('RAG_SOURCE_CONTENT_UNAVAILABLE')
  const hash = crypto.createHash('sha256')
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_CONTENT_BYTES) fail('RAG_SOURCE_CONTENT_TOO_LARGE')
      hash.update(buffer)
      chunks.push(buffer)
    }
  } finally {
    if (signal?.aborted && typeof stream.destroy === 'function') stream.destroy()
  }
  if (bytes !== statBytes) fail('RAG_SOURCE_CONTENT_HASH_MISMATCH')
  const actualHash = hash.digest('hex')
  if ((expectedHash && expectedHash !== actualHash) || (metadataHash && metadataHash !== actualHash)) {
    fail('RAG_SOURCE_CONTENT_HASH_MISMATCH')
  }
  return Object.freeze({ buffer: Buffer.concat(chunks), bytes, sha256: actualHash })
}

function documentEffectiveRow(row) {
  const versionId = isPositiveId(row.current_version_id)
  if (!versionId) return row
  return {
    ...row,
    file_path: row.current_version_file_path ?? row.file_path,
    storage_key: row.current_version_storage_key ?? row.storage_key,
    content_sha256: row.current_version_content_sha256 ?? row.content_sha256,
    content_bytes: row.current_version_content_bytes ?? row.content_bytes
  }
}

function ebookEffectiveRow(row) {
  const hasCurrentObject = normalizeHash(row.current_content_sha256) || Number.isSafeInteger(row.current_content_bytes)
  if (!hasCurrentObject) return row
  return {
    ...row,
    storage_key: row.storage_key ?? row.current_storage_key,
    content_sha256: row.current_content_sha256 ?? row.content_sha256,
    content_bytes: row.current_content_bytes ?? row.content_bytes
  }
}

function sourceVersionForDocument(row, contentHash) {
  const versionId = isPositiveId(row.current_version_id)
  if (versionId) return String(versionId)
  const version = row.version === undefined || row.version === null || row.version === '' ? '1' : String(row.version)
  return `current:${version}:${contentHash}`
}

function sourceVersionForEbook(row, contentHash) {
  const versionId = isPositiveId(row.current_resource_version_id)
  if (versionId) return String(versionId)
  const version = row.current_resource_version_number ?? 1
  return `current:${version}:${contentHash}`
}

function documentBaseLocator(id, versionId) {
  return Object.freeze({
    route: '/documents',
    documentId: id,
    ...(versionId ? { versionId } : {})
  })
}

function ebookBaseLocator(id, versionId) {
  return Object.freeze({
    route: '/books',
    bookId: id,
    ...(versionId ? { versionId } : {})
  })
}

function repositoryBaseLocator(id, commit) {
  return Object.freeze({ route: '/code', repositoryId: id, commit })
}

function makeSource({ sourceType, sourceId, sourceVersionId, sourceContentSha256, title, sections, baseLocator, errors }) {
  const status = errors.length > 0 ? 'partial' : 'ready'
  return Object.freeze({
    sourceType,
    sourceId,
    sourceVersionId,
    sourceContentSha256,
    extractorVersion: RAG_SOURCE_EXTRACTOR_VERSION,
    title,
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    baseLocator,
    status,
    errors: Object.freeze([...errors])
  })
}

function formatForDocument(row) {
  const name = String(row.original_name ?? row.file_path ?? '').toLocaleLowerCase('und')
  return DOCUMENT_FORMATS.get(path.extname(name)) ?? null
}

function makeDocumentSection({ id, versionId, format, title, text }) {
  const locator = documentBaseLocator(id, versionId)
  return {
    format,
    text,
    title,
    sectionPath: Object.freeze([]),
    locator
  }
}

async function collectDocument(row, contentService, signal) {
  const id = isPositiveId(row.id)
  if (!id) return { source: null, errors: [] }
  const sourceType = 'document'
  const errors = []
  const versionId = isPositiveId(row.current_version_id)
  const effective = documentEffectiveRow(row)
  const fallbackHash = normalizeHash(effective.content_sha256)
  const baseLocator = documentBaseLocator(id, versionId)
  const format = formatForDocument(effective)
  let sourceHash = fallbackHash
  let sections = []
  if (!format) {
    addSourceError(errors, 'RAG_SOURCE_DOCUMENT_FORMAT_UNSUPPORTED', sourceType, id)
  } else {
    try {
      const content = await readVerifiedContent(contentService, effective, { signal })
      sourceHash = content.sha256
      const text = textFromBuffer(content.buffer, { html: format === 'html' })
      sections = [makeDocumentSection({ id, versionId, format, title: safeTitle(row.title, `Document ${id}`), text })]
    } catch (error) {
      if (error?.code === 'RAG_SOURCE_CANCELLED') throw error
      addSourceError(errors, errorCode(error, sourceType), sourceType, id)
    }
  }
  if (!sourceHash) {
    return { source: null, errors: [sourceError('RAG_SOURCE_DOCUMENT_CONTENT_UNAVAILABLE', sourceType, id)] }
  }
  return {
    source: makeSource({
      sourceType,
      sourceId: id,
      sourceVersionId: sourceVersionForDocument(row, sourceHash),
      sourceContentSha256: sourceHash,
      title: safeTitle(row.title, `Document ${id}`),
      sections,
      baseLocator,
      errors
    }),
    errors
  }
}

function cacheBinding(cache) {
  const candidates = [
    cache?.sourceContentSha256,
    cache?.source_content_sha256,
    cache?.contentSha256,
    cache?.content_sha256,
    cache?.sourceHash,
    cache?.contentHash,
    cache?.sha256,
    cache?.metadata?.sourceContentSha256,
    cache?.metadata?.source_content_sha256,
    cache?.metadata?.contentSha256,
    cache?.metadata?.sha256,
    cache?.meta?.sourceContentSha256,
    cache?.meta?.contentSha256,
    cache?.meta?.sha256
  ]
  return candidates.map(normalizeHash).find(Boolean) ?? null
}

function parseBookCache(row, expectedHash, chapters) {
  if (typeof row.content_cache !== 'string' || !row.content_cache.trim()) fail('RAG_SOURCE_EBOOK_CACHE_UNBOUND')
  let cache
  try { cache = JSON.parse(row.content_cache) } catch { fail('RAG_SOURCE_EBOOK_CACHE_INVALID') }
  if (!isPlainObject(cache)) fail('RAG_SOURCE_EBOOK_CACHE_INVALID')
  const binding = cacheBinding(cache)
  if (!binding) fail('RAG_SOURCE_EBOOK_CACHE_UNBOUND')
  if (binding !== expectedHash) fail('RAG_SOURCE_EBOOK_CACHE_STALE')
  const cachedChapters = Array.isArray(cache.chapters)
    ? cache.chapters
    : (Array.isArray(cache.sections) ? cache.sections : null)
  if (!cachedChapters || cachedChapters.length === 0) fail('RAG_SOURCE_EBOOK_CACHE_INVALID')
  const chapterByIndex = new Map(chapters.map((chapter) => [isNonNegativeInteger(chapter.chapter_index), chapter]))
  const chapterByOrder = chapters
  const sections = []
  for (let order = 0; order < cachedChapters.length; order += 1) {
    const chapter = cachedChapters[order]
    if (!isPlainObject(chapter)) fail('RAG_SOURCE_EBOOK_CACHE_INVALID')
    const index = isNonNegativeInteger(chapter.index ?? chapter.chapterIndex ?? chapter.chapter_index) ?? order
    const metadata = chapterByIndex.get(index) ?? chapterByOrder[order]
    const chapterId = isPositiveId(chapter.chapterId ?? chapter.chapter_id ?? chapter.id) ?? isPositiveId(metadata?.id)
    const textValue = chapter.content ?? chapter.text ?? chapter.body
    if (typeof textValue !== 'string' || !textValue.trim()) continue
    const text = stripMarkup(textValue)
    if (!text) continue
    const title = safeTitle(chapter.title ?? metadata?.title, `Chapter ${index + 1}`)
    sections.push({
      ...(chapterId ? { chapterId } : {}),
      index,
      format: 'ebook',
      title,
      sectionPath: Object.freeze([title]),
      text,
      locator: Object.freeze({ route: '/books', bookId: Number(row.id), chapterIndex: index })
    })
  }
  if (sections.length === 0) fail('RAG_SOURCE_EBOOK_CACHE_INVALID')
  return sections
}

async function collectEbook(row, contentService, chapters, signal) {
  const id = isPositiveId(row.id)
  if (!id) return { source: null, errors: [] }
  const sourceType = 'ebook'
  const errors = []
  const versionId = isPositiveId(row.current_resource_version_id)
  const effective = ebookEffectiveRow(row)
  const fallbackHash = normalizeHash(effective.content_sha256)
  const title = safeTitle(row.title, `Ebook ${id}`)
  const baseLocator = ebookBaseLocator(id, versionId)
  let sourceHash = fallbackHash
  let sections = []
  const fileName = String(effective.original_name ?? effective.file_path ?? effective.file_type ?? '').toLocaleLowerCase('und')
  const isEpub = fileName.includes('epub') || path.extname(fileName) === '.epub'
  const isTxt = path.extname(fileName) === '.txt' || fileName === 'text/plain'
  try {
    const content = await readVerifiedContent(contentService, effective, { kind: 'ebooks', signal })
    sourceHash = content.sha256
    if (isTxt) {
      const text = textFromBuffer(content.buffer)
      const firstChapter = chapters[0]
      sections = [{
        ...(isPositiveId(firstChapter?.id) ? { chapterId: Number(firstChapter.id) } : {}),
        index: 0,
        format: 'ebook',
        title,
        sectionPath: Object.freeze([title]),
        text,
        locator: Object.freeze({ route: '/books', bookId: id, chapterIndex: 0 })
      }]
    } else if (isEpub) {
      sections = parseBookCache(effective, sourceHash, chapters)
    } else {
      addSourceError(errors, 'RAG_SOURCE_EBOOK_FORMAT_UNSUPPORTED', sourceType, id)
    }
  } catch (error) {
    if (error?.code === 'RAG_SOURCE_CANCELLED') throw error
    addSourceError(errors, errorCode(error, sourceType), sourceType, id)
  }
  if (!sourceHash) return { source: null, errors: [sourceError('RAG_SOURCE_EBOOK_CONTENT_UNAVAILABLE', sourceType, id)] }
  return {
    source: makeSource({
      sourceType,
      sourceId: id,
      sourceVersionId: sourceVersionForEbook(row, sourceHash),
      sourceContentSha256: sourceHash,
      title,
      sections,
      baseLocator,
      errors
    }),
    errors
  }
}

function normalizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || typeof snapshot.commit !== 'string' || !COMMIT_PATTERN.test(snapshot.commit) ||
      !Array.isArray(snapshot.files)) fail('RAG_SOURCE_REPOSITORY_SNAPSHOT_INVALID')
  const files = snapshot.files.map((value) => safeRelativePath(value)).sort((left, right) => left.localeCompare(right))
  if (files.length > MAX_REPOSITORY_FILES) fail('RAG_SOURCE_REPOSITORY_SNAPSHOT_INVALID')
  return Object.freeze({
    commit: snapshot.commit.toLowerCase(),
    branch: typeof snapshot.branch === 'string' ? snapshot.branch.slice(0, 512) : null,
    repositoryPath: typeof snapshot.repositoryPath === 'string' ? snapshot.repositoryPath : null,
    files: Object.freeze([...new Set(files)])
  })
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function readManagedFile(codeBasePath, repositoryPath, relativePath) {
  const fullPath = resolveRepositoryEntry(codeBasePath, repositoryPath, relativePath)
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let descriptor
  try {
    const pathStat = fs.lstatSync(fullPath)
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_REPOSITORY_FILE_BYTES) {
      fail('RAG_SOURCE_REPOSITORY_FILE_UNSAFE')
    }
    descriptor = fs.openSync(fullPath, fs.constants.O_RDONLY | noFollow)
    const before = fs.fstatSync(descriptor)
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino ||
        before.size > MAX_REPOSITORY_FILE_BYTES) fail('RAG_SOURCE_REPOSITORY_FILE_UNSAFE')
    const buffer = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs) fail('RAG_SOURCE_REPOSITORY_FILE_CHANGED')
    return safeCodeText(buffer)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
  }
}

async function inspectRepository(database, repository, dependencies, signal) {
  if (repository.type === 'git_nas') {
    return dependencies.inspectGitNasSnapshot(database, repository.id, { signal, runGit: dependencies.runGit })
  }
  const repositoryPath = resolveManagedRepositoryPath(dependencies.codeBasePath, repository.local_path, { mustExist: true })
  const rootPath = (fs.realpathSync.native ?? fs.realpathSync)(dependencies.codeBasePath)
  return dependencies.inspectReadOnlyGitSnapshot({
    repositoryPath,
    rootPath,
    signal,
    runGit: dependencies.runGit
  })
}

function readRepositoryFile(database, repository, snapshot, relativePath, dependencies) {
  if (repository.type === 'git_nas') {
    const file = dependencies.readGitNasFile(database, repository.id, relativePath, { maxBytes: MAX_REPOSITORY_FILE_BYTES })
    return safeCodeText(file?.buffer)
  }
  if (dependencies.readManagedFile) return dependencies.readManagedFile(repository, snapshot, relativePath)
  return readManagedFile(dependencies.codeBasePath, snapshot.repositoryPath, relativePath)
}

function repositoryContentHash(commit, sections) {
  return sha256(stableJson({
    commit,
    files: sections.map((section) => ({ path: section.path, text: section.text }))
  }))
}

async function collectRepository(row, dependencies, signal) {
  const id = isPositiveId(row.id)
  if (!id) return { source: null, errors: [] }
  const sourceType = 'code_repository'
  const errors = []
  const title = safeTitle(row.name, `Repository ${id}`)
  let inspected
  try {
    inspected = normalizeSnapshot(await inspectRepository(dependencies.database, row, dependencies, signal))
  } catch (error) {
    if (error?.code === 'RAG_SOURCE_CANCELLED') throw error
    return { source: null, errors: [sourceError(errorCode(error, sourceType), sourceType, id)] }
  }
  const candidatePaths = inspected.files.filter(isAllowedRepositoryDocument)
  const sections = []
  for (const relativePath of candidatePaths) {
    throwIfAborted(signal)
    try {
      const text = readRepositoryFile(dependencies.database, row, inspected, relativePath, dependencies)
      if (!text) {
        addSourceError(errors, 'RAG_SOURCE_REPOSITORY_FILE_UNSAFE', sourceType, id)
        continue
      }
      sections.push({
        path: relativePath,
        commit: inspected.commit,
        format: 'repository_document',
        sectionPath: Object.freeze([relativePath]),
        text,
        locator: Object.freeze({ route: '/code', repositoryId: id, path: relativePath, commit: inspected.commit })
      })
    } catch (error) {
      if (error?.code === 'RAG_SOURCE_CANCELLED') throw error
      addSourceError(errors, errorCode(error, sourceType), sourceType, id)
    }
  }
  let verified
  try {
    verified = normalizeSnapshot(await inspectRepository(dependencies.database, row, dependencies, signal))
  } catch (error) {
    if (error?.code === 'RAG_SOURCE_CANCELLED') throw error
    addSourceError(errors, errorCode(error, sourceType), sourceType, id)
  }
  if (!verified || verified.commit !== inspected.commit || !sameFiles(verified.files, inspected.files)) {
    addSourceError(errors, 'RAG_SOURCE_REPOSITORY_STALE', sourceType, id)
    sections.length = 0
  }
  if (candidatePaths.length > 0 && sections.length === 0) {
    addSourceError(errors, 'RAG_SOURCE_REPOSITORY_NO_DOCUMENTS', sourceType, id)
  } else if (candidatePaths.length === 0) {
    addSourceError(errors, 'RAG_SOURCE_REPOSITORY_NO_DOCUMENTS', sourceType, id)
  }
  const baseLocator = repositoryBaseLocator(id, inspected.commit)
  return {
    source: makeSource({
      sourceType,
      sourceId: id,
      sourceVersionId: inspected.commit,
      sourceContentSha256: repositoryContentHash(inspected.commit, sections),
      title,
      sections,
      baseLocator,
      errors
    }),
    errors
  }
}

function appendErrors(target, errors) {
  for (const error of errors) {
    if (!target.some((existing) => existing.code === error.code && existing.sourceType === error.sourceType &&
        existing.sourceId === error.sourceId)) target.push(error)
  }
}

export function createRagSourceCollector({
  documentRuntimeProvider = getDocumentStorageRuntime,
  resourceRuntimeProvider = getResourceStorageRuntime,
  documentContentService,
  ebookContentService,
  inspectGitNasSnapshotFn = inspectGitNasSnapshot,
  inspectReadOnlyGitSnapshotFn = inspectReadOnlyGitSnapshot,
  readGitNasFileFn = readGitNasFile,
  readManagedFileFn,
  runGit = createGitNasReadOnlyRunner(),
  codeBasePath = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')
} = {}) {
  return async function collectRagSources({ database, signal, onProgress = async () => {} } = {}) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
    throwIfAborted(signal)
    const documentRuntime = documentRuntimeProvider?.() ?? {}
    const resourceRuntime = resourceRuntimeProvider?.() ?? {}
    const dependencies = {
      database,
      documentContentService: documentContentService ?? documentRuntime.contentService,
      ebookContentService: ebookContentService ?? resourceRuntime.contentServiceFor?.('ebooks') ?? resourceRuntime.contentService,
      inspectGitNasSnapshot: inspectGitNasSnapshotFn,
      inspectReadOnlyGitSnapshot: inspectReadOnlyGitSnapshotFn,
      readGitNasFile: readGitNasFileFn,
      ...(readManagedFileFn ? { readManagedFile: readManagedFileFn } : {}),
      runGit,
      codeBasePath
    }
    const documents = documentRows(database)
    const books = ebookRows(database)
    const chapters = chapterRows(database)
    const repositories = repositoryRows(database)
    const total = documents.length + books.length + repositories.length
    const sources = []
    const errors = []
    let completed = 0
    await onProgress(0)
    const progress = async () => {
      completed += 1
      await onProgress(total === 0 ? 100 : Math.round((completed / total) * 100))
    }
    for (const row of documents) {
      throwIfAborted(signal)
      const result = await collectDocument(row, dependencies.documentContentService, signal)
      if (result.source) sources.push(result.source)
      appendErrors(errors, result.errors)
      await progress()
    }
    for (const row of books) {
      throwIfAborted(signal)
      const result = await collectEbook(row, dependencies.ebookContentService, chapters.filter((chapter) => Number(chapter.book_id) === Number(row.id)), signal)
      if (result.source) sources.push(result.source)
      appendErrors(errors, result.errors)
      await progress()
    }
    for (const row of repositories) {
      throwIfAborted(signal)
      const result = await collectRepository(row, dependencies, signal)
      if (result.source) sources.push(result.source)
      appendErrors(errors, result.errors)
      await progress()
    }
    if (total === 0) await onProgress(100)
    return Object.freeze({ sources: Object.freeze(sources), errors: Object.freeze(errors) })
  }
}

export const collectRagSources = createRagSourceCollector()
export default collectRagSources
