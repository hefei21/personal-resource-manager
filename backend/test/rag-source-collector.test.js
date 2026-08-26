import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import test from 'node:test'

import { CREATE_RESOURCE_DOMAIN_LINKS_SQL, CREATE_RESOURCES_SQL } from '../src/config/resourceModelSchema.js'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { createRagSourceCollector } from '../src/services/ragSourceCollector.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/Could not locate the bindings file/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fixtureDatabase({ documentBody, ebookBody, ebookCache } = {}) {
  const documentBuffer = Buffer.from(documentBody ?? '文档正文：权限感知来源。')
  const ebookBuffer = Buffer.from(ebookBody ?? 'epub placeholder')
  const cacheText = ebookCache ?? JSON.stringify({
    sourceContentSha256: sha256(ebookBuffer),
    chapters: [{ chapterId: 21, index: 0, title: '第一章', content: '<p>章节正文。</p>' }]
  })
  const database = new Database(':memory:')
  database.exec(`
    ${CREATE_RESOURCE_TRASH_SQL};
    ${CREATE_RESOURCES_SQL};
    ${CREATE_RESOURCE_DOMAIN_LINKS_SQL};
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, file_path TEXT, storage_key TEXT,
      content_sha256 TEXT, content_bytes INTEGER, original_name TEXT, version REAL,
      updated_at TEXT
    );
    CREATE TABLE document_versions (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL, version INTEGER NOT NULL,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER,
      note TEXT, created_at TEXT
    );
    CREATE TABLE books (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT, file_path TEXT,
      storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER, original_name TEXT,
      file_type TEXT, content_cache TEXT, updated_at TEXT
    );
    CREATE TABLE book_chapters (
      id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, title TEXT, chapter_index INTEGER
    );
    CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, local_path TEXT, type TEXT,
      description TEXT, updated_at TEXT
    );
    INSERT INTO resources (id, resource_type, title, lifecycle_status) VALUES
      (101, 'document', '文档资源', 'active'),
      (102, 'ebook', '电子书资源', 'active'),
      (103, 'code_repository', '仓库资源', 'active');
    INSERT INTO documents
      (id, title, file_path, content_sha256, content_bytes, original_name, version)
    VALUES (1, '权限文档', 'legacy/a.md', '${sha256(documentBuffer)}', ${documentBuffer.length}, 'a.md', 2);
    INSERT INTO document_versions
      (id, document_id, version, file_path, content_sha256, content_bytes)
    VALUES (11, 1, 2, 'legacy/a.md', '${sha256(documentBuffer)}', ${documentBuffer.length});
    INSERT INTO books
      (id, title, file_path, content_sha256, content_bytes, original_name, file_type, content_cache)
    VALUES (2, '权限电子书', 'legacy/book.epub', '${sha256(ebookBuffer)}', ${ebookBuffer.length},
      'book.epub', 'epub', '${cacheText.replaceAll("'", "''")}');
    INSERT INTO book_chapters (id, book_id, title, chapter_index) VALUES (21, 2, '第一章', 0);
    INSERT INTO code_repositories (id, name, local_path, type) VALUES (3, '说明仓库', '', 'git_nas');
    INSERT INTO resource_domain_links (resource_id, domain_type, domain_id) VALUES
      (101, 'document', 1), (102, 'ebook', 2), (103, 'code_repository', 3);
  `)
  return { database, documentBuffer, ebookBuffer }
}

