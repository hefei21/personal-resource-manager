import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRagSourceFromQuery } from '../src/services/ragSourceResolver.js'

const coverageProvider = () => ({
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
    coverageProvider: () => ({ data: [
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
