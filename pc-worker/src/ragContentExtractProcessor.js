import crypto from 'node:crypto'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export const RAG_CONTENT_EXTRACT_TASK_TYPE = 'rag.content.extract'
export const RAG_CONTENT_EXTRACT_PROCESSOR_VERSION = 'v1'
export const RAG_CONTENT_EXTRACT_EXECUTION_CLASS = 'cpu'
export const RAG_CONTENT_EXTRACTOR_VERSION = 'pc-worker-structured-text.v1'

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_SECTION_COUNT = 100_000
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const FORMATS = new Set(['pdf', 'docx', 'epub'])

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code, retryable: false })
}

function text(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function archive(buffer) {
  let value
  try { value = new AdmZip(buffer) } catch { fail('WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID') }
  const entries = value.getEntries()
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) fail('WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID')
  let expandedBytes = 0
  for (const entry of entries) {
    const normalized = entry.entryName.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
      fail('WORKER_CONTENT_EXTRACT_ARCHIVE_UNSAFE')
    }
    expandedBytes += Number(entry.header?.size ?? 0)
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_INPUT_BYTES * 4) {
      fail('WORKER_CONTENT_EXTRACT_ARCHIVE_TOO_LARGE')
    }
  }
  return value
}

function entryText(zip, entryName) {
  const entry = zip.getEntry(entryName)
  if (!entry || entry.isDirectory) fail('WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID')
  const data = entry.getData()
  if (data.length > MAX_ARTIFACT_BYTES) fail('WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE')
  return data.toString('utf8')
}

function extractDocx(buffer) {
  const zip = archive(buffer)
  const xml = entryText(zip, 'word/document.xml')
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/giu)]
    .map((match) => text(match[1].replace(/<w:tab\b[^>]*\/?\s*>/giu, '\t').replace(/<w:br\b[^>]*\/?\s*>/giu, '\n')))
    .filter(Boolean)
  if (paragraphs.length === 0) fail('WORKER_CONTENT_EXTRACT_EMPTY')
  return [{ ordinal: 0, title: 'Document', text: paragraphs.join('\n\n'), locator: { paragraphStart: 0, paragraphEnd: paragraphs.length - 1 } }]
}

function resolveArchivePath(base, target) {
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(base), target.replaceAll('\\', '/')))
  if (!normalized || normalized.startsWith('../') || normalized.startsWith('/')) fail('WORKER_CONTENT_EXTRACT_ARCHIVE_UNSAFE')
  return normalized
}

function extractEpub(buffer) {
  const zip = archive(buffer)
  const container = entryText(zip, 'META-INF/container.xml')
  const rootfile = container.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/iu)?.[1]
  if (!rootfile) fail('WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID')
  const opf = entryText(zip, rootfile)
  const manifest = new Map([...opf.matchAll(/<item\b([^>]+)>/giu)].map((match) => {
    const id = match[1].match(/\bid=["']([^"']+)["']/iu)?.[1]
    const href = match[1].match(/\bhref=["']([^"']+)["']/iu)?.[1]
    return id && href ? [id, resolveArchivePath(rootfile, href)] : [null, null]
  }).filter(([id]) => id))
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*\/?\s*>/giu)].map((match) => match[1])
  const sections = []
  for (const id of spine) {
    const entryName = manifest.get(id)
    if (!entryName) continue
    const html = entryText(zip, entryName)
    const body = text(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1] ?? html)
    if (!body) continue
    const title = text(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? path.posix.basename(entryName))
    sections.push({ ordinal: sections.length, title: title || `Section ${sections.length + 1}`, text: body, locator: { spineIndex: sections.length } })
  }
  if (sections.length === 0) fail('WORKER_CONTENT_EXTRACT_EMPTY')
  return sections
}

