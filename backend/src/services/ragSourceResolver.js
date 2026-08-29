function compactText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]/gu, '')
    : ''
}

function significantAlias(value) {
  const compact = compactText(value)
  if (!compact) return null
  const hasCjk = /[\u3400-\u9fff]/u.test(compact)
  const length = [...compact].length
  return length >= (hasCjk ? 4 : 6) ? compact : null
}

function titleAliases(title) {
  if (typeof title !== 'string') return []
  const aliases = new Set()
  const full = significantAlias(title)
  if (full) aliases.add(full)
  for (const segment of title.split(/[～~—–|:：/\\()[\]{}【】《》]/u)) {
    const alias = significantAlias(segment)
    if (alias) aliases.add(alias)
  }
  return [...aliases].sort((left, right) => [...right].length - [...left].length)
}

export async function resolveRagSourceFromQuery({
  database,
  query,
  req,
  checks,
  coverageProvider,
  sourceStatusProvider
} = {}) {
  if (typeof query !== 'string' || typeof coverageProvider !== 'function') return Object.freeze({ source: null })
  const compactQuery = compactText(query)
  if (!compactQuery) return Object.freeze({ source: null })
  let coverage
  try {
    coverage = await Promise.resolve(coverageProvider({
      database,
      req,
      checks,
      sourceStatusProvider,
      type: null,
      limit: 200,
      offset: 0
    }))
  } catch {
    return Object.freeze({ source: null })
  }
  if (!Array.isArray(coverage?.data)) return Object.freeze({ source: null })
  const matches = []
  for (const item of coverage.data) {
    const type = item?.source?.type
    const id = Number(item?.source?.id)
    if (!['document', 'ebook', 'code_repository'].includes(type) || !Number.isSafeInteger(id) || id <= 0) continue
    const alias = titleAliases(item.source.title).find((candidate) => compactQuery.includes(candidate))
    if (!alias) continue
    matches.push({ sourceType: type, sourceId: id })
  }
  if (matches.length === 0) return Object.freeze({ source: null })
  if (matches.length !== 1) return Object.freeze({ source: null, ambiguous: true })
  return Object.freeze({
    source: Object.freeze({ sourceType: matches[0].sourceType, sourceId: matches[0].sourceId }),
    inferred: true
  })
}

export default resolveRagSourceFromQuery
