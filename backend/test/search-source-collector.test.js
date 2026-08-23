import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createSearchSourceCollector } from '../src/services/searchSourceCollector.js'

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

function fixtureDatabase() {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE resource_domain_links (resource_id INTEGER, domain_type TEXT, domain_id INTEGER);
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, title TEXT, category TEXT, subcategory TEXT, tags TEXT,
      file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER,
      original_name TEXT, updated_at TEXT
    );
    CREATE TABLE book_categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY, title TEXT, author TEXT, publisher TEXT, year TEXT, description TEXT,
      category_id INTEGER, file_path TEXT, storage_key TEXT, content_sha256 TEXT, content_bytes INTEGER,
      original_name TEXT, content_cache TEXT, metadata_status TEXT, updated_at TEXT
    );
    CREATE TABLE book_chapters (id INTEGER PRIMARY KEY, book_id INTEGER, title TEXT, chapter_index INTEGER, created_at TEXT);
    CREATE TABLE blog_categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE blog_posts (id INTEGER PRIMARY KEY, title TEXT, content TEXT, status TEXT, category_id INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE blog_tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE blog_post_tags (post_id INTEGER, tag_id INTEGER);
    CREATE TABLE music (
      id INTEGER PRIMARY KEY, title TEXT, artist TEXT, album TEXT, category TEXT, tags TEXT,
      storage_key TEXT, metadata_status TEXT, updated_at TEXT
    );
    CREATE TABLE code_repositories (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, local_path TEXT, type TEXT,
      last_sync TEXT, created_at TEXT, updated_at TEXT, languages TEXT
    );

    INSERT INTO documents VALUES
      (1, '架构文档', '工程', '检索', '["NAS","搜索"]', '/private/docs/a.md', NULL, NULL, NULL, 'a.md', '2026-08-24T01:00:00.000Z');
    INSERT INTO book_categories VALUES (1, '技术');
    INSERT INTO books VALUES
      (2, '搜索手册', 'Owner', '本地', '2026', '搜索说明', 1, '/private/books/a.epub', NULL, NULL, NULL,
       'a.epub', '{"chapters":[{"title":"统一检索","content":"<p>章节正文与定位</p>"}]}', 'ready', '2026-08-24T01:00:00.000Z');
    INSERT INTO blog_categories VALUES (1, '工作笔记');
    INSERT INTO blog_posts VALUES
      (3, '阶段记录', '# 进展\nFTS5 已启用', 'complete', 1, '2026-08-24T01:00:00.000Z', '2026-08-24T01:00:00.000Z');
    INSERT INTO blog_tags VALUES (1, 'FTS5');
    INSERT INTO blog_post_tags VALUES (3, 1);
    INSERT INTO music VALUES
      (4, '本地音频', '作者', '专辑', '录音', '["现场"]', NULL, 'ready', '2026-08-24T01:00:00.000Z');
    INSERT INTO code_repositories VALUES
      (5, 'pr-manager', '统一搜索实现', '', 'git_nas', NULL, '2026-08-24T01:00:00.000Z', '2026-08-24T01:00:00.000Z', '{"JavaScript":10}');
    INSERT INTO resource_domain_links VALUES
      (11, 'document', 1), (12, 'ebook', 2), (14, 'music', 4), (15, 'code_repository', 5);
  `)
  return database
}

test('collects all Stage 6A source types with public locators and safe code exclusions', nativeTestOptions, async () => {
  const database = fixtureDatabase()
  const documentBody = Buffer.from('架构文档正文：NAS 本机检索。')
  const collector = createSearchSourceCollector({
    documentRuntimeProvider: () => ({
      contentService: {
        stat: async () => ({ bytes: documentBody.length }),
        createReadStream: async () => ({ stream: Readable.from([documentBody]) })
      }
    }),
    resourceRuntimeProvider: () => ({
      contentServiceFor: () => ({
        stat: async () => ({ bytes: 0 }),
        createReadStream: async () => ({ stream: Readable.from([]) })
      })
    }),
    listGitNasTreeFn: (_database, _repositoryId, relativePath) => relativePath === ''
      ? [
          { name: 'src', type: 'directory', path: 'src' },
          { name: '.env', type: 'file', path: '.env', size: 20 }
        ]
      : [{ name: 'search.js', type: 'file', path: 'src/search.js', size: 64 }],
    readGitNasFileFn: (_database, _repositoryId, relativePath) => ({
      buffer: Buffer.from(relativePath === '.env' ? 'SECRET=should-not-read' : 'export function unifiedSearch() { return "FTS5" }')
    })
  })
  try {
    const report = await collector({ database, includeCodeFiles: true })
    const keys = report.entries.map((entry) => entry.entryKey)
    assert.deepEqual(keys, [
      'document:1',
      'ebook:2',
      'ebook-chapter:2:0',
      'note:3',
      'audio:4',
      'code-repository:5',
      'code-file:5:src/search.js'
    ])
    assert.equal(report.errors.length, 0)
    assert.equal(report.entries.find((entry) => entry.entryKey === 'document:1').body, '架构文档正文：NAS 本机检索。')
    assert.deepEqual(report.entries.find((entry) => entry.entryKey === 'ebook-chapter:2:0').locator, {
      route: '/books', bookId: 2, chapterIndex: 0
    })
    assert.match(report.entries.find((entry) => entry.entryKey === 'code-file:5:src/search.js').body, /unifiedSearch/u)
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes('/private/'), false)
    assert.equal(serialized.includes('should-not-read'), false)
  } finally {
    database.close()
  }
})
