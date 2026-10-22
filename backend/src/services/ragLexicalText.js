// A search-only projection. Never use these extra tokens as model evidence or
// citation text; rag_chunks.body remains the unchanged, locatable source text.
const HAN = /\p{Script=Han}+/gu
const WORDS = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_-])+/gu

function grams(text, includeSingles) {
  const characters = [...text]
  const output = includeSingles || characters.length === 1 ? [...characters] : []
  for (let i = 0; i + 1 < characters.length; i += 1) output.push(characters[i] + characters[i + 1])
  return output
}

export function buildRagSearchText(body) {
  const normalized = body.normalize('NFKC')
  const tokens = [...normalized.matchAll(HAN)].flatMap(([text]) => grams(text, true))
  return tokens.length ? `${normalized}\n${tokens.join(' ')}` : normalized
}

export function ragQueryTerms(query) {
  // Keep compound Chinese terms ahead of isolated characters, and split mixed
  // text such as Redis的TLS支持. Common single characters must not consume the
  // query budget or dominate relaxed BM25 recall.
  return [...new Set((query.normalize('NFKC').match(WORDS) ?? []).flatMap(text =>
    /^\p{Script=Han}+$/u.test(text) ? grams(text, false) : [text]))].slice(0, 64)
}

// A narrow lexical retry, not a translation or generated query. Only a sole
// technical identifier in a mixed Chinese question may anchor this fallback.
export function boundRagIdentifier(query) {
  if (typeof query !== 'string' || !/\p{Script=Han}/u.test(query)) return null
  // Inspect the whole question, not the capped FTS token budget: a second
  // object late in a long question must still disable the retry.
  const terms = [...new Set(query.match(WORDS) ?? [])].filter(term => !/^\p{Script=Han}+$/u.test(term))
  if (terms.length !== 1) return null
  const [term] = terms
  return /^[A-Za-z][A-Za-z0-9_]{2,127}$/u.test(term) && /_|[a-z][A-Z]/u.test(term) ? term : null
}
