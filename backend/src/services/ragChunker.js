import crypto from 'node:crypto'

export const RAG_CHUNKER_VERSION = 'rag-chunker.v1'
export const RAG_CHUNKER_MODEL_ID = 'Qwen/Qwen3-Embedding-0.6B'
export const RAG_CHUNKER_MODEL_REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'

const DEFAULT_MAX_TOKENS = 768
const DEFAULT_OVERLAP_TOKENS = 96
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_BYTES = 1024 * 1024
const MIN_CHUNK_BYTES = 128
const MAX_OUTPUT_CHUNKS = 100_000
const MAX_LOCATOR_BYTES = 4096
const MAX_SECTION_DEPTH = 32
const MAX_SECTION_PART_BYTES = 512
const MAX_TOKEN_COUNT = 4_000_000

const FORMATS = new Set(['markdown', 'html', 'txt', 'ebook', 'repository_document'])
const SOURCE_KEYS = new Set(['format', 'body', 'locator', 'sectionPath'])
const OPTION_KEYS = new Set(['tokenizer', 'maxTokens', 'overlapTokens', 'maxSourceBytes', 'maxChunkBytes'])
const LOCATOR_KEYS = new Set([
  'route', 'documentId', 'bookId', 'chapterIndex', 'repositoryId', 'path', 'line',
  'commit', 'versionId', 'sourceVersionId', 'page', 'spineIndex', 'paragraphStart', 'paragraphEnd'
])
const ROUTES = Object.freeze({
  markdown: '/documents',
  html: '/documents',
  txt: '/documents',
  ebook: '/books',
  repository_document: '/code'
})
const STRUCTURE_RULES_VERSION = 'headings-v1|html-blocks-v1|paragraphs-v1|fence-atomic-v1|line-locators-v1'

export const RAG_CHUNKER_DEFAULTS = Object.freeze({
  modelId: RAG_CHUNKER_MODEL_ID,
  modelRevision: RAG_CHUNKER_MODEL_REVISION,
  maxTokens: DEFAULT_MAX_TOKENS,
  overlapTokens: DEFAULT_OVERLAP_TOKENS,
  maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
  structureRulesVersion: STRUCTURE_RULES_VERSION
})

function fail(code, message) {
  const error = new TypeError(message)
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
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function requiredText(value, name, maxBytes = MAX_SECTION_PART_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000]/u.test(value)) {
    fail('RAG_CHUNKER_INPUT_INVALID', `${name} is invalid`)
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || byteLength(normalized) > maxBytes || /[\u0000]/u.test(normalized)) {
    fail('RAG_CHUNKER_INPUT_INVALID', `${name} is invalid`)
  }
  return normalized
}

function positiveInteger(value, name, { max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('RAG_CHUNKER_LOCATOR_INVALID', `${name} is invalid`)
  return value
}

function nonNegativeInteger(value, name, { max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('RAG_CHUNKER_LOCATOR_INVALID', `${name} is invalid`)
  return value
}

function normalizeSectionPath(value, name = 'sectionPath') {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_SECTION_DEPTH) fail('RAG_CHUNKER_LOCATOR_INVALID', `${name} is invalid`)
  const parts = value.map((part, index) => requiredText(part, `${name}[${index}]`))
  return Object.freeze(parts)
}

function normalizeRelativePath(value) {
  const normalized = requiredText(value, 'locator.path', 2048).replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) ||
      segments.some((segment) => segment === '.' || segment === '..' || segment === '')) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.path is invalid')
  }
  if (/(?:^|\/)(?:\.git|node_modules|vendor|dist|build|coverage)(?:\/|$)/iu.test(normalized)) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.path is not an indexable document path')
  }
  return normalized
}

