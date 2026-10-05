import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const profile = JSON.parse(readFileSync(new URL('../reranker/profile.json', import.meta.url), 'utf8'))
export const QWEN_RERANKER_MODEL = Object.freeze({
  provider: 'prmanager-pytorch', modelId: profile.modelId, modelRevision: profile.revision,
  dimensions: 1, inputLimit: 2048,
  configHash: createHash('sha256').update(JSON.stringify([
    profile.revision, profile.instruction, 'float16', 'sdpa', 2048, 8, 'yes-minus-no', 'reject-overlength', 'length-ascending-stable-v1'
  ])).digest('hex')
})
export const matchesQwenReranker = value => value && Object.entries(QWEN_RERANKER_MODEL).every(([k, v]) => value[k] === v)
export function validQwenEndpoint(value, apiKey) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/rerank', ''].includes(url.pathname) && typeof apiKey === 'string' && /^[!-~]{32,4096}$/u.test(apiKey)
  } catch { return false }
}
