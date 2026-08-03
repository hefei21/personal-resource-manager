import DOMPurify from 'dompurify'

const RICH_TEXT_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'option',
    'link',
    'meta',
    'base',
    'svg',
    'math'
  ],
  FORBID_ATTR: [
    'style',
    'srcset',
    'formaction',
    'xlink:href'
  ]
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|x-icon);base64,/i

function isSafeImageSource(value) {
  return SAFE_DATA_IMAGE.test(value) ||
    value.startsWith('/api/') ||
    value.startsWith('/uploads/') ||
    value.startsWith('blob:')
}

function isSafeLink(value) {
  if (value.startsWith('#') || value.startsWith('/')) return true
  try {
    const parsed = new URL(value, window.location.origin)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

export function sanitizeRichHtml(value) {
  const clean = DOMPurify.sanitize(String(value ?? ''), RICH_TEXT_CONFIG)
  const template = document.createElement('template')
  template.innerHTML = clean

  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') || ''
    if (!isSafeImageSource(source)) image.removeAttribute('src')
    image.removeAttribute('srcset')
    image.setAttribute('loading', 'lazy')
    image.setAttribute('referrerpolicy', 'no-referrer')
  }

  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') || ''
    if (!isSafeLink(href)) {
      link.removeAttribute('href')
      link.removeAttribute('target')
      continue
    }
    if (/^https?:/i.test(href)) link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer nofollow')
  }

  return template.innerHTML
}

export function sanitizeHighlightHtml(value) {
  return DOMPurify.sanitize(String(value ?? ''), {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class']
  })
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
