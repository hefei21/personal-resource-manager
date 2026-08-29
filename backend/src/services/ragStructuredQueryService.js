const CHAPTER_COUNT_PATTERNS = Object.freeze([
  /(?:多少|几)(?:个)?(?:正文)?(?:章|章节)/u,
  /(?:章|章节)(?:节)?(?:数|数量|总数)/u,
  /how\s+many\s+chapters|chapter\s+count|number\s+of\s+chapters/iu
])

function hasTable(database, tableName) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(tableName))
}

function safeTitle(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  return normalized ? normalized.slice(0, 256) : fallback
}

function cachedChapterCount(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 64 * 1024 * 1024) return null
  try {
    const cache = JSON.parse(value)
    const chapters = Array.isArray(cache?.chapters) ? cache.chapters : null
    if (!chapters || chapters.length < 1 || chapters.length > 100_000) return null
    return chapters.length
  } catch {
    return null
  }
}

function tableChapterCount(database, sourceId) {
  if (!hasTable(database, 'book_chapters')) return null
  const count = Number(database.prepare(`
    SELECT COUNT(DISTINCT chapter_index) AS count
      FROM book_chapters
     WHERE book_id = ?
  `).get(sourceId)?.count)
  return Number.isSafeInteger(count) && count > 0 ? count : null
}

function indexedChapterCount(database, sourceId) {
  if (!hasTable(database, 'rag_source_state') || !hasTable(database, 'rag_source_snapshots') ||
      !hasTable(database, 'rag_chunks')) return null
  const count = Number(database.prepare(`
    SELECT COUNT(DISTINCT json_extract(chunk.locator_json, '$.chapterIndex')) AS count
      FROM rag_chunks chunk
      JOIN rag_source_snapshots snapshot ON snapshot.id = chunk.snapshot_id
      JOIN rag_source_state state
        ON state.source_type = snapshot.source_type
       AND state.source_id = snapshot.source_id
       AND state.active_snapshot_id = snapshot.id
     WHERE snapshot.source_type = 'ebook'
       AND snapshot.source_id = ?
       AND json_type(chunk.locator_json, '$.chapterIndex') = 'integer'
  `).get(sourceId)?.count)
  return Number.isSafeInteger(count) && count > 0 ? count : null
}

function chapterCountAnswer(database, sourceId, query) {
  if (!hasTable(database, 'books')) return null
  const row = database.prepare(
    'SELECT title, content_cache FROM books WHERE id = ? LIMIT 1'
  ).get(sourceId)
  if (!row) return null
  const count = cachedChapterCount(row.content_cache) ??
    tableChapterCount(database, sourceId) ??
    indexedChapterCount(database, sourceId)
  if (count === null) return null
  const title = safeTitle(row.title, '所选电子书')
  const isChinese = /[\u3400-\u9fff]/u.test(query)
  return Object.freeze({
    status: 'complete',
    query,
    language: isChinese ? 'zh' : 'en',
    answer: isChinese
      ? `《${title}》当前可读取的正文共 ${count} 章。`
      : `The readable main text of “${title}” currently contains ${count} chapters.`,
    abstained: false,
    reasonCode: 'structured_fact',
    degraded: false,
    citations: Object.freeze([Object.freeze({
      citationId: 'C1',
      title,
      openUrl: `/books?bookId=${sourceId}`
    })]),
    structured: Object.freeze({ fact: 'ebook.chapter_count', value: count })
  })
}

export function readRagStructuredAnswer({ database, query, source } = {}) {
  if (!database?.prepare || typeof query !== 'string' || source?.sourceType !== 'ebook' ||
      !Number.isSafeInteger(source?.sourceId) || source.sourceId <= 0) return null
  if (!CHAPTER_COUNT_PATTERNS.some((pattern) => pattern.test(query))) return null
  return chapterCountAnswer(database, source.sourceId, query)
}

export default readRagStructuredAnswer
