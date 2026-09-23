import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRagSourceFromQuery } from '../src/services/ragSourceResolver.js'
import { readRagCoverage } from '../src/services/ragCoverageService.js'

const coverageProvider = () => ({
  complete: true, total: 2, offset: 0,
  data: [
    { source: { type: 'ebook', id: 23, title: '无职转生 ～到了异世界就拿出真本事' } },
    { source: { type: 'document', id: 7, title: '北辰灯塔夜间值守手册' } }
  ]
})

test('a distinctive title segment infers one exact resource scope', async () => {
  const result = await resolveRagSourceFromQuery({
    query: '无职转生正文一共多少章',
    coverageProvider
  })
  assert.deepEqual(result, {
    source: { sourceType: 'ebook', sourceId: 23 },
    inferred: true
  })
})

test('generic questions and ambiguous title matches do not silently choose a resource', async () => {
  assert.deepEqual(await resolveRagSourceFromQuery({
    query: '如何恢复索引',
    coverageProvider
  }), { source: null })
  const ambiguous = await resolveRagSourceFromQuery({
    query: '无职转生有多少章',
    coverageProvider: () => ({ complete: true, total: 2, offset: 0, data: [
      { source: { type: 'ebook', id: 23, title: '无职转生～第一卷' } },
      { source: { type: 'ebook', id: 24, title: '无职转生～第二卷' } }
    ] })
  })
  assert.deepEqual(ambiguous, { source: null, ambiguous: true })
  assert.deepEqual(await resolveRagSourceFromQuery({
    query: '比较无职转生和北辰灯塔夜间值守手册',
    coverageProvider
  }), { source: null, ambiguous: true })
})

function catalogDatabase(books, documents = []) {
  const rows = { books, documents }
  return { prepare(sql) {
    return {
      get: table => sql.includes('sqlite_master') && Object.hasOwn(rows, table) ? { present: 1 } : undefined,
      all: () => rows[Object.keys(rows).find(table => sql.includes(`FROM ${table}`))] ?? []
    }
  } }
}

test('resolution sees books after 200 documents and detects a late duplicate in one scan', async () => {
  const documents = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: `其他资料${i}` }))
  const books = [{ id: 1, title: '跨页目录测试书籍' }]
  let statuses = 0
  const resolve = () => resolveRagSourceFromQuery({
    database: catalogDatabase(books, documents), query: '跨页目录测试书籍讲什么？',
    coverageProvider: readRagCoverage,
    sourceStatusProvider: () => { statuses++; return { sourceState: { status: 'ready' }, chunks: { count: 1 } } }
  })
  assert.deepEqual(await resolve(), { source: { sourceType: 'ebook', sourceId: 1 }, inferred: true })
  assert.equal(statuses, 201)
  documents[0].title = books[0].title
  statuses = 0
  assert.deepEqual(await resolve(), { source: null, ambiguous: true })
  assert.equal(statuses, 201)
})

test('partial, malformed or failed catalogs never establish uniqueness', async () => {
  const data = [{ source: { type: 'ebook', id: 1, title: '跨页目录测试书籍' } }]
  for (const coverage of [
    { data }, { data, total: 201, offset: 0, complete: true },
    { data, total: 1, offset: 200, complete: true },
    { data, total: 1, offset: 0, complete: false },
    { data: [...data, {}], total: 2, offset: 0, complete: true }
  ]) assert.deepEqual(await resolveRagSourceFromQuery({
    query: '跨页目录测试书籍讲什么？', coverageProvider: () => coverage
  }), { source: null })
  assert.deepEqual(await resolveRagSourceFromQuery({
    query: '跨页目录测试书籍讲什么？',
    database: catalogDatabase([{ id: 1, title: '跨页目录测试书籍' }, { id: 2, title: '跨页目录测试书籍' }]),
    coverageProvider: readRagCoverage,
    sourceStatusProvider: ({ sourceId }) => {
      if (sourceId === 2) throw new Error('status unavailable')
      return { sourceState: { status: 'ready' }, chunks: { count: 1 } }
    }
  }), { source: null })
})

test('invisible duplicates are excluded and request/checks pass through unchanged', async () => {
  const req = {}, checks = {}
  assert.deepEqual(await resolveRagSourceFromQuery({
    req, checks, query: '跨页目录测试书籍讲什么？',
    database: catalogDatabase([{ id: 1, title: '跨页目录测试书籍' }, { id: 2, title: '跨页目录测试书籍' }]),
    coverageProvider: readRagCoverage,
    sourceStatusProvider: input => {
      assert.equal(input.req, req); assert.equal(input.checks, checks)
      return input.sourceId === 2 ? null : { sourceState: { status: 'ready' }, chunks: { count: 1 } }
    }
  }), { source: { sourceType: 'ebook', sourceId: 1 }, inferred: true })
})

test('SQLite catalog resolves a late book and refuses a duplicate across resource types', async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec('CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT)')
    const insert = database.prepare('INSERT INTO documents (title) VALUES (?)')
    database.transaction(() => {
      for (let i = 0; i < 205; i++) insert.run(`其他合成资料${i}`)
    })()
    database.prepare('INSERT INTO books (id, title) VALUES (?, ?)').run(1, '跨页目录测试书籍')
    const resolve = () => resolveRagSourceFromQuery({
      database, query: '跨页目录测试书籍讲什么？', coverageProvider: readRagCoverage,
      sourceStatusProvider: () => ({ sourceState: { status: 'missing' }, chunks: { count: 0 } })
    })
    assert.deepEqual(await resolve(), { source: { sourceType: 'ebook', sourceId: 1 }, inferred: true })
    insert.run('跨页目录测试书籍')
    assert.deepEqual(await resolve(), { source: null, ambiguous: true })
  } finally { database.close() }
})
