import assert from 'node:assert/strict'
import test from 'node:test'

import { readRagStructuredAnswer } from '../src/services/ragStructuredQueryService.js'

function databaseWithBook() {
  const tables = new Set(['books', 'book_chapters'])
  return {
    prepare(sql) {
      return {
        get(value) {
          if (sql.includes('sqlite_master')) return tables.has(value) ? { present: 1 } : undefined
          if (sql.includes('SELECT title, content_cache')) {
            return {
              title: '无职转生 ～到了异世界就拿出真本事',
              content_cache: JSON.stringify({ chapters: [{}, {}, {}] })
            }
          }
          if (sql.includes('COUNT(DISTINCT chapter_index)')) return { count: 0 }
          return undefined
        }
      }
    }
  }
}

test('chapter-count intent reads the exact selected ebook structured cache', () => {
  const answer = readRagStructuredAnswer({
    database: databaseWithBook(),
    query: '正文一共多少章',
    source: { sourceType: 'ebook', sourceId: 23 }
  })
  assert.equal(answer.structured.fact, 'ebook.chapter_count')
  assert.equal(answer.structured.value, 3)
  assert.match(answer.answer, /共 3 章/u)
  assert.equal(answer.citations[0].openUrl, '/books?bookId=23')
})

test('structured facts require both a supported intent and an exact ebook scope', () => {
  const database = databaseWithBook()
  assert.equal(readRagStructuredAnswer({
    database,
    query: '这本书讲了什么',
    source: { sourceType: 'ebook', sourceId: 23 }
  }), null)
  assert.equal(readRagStructuredAnswer({
    database,
    query: '有多少章',
    source: { sourceType: 'document', sourceId: 23 }
  }), null)
})