function normalizeLocator(locator, format) {
  if (!isPlainObject(locator) || Object.keys(locator).some((key) => !LOCATOR_KEYS.has(key))) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator is invalid')
  }
  const route = requiredText(locator.route, 'locator.route', 64)
  if (route !== ROUTES[format]) fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.route does not match format')

  const normalized = { route }
  if (format === 'repository_document') {
    normalized.repositoryId = positiveInteger(locator.repositoryId, 'locator.repositoryId')
    normalized.path = normalizeRelativePath(locator.path)
    if (locator.commit !== undefined) {
      if (typeof locator.commit !== 'string' || !/^[a-f0-9]{7,64}$/iu.test(locator.commit)) {
        fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.commit is invalid')
      }
      normalized.commit = locator.commit.toLowerCase()
    }
  } else if (format === 'ebook') {
    normalized.bookId = positiveInteger(locator.bookId, 'locator.bookId')
    if (locator.chapterIndex !== undefined) normalized.chapterIndex = nonNegativeInteger(locator.chapterIndex, 'locator.chapterIndex')
    if (locator.spineIndex !== undefined) normalized.spineIndex = nonNegativeInteger(locator.spineIndex, 'locator.spineIndex')
    if (locator.page !== undefined) fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.page is invalid for an ebook')
  } else {
    normalized.documentId = positiveInteger(locator.documentId, 'locator.documentId')
    if (locator.page !== undefined) normalized.page = positiveInteger(locator.page, 'locator.page')
    if (locator.spineIndex !== undefined) fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator.spineIndex is invalid for a document')
  }

  if (format !== 'repository_document') {
    if (locator.paragraphStart !== undefined) normalized.paragraphStart = nonNegativeInteger(locator.paragraphStart, 'locator.paragraphStart')
    if (locator.paragraphEnd !== undefined) normalized.paragraphEnd = nonNegativeInteger(locator.paragraphEnd, 'locator.paragraphEnd')
    if (normalized.paragraphEnd !== undefined && normalized.paragraphStart !== undefined &&
        normalized.paragraphEnd < normalized.paragraphStart) {
      fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator paragraph range is invalid')
    }
  } else if (locator.page !== undefined || locator.spineIndex !== undefined ||
      locator.paragraphStart !== undefined || locator.paragraphEnd !== undefined) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator contains unsupported repository fields')
  }

  for (const key of ['line', 'versionId', 'sourceVersionId']) {
    if (locator[key] !== undefined) normalized[key] = positiveInteger(locator[key], `locator.${key}`)
  }
  const serialized = stableJson(normalized)
  if (byteLength(serialized) > MAX_LOCATOR_BYTES || /[\u0000]/u.test(serialized) ||
      /(?:storage[_-]?key|managed[_-]?storage|[A-Za-z]:\\|\/etc\/|\/app\/data)/iu.test(serialized)) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'locator exposes internal data')
  }
  return Object.freeze(normalized)
}

function normalizeBody(value, maxSourceBytes) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000]/u.test(value)) {
    fail('RAG_CHUNKER_INPUT_INVALID', 'body is invalid')
  }
  const normalized = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!normalized.trim() || byteLength(normalized) > maxSourceBytes) {
    fail('RAG_CHUNKER_INPUT_TOO_LARGE', 'body is empty or exceeds the source byte ceiling')
  }
  return normalized
}

function normalizeOptions(options = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    fail('RAG_CHUNKER_OPTIONS_INVALID', 'chunker options are invalid')
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS
  if (maxTokens !== DEFAULT_MAX_TOKENS || overlapTokens !== DEFAULT_OVERLAP_TOKENS) {
    fail('RAG_CHUNKER_OPTIONS_INVALID', '6C.1 uses the fixed 768/96 token configuration')
  }
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < MIN_CHUNK_BYTES || maxSourceBytes > MAX_SOURCE_BYTES ||
      !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < MIN_CHUNK_BYTES || maxChunkBytes > MAX_CHUNK_BYTES) {
    fail('RAG_CHUNKER_OPTIONS_INVALID', 'byte ceilings are invalid')
  }
  const tokenizer = options.tokenizer
  if (tokenizer !== undefined && (!isPlainObject(tokenizer) || typeof tokenizer.encode !== 'function' || typeof tokenizer.decode !== 'function')) {
    fail('RAG_CHUNKER_TOKENIZER_INVALID', 'tokenizer must expose encode() and decode()')
  }
  const config = {
    ...RAG_CHUNKER_DEFAULTS,
    maxSourceBytes,
    maxChunkBytes,
    tokenizerMode: tokenizer ? 'actual' : 'deferred'
  }
  const configHash = sha256(stableJson(config))
  return Object.freeze({ ...config, tokenizer, configHash })
}

