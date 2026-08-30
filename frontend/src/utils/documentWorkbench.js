export function documentFileIcon(filePath) {
  const extension = String(filePath || '').split('.').pop()?.toLowerCase() || ''
  const iconMap = {
    pdf: 'file-pdf',
    doc: 'file-text',
    docx: 'file-text',
    xls: 'file-text',
    xlsx: 'file-text',
    ppt: 'file-text',
    pptx: 'file-text',
    txt: 'file-text',
    md: 'file-text',
    log: 'file-text',
    csv: 'file-text',
    jpg: 'image',
    jpeg: 'image',
    png: 'image',
    gif: 'image'
  }

  return iconMap[extension] || 'file'
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
