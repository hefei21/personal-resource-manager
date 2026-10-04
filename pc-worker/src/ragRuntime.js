import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export const RAG_RUNTIME = freeze(JSON.parse(readFileSync(new URL('../rag-runtime/qwen35-v1.json', import.meta.url), 'utf8')))
export const RAG_RUNTIME_HASH = createHash('sha256').update(JSON.stringify(RAG_RUNTIME)).digest('hex')
const fail = () => { throw new Error('RAG runtime configuration mismatch.') }

export function runtimeUrl(baseUrl) {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/', '/v1/chat/completions'].includes(url.pathname)) fail()
  return url.origin.replace(/^http/u, 'ws')
}

export function assertRuntime(info, actual) {
  if (info?.identifier !== RAG_RUNTIME.alias || info?.path !== RAG_RUNTIME.modelKey) fail()
  for (const [key, value] of Object.entries(RAG_RUNTIME.load)) if (!isDeepStrictEqual(actual?.[key], value)) fail()
}

export function assertPrediction(actual, requested) {
  const fields = new Map((actual?.fields ?? []).map(field => [field.key, field.value]))
  const checked = value => ({ checked: true, value })
  const expected = {
    temperature: requested.temperature, topKSampling: requested.topKSampling,
    topPSampling: checked(requested.topPSampling), minPSampling: checked(requested.minPSampling),
    repeatPenalty: checked(requested.repeatPenalty), 'llama.presencePenalty': checked(requested.presencePenalty),
    'reasoning.budgetTokens': checked(requested.reasoningBudget), 'reasoning.enableThinking': requested.enableThinking,
    maxPredictedTokens: checked(requested.maxTokens), contextOverflowPolicy: requested.contextOverflowPolicy,
    stopStrings: [], promptTemplate: requested.promptTemplate, structured: requested.structured, tools: { type: 'none' }
  }
  for (const [key, value] of Object.entries(expected)) if (!isDeepStrictEqual(fields.get(`llm.prediction.${key}`), value)) fail()
}

async function defaultClient(baseUrl) {
  const { LMStudioClient } = await import('@lmstudio/sdk')
  return new LMStudioClient({ baseUrl: runtimeUrl(baseUrl) })
}

// An opt-in SDK adapter for the existing processors. Never loads/ejects models
// or falls back to a chat preset. Abort reaches both the caller and prediction.
export function createRagRuntimeFetch({ config, clientFactory = defaultClient } = {}) {
  if (config?.runtimeProfile !== RAG_RUNTIME.id || config.modelId !== RAG_RUNTIME.alias || config.apiKey) fail()
  runtimeUrl(config.baseUrl)
  return async (endpoint, options) => {
    if (new URL(endpoint).origin !== new URL(config.baseUrl).origin) fail()
    const request = JSON.parse(options.body)
    if (request.model !== RAG_RUNTIME.alias || !Array.isArray(request.messages) ||
        request.response_format?.type !== 'json_schema') fail()
    const signal = options.signal
    signal?.throwIfAborted()
    let prediction
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => { if (prediction) Promise.resolve().then(() => prediction.cancel()).catch(() => {}); reject(signal.reason ?? new Error('Cancelled')) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([aborted, (async () => {
        const client = await clientFactory(config.baseUrl)
        signal?.throwIfAborted()
        const model = await client.llm.model(RAG_RUNTIME.alias)
        const [info, actual] = await Promise.all([model.getModelInfo(), model.getLoadConfig()])
        signal?.throwIfAborted()
        assertRuntime(info, actual)
        const translation = request.response_format.json_schema.name === 'search_queries'
        const predictionConfig = {
          ...RAG_RUNTIME.prediction,
          promptTemplate: { ...RAG_RUNTIME.load.promptTemplate, stopStrings: [] },
          ...(translation ? { enableThinking: false, maxTokens: 2048 } : {}),
          structured: { type: 'json', jsonSchema: request.response_format.json_schema.schema }
        }
        prediction = model.respond(request.messages, predictionConfig)
        const value = await prediction
        signal?.throwIfAborted()
        assertPrediction(value.predictionConfig, predictionConfig)
        return { model: RAG_RUNTIME.alias, choices: [{ finish_reason: value.stats.stopReason === 'eosFound' ? 'stop' : value.stats.stopReason,
          message: { content: value.nonReasoningContent } }] }
      })()])
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    } finally { signal?.removeEventListener('abort', onAbort) }
  }
}
