import { parse } from 'parse5'

const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul'])
const OMIT = new Set(['script', 'style', 'template'])
// Match the NAS deferred prose ceiling. Oversized blocks keep legacy text
// rather than moving annotations beyond the existing neighbor context window.
export const EPUB_RUBY_BLOCK_BYTES = 1536

function visibleText(root) {
  const pieces = [], pending = [root]
  // Iterative traversal also handles deeply nested, untrusted book markup.
  while (pending.length) {
    const node = pending.pop()
    if (typeof node === 'string') { pieces.push(node); continue }
    if (!node || OMIT.has(node.tagName)) continue
    if (node.nodeName === '#text') { pieces.push(node.value); continue }
    if (node.tagName === 'br') { pieces.push('\n'); continue }
    const boundary = BLOCKS.has(node.tagName) ? '\n' : ['td', 'th'].includes(node.tagName) ? ' ' : ''
    if (boundary) { pieces.push(boundary); pending.push(boundary) }
    const children = node.childNodes ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
  return pieces.join('')
}

function simpleRuby(node) {
  const base = [], annotations = [], pending = [node]
  while (pending.length) {
    const current = pending.pop()
    if (OMIT.has(current.tagName)) continue
    if ((current !== node && current.tagName === 'ruby') || current.tagName === 'rtc') return null
    if (current.tagName === 'rt') {
      // Do not interpret nested Ruby, even inside annotation text.
      const descendants = [...(current.childNodes ?? [])]
      while (descendants.length) {
        const child = descendants.pop()
        if (['ruby', 'rtc', 'rt'].includes(child.tagName)) return null
        for (const item of child.childNodes ?? []) descendants.push(item)
      }
      annotations.push(visibleText(current))
      continue
    }
    if (current.tagName === 'rp') continue
    if (BLOCKS.has(current.tagName) || current.tagName === 'br') return null
    if (current.nodeName === '#text') { base.push(current.value); continue }
    const children = current.childNodes ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
  const text = base.join('')
  return text.trim() && annotations.length === 1 && annotations[0].trim()
    ? { text, annotation: annotations[0] } : null
}

function rubyAwareText(root) {
  const initial = { root, pieces: [], notes: [] }, frames = [initial], pending = [{ node: root }]
  const render = frame => {
    const body = frame.pieces.join('') + (frame.notes.length ? '\n' + frame.notes.join('\n') : '')
    return frame.notes.length && Buffer.byteLength(body, 'utf8') + 2 > EPUB_RUBY_BLOCK_BYTES
      ? visibleText(frame.root) : body
  }
  while (pending.length) {
    const item = pending.pop(), frame = frames.at(-1)
    if (item.close) {
      const child = frames.pop()
      frames.at(-1).pieces.push('\n' + render(child) + '\n')
      continue
    }
    if (item.text !== undefined) { frame.pieces.push(item.text); continue }
    const node = item.node
    if (!node || OMIT.has(node.tagName)) continue
    if (node.nodeName === '#text') { frame.pieces.push(node.value); continue }
    if (node.tagName === 'br') { frame.pieces.push('\n'); continue }
    if (node.tagName === 'ruby') {
      const pair = simpleRuby(node)
      if (pair) {
        frame.pieces.push(pair.text)
        frame.notes.push(`[Ruby ${JSON.stringify(pair.text)} → ${JSON.stringify(pair.annotation)}]`)
      } else frame.pieces.push(visibleText(node))
      continue
    }
    if (BLOCKS.has(node.tagName)) {
      frames.push({ root: node, pieces: [], notes: [] }); pending.push({ close: true })
    } else if (['td', 'th'].includes(node.tagName)) {
      frame.pieces.push(' '); pending.push({ text: ' ' })
    }
    const children = node.childNodes ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i] })
  }
  return render(initial)
}

export function extractEpubHtml(html) {
  // Parse once: entities become text, never a second round of executable markup.
  // This parser does not execute scripts, fetch resources, or resolve XML DTDs.
  const document = parse(html)
  const root = document.childNodes.find(node => node.tagName === 'html')
  const body = root?.childNodes.find(node => node.tagName === 'body')
  const head = root?.childNodes.find(node => node.tagName === 'head')
  const title = head?.childNodes.find(node => node.tagName === 'title')
  return { body: rubyAwareText(body), title: visibleText(title) }
}
