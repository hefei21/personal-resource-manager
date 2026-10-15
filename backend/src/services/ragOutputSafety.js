// Defense in depth for user-visible RAG text, not a general secret detector.
// Concept names are not credentials. Value-bearing labels stay conservative;
// authorization, input redaction and exact cited-URL checks remain independent.
const PRIVATE_REFERENCE = /(?:(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]|\\\\|\/(?:home|root|mnt|var|tmp|etc|opt|srv|data)\/|storage[ _-]?key|(?:sha|sha256)[ _-]?hash|lease[ _-]?token|(?:source|document|book|repository|snapshot|chunk|database)[ _-]?id\s*[:=]?\s*\d+)/iu
const CREDENTIAL_VALUE = /(?:\b(?:api[ _-]?keys?|passwords?|passwd|secrets?|access[ _-]?tokens?|refresh[ _-]?tokens?)\b|密码|口令|密钥|令牌)[\s"'`*]*(?:(?:value|值)\s*)?(?:[:=]|\bis\b|\bare\b|为|是)[\s\S]*\S/iu
const QUOTED_CREDENTIAL = /(?:\b(?:api[ _-]?key|password|passwd|secret|access[ _-]?token|refresh[ _-]?token)\b|密码|口令|密钥|令牌)\s+["'`“‘][^"'`”’\s]+["'`”’]/iu
const CREDENTIAL_LITERAL = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bBearer\s+(?!(?:authentication|authorization|tokens?|scheme)\b)[A-Za-z0-9._~+\/-]+=*|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/iu

export function isSafeRagText(value) {
  if (typeof value !== 'string') return false
  const normalized = value.normalize('NFKC')
  // Invisible/control characters must not split credential labels or paths.
  if (/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) return false
  // Base64-looking prose ("Basic authentication") is not a Basic credential.
  const basicCredential = [...normalized.matchAll(/\bBasic\s+([A-Za-z0-9+/]+={0,2})/giu)]
    .some(([, token]) => Buffer.from(token, 'base64').includes(0x3a))
  return !PRIVATE_REFERENCE.test(normalized) && !CREDENTIAL_VALUE.test(normalized) &&
    !QUOTED_CREDENTIAL.test(normalized) && !CREDENTIAL_LITERAL.test(normalized) && !basicCredential &&
    !/\bhttps?:\/\/[^\s/]+@/iu.test(normalized)
}
