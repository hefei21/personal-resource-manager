// Kept identical to backend/src/services/ragEvidenceUrls.js: both runtimes
// independently enforce the display-only contract, without resolving URLs.
export function evidenceUrls(text) {
  return (text.match(/https?:\/\/[^\s<>"'`，。；！？、）】》]+/giu) ?? [])
    .map(url => url.replace(/[.,;:!?)\]}]+$/u, ''))
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
