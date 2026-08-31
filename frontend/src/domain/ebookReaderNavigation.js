const EBOOK_ORIGIN = 'https://ebook.local'

function normalizePath(value) {
  return decodeURIComponent(String(value || ''))
    .replace(/^\/+/, '')
    .replace(/\\/gu, '/')
}
export function resolveEbookLink(href, currentHref = '') {
  const rawHref = String(href || '').trim()
  if (!rawHref) return null

  if (/^(?:https?:|mailto:|tel:)/iu.test(rawHref)) {
    return { external: true, url: rawHref, path: '', fragment: '' }
  }

  try {
    const base = new URL(normalizePath(currentHref) || 'index.xhtml', `${EBOOK_ORIGIN}/`)
    const target = new URL(rawHref, base)
    if (target.origin !== EBOOK_ORIGIN) return { external: true, url: target.href, path: '', fragment: '' }
    return {
      external: false,
      url: '',
      path: normalizePath(target.pathname),
      fragment: decodeURIComponent(target.hash.slice(1))
    }
  } catch {
    return null
  }
}

export function findEbookChapterIndex(chapters, targetPath) {
  const normalizedTarget = normalizePath(targetPath)
  if (!normalizedTarget) return -1

  const normalizedChapters = chapters.map(chapter => normalizePath(chapter?.href))
  const exactIndex = normalizedChapters.indexOf(normalizedTarget)
  if (exactIndex >= 0) return exactIndex

  const targetName = normalizedTarget.split('/').at(-1)
  const basenameMatches = normalizedChapters
    .map((path, index) => ({ path, index }))
    .filter(item => item.path.split('/').at(-1) === targetName)
  return basenameMatches.length === 1 ? basenameMatches[0].index : -1
}
