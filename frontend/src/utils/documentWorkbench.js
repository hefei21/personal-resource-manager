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
    txt: 'file-text',
    md: 'file-markdown',
    log: 'file-text',
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
