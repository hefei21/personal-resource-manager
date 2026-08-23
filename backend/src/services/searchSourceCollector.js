import fs from 'node:fs'
import path from 'node:path'
import { load } from 'cheerio'

import { getDocumentStorageRuntime } from './documentStorageRuntime.js'
import { getResourceStorageRuntime } from './resourceStorageRuntime.js'
import { listGitNasTree, readGitNasFile } from './gitNasRepositoryService.js'
import { resolveManagedRepositoryPath, resolveRepositoryEntry } from './repositorySecurity.js'

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_CODE_FILE_BYTES = 512 * 1024
const MAX_CODE_FILES = 5000
const MAX_CODE_DEPTH = 32
const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm', '.yaml', '.yml'
])
const CODE_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.cs', '.css', '.dart', '.go', '.graphql', '.gql',
  '.html', '.htm', '.java', '.js', '.jsx', '.json', '.jsonc', '.kt', '.kts', '.lua', '.md',
  '.php', '.pl', '.pm', '.proto', '.ps1', '.py', '.rb', '.rs', '.scala', '.scss', '.sh', '.sql',
  '.svelte', '.swift', '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml', '.zsh'
])
const CODE_TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'notice', 'procfile', 'gemfile', 'rakefile'
])
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.cache', '.idea', '.vscode', 'node_modules', 'vendor', 'dist', 'build',
  'coverage', 'target', 'bin', 'obj', '__pycache__', '.next', '.nuxt', '.output'
])
const SENSITIVE_FILENAMES = [
  /^\.env(?:\.|$)/iu,
  /^\.npmrc$/iu,
  /^\.pypirc$/iu,
  /^\.netrc$/iu,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/iu,
  /(?:^|[-_.])(secret|secrets|credential|credentials|keystore|private[-_.]?key)(?:[-_.]|$)/iu,
  /\.(?:pem|p12|pfx|key|jks|keystore)$/iu
]
const CREDENTIAL_CONTENT_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/iu
]

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Search source collection was cancelled.')
    error.code = 'SEARCH_INDEX_CANCELLED'
    throw error
  }
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return value.split(',').map((tag) => tag.trim()).filter(Boolean)
}

function stripMarkup(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = /<[/!A-Za-z][^>]*>/u.test(value)
    ? load(`<body>${value}</body>`)('body').text()
    : value
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t ]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, MAX_TEXT_BYTES)
}

function extensionFor(row) {
  const source = row.original_name || row.file_path || ''
  return path.extname(source).toLowerCase()
}

async function readStreamText(contentService, row, options = {}) {
  const metadata = await contentService.stat(row, options)
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > MAX_TEXT_BYTES) return null
  const { stream } = await contentService.createReadStream(row, {}, options)
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_TEXT_BYTES) {
      if (typeof stream.destroy === 'function') stream.destroy()
      return null
    }
    chunks.push(buffer)
  }
  const buffer = Buffer.concat(chunks)
  if (buffer.includes(0)) return null
  return stripMarkup(buffer.toString('utf8'))
}

