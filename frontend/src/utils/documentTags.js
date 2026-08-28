export function normalizeDocumentTags(value) {
  if (Array.isArray(value)) {
    return value.map(tag => String(tag).trim()).filter(Boolean)
  }
  if (typeof value !== 'string' || !value.trim()) return []
  const source = value.trim()
  if (source.startsWith('[')) {
    try {
      const parsed = JSON.parse(source)
      if (Array.isArray(parsed)) return normalizeDocumentTags(parsed)
    } catch {
      // Fall through to the legacy comma-separated representation.
    }
  }
  return source.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean)
}

export function documentTagsLabel(value) {
  return normalizeDocumentTags(value).join('、')
}
