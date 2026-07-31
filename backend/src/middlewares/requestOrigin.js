import { OWNER_SESSION_COOKIE } from '../services/sessions.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function normalizeOrigin(value) {
  if (!value || value === 'null') return null

  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

export function configuredAllowedOrigins(env = process.env) {
  return new Set(
    (env.CORS_ORIGIN || '')
      .split(',')
      .map(value => value.trim())
      .filter(value => value && value !== '*')
      .map(normalizeOrigin)
      .filter(Boolean)
  )
}

export function getRequestOrigin(req) {
  const host = req.get?.('host')
  if (!host) return null
  return normalizeOrigin(`${req.protocol || 'http'}://${host}`)
}

export function getSourceOrigin(req) {
  const originHeader = req.get?.('origin')
  if (originHeader !== undefined) return normalizeOrigin(originHeader)

  const referer = req.get?.('referer')
  return normalizeOrigin(referer)
}

export function isTrustedRequestOrigin(req, sourceOrigin, env = process.env) {
  const normalizedSource = normalizeOrigin(sourceOrigin)
  if (!normalizedSource) return false

  if (normalizedSource === getRequestOrigin(req)) return true
  return configuredAllowedOrigins(env).has(normalizedSource)
}

/**
 * Cookie-authenticated state changes must originate from this application or
 * an explicitly configured frontend origin. SameSite remains defense in depth;
 * this check is the server-side CSRF boundary.
 */
export function enforceOwnerRequestOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method?.toUpperCase())) return next()
  if (!req.cookies?.[OWNER_SESSION_COOKIE]) return next()

  const sourceOrigin = getSourceOrigin(req)
  if (!sourceOrigin) {
    return res.status(403).json({
      message: '无法验证请求来源',
      code: 'ORIGIN_REQUIRED'
    })
  }

  if (!isTrustedRequestOrigin(req, sourceOrigin)) {
    return res.status(403).json({
      message: '请求来源不受信任',
      code: 'ORIGIN_FORBIDDEN'
    })
  }

  next()
}
