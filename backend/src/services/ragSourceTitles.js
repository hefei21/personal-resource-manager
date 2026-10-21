import { isSafeRagText } from './ragOutputSafety.js'

const SOURCES = Object.freeze({
  document: ['documents', 'title'],
  ebook: ['books', 'title'],
  code_repository: ['code_repositories', 'name']
})
const accepted = value => value === true || value?.visible === true

// Chunk titles describe chapters/files. Never label them as source identity.
// Called only for the opt-in answer candidate, after retrieval and expansion.
export async function attachRagSourceTitles({ database, evidence, checks, context = {} }) {
  const output = []
  for (const item of evidence) {
    const phase = { ...context, phase: 'answer_source_title' }
    if (!accepted(await checks.authoritativeActiveSnapshot(item, phase)) ||
        !accepted(await checks.authoritativeVisibility(item, phase))) continue
    let title = null
    const spec = Object.hasOwn(SOURCES, item.sourceType) ? SOURCES[item.sourceType] : null
    if (spec && Number.isSafeInteger(item.sourceId) && item.sourceId > 0 && database?.prepare) {
      try {
        const row = database.prepare(`SELECT ${spec[1]} AS title FROM ${spec[0]} WHERE id = ?`).get(item.sourceId)
        if (typeof row?.title === 'string' && row.title.trim() &&
            Buffer.byteLength(row.title, 'utf8') <= 2048 && isSafeRagText(row.title)) title = row.title
      } catch {
        // Missing authoritative metadata must not turn a chapter into a book title.
      }
    }
    output.push({ ...item, title })
  }
  return output
}
