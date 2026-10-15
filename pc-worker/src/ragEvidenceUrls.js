// Duplicated in the independent Worker/server packages; a parity test keeps
// independently enforce the display-only contract, without resolving URLs.
export function evidenceUrls(text) {
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"'`，。；！？、）】》]+/giu), match => {
      let url = match[0]
      // A Markdown destination has an explicit closing delimiter. Sentence
      // punctuation after it is not part of the URI; punctuation inside is.
      // Do not apply this to bare URLs or guess boundaries of malformed links.
      if (text.slice(Math.max(0, match.index - 2), match.index) === '](' && !url.includes('\\')) {
        let depth = 0
        for (let i = 0; i < url.length; i++) {
          if (url[i] === '(') depth++
          if (url[i] !== ')') continue
          if (depth > 0) { depth--; continue }
          if (/^[.,;:!?]*$/u.test(url.slice(i + 1))) url = url.slice(0, i)
          break
        }
      }
      // Only discard unmatched prose wrappers, never URI punctuation such
      // as a trailing dot or question mark (which can change the resource).
      for (;;) {
        const close = url.at(-1), open = { ')': '(', ']': '[', '}': '{' }[close]
        if (!open || url.split(close).length <= url.split(open).length) return url
        url = url.slice(0, -1)
      }
    })
}

export function hasOnlyCitedUrls(answer, allowedUrls) {
  const urls = evidenceUrls(answer)
  // Normalization must not turn disguised text into a newly allowed URL.
  if (JSON.stringify(urls) !== JSON.stringify(evidenceUrls(answer.normalize('NFKC')))) return false
  const allowed = new Set(allowedUrls)
  return urls.every(url => {
    if (!allowed.has(url)) return false
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
    } catch { return false }
  })
}
