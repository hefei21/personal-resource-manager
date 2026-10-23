import crypto from 'node:crypto'
import { DECLARATION_VERSION, declaredApiName } from './ragApiDeclarations.js'
import { expandRagEvidenceContext } from './ragEvidenceContext.js'

const digest = text => crypto.createHash('sha256').update(text).digest('hex')

// Optional, explicit-bound completion. Metadata stays in SQLite, never in the
// evidence or prompt. Legacy indices without original-source bounds fail closed.
export async function completeRagDeclarationContext({ database, evidence, query, source, checks, context = {} }) {
  const name = declaredApiName(query)
  if (!name || !source?.sourceType || !source?.sourceId || !evidence?.length || !database?.prepare) return evidence
  if (evidence.some(e => e.sourceType !== source.sourceType || e.sourceId !== source.sourceId)) return evidence
  const read = database.prepare(`SELECT c.api_declarations_json AS metadata, c.body,
    c.chunk_sha256 AS chunkHash, c.locator_json AS locator, c.ordinal,
    s.source_content_sha256 AS sourceHash, s.chunker_version AS chunkerVersion,
    s.chunker_config_hash AS chunkerConfigHash
    FROM rag_chunks c JOIN rag_source_snapshots s ON s.id=c.snapshot_id
    JOIN rag_source_state state ON state.source_type=s.source_type AND state.source_id=s.source_id
      AND state.active_snapshot_id=s.id
    WHERE c.id=? AND c.snapshot_id=? AND s.source_type=? AND s.source_id=?
      AND s.source_version_id=? AND s.status IN ('text_ready','embedding_pending','ready','partial')`)
  const matches = []
  for (const seed of evidence) {
    const row = read.get(seed.chunkId, seed.snapshotId, source.sourceType, source.sourceId, seed.sourceVersionId)
    if (!row?.metadata || row.body !== seed.body || digest(row.body) !== row.chunkHash || row.ordinal !== seed.ordinal) continue
    try {
      const m = JSON.parse(row.metadata)
      if (m.version !== DECLARATION_VERSION || m.boundsVersion !== 1 || m.snapshotId !== seed.snapshotId ||
          m.sourceHash !== row.sourceHash || row.sourceHash !== seed.sourceContentSha256 || m.chunkHash !== row.chunkHash ||
          m.chunkerVersion !== row.chunkerVersion || m.chunkerConfigHash !== row.chunkerConfigHash ||
          JSON.stringify(JSON.parse(row.locator)) !== JSON.stringify(seed.locator) || !Array.isArray(m.declarations)) continue
      for (const d of m.declarations) {
        if (d.name === name && typeof d.module === 'string' && d.module &&
            Number.isSafeInteger(d.line) && Number.isSafeInteger(d.endLine) && d.endLine >= d.line &&
            d.line >= seed.locator.startLine && d.line <= seed.locator.endLine) matches.push({ seed, endLine: d.endLine })
      }
    } catch { /* Corrupt/legacy provenance must not widen evidence. */ }
  }
  if (matches.length !== 1) return evidence
  const output = [...evidence], seen = new Set(evidence.map(e => `${e.snapshotId}:${e.chunkId}`))
  let bytes = evidence.reduce((n, e) => n + Buffer.byteLength(e.body), 0)
  let { seed: frontier, endLine } = matches[0]
  // Walk bounded authorized neighbors; a denied/missing intermediate block is
  // a hard stop, not permission to skip ahead. Keep original evidence priority.
  for (let depth = 0; depth < 16 && frontier.locator.endLine < endLine; depth++) {
    if (output.length >= 16 || bytes >= 24576) break
    context.signal?.throwIfAborted()
    const neighbors = await expandRagEvidenceContext({ database, evidence: [frontier], checks, context })
    const next = neighbors.find(e => e.ordinal === frontier.ordinal + 1 && e.locator.startLine <= endLine)
    if (!next) break
    const key = `${next.snapshotId}:${next.chunkId}`
    if (!seen.has(key)) {
      const length = Buffer.byteLength(next.body)
      if (bytes + length > 24576) break
      output.push(next); seen.add(key); bytes += length
    }
    frontier = next
  }
  return output
}
