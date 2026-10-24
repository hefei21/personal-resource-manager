import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Offline preflight only. No downloads, model calls or modification of history.
// Known publisher aliases deliberately collapse versions: a new revision is not
// a new source for a holdout. Other publishers require human identity review.
export function sourceIdentity(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Public HTTP(S) source required')
  const host = url.hostname.toLowerCase()
  let match
  if (['www.rfc-editor.org', 'rfc-editor.org', 'www.ietf.org', 'ietf.org'].includes(host) &&
      (match = url.pathname.match(/^\/(?:rfc|info)\/rfc([1-9]\d*)(?:\.(?:txt|html|pdf|xml))?\/?$/i))) return `rfc:${match[1]}`
  if (host === 'datatracker.ietf.org' &&
      (match = url.pathname.match(/^\/doc\/(?:html\/)?rfc([1-9]\d*)\/?$/i))) return `rfc:${match[1]}`
  if (host === 'docs.python.org' && (match = url.pathname.match(/^\/(?:[^/]+\/)?library\/([^/]+)\.html$/))) return `python-library:${match[1]}`
  if (host === 'raw.githubusercontent.com' && (match = url.pathname.match(/^\/python\/cpython\/.+\/Doc\/library\/([^/]+)\.rst$/))) return `python-library:${match[1]}`
  if (host === 'git-scm.com' && (match = url.pathname.match(/^\/docs\/([^/]+)(?:\/[^/]+)?\/?$/))) return `git-manual:${match[1]}`
  url.hash = ''
  return url.href
}

function sources(value, key = '') {
  if (typeof value === 'string') {
    if (/^(?:source|sources|url|sourceUrl|source_url|sourceUri|source_uri)$/i.test(key) && /^https?:\/\//i.test(value) && !/\s/.test(value)) return [value]
    return []
  }
  if (Array.isArray(value)) return value.flatMap(item => sources(item, key))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => sources(v, k))
  return []
}

export async function checkSourceNovelty(root, candidates) {
  if (!candidates.length) throw new Error('At least one candidate URL required')
  const results = candidates.map(url => ({ url, identity: sourceIdentity(url), matches: [] }))
  let files = 0
  const errors = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { errors.push({ file: path.relative(root, file), error: 'symlink not scanned' }); continue }
      if (entry.isDirectory()) { await walk(file); continue }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      files++
      try {
        const data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
        for (const source of new Set(sources(data))) {
          const identity = sourceIdentity(source)
          for (const result of results) if (result.identity === identity) result.matches.push({ file: path.relative(root, file), source })
        }
      } catch { errors.push({ file: path.relative(root, file), error: 'invalid JSON or source URL' }) }
    }
  }
  await walk(path.resolve(root))
  return { files, errors, results, status: errors.length || !files ? 'incomplete' : results.some(r => r.matches.length) ? 'previously-seen' : 'no-recorded-match',
    limitation: 'No recorded match is not proof of novelty: unnamed sources, unrecognized aliases and non-JSON history require review.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, ...urls] = process.argv.slice(2)
    if (!root) throw new Error('Usage: node rag-source-novelty.mjs HISTORY_ROOT SOURCE_URL...')
    const report = await checkSourceNovelty(root, urls)
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'incomplete' ? 1 : report.status === 'previously-seen' ? 2 : 0
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
