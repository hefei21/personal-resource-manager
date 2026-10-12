import { parse } from 'parse5'

const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul'])
const OMIT = new Set(['script', 'style', 'template'])

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

export function extractEpubHtml(html) {
  // Parse once: entities become text, never a second round of executable markup.
  // This parser does not execute scripts, fetch resources, or resolve XML DTDs.
  const document = parse(html)
  const root = document.childNodes.find(node => node.tagName === 'html')
  const body = root?.childNodes.find(node => node.tagName === 'body')
  const head = root?.childNodes.find(node => node.tagName === 'head')
  const title = head?.childNodes.find(node => node.tagName === 'title')
  return { body: visibleText(body), title: visibleText(title) }
}
