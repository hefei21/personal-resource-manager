export function documentFileIcon(filePath) {
  const extension = String(filePath || '').split('.').pop()?.toLowerCase() || ''
  const iconMap = {
    pdf: 'file-pdf',
    doc: 'file-word',
    docx: 'file-word',
    xls: 'file-excel',
    xlsx: 'file-excel',
    ppt: 'file-powerpoint',
    pptx: 'file-powerpoint',
    txt: 'file-txt',
    md: 'file-md',
    log: 'file-txt',
    csv: 'file-excel',
    jpg: 'file-image',
    jpeg: 'file-image',
    png: 'file-image',
    gif: 'file-image',
    bmp: 'file-image',
    webp: 'file-image',
    json: 'code',
    js: 'code',
    ts: 'code',
    py: 'code',
    java: 'code',
    c: 'code',
    cpp: 'code',
    h: 'code',
    hpp: 'code',
    go: 'code',
    rs: 'code',
    sql: 'code',
    sh: 'code',
    yml: 'code',
    yaml: 'code'
  }

  return iconMap[extension] || 'file'
}

export function documentDisplayFileName(title, filePath) {
  const cleanTitle = String(title || '').trim()
  const sourceName = String(filePath || '').replace(/\\/gu, '/').split('/').pop() || ''
  const extension = sourceName.includes('.') ? sourceName.split('.').pop()?.toLowerCase() || '' : ''
  if (!cleanTitle) return sourceName || '未知文件'
  if (!extension || cleanTitle.toLowerCase().endsWith(`.${extension}`)) return cleanTitle
  return `${cleanTitle}.${extension}`
}

export const DOCUMENT_PREVIEW_POSITION_MAX_ENTRIES = 100
export const DOCUMENT_PREVIEW_POSITION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export function pruneDocumentPreviewPositions(value, now = Date.now()) {
  const entries = Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([key, position]) => (
      key
      && position
      && typeof position === 'object'
      && Number.isFinite(Number(position.savedAt))
      && now - Number(position.savedAt) <= DOCUMENT_PREVIEW_POSITION_MAX_AGE_MS
    ))
    .sort(([, left], [, right]) => Number(right.savedAt) - Number(left.savedAt))
    .slice(0, DOCUMENT_PREVIEW_POSITION_MAX_ENTRIES)

  return Object.fromEntries(entries)
}

export function updateDocumentPreviewPosition(value, key, position, now = Date.now()) {
  if (!key || !position || typeof position !== 'object') {
    return pruneDocumentPreviewPositions(value, now)
  }

  return pruneDocumentPreviewPositions({
    ...(value && typeof value === 'object' ? value : {}),
    [key]: {
      type: String(position.type || 'text'),
      page: Math.max(1, Number(position.page) || 1),
      scrollTop: Math.max(0, Number(position.scrollTop) || 0),
      scrollLeft: Math.max(0, Number(position.scrollLeft) || 0),
      savedAt: now
    }
  }, now)
}

export function documentFileTone(filePath) {
  const extension = String(filePath || '').split('.').pop()?.toLowerCase() || ''
  if (extension === 'pdf') return 'pdf'
  if (['doc', 'docx'].includes(extension)) return 'word'
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'sheet'
  if (['ppt', 'pptx'].includes(extension)) return 'slides'
  if (extension === 'md') return 'markdown'
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension)) return 'image'
  if (['json', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sql', 'sh', 'yml', 'yaml'].includes(extension)) return 'code'
  return 'text'
}

export function collectExpandableCategoryIds(categories) {
  const result = new Set()
  const walk = (nodes) => {
    for (const category of Array.isArray(nodes) ? nodes : []) {
      if (!Array.isArray(category?.subcategories) || category.subcategories.length === 0) continue
      result.add(category.id)
      walk(category.subcategories)
    }
  }

  walk(categories)
  return result
}

export function flattenVisibleDocumentCategories(categories, expandedCategoryIds = new Set()) {
  const result = []
  const expanded = expandedCategoryIds instanceof Set
    ? expandedCategoryIds
    : new Set(expandedCategoryIds)

  const walk = (nodes, trail = []) => {
    for (const category of Array.isArray(nodes) ? nodes : []) {
      if (!category) continue
      const nextTrail = [...trail, category]
      result.push({ ...category, depth: trail.length, trail: nextTrail })
      if (expanded.has(category.id)) walk(category.subcategories, nextTrail)
    }
  }

  walk(categories)
  return result
}
