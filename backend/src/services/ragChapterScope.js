import { createHash } from 'node:crypto'

// Only server-resolved IDs may enter retrieval. An empty restriction is never
// equivalent to unrestricted search, including during vector degradation.
export function normalizeRagChunkScope(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw Object.assign(new Error('Invalid chapter chunk scope.'), { code: 'RAG_QUERY_INPUT_INVALID' })
  }
  return Object.freeze([...new Set(value)])
}

function parse(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function readRagChapterScope({ database, sourceId, section }) {
  const book = database.prepare('SELECT file_type FROM books WHERE id = ?').get(sourceId)
  const epub = String(book?.file_type).toLowerCase() === 'epub'
  const rows = database.prepare(`
    SELECT c.id, c.snapshot_id, c.section_path_json, c.locator_json
    FROM rag_source_state s JOIN rag_source_snapshots p ON p.id = s.active_snapshot_id
    JOIN rag_chunks c ON c.snapshot_id = p.id
    WHERE s.source_type = 'ebook' AND s.source_id = ?
      AND p.source_type = s.source_type AND p.source_id = s.source_id
      AND p.status IN ('text_ready', 'embedding_pending', 'ready', 'partial')
    ORDER BY c.ordinal, c.id
  `).all(sourceId)
  const groups = new Map()
  for (const row of rows) {
    const path = parse(row.section_path_json, [])
    const locator = parse(row.locator_json, {})
    if (!Array.isArray(path) || !path.length || path.some((part) => typeof part !== 'string')) continue
    const index = epub && Number.isSafeInteger(locator?.chapterIndex) && locator.chapterIndex >= 0
      ? locator.chapterIndex : null
    // TXT has one reader chapter but multiple indexed heading paths. Never
    // advertise its chapterIndex=0 as a reliable "current chapter" mapping.
    const identity = index === null ? ['heading', path] : ['chapter', index]
    const key = createHash('sha256').update(JSON.stringify([sourceId, row.snapshot_id, identity])).digest('hex')
    if (!groups.has(key)) groups.set(key, {
      key, label: index === null ? path.join(' / ') : path[0], chapterIndex: index, chunkIds: []
    })
    groups.get(key).chunkIds.push(row.id)
  }
  if (section !== undefined) {
    const group = groups.get(section)
    if (!group) throw Object.assign(new Error('Chapter selection is stale.'), { code: 'RAG_SECTION_STALE' })
    return { chunkIds: normalizeRagChunkScope(group.chunkIds) }
  }
  return { sections: [...groups.values()].map(({ chunkIds, ...option }) => option) }
}