function resourceLink(row) {
  const id = Number(row.resource_id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function addError(errors, code, resourceType, domainId) {
  errors.push(Object.freeze({ code, resourceType, domainId: Number(domainId) }))
}

async function collectDocuments(database, dependencies, context) {
  const rows = database.prepare(`
    SELECT d.*, l.resource_id
      FROM documents d
      LEFT JOIN resource_domain_links l
        ON l.domain_type = 'document' AND l.domain_id = d.id
     ORDER BY d.id
  `).all()
  const entries = []
  for (const row of rows) {
    throwIfAborted(context.signal)
    const extension = extensionFor(row)
    let body = null
    let indexStatus = 'metadata_only'
    if (TEXT_DOCUMENT_EXTENSIONS.has(extension)) {
      try {
        body = await readStreamText(dependencies.documentContentService, row)
        if (body) indexStatus = 'ready'
      } catch {
        addError(context.errors, 'SEARCH_DOCUMENT_CONTENT_UNAVAILABLE', 'document', row.id)
      }
    }
    entries.push({
      entryKey: `document:${row.id}`,
      resourceType: 'document',
      resourceId: resourceLink(row),
      domainId: row.id,
      title: row.title,
      subtitle: [row.category, row.subcategory].filter(Boolean).join(' / ') || null,
      body,
      tags: normalizeTags(row.tags),
      status: 'active',
      sourceKind: row.storage_key ? 'managed_storage' : 'legacy_record',
      sourceLabel: row.category || '文档',
      locator: { route: '/documents', documentId: row.id },
      sourceUpdatedAt: row.updated_at,
      indexStatus
    })
  }
  return entries
}

function parseBookCache(row, errors) {
  if (!row.content_cache) return []
  try {
    const parsed = JSON.parse(row.content_cache)
    const chapters = Array.isArray(parsed?.chapters) ? parsed.chapters : []
    const toc = Array.isArray(parsed?.toc) ? parsed.toc : []
    return chapters.map((chapter, index) => ({
      index,
      title: chapter?.title || toc.find((item) => Number(item?.index) === index)?.title || `第 ${index + 1} 章`,
      body: stripMarkup(chapter?.content ?? chapter?.text ?? '')
    }))
  } catch {
    addError(errors, 'SEARCH_EBOOK_CACHE_INVALID', 'ebook', row.id)
    return []
  }
}

async function collectBooks(database, dependencies, context) {
  const rows = database.prepare(`
    SELECT b.*, c.name AS category_name, l.resource_id
      FROM books b
      LEFT JOIN book_categories c ON c.id = b.category_id
      LEFT JOIN resource_domain_links l
        ON l.domain_type = 'ebook' AND l.domain_id = b.id
     ORDER BY b.id
  `).all()
  const chapterRows = database.prepare(`
    SELECT id, book_id, title, chapter_index, created_at
      FROM book_chapters
     ORDER BY book_id, chapter_index, id
  `).all()
  const chaptersByBook = new Map()
  for (const chapter of chapterRows) {
    const list = chaptersByBook.get(chapter.book_id) ?? []
    list.push(chapter)
    chaptersByBook.set(chapter.book_id, list)
  }
  const entries = []
  for (const row of rows) {
    throwIfAborted(context.signal)
    entries.push({
      entryKey: `ebook:${row.id}`,
      resourceType: 'ebook',
      resourceId: resourceLink(row),
      domainId: row.id,
      title: row.title,
      subtitle: [row.author, row.publisher, row.year].filter(Boolean).join(' · ') || null,
      body: stripMarkup(row.description),
      tags: row.category_name ? [row.category_name] : [],
      author: row.author,
      status: row.metadata_status || 'ready',
      sourceKind: row.storage_key ? 'managed_storage' : 'legacy_record',
      sourceLabel: row.category_name || '电子书',
      locator: { route: '/books', bookId: row.id },
      sourceUpdatedAt: row.updated_at,
      indexStatus: 'ready'
    })
    let cachedChapters = parseBookCache(row, context.errors)
    if (cachedChapters.length === 0 && extensionFor(row) === '.txt') {
      try {
        const body = await readStreamText(dependencies.ebookContentService, row, { kind: 'ebooks' })
        if (body) cachedChapters = [{ index: 0, title: row.title, body }]
      } catch {
        addError(context.errors, 'SEARCH_EBOOK_CONTENT_UNAVAILABLE', 'ebook', row.id)
      }
    }
    const chapterSource = cachedChapters.length > 0
      ? cachedChapters
      : (chaptersByBook.get(row.id) ?? []).map((chapter) => ({
          index: chapter.chapter_index,
          title: chapter.title,
          body: null
        }))
    for (const chapter of chapterSource) {
      entries.push({
        entryKey: `ebook-chapter:${row.id}:${chapter.index}`,
        resourceType: 'ebook_chapter',
        resourceId: resourceLink(row),
        domainId: row.id,
        parentDomainId: row.id,
        title: chapter.title,
        subtitle: row.title,
        body: chapter.body,
        tags: row.category_name ? [row.category_name] : [],
        author: row.author,
        status: row.metadata_status || 'ready',
        sourceKind: row.storage_key ? 'managed_storage' : 'legacy_record',
        sourceLabel: row.title,
        locator: { route: '/books', bookId: row.id, chapterIndex: chapter.index },
        sourceUpdatedAt: row.updated_at,
        indexStatus: chapter.body ? 'ready' : 'metadata_only'
      })
    }
  }
  return entries
}

function collectNotes(database) {
  return database.prepare(`
    SELECT p.id, p.title, p.content, p.status, p.created_at, p.updated_at,
           c.name AS category_name,
           COALESCE(group_concat(t.name, ','), '') AS tags
      FROM blog_posts p
      LEFT JOIN blog_categories c ON c.id = p.category_id
      LEFT JOIN blog_post_tags pt ON pt.post_id = p.id
      LEFT JOIN blog_tags t ON t.id = pt.tag_id
     GROUP BY p.id
     ORDER BY p.id
  `).all().map((row) => ({
    entryKey: `note:${row.id}`,
    resourceType: 'note',
    domainId: row.id,
    title: row.title,
    subtitle: row.category_name,
    body: stripMarkup(row.content),
    tags: normalizeTags(row.tags),
    status: row.status || 'draft',
    sourceKind: 'owner_note',
    sourceLabel: row.category_name || '个人笔记',
    locator: { route: '/blog', postId: row.id },
    sourceUpdatedAt: row.updated_at || row.created_at,
    indexStatus: 'ready'
  }))
}

function collectAudio(database) {
  return database.prepare(`
    SELECT m.*, l.resource_id
      FROM music m
      LEFT JOIN resource_domain_links l
        ON l.domain_type = 'music' AND l.domain_id = m.id
     ORDER BY m.id
  `).all().map((row) => ({
    entryKey: `audio:${row.id}`,
    resourceType: 'audio',
    resourceId: resourceLink(row),
    domainId: row.id,
    title: row.title,
    subtitle: [row.artist, row.album].filter(Boolean).join(' · ') || null,
    body: [row.album, row.category].filter(Boolean).join('\n') || null,
    tags: normalizeTags(row.tags),
    author: row.artist,
    status: row.metadata_status || 'ready',
    sourceKind: row.storage_key ? 'managed_storage' : 'legacy_record',
    sourceLabel: row.album || '音频',
    locator: { route: '/music', musicId: row.id },
    sourceUpdatedAt: row.updated_at,
    indexStatus: 'ready'
  }))
}

function isSensitiveFile(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLocaleLowerCase('und')))) return true
  return SENSITIVE_FILENAMES.some((pattern) => pattern.test(segments.at(-1) ?? ''))
}