function normalizeSource(source, config) {
  if (!isPlainObject(source) || Object.keys(source).some((key) => !SOURCE_KEYS.has(key))) {
    fail('RAG_CHUNKER_INPUT_INVALID', 'source input is invalid')
  }
  const format = requiredText(source.format, 'format', 64).toLowerCase()
  if (!FORMATS.has(format)) fail('RAG_CHUNKER_FORMAT_UNSUPPORTED', 'source format is unsupported')
  const body = normalizeBody(source.body, config.maxSourceBytes)
  return Object.freeze({
    format,
    body,
    locator: normalizeLocator(source.locator, format),
    sectionPath: normalizeSectionPath(source.sectionPath)
  })
}

function lineNumberAt(lineStarts, offset) {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  return high + 1
}

function lineStarts(body) {
  const starts = [0]
  for (let index = 0; index < body.length; index += 1) if (body[index] === '\n') starts.push(index + 1)
  return starts
}

function cleanMarkdownText(value) {
  return value.replace(/[ \t]+$/gmu, '').trim()
}

function cleanPlainText(value) {
  return value.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').trim()
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return value.replace(/&(#x[\da-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);/gu, (match, entity) => {
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return named[entity] ?? match
  })
}

function stripHtml(value) {
  return decodeHtmlEntities(value
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<\/?[^>]+>/gu, ''))
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function createSection(sectionPath) {
  return { sectionPath: Object.freeze([...sectionPath]), units: [], nextParagraphIndex: 0 }
}

function addUnit(section, { text, startLine, endLine, atomic = false, paragraphIndex }) {
  const body = atomic ? text : cleanPlainText(text)
  if (!body) return
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine) {
    fail('RAG_CHUNKER_LOCATOR_INVALID', 'source line locator is invalid')
  }
  const resolvedParagraphIndex = paragraphIndex === undefined ? section.nextParagraphIndex : paragraphIndex
  section.nextParagraphIndex = Math.max(section.nextParagraphIndex, resolvedParagraphIndex + 1)
  section.units.push(Object.freeze({
    text: body,
    startLine,
    endLine,
    paragraphIndex: resolvedParagraphIndex,
    atomic
  }))
}

function headingPath(basePath, stack, level, title) {
  while (stack.length > 0 && stack.at(-1).level >= level) stack.pop()
  stack.push({ level, title })
  return [...basePath, ...stack.map((item) => item.title)]
}