async function extractPdf(buffer, signal) {
  let document
  try {
    document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false }).promise
  } catch { fail('WORKER_CONTENT_EXTRACT_PDF_INVALID') }
  const sections = []
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED')
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = text(content.items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join(''))
      if (pageText) sections.push({ ordinal: sections.length, title: `Page ${pageNumber}`, text: pageText, locator: { page: pageNumber } })
    }
  } finally {
    await document.destroy()
  }
  if (sections.length === 0) fail('WORKER_CONTENT_EXTRACT_EMPTY')
  return sections
}

async function readInput(stream, expected, signal) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail('WORKER_INPUT_STREAM_INVALID')
  const chunks = []
  const hash = crypto.createHash('sha256')
  let bytes = 0
  for await (const value of stream) {
    if (signal?.aborted) fail('WORKER_PROCESSOR_CANCELLED')
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES || bytes > expected.contentBytes) fail('WORKER_CONTENT_EXTRACT_INPUT_TOO_LARGE')
    hash.update(chunk)
    chunks.push(chunk)
  }
  if (bytes !== expected.contentBytes || hash.digest('hex') !== expected.sourceContentSha256) fail('WORKER_INPUT_MISMATCH')
  return Buffer.concat(chunks)
}

function normalizeTask(task) {
  const input = task?.input
  if (task?.taskType !== RAG_CONTENT_EXTRACT_TASK_TYPE || task?.processorVersion !== RAG_CONTENT_EXTRACT_PROCESSOR_VERSION ||
      task?.executionClass !== RAG_CONTENT_EXTRACT_EXECUTION_CLASS || !input || input.schemaVersion !== 1 ||
      !FORMATS.has(input.format) || !Number.isSafeInteger(input.contentBytes) || input.contentBytes < 1 ||
      input.contentBytes > MAX_INPUT_BYTES || typeof input.sourceVersionId !== 'string' ||
      typeof input.sourceContentSha256 !== 'string' || !HASH_PATTERN.test(input.sourceContentSha256)) {
    fail('WORKER_CONTENT_EXTRACT_INPUT_INVALID')
  }
  return input
}

export function createRagContentExtractProcessor() {
  return Object.freeze({
    supports(taskType) { return taskType === RAG_CONTENT_EXTRACT_TASK_TYPE },
    async process(task, stream, { signal } = {}) {
      const input = normalizeTask(task)
      const buffer = await readInput(stream, input, signal)
      const sections = input.format === 'pdf'
        ? await extractPdf(buffer, signal)
        : input.format === 'docx' ? extractDocx(buffer) : extractEpub(buffer)
      if (sections.length > MAX_SECTION_COUNT) fail('WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE')
      const artifact = { schemaVersion: 1, format: input.format, sections }
      const serialized = JSON.stringify(artifact)
      const artifactBytes = Buffer.byteLength(serialized, 'utf8')
      if (artifactBytes > MAX_ARTIFACT_BYTES) fail('WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE')
      const artifactSha256 = crypto.createHash('sha256').update(serialized).digest('hex')
      return {
        schemaVersion: 1,
        processorVersion: RAG_CONTENT_EXTRACT_PROCESSOR_VERSION,
        output: {
          sourceVersionId: input.sourceVersionId,
          sourceContentSha256: input.sourceContentSha256,
          extractorVersion: RAG_CONTENT_EXTRACTOR_VERSION,
          artifactSha256,
          artifactBytes,
          sectionCount: sections.length,
          manifest: { artifactSha256, artifactBytes, sectionCount: sections.length, format: input.format, sections }
        }
      }
    }
  })
}

export const RAG_CONTENT_EXTRACT_PROCESSOR_CAPABILITY = Object.freeze({
  taskType: RAG_CONTENT_EXTRACT_TASK_TYPE,
  processorVersion: RAG_CONTENT_EXTRACT_PROCESSOR_VERSION,
  executionClass: RAG_CONTENT_EXTRACT_EXECUTION_CLASS,
  outputSchemaVersion: 1
})

export default createRagContentExtractProcessor
