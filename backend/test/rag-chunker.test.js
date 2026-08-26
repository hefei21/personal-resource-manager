import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  chunkRagSource,
  createRagChunker,
  RAG_CHUNKER_DEFAULTS,
  RAG_CHUNKER_MODEL_ID,
  RAG_CHUNKER_MODEL_REVISION,
  RAG_CHUNKER_VERSION
} from '../src/services/ragChunker.js'

const documentLocator = { route: '/documents', documentId: 41 }
const ebookLocator = { route: '/books', bookId: 42, chapterIndex: 1 }
const repositoryLocator = {
  route: '/code', repositoryId: 43, path: 'docs/README.md', commit: 'a'.repeat(40)
}

const whitespaceTokenizer = Object.freeze({
  encode(text) {
    return text.split(/\s+/u).filter(Boolean)
  },
  decode(tokens) {
    return tokens.join(' ')
  }
})

function bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function assertChunkShape(report) {
  assert.equal(report.chunkerVersion, RAG_CHUNKER_VERSION)
  assert.match(report.configHash, /^[a-f0-9]{64}$/u)
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/u)
  assert.ok(report.chunks.length > 0)
  assert.deepEqual(report.chunks.map((chunk) => chunk.ordinal), report.chunks.map((_chunk, index) => index))
  for (const chunk of report.chunks) {
    assert.equal(chunk.bodySha256, crypto.createHash('sha256').update(chunk.body, 'utf8').digest('hex'))
    assert.ok(bytes(chunk.body) <= RAG_CHUNKER_DEFAULTS.maxChunkBytes)
    assert.ok(chunk.startLine >= 1)
    assert.ok(chunk.endLine >= chunk.startLine)
    assert.ok(Number.isSafeInteger(chunk.paragraphIndex))
    assert.deepEqual(chunk.locatorPatch.sectionPath, chunk.sectionPath)
    assert.equal(chunk.locatorPatch.startLine, chunk.startLine)
    assert.equal(chunk.locatorPatch.endLine, chunk.endLine)
  }
}

test('deferred mode uses structure boundaries, public locators, and no fake token counts', () => {
  const report = chunkRagSource({
    format: 'markdown',
    body: '# Introduction\r\n\r\nA first paragraph.\r\n\r\n## Details\r\n\r\nA second paragraph.',
    locator: documentLocator,
    sectionPath: ['Guide']
  })

  assertChunkShape(report)
  assert.equal(report.tokenCountMode, 'deferred')
  assert.deepEqual(report.locator, documentLocator)
  assert.deepEqual(report.chunks.map((chunk) => chunk.sectionPath), [
    ['Guide', 'Introduction'], ['Guide', 'Introduction', 'Details']
  ])
  assert.deepEqual(report.chunks.map((chunk) => [chunk.startLine, chunk.endLine]), [[1, 3], [5, 7]])
  assert.deepEqual(report.chunks.map((chunk) => chunk.tokenCount), [null, null])
  assert.match(report.chunks[0].body, /Introduction/u)
})