function isCodeTextFile(relativePath) {
  const name = path.basename(relativePath).toLocaleLowerCase('und')
  return CODE_TEXT_EXTENSIONS.has(path.extname(name)) || CODE_TEXT_FILENAMES.has(name)
}

function safeCodeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_CODE_FILE_BYTES || buffer.includes(0)) return null
  const text = buffer.toString('utf8')
  if (CREDENTIAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) return null
  const replacementCount = [...text].filter((character) => character === '\ufffd').length
  if (replacementCount > Math.max(4, text.length * 0.01)) return null
  return text.replace(/\r\n?/gu, '\n').slice(0, MAX_TEXT_BYTES)
}

function collectGitNasFiles(database, repository, dependencies, signal) {
  const files = []
  const queue = [{ path: '', depth: 0 }]
  while (queue.length > 0 && files.length < MAX_CODE_FILES) {
    throwIfAborted(signal)
    const current = queue.shift()
    if (current.depth > MAX_CODE_DEPTH) continue
    const children = dependencies.listGitNasTree(database, repository.id, current.path)
    for (const child of children) {
      if (files.length >= MAX_CODE_FILES) break
      if (isSensitiveFile(child.path)) continue
      if (child.type === 'directory') {
        queue.push({ path: child.path, depth: current.depth + 1 })
      } else if (child.size <= MAX_CODE_FILE_BYTES && isCodeTextFile(child.path)) {
        try {
          const file = dependencies.readGitNasFile(database, repository.id, child.path, { maxBytes: MAX_CODE_FILE_BYTES })
          const body = safeCodeText(file.buffer)
          if (body) files.push({ path: child.path, body })
        } catch {}
      }
    }
  }
  return files
}

function collectManagedFiles(repository, dependencies, signal) {
  const files = []
  let repositoryPath
  try {
    repositoryPath = resolveManagedRepositoryPath(dependencies.codeBasePath, repository.local_path, { mustExist: true })
  } catch {
    return files
  }
  const queue = [{ absolutePath: repositoryPath, relativePath: '', depth: 0 }]
  while (queue.length > 0 && files.length < MAX_CODE_FILES) {
    throwIfAborted(signal)
    const current = queue.shift()
    if (current.depth > MAX_CODE_DEPTH) continue
    let children
    try { children = fs.readdirSync(current.absolutePath, { withFileTypes: true }) } catch { continue }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (files.length >= MAX_CODE_FILES) break
      const relativePath = current.relativePath ? `${current.relativePath}/${child.name}` : child.name
      if (isSensitiveFile(relativePath) || child.isSymbolicLink()) continue
      if (child.isDirectory()) {
        queue.push({
          absolutePath: path.join(current.absolutePath, child.name),
          relativePath,
          depth: current.depth + 1
        })
      } else if (child.isFile() && isCodeTextFile(relativePath)) {
        try {
          const fullPath = resolveRepositoryEntry(dependencies.codeBasePath, repositoryPath, relativePath)
          const stat = fs.statSync(fullPath)
          if (stat.size > MAX_CODE_FILE_BYTES) continue
          const body = safeCodeText(fs.readFileSync(fullPath))
          if (body) files.push({ path: relativePath, body })
        } catch {}
      }
    }
  }
  return files
}

