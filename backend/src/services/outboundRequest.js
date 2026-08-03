import dns from 'node:dns/promises'
import dnsCallback from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'

const blockedAddresses = new net.BlockList()

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4')
}

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32]
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6')
}

export class OutboundRequestError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'OutboundRequestError'
    this.code = code
  }
}

export function isBlockedAddress(address) {
  const mappedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mappedMatch) {
    return blockedAddresses.check(mappedMatch[1], 'ipv4')
  }
  const family = net.isIP(address)
  if (!family) return true
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function hostMatches(hostname, allowedHosts) {
  if (!allowedHosts?.length) return true
  const normalized = hostname.toLowerCase()
  return allowedHosts.some(rule => {
    const candidate = rule.toLowerCase()
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1)
      return normalized.endsWith(suffix) && normalized !== suffix.slice(1)
    }
    return normalized === candidate
  })
}

export async function assertSafePublicUrl(value, options = {}) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new OutboundRequestError('外部 URL 无效', 'OUTBOUND_URL_INVALID')
  }

  const allowedProtocols = options.allowedProtocols || ['http:', 'https:']
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new OutboundRequestError(
      '外部 URL 协议不受支持',
      'OUTBOUND_PROTOCOL_FORBIDDEN'
    )
  }
  if (parsed.username || parsed.password) {
    throw new OutboundRequestError(
      '外部 URL 不得包含凭据',
      'OUTBOUND_CREDENTIALS_FORBIDDEN'
    )
  }

  const hostname = parsed.hostname.toLowerCase()
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new OutboundRequestError(
      '禁止访问本机或内部网络',
      'OUTBOUND_HOST_FORBIDDEN'
    )
  }
  if (!hostMatches(hostname, options.allowedHosts)) {
    throw new OutboundRequestError(
      '外部主机不在允许列表中',
      'OUTBOUND_HOST_NOT_ALLOWED'
    )
  }

  const resolver = options.resolver || (host => dns.lookup(host, {
    all: true,
    verbatim: true
  }))
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await resolver(hostname)

  if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) {
    throw new OutboundRequestError(
      '外部主机解析到了非公网地址',
      'OUTBOUND_ADDRESS_FORBIDDEN'
    )
  }

  return parsed
}

export function normalizePublicDomain(value) {
  if (!value || typeof value !== 'string') {
    throw new OutboundRequestError('域名不能为空', 'OUTBOUND_DOMAIN_INVALID')
  }
  const trimmed = value.trim().toLowerCase()
  if (
    trimmed.includes('/') ||
    trimmed.includes('@') ||
    trimmed.includes(':') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new OutboundRequestError(
      '只能填写不含协议、端口和路径的域名',
      'OUTBOUND_DOMAIN_INVALID'
    )
  }

  let parsed
  try {
    parsed = new URL(`https://${trimmed}`)
  } catch {
    throw new OutboundRequestError('域名无效', 'OUTBOUND_DOMAIN_INVALID')
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    throw new OutboundRequestError('域名无效', 'OUTBOUND_DOMAIN_INVALID')
  }
  return parsed.hostname
}

function safeLookup(hostname, options, callback) {
  const normalizedOptions = typeof options === 'number'
    ? { family: options }
    : (options || {})
  dnsCallback.lookup(hostname, {
    all: true,
    verbatim: true,
    family: normalizedOptions.family || 0
  }, (error, addresses) => {
    if (error) return callback(error)
    if (!addresses.length || addresses.some(item => isBlockedAddress(item.address))) {
      return callback(new OutboundRequestError(
        '外部主机解析到了非公网地址',
        'OUTBOUND_ADDRESS_FORBIDDEN'
      ))
    }
    if (normalizedOptions.all) return callback(null, addresses)
    const selected = addresses[0]
    return callback(null, selected.address, selected.family)
  })
}

export async function safeAxiosGet(value, options = {}) {
  const maxRedirects = options.safeMaxRedirects ?? 3
  const allowedHosts = options.allowedHosts
  const allowedProtocols = options.allowedProtocols
  const resolver = options.resolver
  let current = new URL(value).toString()

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafePublicUrl(current, {
      allowedHosts,
      allowedProtocols,
      resolver
    })

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
    const httpAgent = proxyAgent || new http.Agent({ lookup: safeLookup })
    const httpsAgent = proxyAgent || new https.Agent({ lookup: safeLookup })
    const callerValidateStatus = options.validateStatus ||
      (status => status >= 200 && status < 300)
    const response = await axios.get(current, {
      ...options,
      safeMaxRedirects: undefined,
      allowedHosts: undefined,
      allowedProtocols: undefined,
      resolver: undefined,
      maxRedirects: 0,
      httpAgent,
      httpsAgent,
      proxy: false,
      validateStatus: status =>
        (status >= 300 && status < 400) || callerValidateStatus(status)
    })

    if (response.status < 300 || response.status >= 400) {
      response.safeFinalUrl = current
      return response
    }
    const location = response.headers.location
    if (!location || redirectCount === maxRedirects) {
      throw new OutboundRequestError(
        '外部请求重定向次数过多',
        'OUTBOUND_REDIRECT_LIMIT'
      )
    }
    current = new URL(location, current).toString()
  }

  throw new OutboundRequestError(
    '外部请求失败',
    'OUTBOUND_REQUEST_FAILED'
  )
}