test('supports html, txt, ebook, and repository_document inputs with safe locators', () => {
  const sources = [
    {
      format: 'html',
      body: '<h1>HTML Guide</h1><p>Hello &amp; welcome.</p><script>secret_token()</script><p>Visible.</p>',
      locator: documentLocator,
      expected: ['HTML Guide', 'Hello & welcome.', 'Visible.']
    },
    {
      format: 'txt',
      body: 'Plain paragraph one.\n\nPlain paragraph two.',
      locator: documentLocator,
      expected: ['Plain paragraph one.', 'Plain paragraph two.']
    },
    {
      format: 'ebook',
      body: 'Chapter 1\n\nAlice enters the garden.\n\nChapter 2\n\nThe door is locked.',
      locator: ebookLocator,
      expected: ['Chapter 1', 'Alice enters the garden.', 'Chapter 2', 'The door is locked.']
    },
    {
      format: 'repository_document',
      body: '# README\n\nInstall the package.\n\n## Usage\n\nRun the command.',
      locator: repositoryLocator,
      expected: ['README', 'Install the package.', 'Usage', 'Run the command.']
    }
  ]

  for (const source of sources) {
    const { expected, ...input } = source
    const report = chunkRagSource(input)
    assertChunkShape(report)
    const body = report.chunks.map((chunk) => chunk.body).join('\n')
    for (const expectedText of expected) assert.match(body, new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    assert.doesNotMatch(body, /secret_token/u)
  }
})

test('preserves binary extraction page, paragraph and spine locators through chunking', () => {
  const pdf = chunkRagSource({
    format: 'txt',
    body: 'PDF page content.',
    locator: { ...documentLocator, page: 2, paragraphStart: 0, paragraphEnd: 3 }
  })
  assert.deepEqual(pdf.locator, {
    ...documentLocator, page: 2, paragraphStart: 0, paragraphEnd: 3
  })
  const epub = chunkRagSource({
    format: 'ebook',
    body: 'EPUB spine content.',
    locator: { route: '/books', bookId: 42, spineIndex: 4 }
  })
  assert.deepEqual(epub.locator, { route: '/books', bookId: 42, spineIndex: 4 })
})

test('actual tokenizer mode fixes 768/96 and reports real token counts', () => {
  const body = Array.from({ length: 1700 }, (_value, index) => `token-${index}`).join(' ')
  const report = chunkRagSource({ format: 'txt', body, locator: documentLocator }, { tokenizer: whitespaceTokenizer })

  assert.equal(report.tokenCountMode, 'actual')
  assert.equal(report.chunks.length, 3)
  assert.deepEqual(report.chunks.map((chunk) => chunk.tokenCount), [768, 768, 356])
  assert.deepEqual(report.chunks.map((chunk) => [chunk.tokenStart, chunk.tokenEnd]), [[0, 768], [672, 1440], [1344, 1700]])
  assert.ok(report.chunks.every((chunk) => chunk.tokenCount <= 768))
  assert.equal(report.chunks[1].body.includes('token-672'), true)
  assert.equal(report.chunks[1].body.includes('token-575'), false)
  assert.equal(report.chunks[1].tokenStart - report.chunks[0].tokenEnd, -96)
  assert.equal(report.configHash, chunkRagSource({ format: 'txt', body, locator: documentLocator }, { tokenizer: whitespaceTokenizer }).configHash)
  assert.notEqual(report.configHash, chunkRagSource({ format: 'txt', body, locator: documentLocator }).configHash)
})

test('token overlap never crosses markdown sections', () => {
  const sectionA = Array.from({ length: 1000 }, (_value, index) => `a-${index}`).join(' ')
  const sectionB = Array.from({ length: 1000 }, (_value, index) => `b-${index}`).join(' ')
  const report = chunkRagSource({
    format: 'markdown',
    body: `# A\n\n${sectionA}\n\n# B\n\n${sectionB}`,
    locator: documentLocator
  }, { tokenizer: whitespaceTokenizer })

  const aChunks = report.chunks.filter((chunk) => chunk.sectionPath.at(-1) === 'A')
  const bChunks = report.chunks.filter((chunk) => chunk.sectionPath.at(-1) === 'B')
  assert.ok(aChunks.length >= 2)
  assert.ok(bChunks.length >= 2)
  assert.equal(aChunks[0].tokenStart, 0)
  assert.equal(bChunks[0].tokenStart, 0)
  assert.ok(aChunks.every((chunk) => !chunk.body.includes('b-')))
  assert.ok(bChunks.every((chunk) => !chunk.body.includes('a-')))
})

test('fenced code is an atomic chunk and oversized code is rejected', () => {
  const body = '# Code\n\nBefore.\n\n```js\nconst answer = 42;\n```\n\nAfter.'
  const report = chunkRagSource({ format: 'markdown', body, locator: documentLocator })
  const code = report.chunks.find((chunk) => chunk.body.includes('const answer'))
  assert.ok(code)
  assert.match(code.body, /^```js[\s\S]*```$/u)
  assert.equal(code.startLine, 5)
  assert.equal(code.endLine, 7)
  assert.equal(report.chunks.filter((chunk) => chunk.body.includes('const answer')).length, 1)

  const oversized = `\`\`\`\n${Array.from({ length: 900 }, (_value, index) => `code-${index}`).join(' ')}\n\`\`\``
  assert.throws(
    () => chunkRagSource({ format: 'markdown', body: oversized, locator: documentLocator }, { tokenizer: whitespaceTokenizer }),
    (error) => error.code === 'RAG_CHUNKER_CODE_BLOCK_TOO_LARGE'
  )
})

test('deferred mode respects UTF-8 byte ceilings without splitting invalid code points', () => {
  const body = `${'你好世界'.repeat(100)}\n\n${'内容'.repeat(100)}`
  const report = chunkRagSource({ format: 'txt', body, locator: documentLocator }, { maxChunkBytes: 128 })
  assert.ok(report.chunks.length > 1)
  assert.ok(report.chunks.every((chunk) => bytes(chunk.body) <= 128 && chunk.tokenCount === null))
  assert.equal(report.chunks.map((chunk) => chunk.body).join('').replace(/\n/gu, '').length > 0, true)
  assert.ok(report.chunks.every((chunk) => !chunk.body.includes('\uFFFD')))
})

test('chunker and locator inputs reject unsafe, oversized, and unknown values', () => {
  assert.throws(() => chunkRagSource({ format: 'pdf', body: 'x', locator: documentLocator }), { code: 'RAG_CHUNKER_FORMAT_UNSUPPORTED' })
  assert.throws(() => chunkRagSource({ format: 'txt', body: 'x', locator: { ...documentLocator, route: '/books' } }), { code: 'RAG_CHUNKER_LOCATOR_INVALID' })
  assert.throws(() => chunkRagSource({ format: 'repository_document', body: 'x', locator: { ...repositoryLocator, path: '../secret.md' } }), { code: 'RAG_CHUNKER_LOCATOR_INVALID' })
  assert.throws(() => chunkRagSource({ format: 'txt', body: 'x\u0000y', locator: documentLocator }), { code: 'RAG_CHUNKER_INPUT_INVALID' })
  assert.throws(() => chunkRagSource({ format: 'txt', body: 'x', locator: documentLocator, unknown: true }), { code: 'RAG_CHUNKER_INPUT_INVALID' })
  assert.throws(() => chunkRagSource({ format: 'txt', body: 'x'.repeat(200), locator: documentLocator }, { maxSourceBytes: 128 }), { code: 'RAG_CHUNKER_INPUT_TOO_LARGE' })
  assert.throws(() => chunkRagSource({ format: 'txt', body: 'x', locator: documentLocator }, { maxTokens: 512 }), { code: 'RAG_CHUNKER_OPTIONS_INVALID' })
  assert.throws(() => createRagChunker({ tokenizer: { encode: () => [] } }), { code: 'RAG_CHUNKER_TOKENIZER_INVALID' })
})

test('configuration identity is deterministic and binds model, revision, structure, and byte ceiling', () => {
  const deferred = createRagChunker()
  const deferredAgain = createRagChunker({ maxChunkBytes: RAG_CHUNKER_DEFAULTS.maxChunkBytes })
  const actual = createRagChunker({ tokenizer: whitespaceTokenizer })
  assert.equal(deferred.config.modelId, RAG_CHUNKER_MODEL_ID)
  assert.equal(deferred.config.modelRevision, RAG_CHUNKER_MODEL_REVISION)
  assert.equal(deferred.config.maxTokens, 768)
  assert.equal(deferred.config.overlapTokens, 96)
  assert.equal(deferred.config.configHash, deferredAgain.config.configHash)
  assert.notEqual(deferred.config.configHash, actual.config.configHash)
  assert.notEqual(
    deferred.config.configHash,
    createRagChunker({ maxChunkBytes: RAG_CHUNKER_DEFAULTS.maxChunkBytes - 128 }).config.configHash
  )
})