function headingMatch(line) {
  const match = /^( {0,3})(#{1,6})[ \t]+(.+?)\s*#*\s*$/u.exec(line)
  if (!match) return null
  return { level: match[2].length, title: cleanMarkdownText(match[3]) }
}

function fenceStart(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(?:[^`]*)$/u.exec(line)
  return match ? { marker: match[1][0], length: match[1].length } : null
}

function fenceEnd(line, fence) {
  const pattern = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`, 'u')
  return pattern.test(line)
}

function parseMarkdown(body, basePath) {
  const lines = body.split('\n')
  const sections = []
  let section = createSection(basePath)
  sections.push(section)
  const stack = []
  let paragraphLines = []
  let paragraphStart = 0
  let fence = null
  let fenceLines = []
  let fenceStartLine = 0

  const flushParagraph = (endLine) => {
    if (paragraphLines.length === 0) return
    addUnit(section, {
      text: paragraphLines.join('\n'),
      startLine: paragraphStart,
      endLine,
      atomic: false
    })
    paragraphLines = []
    paragraphStart = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const number = index + 1
    if (fence) {
      fenceLines.push(line)
      if (fenceEnd(line, fence)) {
        addUnit(section, {
          text: fenceLines.join('\n'),
          startLine: fenceStartLine,
          endLine: number,
          atomic: true
        })
        fence = null
        fenceLines = []
      }
      continue
    }
    const openingFence = fenceStart(line)
    if (openingFence) {
      flushParagraph(number - 1)
      fence = openingFence
      fenceLines = [line]
      fenceStartLine = number
      continue
    }
    const heading = headingMatch(line)
    if (heading) {
      flushParagraph(number - 1)
      const path = headingPath(basePath, stack, heading.level, heading.title)
      section = createSection(path)
      sections.push(section)
      addUnit(section, { text: heading.title, startLine: number, endLine: number, paragraphIndex: 0 })
      continue
    }
    if (!line.trim()) {
      flushParagraph(number - 1)
      continue
    }
    if (paragraphLines.length === 0) paragraphStart = number
    paragraphLines.push(line)
  }
  if (fence) fail('RAG_CHUNKER_FORMAT_INVALID', 'unterminated fenced code block')
  flushParagraph(lines.length)
  return sections.filter((candidate) => candidate.units.length > 0)
}

function ebookHeading(line) {
  const trimmed = line.trim()
  if (/^(?:chapter|part|book|prologue|epilogue)\b/iu.test(trimmed)) return trimmed
  if (/^第\s*[\d一二三四五六七八九十百千万]+\s*(?:章|节|卷)\b/u.test(trimmed)) return trimmed
  return null
}

function parsePlain(body, basePath, format) {
  if (format === 'txt') return parseParagraphs(body, basePath)
  const lines = body.split('\n')
  const sections = []
  let section = createSection(basePath)
  sections.push(section)
  let paragraphLines = []
  let paragraphStart = 0
  const flushParagraph = (endLine) => {
    if (paragraphLines.length === 0) return
    addUnit(section, { text: paragraphLines.join('\n'), startLine: paragraphStart, endLine })
    paragraphLines = []
    paragraphStart = 0
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const number = index + 1
    const title = ebookHeading(line)
    if (title) {
      flushParagraph(number - 1)
      section = createSection([...basePath, title])
      sections.push(section)
      addUnit(section, { text: title, startLine: number, endLine: number, paragraphIndex: 0 })
    } else if (!line.trim()) {
      flushParagraph(number - 1)
    } else {
      if (paragraphLines.length === 0) paragraphStart = number
      paragraphLines.push(line)
    }
  }
  flushParagraph(lines.length)
  return sections.filter((candidate) => candidate.units.length > 0)
}

function parseParagraphs(body, basePath) {
  const lines = body.split('\n')
  const sections = [createSection(basePath)]
  let paragraphLines = []
  let paragraphStart = 0
  const flushParagraph = (endLine) => {
    if (paragraphLines.length === 0) return
    addUnit(sections[0], { text: paragraphLines.join('\n'), startLine: paragraphStart, endLine })
    paragraphLines = []
    paragraphStart = 0
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const number = index + 1
    if (!line.trim()) flushParagraph(number - 1)
    else {
      if (paragraphLines.length === 0) paragraphStart = number
      paragraphLines.push(line)
    }
  }
  flushParagraph(lines.length)
  return sections.filter((candidate) => candidate.units.length > 0)
}

function htmlLineSpan(starts, startOffset, endOffset) {
  return {
    startLine: lineNumberAt(starts, startOffset),
    endLine: lineNumberAt(starts, Math.max(startOffset, endOffset - 1))
  }
}

function parseHtml(body, basePath) {
  const starts = lineStarts(body)
  const blockPattern = /<\s*(h[1-6]|p|pre|li|blockquote|dt|dd)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/giu
  const masked = body.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/\s*(?:script|style)\s*>/giu, (value) => value.replace(/[^\n]/gu, ' '))
  const sections = []
  let section = createSection(basePath)
  sections.push(section)
  const stack = []
  let cursor = 0
  let sawBlock = false
  const addOutside = (text, startOffset, endOffset) => {
    const plain = stripHtml(text)
    if (!plain) return
    const span = htmlLineSpan(starts, startOffset, endOffset)
    addUnit(section, { text: plain, ...span })
  }
  for (const match of masked.matchAll(blockPattern)) {
    const startOffset = match.index ?? 0
    addOutside(masked.slice(cursor, startOffset), cursor, startOffset)
    cursor = startOffset + match[0].length
    sawBlock = true
    const tag = match[1].toLowerCase()
    const inner = match[2]
    const span = htmlLineSpan(starts, startOffset, cursor)
    if (tag[0] === 'h') {
      const level = Number(tag.slice(1))
      const title = stripHtml(inner)
      if (!title) continue
      const path = headingPath(basePath, stack, level, title)
      section = createSection(path)
      sections.push(section)
      addUnit(section, { text: title, ...span, paragraphIndex: 0 })
    } else {
      addUnit(section, { text: stripHtml(inner), ...span, atomic: tag === 'pre' })
    }
  }
  addOutside(masked.slice(cursor), cursor, body.length)
  if (!sawBlock && sections[0].units.length === 0) {
    const plain = stripHtml(body)
    if (plain) addUnit(sections[0], { text: plain, startLine: 1, endLine: body.split('\n').length })
  }
  return sections.filter((candidate) => candidate.units.length > 0)
}

function parseSections(source) {
  if (source.format === 'html') return parseHtml(source.body, source.sectionPath)
  if (source.format === 'markdown' || source.format === 'repository_document') {
    return parseMarkdown(source.body, source.sectionPath)
  }
  return parsePlain(source.body, source.sectionPath, source.format)
}

function asTokenArray(value) {
  if (Array.isArray(value)) return [...value]
  if (ArrayBuffer.isView(value)) return Array.from(value)
  fail('RAG_CHUNKER_TOKENIZER_INVALID', 'tokenizer.encode() must return an array')
}

function encode(tokenizer, text) {
  let value
  try { value = tokenizer.encode(text) } catch (error) { fail('RAG_CHUNKER_TOKENIZER_INVALID', `tokenizer.encode() failed: ${error.message}`) }
  const tokens = asTokenArray(value)
  if (tokens.length > MAX_TOKEN_COUNT) fail('RAG_CHUNKER_TOKENIZER_INVALID', 'tokenizer returned too many tokens for one structural unit')
  return tokens
}

function decode(tokenizer, tokens) {
  let value
  try { value = tokenizer.decode(tokens) } catch (error) { fail('RAG_CHUNKER_TOKENIZER_INVALID', `tokenizer.decode() failed: ${error.message}`) }
  if (typeof value !== 'string' || !value.trim() || /[\u0000]/u.test(value)) {
    fail('RAG_CHUNKER_TOKENIZER_INVALID', 'tokenizer.decode() returned invalid text')
  }
  return value.replace(/\r\n?/gu, '\n')
}

function makeLocatorPatch(sectionPath, firstUnit, lastUnit) {
  const patch = {
    sectionPath: Object.freeze([...sectionPath]),
    startLine: firstUnit.startLine,
    endLine: lastUnit.endLine,
    paragraphIndex: firstUnit.paragraphIndex
  }
  if (lastUnit.paragraphIndex !== firstUnit.paragraphIndex) patch.paragraphEndIndex = lastUnit.paragraphIndex
  return Object.freeze(patch)
}

function makeChunk({ ordinal, body, sectionPath, firstUnit, lastUnit, tokenCount, tokenCountMode, tokenStart, tokenEnd, maxChunkBytes }) {
  const normalizedBody = body.replace(/\r\n?/gu, '\n').trim()
  if (!normalizedBody || /[\u0000]/u.test(normalizedBody) || byteLength(normalizedBody) > maxChunkBytes) {
    fail('RAG_CHUNKER_OUTPUT_INVALID', 'chunk body exceeds the byte ceiling')
  }
  const locatorPatch = makeLocatorPatch(sectionPath, firstUnit, lastUnit)
  return Object.freeze({
    ordinal,
    body: normalizedBody,
    bodySha256: sha256(normalizedBody),
    tokenCount,
    tokenCountMode,
    ...(tokenStart === undefined ? {} : { tokenStart, tokenEnd }),
    sectionPath: locatorPatch.sectionPath,
    startLine: locatorPatch.startLine,
    endLine: locatorPatch.endLine,
    paragraphIndex: locatorPatch.paragraphIndex,
    ...(locatorPatch.paragraphEndIndex === undefined ? {} : { paragraphEndIndex: locatorPatch.paragraphEndIndex }),
    locatorPatch
  })
}

function unitsForRange(units, start, end) {
  const covered = units.filter((unit) => unit.endToken > start && unit.startToken < end)
  if (covered.length === 0) return [units[Math.max(0, Math.min(units.length - 1, start))]]
  return covered
}

function chunkTokenizedRun(units, tokenizer, config, ordinalRef) {
  const separatorTokens = encode(tokenizer, '\n\n')
  const tokens = []
  const spans = []
  for (const [index, unit] of units.entries()) {
    const startToken = tokens.length
    tokens.push(...encode(tokenizer, unit.text))
    spans.push(Object.freeze({ unit, startToken, endToken: tokens.length }))
    if (index < units.length - 1) tokens.push(...separatorTokens)
  }
  if (tokens.length === 0) return []
  const chunks = []
  let start = 0
  while (start < tokens.length) {
    let end = Math.min(tokens.length, start + config.maxTokens)
    let body = decode(tokenizer, tokens.slice(start, end))
    while (byteLength(body) > config.maxChunkBytes && end > start + 1) {
      end -= 1
      body = decode(tokenizer, tokens.slice(start, end))
    }
    if (byteLength(body) > config.maxChunkBytes) fail('RAG_CHUNKER_OUTPUT_INVALID', 'tokenized chunk exceeds the byte ceiling')
    const covered = unitsForRange(spans, start, end).map((span) => span.unit)
    chunks.push(makeChunk({
      ordinal: ordinalRef.value++,
      body,
      sectionPath: units[0].sectionPath,
      firstUnit: covered[0],
      lastUnit: covered.at(-1),
      tokenCount: end - start,
      tokenCountMode: 'actual',
      tokenStart: start,
      tokenEnd: end,
      maxChunkBytes: config.maxChunkBytes
    }))
    if (end === tokens.length) break
    start = Math.max(start + 1, end - config.overlapTokens)
  }
  return chunks
}

function chunkAtomicUnit(unit, config, ordinalRef) {
  if (config.tokenizer) {
    const tokens = encode(config.tokenizer, unit.text)
    if (tokens.length > config.maxTokens) fail('RAG_CHUNKER_CODE_BLOCK_TOO_LARGE', 'fenced code block exceeds the token ceiling')
    const body = decode(config.tokenizer, tokens)
    if (byteLength(body) > config.maxChunkBytes) fail('RAG_CHUNKER_CODE_BLOCK_TOO_LARGE', 'fenced code block exceeds the byte ceiling')
    return makeChunk({
      ordinal: ordinalRef.value++,
      body,
      sectionPath: unit.sectionPath,
      firstUnit: unit,
      lastUnit: unit,
      tokenCount: tokens.length,
      tokenCountMode: 'actual',
      tokenStart: 0,
      tokenEnd: tokens.length,
      maxChunkBytes: config.maxChunkBytes
    })
  }
  if (byteLength(unit.text) > config.maxChunkBytes) fail('RAG_CHUNKER_CODE_BLOCK_TOO_LARGE', 'fenced code block exceeds the byte ceiling')
  return makeChunk({
    ordinal: ordinalRef.value++,
    body: unit.text,
    sectionPath: unit.sectionPath,
    firstUnit: unit,
    lastUnit: unit,
    tokenCount: null,
    tokenCountMode: 'deferred',
    maxChunkBytes: config.maxChunkBytes
  })
}

function splitUtf8(text, maxBytes) {
  const pieces = []
  let current = ''
  let startOffset = 0
  let offset = 0
  for (const character of text) {
    const next = `${current}${character}`
    if (current && byteLength(next) > maxBytes) {
      pieces.push({ text: current, startOffset, endOffset: offset })
      current = character
      startOffset = offset
    } else {
      current = next
    }
    offset += character.length
  }
  if (current) pieces.push({ text: current, startOffset, endOffset: offset })
  return pieces
}

function lineSpanForOffset(unit, text, startOffset, endOffset) {
  const before = text.slice(0, startOffset)
  const through = text.slice(0, Math.max(startOffset, endOffset))
  const startLine = unit.startLine + (before.match(/\n/gu) ?? []).length
  const lineBreaks = (through.match(/\n/gu) ?? []).length
  const endLine = Math.max(startLine, unit.startLine + lineBreaks - (through.endsWith('\n') ? 1 : 0))
  return { startLine, endLine }
}

function chunkDeferredRun(units, config, ordinalRef) {
  const chunks = []
  let current = []
  let currentBytes = 0
  const flush = () => {
    if (current.length === 0) return
    chunks.push(makeChunk({
      ordinal: ordinalRef.value++,
      body: current.map((unit) => unit.text).join('\n\n'),
      sectionPath: current[0].sectionPath,
      firstUnit: current[0],
      lastUnit: current.at(-1),
      tokenCount: null,
      tokenCountMode: 'deferred',
      maxChunkBytes: config.maxChunkBytes
    }))
    current = []
    currentBytes = 0
  }
  for (const unit of units) {
    if (unit.atomic) {
      flush()
      chunks.push(chunkAtomicUnit(unit, config, ordinalRef))
      continue
    }
    const pieces = byteLength(unit.text) > config.maxChunkBytes
      ? splitUtf8(unit.text, config.maxChunkBytes)
      : [{ text: unit.text, startOffset: 0, endOffset: unit.text.length }]
    for (const piece of pieces) {
      const separatorBytes = current.length === 0 ? 0 : byteLength('\n\n')
      if (current.length > 0 && currentBytes + separatorBytes + byteLength(piece.text) > config.maxChunkBytes) flush()
      if (current.length === 0 && byteLength(piece.text) <= config.maxChunkBytes) {
        if (pieces.length === 1) {
          current.push(unit)
          currentBytes = byteLength(unit.text)
        } else {
          const span = lineSpanForOffset(unit, unit.text, piece.startOffset, piece.endOffset)
          const pieceUnit = Object.freeze({ ...unit, text: piece.text, startLine: span.startLine, endLine: span.endLine })
          chunks.push(makeChunk({
            ordinal: ordinalRef.value++,
            body: piece.text,
            sectionPath: unit.sectionPath,
            firstUnit: pieceUnit,
            lastUnit: pieceUnit,
            tokenCount: null,
            tokenCountMode: 'deferred',
            maxChunkBytes: config.maxChunkBytes
          }))
        }
      } else if (byteLength(piece.text) > config.maxChunkBytes) {
        fail('RAG_CHUNKER_OUTPUT_INVALID', 'a UTF-8 chunk cannot fit the byte ceiling')
      } else {
        current.push(unit)
        currentBytes += separatorBytes + byteLength(piece.text)
      }
    }
  }
  flush()
  return chunks
}

function chunkSections(sections, config) {
  const ordinalRef = { value: 0 }
  const all = []
  for (const section of sections) {
    let run = []
    const flushRun = () => {
      if (run.length === 0) return
      const result = config.tokenizer
        ? chunkTokenizedRun(run, config.tokenizer, config, ordinalRef)
        : chunkDeferredRun(run, config, ordinalRef)
      all.push(...result)
      run = []
    }
    for (const unit of section.units) {
      const locatedUnit = { ...unit, sectionPath: section.sectionPath }
      if (unit.atomic) {
        flushRun()
        all.push(chunkAtomicUnit(locatedUnit, config, ordinalRef))
      } else run.push(locatedUnit)
    }
    flushRun()
  }
  if (all.length === 0) fail('RAG_CHUNKER_OUTPUT_INVALID', 'source produced no chunks')
  if (all.length > MAX_OUTPUT_CHUNKS) fail('RAG_CHUNKER_OUTPUT_INVALID', 'source produced too many chunks')
  return Object.freeze(all)
}

export function normalizeRagChunkerOptions(options = {}) {
  return normalizeOptions(options)
}

function chunkWithConfig(source, config) {
  const normalized = normalizeSource(source, config)
  const sections = parseSections(normalized)
  const chunks = chunkSections(sections, config)
  return Object.freeze({
    format: normalized.format,
    locator: normalized.locator,
    sourceSha256: sha256(normalized.body),
    chunkerVersion: RAG_CHUNKER_VERSION,
    configHash: config.configHash,
    tokenCountMode: config.tokenizer ? 'actual' : 'deferred',
    chunks
  })
}

export function chunkRagSource(source, options = {}) {
  return chunkWithConfig(source, normalizeOptions(options))
}

export function createRagChunker(options = {}) {
  const config = normalizeOptions(options)
  return Object.freeze({
    config,
    chunk(source) {
      return chunkWithConfig(source, config)
    }
  })
}

export default chunkRagSource
