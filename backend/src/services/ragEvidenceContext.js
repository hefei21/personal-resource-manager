const MAX_CONTEXT_BYTES = 24 * 1024
const MAX_CONTEXT_ITEMS = 16

const accepted = value => value === true || value?.visible === true
const sameSection = (a, b) => JSON.stringify(a?.sectionPath ?? []) === JSON.stringify(b?.sectionPath ?? []) &&
  a?.chapterIndex === b?.chapterIndex && a?.path === b?.path && a?.page === b?.page

// Keep each neighbor as an independently authorized, locatable citation rather
// than appending untracked text to a seed's chunk ID. Original seeds have budget
// priority; expansion never crosses a snapshot, chapter, file or page boundary.
export async function expandRagEvidenceContext({ database, evidence, checks, context = {} }) {
  if (!Array.isArray(evidence) || !evidence.length) return []
  const output = [], seen = new Set()
  let bytes = 0
  const add = async candidate => {
    const key = `${candidate.snapshotId}:${candidate.chunkId}`
    if (seen.has(key) || output.length >= MAX_CONTEXT_ITEMS || typeof candidate.body !== 'string') return
    const length = Buffer.byteLength(candidate.body, 'utf8')
    if (!length || length + bytes > MAX_CONTEXT_BYTES) return
    const phase = { ...context, phase: 'route_context_expand' }
    if (!accepted(await checks.authoritativeActiveSnapshot(candidate, phase)) ||
        !accepted(await checks.authoritativeVisibility(candidate, phase))) return
    seen.add(key); bytes += length; output.push(candidate)
  }
  for (const seed of evidence) await add(seed)
  if (!database?.prepare || !output.length) return output
  const read = database.prepare(`
    SELECT c.id, c.ordinal, c.body, c.title, c.locator_json
      FROM rag_chunks c JOIN rag_source_snapshots s ON s.id = c.snapshot_id
      JOIN rag_source_state state ON state.source_type = s.source_type
        AND state.source_id = s.source_id AND state.active_snapshot_id = s.id
     WHERE c.snapshot_id = ? AND s.source_type = ? AND s.source_id = ?
       AND s.source_version_id = ? AND s.status IN ('text_ready','embedding_pending','ready','partial')
       AND c.ordinal BETWEEN ? AND ? ORDER BY ABS(c.ordinal - ?), c.ordinal`)
  for (const seed of [...output]) {
    if (!Number.isSafeInteger(seed.ordinal)) continue
    const neighbors = read.all(seed.snapshotId, seed.sourceType, seed.sourceId, seed.sourceVersionId,
      Math.max(0, seed.ordinal - 1), seed.ordinal + 1, seed.ordinal)
    for (const row of neighbors) {
      if (row.id === seed.chunkId) continue
      let locator
      try { locator = JSON.parse(row.locator_json) } catch { continue }
      if (!sameSection(seed.locator, locator)) continue
      await add({ ...seed, chunkId: row.id, ordinal: row.ordinal, body: row.body, title: row.title, locator,
        citationId: `rag-context:${seed.snapshotId}:${row.id}`,
        retrieval: { ...seed.retrieval, contextFor: seed.chunkId } })
    }
  }
  return output
}
