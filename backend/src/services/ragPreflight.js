import crypto from 'node:crypto'

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is invalid`)
  return value.trim()
}

export function validateEmbeddingProviderContract(contract) {
  if (!isPlainObject(contract)) throw new TypeError('embedding contract is invalid')
  const dimensions = Number(contract.dimensions)
  const inputLimit = Number(contract.inputLimit)
  if (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 65536) {
    throw new TypeError('embedding dimensions are invalid')
  }
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 128 || inputLimit > 1_048_576) {
    throw new TypeError('embedding inputLimit is invalid')
  }
  if (!['cosine', 'dot', 'euclid'].includes(contract.distance)) throw new TypeError('embedding distance is invalid')
  if (!['none', 'l2'].includes(contract.normalization)) throw new TypeError('embedding normalization is invalid')
  return Object.freeze({
    provider: requiredText(contract.provider, 'provider'),
    modelId: requiredText(contract.modelId, 'modelId'),
    modelRevision: requiredText(contract.modelRevision, 'modelRevision'),
    dimensions,
    inputLimit,
    distance: contract.distance,
    normalization: contract.normalization,
    instruction: typeof contract.instruction === 'string' ? contract.instruction : '',
    configHash: crypto.createHash('sha256').update(JSON.stringify({
      provider: contract.provider,
      modelId: contract.modelId,
      modelRevision: contract.modelRevision,
      dimensions,
      inputLimit,
      distance: contract.distance,
      normalization: contract.normalization,
      instruction: typeof contract.instruction === 'string' ? contract.instruction : ''
    })).digest('hex')
  })
}

export function normalizeEmbeddingResponse(response, contract, { expectedCount } = {}) {
  const normalizedContract = validateEmbeddingProviderContract(contract)
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 256) {
    throw new TypeError('expectedCount is invalid')
  }
  if (!isPlainObject(response) || !Array.isArray(response.data) || response.data.length !== expectedCount) {
    throw new TypeError('embedding response count is invalid')
  }
  if (typeof response.model === 'string' && response.model !== normalizedContract.modelId) {
    throw new TypeError('embedding response model identity is stale')
  }
  const ordered = [...response.data].sort((left, right) => Number(left?.index) - Number(right?.index))
  const vectors = ordered.map((item, index) => {
    if (!isPlainObject(item) || item.index !== index || !Array.isArray(item.embedding) ||
        item.embedding.length !== normalizedContract.dimensions ||
        item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new TypeError(`embedding response item ${index} is invalid`)
    }
    return Object.freeze([...item.embedding])
  })
  const vectorSha256 = crypto.createHash('sha256').update(JSON.stringify(vectors)).digest('hex')
  return Object.freeze({ contract: normalizedContract, vectors: Object.freeze(vectors), vectorSha256 })
}

function normalizeSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) throw new TypeError('sections are invalid')
  return sections.map((section, index) => {
    if (!isPlainObject(section) || typeof section.text !== 'string' || !section.text.trim()) {
      throw new TypeError(`sections[${index}] is invalid`)
    }
    return Object.freeze({
      sectionPath: Object.freeze(Array.isArray(section.sectionPath) ? section.sectionPath.map(String) : []),
      text: section.text.trim()
    })
  })
}

export function chunkTokenizedSections(sections, tokenizer, { maxTokens, overlapTokens }) {
  if (!tokenizer || typeof tokenizer.encode !== 'function' || typeof tokenizer.decode !== 'function') {
    throw new TypeError('tokenizer adapter is invalid')
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens > 8192 ||
      !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens / 2) {
    throw new TypeError('chunk configuration is invalid')
  }
  const chunks = []
  for (const section of normalizeSections(sections)) {
    const tokens = tokenizer.encode(section.text)
    if (!Array.isArray(tokens) || tokens.length === 0) throw new TypeError('tokenizer returned invalid tokens')
    const step = maxTokens - overlapTokens
    for (let start = 0; start < tokens.length; start += step) {
      const end = Math.min(tokens.length, start + maxTokens)
      const body = tokenizer.decode(tokens.slice(start, end))
      chunks.push(Object.freeze({
        ordinal: chunks.length,
        sectionPath: section.sectionPath,
        tokenStart: start,
        tokenEnd: end,
        tokenCount: end - start,
        body,
        bodySha256: crypto.createHash('sha256').update(body).digest('hex')
      }))
      if (end === tokens.length) break
    }
  }
  return Object.freeze(chunks)
}

export function compareChunkConfigurations(sections, tokenizer, configurations) {
  if (!Array.isArray(configurations) || configurations.length === 0) throw new TypeError('configurations are invalid')
  return Object.freeze(configurations.map((configuration) => {
    const chunks = chunkTokenizedSections(sections, tokenizer, configuration)
    const duplicatedTokens = chunks.reduce((sum, chunk, index) => {
      if (index === 0 || chunks[index - 1].sectionPath !== chunk.sectionPath) return sum
      return sum + Math.max(0, chunks[index - 1].tokenEnd - chunk.tokenStart)
    }, 0)
    return Object.freeze({
      ...configuration,
      chunkCount: chunks.length,
      maxObservedTokens: Math.max(...chunks.map((chunk) => chunk.tokenCount)),
      duplicatedTokens,
      chunks
    })
  }))
}
