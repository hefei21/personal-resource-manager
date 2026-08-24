const RAG_PATH_PATTERN = /^\/api\/rag(?:\/|$)/iu
const SAFE_IDENTIFIER_PATTERN = /^(?:[a-f0-9]{16,128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9]\d{0,18})$/iu

const RAG_METADATA_KEYS = Object.freeze([
  'requestId',
  'queryId',
  'traceId',
  'mode',
  'retrievalMode',
  'status',
  'outcome',
  'topK',
  'limit',
  'sourceCount',
  'evidenceCount',
  'citationCount',
  'durationMs'
])

const RAG_MODE_VALUES = new Set([
  'fts',
  'vector',
  'hybrid',
  'rerank',
  'deferred',
  'actual'
])

const RAG_STATUS_VALUES = new Set([
  'success',
  'error',
  'answered',
  'no_answer',
  'degraded',
  'cancelled',
  'timeout'
])

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requestPathWithoutQuery(value) {
  if (typeof value !== 'string') return ''
  const rawPath = value.trim().split(/[?#]/u, 1)[0]
  if (!rawPath) return ''

  try {
    return decodeURIComponent(rawPath)
  } catch {
    // A malformed escape is still classified from its raw path prefix. The
    // logger must fail closed for a malformed request rather than persist it.
    return rawPath
  }
}

/**
 * Express rewrites req.url/req.path while invoking a mounted middleware.
 * originalUrl remains the client path, so use it before any mount-local path.
 */
export function isRagRequest(requestOrUrl) {
  const rawUrl = typeof requestOrUrl === 'string'
    ? requestOrUrl
    : requestOrUrl?.originalUrl ?? requestOrUrl?.url ?? ''
  return RAG_PATH_PATTERN.test(requestPathWithoutQuery(rawUrl))
}

function safeIdentifier(value) {
  if (Number.isSafeInteger(value) && value > 0) return value
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  return SAFE_IDENTIFIER_PATTERN.test(normalized) ? normalized : null
}

function safeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) return null
  return value
}

function safeRagMetadataValue(key, value) {
  if (['requestId', 'queryId', 'traceId'].includes(key)) return safeIdentifier(value)
  if (['mode', 'retrievalMode'].includes(key)) {
    return typeof value === 'string' && RAG_MODE_VALUES.has(value) ? value : null
  }
  if (['status', 'outcome'].includes(key)) {
    return typeof value === 'string' && RAG_STATUS_VALUES.has(value) ? value : null
  }
  return safeCount(value)
}

/**
 * Only server-created, stable metadata is eligible for a RAG audit record.
 * The request body is deliberately not an input to this projection.
 */
export function projectRagLogMetadata(value) {
  if (!isPlainObject(value)) return null

  const result = {}
  for (const key of RAG_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const safeValue = safeRagMetadataValue(key, value[key])
    if (safeValue !== null) result[key] = safeValue
  }

  return Object.keys(result).length > 0 ? result : null
}

export function serializeRagLogMetadata(value) {
  const projected = projectRagLogMetadata(value)
  return projected ? JSON.stringify(projected) : null
}

// Preserve the existing non-RAG audit-log behavior. This is intentionally not
// used for RAG requests because a blacklist cannot safely recognize document
// text under arbitrary application-defined keys.
export function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null

  const sensitiveKey = /(password|passwd|token|secret|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i
  const redact = (value, depth = 0) => {
    if (depth > 4) return '[TRUNCATED]'
    if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, depth + 1))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : redact(child, depth + 1)
      ]))
    }
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}[TRUNCATED]`
    return value
  }

  const safe = redact(body)
  return Object.keys(safe).length > 0 ? JSON.stringify(safe) : null
}

/**
 * RAG request bodies are never serialized. A route may attach a server-owned
 * ragLogContext containing only the allowlisted metadata above.
 */
export function requestBodyForLog(request) {
  if (isRagRequest(request)) return serializeRagLogMetadata(request?.ragLogContext)
  return sanitizeBody(request?.body)
}

export const RAG_LOG_METADATA_KEYS = RAG_METADATA_KEYS
