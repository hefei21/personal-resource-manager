import { TaskProcessorError } from './taskProcessorError.js'

const PROXY_HOST_PATTERN = /(?:proxy:\s*clash|getaddrinfo\s+(?:EAI_AGAIN|ENOTFOUND)\s+clash)/iu
const CONNECTION_PATTERN = /(?:ECONNREFUSED|connect(?:ion)?\s+(?:failed|refused))/iu
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT'])
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'])
const DNS_CODES = new Set(['EAI_AGAIN', 'ENOTFOUND'])

function errorChain(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 4) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }
  return chain
}

function privateText(error) {
  return errorChain(error).map((item) => [item.message, item.stderr]
    .filter((value) => typeof value === 'string')
    .join(' ')).join(' ')
}

function privateCodes(error) {
  return errorChain(error).map((item) => item.code).filter((value) => typeof value === 'string')
}

function proxyHostFailed(error) {
  return errorChain(error).some((item) => item.hostname === 'clash' || item.host === 'clash') ||
    PROXY_HOST_PATTERN.test(privateText(error))
}

export function classifyNetworkTaskFailure(error) {
  const codes = privateCodes(error)
  const text = privateText(error)
  if (proxyHostFailed(error) && (codes.some((code) => DNS_CODES.has(code)) || /resolve proxy|ENOTFOUND|EAI_AGAIN/iu.test(text))) {
    return Object.freeze({
      code: 'PROXY_DNS_FAILED',
      summary: '代理服务名称无法解析，请检查容器网络。',
      retryable: true,
      causeCategory: 'PROXY_DNS'
    })
  }
  if (proxyHostFailed(error) && (codes.some((code) => CONNECTION_CODES.has(code)) || CONNECTION_PATTERN.test(text))) {
    return Object.freeze({
      code: 'PROXY_CONNECTION_FAILED',
      summary: '代理服务暂时无法连接。',
      retryable: true,
      causeCategory: 'PROXY_CONNECTION'
    })
  }
  if (codes.some((code) => DNS_CODES.has(code))) {
    return Object.freeze({ causeCategory: 'NETWORK_DNS' })
  }
  if (codes.some((code) => TIMEOUT_CODES.has(code))) {
    return Object.freeze({ causeCategory: 'NETWORK_TIMEOUT' })
  }
  if (codes.some((code) => CONNECTION_CODES.has(code))) {
    return Object.freeze({ causeCategory: 'NETWORK_CONNECTION' })
  }
  return null
}

export function taskNetworkError(error, fallback) {
  const classification = classifyNetworkTaskFailure(error)
  const selected = classification?.code ? classification : fallback
  return new TaskProcessorError({
    code: selected.code,
    summary: selected.summary,
    retryable: selected.retryable,
    causeCategory: classification?.causeCategory ?? fallback.causeCategory ?? 'NETWORK_OTHER'
  })
}
