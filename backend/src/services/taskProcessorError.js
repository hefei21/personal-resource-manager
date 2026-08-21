const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const MAX_SUMMARY_LENGTH = 256
const CAUSE_CATEGORY_SET = new Set([
  'PROXY_DNS',
  'PROXY_CONNECTION',
  'NETWORK_DNS',
  'NETWORK_CONNECTION',
  'NETWORK_TIMEOUT',
  'NETWORK_OTHER'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeCode(value) {
  if (typeof value !== 'string') throw new TypeError('Task processor error code is invalid.')
  const normalized = value.normalize('NFKC').trim()
  if (!ERROR_CODE_PATTERN.test(normalized)) throw new TypeError('Task processor error code is invalid.')
  return normalized
}

function normalizeSummary(value) {
  if (typeof value !== 'string') throw new TypeError('Task processor error summary is invalid.')
  const normalized = value.normalize('NFKC').split(/[\r\n]/u, 1)[0]
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  if (!normalized) throw new TypeError('Task processor error summary is invalid.')
  return normalized.slice(0, MAX_SUMMARY_LENGTH)
}

export class TaskProcessorError extends Error {
  constructor(options) {
    if (!isPlainObject(options)) throw new TypeError('Task processor error options are invalid.')
    const code = normalizeCode(options.code)
    const summary = normalizeSummary(options.summary)
    if (typeof options.retryable !== 'boolean') {
      throw new TypeError('Task processor error retryable flag is invalid.')
    }
    const causeCategory = options.causeCategory === undefined
      ? null
      : typeof options.causeCategory === 'string' && CAUSE_CATEGORY_SET.has(options.causeCategory)
        ? options.causeCategory
        : (() => { throw new TypeError('Task processor error cause category is invalid.') })()
    super(summary)
    this.name = 'TaskProcessorError'
    Object.defineProperties(this, {
      code: { value: code, enumerable: true },
      summary: { value: summary, enumerable: true },
      retryable: { value: options.retryable, enumerable: true },
      causeCategory: { value: causeCategory, enumerable: true }
    })
    Object.freeze(this)
  }
}
