// Resolve Markdown links only within the repository's logical namespace.
// The server remains authoritative for storage-root and snapshot validation.
export function resolveRepositoryLink(href, currentPath = 'README.md') {
  if (typeof href !== 'string' || !href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null
  try {
    const hash = href.indexOf('#')
    const anchor = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1))
    const rawPath = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0])
    if (/[\\\u0000]/.test(rawPath) || /^[a-z]:/i.test(rawPath)) return null
    if (!rawPath) return { path: currentPath, anchor, sameFile: true }
    const parts = rawPath.startsWith('/') ? [] : currentPath.split('/').slice(0, -1)
    for (const part of rawPath.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!parts.length) return null; parts.pop() }
      else parts.push(part)
    }
    if (!parts.length) return null
    return { path: parts.join('/'), anchor, sameFile: parts.join('/') === currentPath }
  } catch { return null }
}

export function scrollRepositoryAnchor(container, anchor) {
  if (!container || !anchor) return
  const target = [...container.querySelectorAll('[id], [name]')].find(node => node.id === anchor || node.getAttribute('name') === anchor)
  target?.scrollIntoView({ block: 'start', behavior: 'auto' })
}
