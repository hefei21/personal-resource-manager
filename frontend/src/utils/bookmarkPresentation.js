export function bookmarkHref(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
export function bookmarkDomain(value) {
  try {
    return new URL(value).host
  } catch {
    return '链接需修正'
  }
}
const escapeHtml = (value) =>
  String(value || '').replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  )
export function bookmarkHtmlExport(bookmarks) {
  const groups = new Map()
  for (const bookmark of bookmarks) {
    const name = bookmark.category || '未分类'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(bookmark)
  }
  return (
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
    [...groups]
      .map(
        ([category, items]) =>
          '<DT><H3>' +
          escapeHtml(category) +
          '</H3>\n<DL><p>\n' +
          items
            .filter((b) => bookmarkHref(b.url))
            .map(
              (b) =>
                '<DT><A HREF="' +
                escapeHtml(b.url) +
                '" TAGS="' +
                escapeHtml(b.tags.join(',')) +
                '">' +
                escapeHtml(b.title) +
                '</A>\n' +
                (b.description
                  ? '<DD>' + escapeHtml(b.description) + '\n'
                  : ''),
            )
            .join('') +
          '</DL><p>\n',
      )
      .join('') +
    '</DL><p>'
  )
}