function collectorFor({ database, documentBuffer, ebookBuffer, inspect, read, onProgress, binaryExtractor } = {}) {
  return createRagSourceCollector({
    documentRuntimeProvider: () => ({
      contentService: {
        stat: async () => ({ bytes: documentBuffer.length }),
        createReadStream: async () => ({ stream: Readable.from([documentBuffer]) })
      }
    }),
    resourceRuntimeProvider: () => ({
      contentServiceFor: () => ({
        stat: async () => ({ bytes: ebookBuffer.length }),
        createReadStream: async () => ({ stream: Readable.from([ebookBuffer]) })
      })
    }),
    inspectGitNasSnapshotFn: inspect ?? (async () => ({
      sourceKind: 'git_nas', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      files: ['README.md', 'guide.rst', 'src/index.js', '.env', 'LICENSE', 'NOTICE.txt']
    })),
    readGitNasFileFn: read ?? ((_database, _id, relativePath) => ({
      relativePath,
      buffer: Buffer.from(relativePath === 'README.md'
        ? '# 说明\n允许内容'
        : relativePath === 'guide.rst'
          ? '操作说明'
          : relativePath === 'NOTICE.txt'
            ? 'Notice'
            : 'ignored')
    })),
    ...(binaryExtractor ? { binaryExtractor } : {}),
    ...(onProgress ? { onProgress } : {})
  })
}

test('collects permission-aware document, ebook and repository sources with stable locators', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase()
  const progress = []
  try {
    const collector = collectorFor({ database, documentBuffer, ebookBuffer })
    const report = await collector({ database, onProgress: async (value) => progress.push(value) })
    assert.equal(report.errors.length, 0)
    assert.deepEqual(report.sources.map((source) => `${source.sourceType}:${source.sourceId}`), [
      'document:1', 'ebook:2', 'code_repository:3'
    ])
    const document = report.sources.find((source) => source.sourceType === 'document')
    assert.equal(document.sourceVersionId, '11')
    assert.equal(document.sourceContentSha256, sha256(documentBuffer))
    assert.equal(document.sections[0].text, '文档正文：权限感知来源。')
    assert.deepEqual(document.baseLocator, { route: '/documents', documentId: 1, versionId: 11 })
    const ebook = report.sources.find((source) => source.sourceType === 'ebook')
    assert.equal(ebook.sections[0].chapterId, 21)
    assert.equal(ebook.sections[0].index, 0)
    assert.equal(ebook.sections[0].text, '章节正文。')
    const repository = report.sources.find((source) => source.sourceType === 'code_repository')
    assert.deepEqual(repository.sections.map((section) => section.path).sort(), ['NOTICE.txt', 'README.md', 'guide.rst'])
    assert.ok(repository.sections.every((section) => section.commit === repository.sourceVersionId))
    assert.equal(JSON.stringify(report).includes('src/index.js'), false)
    assert.equal(JSON.stringify(report).includes('.env'), false)
    assert.deepEqual(progress, [0, 33, 67, 100])
    assert.equal(Object.isFrozen(report.sources), true)
  } finally {
    database.close()
  }
})

test('filters inactive, trashed and trashed-current-version sources before content access', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase()
  let documentReads = 0
  let ebookReads = 0
  try {
    database.exec(`
      UPDATE resources SET lifecycle_status = 'trashed' WHERE id = 102;
      INSERT INTO resource_trash_entries (resource_type, resource_id, deleted_at)
      VALUES ('document_version', 11, CURRENT_TIMESTAMP), ('code_repository', 3, CURRENT_TIMESTAMP);
    `)
    const collector = createRagSourceCollector({
      documentRuntimeProvider: () => ({
        contentService: {
          stat: async () => { documentReads += 1; return { bytes: documentBuffer.length } },
          createReadStream: async () => ({ stream: Readable.from([documentBuffer]) })
        }
      }),
      resourceRuntimeProvider: () => ({
        contentServiceFor: () => ({
          stat: async () => { ebookReads += 1; return { bytes: ebookBuffer.length } },
          createReadStream: async () => ({ stream: Readable.from([ebookBuffer]) })
        })
      })
    })
    const report = await collector({ database })
    assert.equal(report.sources.length, 0)
    assert.equal(documentReads, 0)
    assert.equal(ebookReads, 0)
    assert.equal(report.errors.length, 0)
  } finally {
    database.close()
  }
})

