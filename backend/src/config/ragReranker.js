export const RAG_RERANKER_MODEL = Object.freeze({
  provider: 'hugging-face-tei',
  modelId: 'BAAI/bge-reranker-v2-m3',
  modelRevision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
  dimensions: 1,
  inputLimit: 512,
  configHash: '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'
})

const ENV_FIELDS = Object.freeze({
  provider: 'RAG_RERANKER_PROVIDER',
  modelId: 'RAG_RERANKER_MODEL_ID',
  modelRevision: 'RAG_RERANKER_MODEL_REVISION',
  dimensions: 'RAG_RERANKER_DIMENSIONS',
  inputLimit: 'RAG_RERANKER_INPUT_LIMIT',
  configHash: 'RAG_RERANKER_CONFIG_HASH'
})

export function loadRagRerankerModel(env = process.env) {
  if (env?.RAG_RERANKER_ENABLED !== 'true') return null
  const candidate = {
    provider: env[ENV_FIELDS.provider],
    modelId: env[ENV_FIELDS.modelId],
    modelRevision: env[ENV_FIELDS.modelRevision],
    dimensions: Number(env[ENV_FIELDS.dimensions]),
    inputLimit: Number(env[ENV_FIELDS.inputLimit]),
    configHash: env[ENV_FIELDS.configHash]
  }
  return Object.entries(RAG_RERANKER_MODEL).every(([key, value]) => candidate[key] === value)
    ? RAG_RERANKER_MODEL
    : null
}
