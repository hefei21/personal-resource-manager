// Preserve authored row/cell boundaries only. This is not a general OOXML
// renderer: uncertain structures remain on the existing paragraph path.
export function preserveDocxTableRows(xml, paragraphText) {
  const stack = []
  const tables = []
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')*>/gu
  for (const match of xml.matchAll(tokens)) {
    const tag = match[0]
    if (/^<(?:!--|!\[CDATA\[|\?)/u.test(tag)) continue
    const close = tag.match(/^<\/([\w:.-]+)\s*>$/u)
    if (close) {
      const open = stack.pop()
      if (!open || open.name !== close[1]) return []
      if (open.table) tables.push({ start: open.start, end: match.index + tag.length })
      continue
    }
    const name = tag.match(/^<([\w:.-]+)(?:\s|\/?>)/u)?.[1]
    if (!name) return []
    if (/\/\s*>$/u.test(tag)) continue
    if (stack.length >= 128) return []
    stack.push({ name, start: match.index, table: name === 'w:tbl' && stack.at(-1)?.name === 'w:body' })
  }
  if (stack.length) return []

  const changes = []
  for (const range of tables) {
    const table = xml.slice(range.start, range.end)
    if ((table.match(/<w:tbl\b/gu) ?? []).length !== 1 || /<w:(?:vMerge|hMerge|gridSpan|gridBefore|gridAfter)\b/u.test(table)) continue
    const rows = [...table.matchAll(/<w:tr\b[^>]*?(?<!\/)>([\s\S]*?)<\/w:tr>/gu)]
      .map(row => [...row[1].matchAll(/<w:tc\b[^>]*?(?<!\/)>([\s\S]*?)<\/w:tc>/gu)].map(cell => cell[1]))
    if (rows.length < 2 || rows[0].length < 2 || rows.some(row => row.length !== rows[0].length)) continue
    // A checklist with only its first content column filled gains no column
    // relationship. Do not rewrite it just because its header has many cells.
    const hasContent = cell => [...cell.matchAll(/<w:t\b[^>]*?(?<!\/)>([\s\S]*?)<\/w:t>/gu)]
      .some(value => value[1].trim().length > 0)
    if (!rows.slice(1).some(row => row.filter(hasContent).length >= 2)) continue
    const rendered = rows.map(row => '| ' + row.map(cell => [...cell.matchAll(/<w:p\b[^>]*?(?<!\/)>([\s\S]*?)<\/w:p>/gu)]
      .map(p => paragraphText(p[1])).filter(Boolean).join(' / ')).join(' | ') + ' |')
    // Plain text stays plain text. Never decode entities a second time or feed
    // authored markup back through an XML parser.
    changes.push({ ...range, rows: rendered })
  }
  return changes
}