test('falls back to the PC extraction artifact when an EPUB cache is not bound', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase({
    ebookCache: JSON.stringify({ chapters: [{ index: 0, content: '旧缓存' }] })
  })
  try {
    const collector = collectorFor({
      database,
      documentBuffer,
      ebookBuffer,
      binaryExtractor: async (input) => ({
        extractorVersion: 'pc-worker-structured-text.v1',
        sections: [{ ordinal: 0, title: 'Spine 1', text: '新提取正文', locator: { spineIndex: 0 } }]
      })
    })
    const report = await collector({ database })
    const ebook = report.sources.find((source) => source.sourceType === 'ebook')
    assert.equal(ebook.status, 'ready')
    assert.equal(ebook.extractorVersion, 'pc-worker-structured-text.v1')
    assert.equal(ebook.sections[0].text, '新提取正文')
    assert.deepEqual(ebook.sections[0].locator, { route: '/books', bookId: 2, spineIndex: 0 })
    assert.equal(report.errors.length, 0)
  } finally {
    database.close()
  }
})

test('applies an exact selector before content access and maps PDF artifact locators', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase()
  let documentReads = 0
  let ebookReads = 0
  let repositoryInspections = 0
  const extractionInputs = []
  try {
    database.exec("UPDATE documents SET original_name = 'report.pdf' WHERE id = 1")
    const collector = createRagSourceCollector({
      documentRuntimeProvider: () => ({
        contentService: {
          stat: async () => { documentReads += 1; return { bytes: documentBuffer.length } },
          createReadStream: async () => ({ stream: Readable.from([documentBuffer]) })
        }
      }),
      resourceRuntimeProvider: () => ({
        contentServiceFor: () => ({
          stat: async () => { ebookReads += 1; return { bytes: ebookBuffer.length } },
          createReadStream: async () => ({ stream: Readable.from([ebookBuffer]) })
        })
      }),
      inspectGitNasSnapshotFn: async () => { repositoryInspections += 1; throw new Error('excluded') },
      binaryExtractor: async (input) => {
        extractionInputs.push(input)
        return {
          extractorVersion: 'pc-worker-structured-text.v1',
          sections: [{ ordinal: 0, title: 'Page 2', text: '精确选择正文', locator: { page: 2 } }]
        }
      }
    })
    const report = await collector({
      database,
      source: { type: 'document', id: 1 },
      filter: { sourceIds: [1] }
    })
    assert.equal(documentReads, 1)
    assert.equal(ebookReads, 0)
    assert.equal(repositoryInspections, 0)
    assert.equal(extractionInputs.length, 1)
    assert.equal(extractionInputs[0].format, 'pdf')
    assert.equal(extractionInputs[0].sourceContentSha256, sha256(documentBuffer))
    assert.deepEqual(report.sources.map((source) => `${source.sourceType}:${source.sourceId}`), ['document:1'])
    assert.deepEqual(report.sources[0].sections[0].locator, {
      route: '/documents', documentId: 1, versionId: 11, page: 2
    })
  } finally {
    database.close()
  }
})

test('rejects a repository whose full commit/files snapshot changes while reading', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase()
  let inspection = 0
  try {
    const inspect = async () => {
      inspection += 1
      return {
        sourceKind: 'git_nas',
        commit: inspection === 1
          ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          : 'cccccccccccccccccccccccccccccccccccccccc',
        files: ['README.md']
      }
    }
    const collector = collectorFor({ database, documentBuffer, ebookBuffer, inspect })
    const report = await collector({ database })
    const repository = report.sources.find((source) => source.sourceType === 'code_repository')
    assert.equal(repository.status, 'partial')
    assert.equal(repository.sections.length, 0)
    assert.equal(repository.errors.some((error) => error.code === 'RAG_SOURCE_REPOSITORY_STALE'), true)
  } finally {
    database.close()
  }
})

test('cancellation is a stable error and never returns a partial success', nativeTestOptions, async () => {
  const { database, documentBuffer, ebookBuffer } = fixtureDatabase()
  const controller = new AbortController()
  controller.abort()
  try {
    const collector = collectorFor({ database, documentBuffer, ebookBuffer })
    await assert.rejects(
      collector({ database, signal: controller.signal }),
      (error) => error?.code === 'RAG_SOURCE_CANCELLED'
    )
  } finally {
    database.close()
  }
})