function collectCode(database, dependencies, context) {
  const rows = database.prepare(`
    SELECT c.*, l.resource_id
      FROM code_repositories c
      LEFT JOIN resource_domain_links l
        ON l.domain_type = 'code_repository' AND l.domain_id = c.id
     ORDER BY c.id
  `).all()
  const entries = []
  for (const row of rows) {
    throwIfAborted(context.signal)
    entries.push({
      entryKey: `code-repository:${row.id}`,
      resourceType: 'code_repository',
      resourceId: resourceLink(row),
      domainId: row.id,
      title: row.name,
      subtitle: row.type === 'git_nas' ? 'NAS 只读 Git' : '受管 Git',
      body: row.description,
      tags: Object.keys((() => { try { return JSON.parse(row.languages || '{}') } catch { return {} } })()),
      status: row.type === 'git_nas' ? 'read_only' : 'active',
      sourceKind: row.type === 'git_nas' ? 'git_nas' : 'managed_git',
      sourceLabel: row.name,
      locator: { route: '/code', repositoryId: row.id },
      sourceUpdatedAt: row.updated_at || row.last_sync || row.created_at,
      indexStatus: context.includeCodeFiles ? 'ready' : 'metadata_only'
    })
    if (!context.includeCodeFiles) continue
    let files = []
    try {
      files = row.type === 'git_nas'
        ? collectGitNasFiles(database, row, dependencies, context.signal)
        : collectManagedFiles(row, dependencies, context.signal)
    } catch {
      addError(context.errors, 'SEARCH_CODE_SOURCE_PARTIAL', 'code_repository', row.id)
    }
    for (const file of files) {
      entries.push({
        entryKey: `code-file:${row.id}:${file.path}`,
        resourceType: 'code_file',
        resourceId: resourceLink(row),
        domainId: row.id,
        parentDomainId: row.id,
        title: path.basename(file.path),
        subtitle: `${row.name} · ${file.path}`,
        body: file.body,
        tags: [path.extname(file.path).slice(1)].filter(Boolean),
        status: row.type === 'git_nas' ? 'read_only' : 'active',
        sourceKind: row.type === 'git_nas' ? 'git_nas' : 'managed_git',
        sourceLabel: row.name,
        locator: { route: '/code', repositoryId: row.id, path: file.path, line: 1 },
        sourceUpdatedAt: row.updated_at || row.last_sync || row.created_at,
        indexStatus: 'ready'
      })
    }
  }
  return entries
}

export function createSearchSourceCollector({
  documentRuntimeProvider = getDocumentStorageRuntime,
  resourceRuntimeProvider = getResourceStorageRuntime,
  listGitNasTreeFn = listGitNasTree,
  readGitNasFileFn = readGitNasFile,
  codeBasePath = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')
} = {}) {
  return async function collectSearchSources({ database, includeCodeFiles = true, signal, onProgress = async () => {} } = {}) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
    const documentRuntime = documentRuntimeProvider()
    const resourceRuntime = resourceRuntimeProvider()
    const dependencies = {
      documentContentService: documentRuntime.contentService,
      ebookContentService: resourceRuntime.contentServiceFor('ebooks'),
      listGitNasTree: listGitNasTreeFn,
      readGitNasFile: readGitNasFileFn,
      codeBasePath
    }
    const errors = []
    const context = { errors, includeCodeFiles, signal }
    const entries = []
    await onProgress(5)
    entries.push(...await collectDocuments(database, dependencies, context))
    await onProgress(25)
    entries.push(...await collectBooks(database, dependencies, context))
    await onProgress(45)
    entries.push(...collectNotes(database))
    await onProgress(60)
    entries.push(...collectAudio(database))
    await onProgress(70)
    entries.push(...collectCode(database, dependencies, context))
    await onProgress(95)
    return Object.freeze({ entries: Object.freeze(entries), errors: Object.freeze(errors) })
  }
}

export const collectSearchEntries = createSearchSourceCollector()
export default collectSearchEntries
