// Candidate transport shared by isolated evaluation and future task integration.
// Endpoint/model come from trusted configuration, never from the query or task.
export function createQueryTranslationTransport({ baseUrl, modelId, apiKey = null, fetchImpl = fetch } = {}) {
  const endpoint = new URL(baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      typeof modelId !== 'string' || !modelId.trim()) throw new TypeError('Invalid translation configuration')
  const path = endpoint.pathname.replace(/\/$/u, '')
  endpoint.pathname = path.endsWith('/chat/completions') ? path
    : path.endsWith('/v1') ? `${path}/chat/completions` : `${path}/v1/chat/completions`
  return async ({ messages, signal }) => {
    signal?.throwIfAborted()
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: modelId, temperature: 0, max_tokens: 2048,
        reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, messages,
        response_format: { type: 'json_schema', json_schema: { name: 'search_queries', strict: true,
          schema: { type: 'object', additionalProperties: false, properties: {
            queries: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 1024 } }
          }, required: ['queries'] } } }
      })
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Translation endpoint unavailable')
    }
    // Bound the streamed envelope too: response.json() alone has no size limit.
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 64 * 1024) throw new Error('Translation response too large')
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally { reader.releaseLock() }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const choice = payload.choices?.[0]
    return { finishReason: choice?.finish_reason, value: JSON.parse(choice?.message?.content), usage: payload.usage }
  }
}
