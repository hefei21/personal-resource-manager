import { createHash } from 'node:crypto'
import { answerProcessorsForConfig } from './ragAnswerProcessor.js'
import { translateRetrievalQuery } from './ragQueryTranslation.js'
import { createQueryTranslationTransport } from './ragQueryTranslationTransport.js'

export function createQueryTranslationProcessor({ enabled = false, config, fetchImpl = fetch } = {}) {
  const configured = enabled === true && answerProcessorsForConfig(config).length > 0
  const complete = configured ? createQueryTranslationTransport({ ...config, fetchImpl }) : null
  const capability = configured ? { taskType: 'rag.query.translate', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 } : null
  return {
    capability,
    supports: type => configured && type === 'rag.query.translate',
    async process(task, { signal, remainingMs = 0 } = {}) {
      const input = task?.input
      const bad = () => { throw Object.assign(new Error('Translation task is invalid.'), { code: 'WORKER_TRANSLATION_INPUT_INVALID', retryable: false }) }
      if (!configured || task.taskType !== 'rag.query.translate' || task.processorVersion !== 'v1' || task.executionClass !== 'gpu' ||
          !input || input.schemaVersion !== 1 || input.modelId !== config.modelId || input.modelRevision !== config.modelRevision ||
          typeof input.requestId !== 'string' || !input.requestId || typeof input.query !== 'string' || input.query.length > 1024 ||
          createHash('sha256').update(input.query).digest('hex') !== input.querySha256) bad()
      if (!Number.isFinite(remainingMs) || remainingMs < 0 || remainingMs > 2000) bad()
      // Only elapsed monotonic time is used on PC. Never compare NAS expiresAt
      // with PC Date.now(): the two machines need not have matching wall clocks.
      const now = () => Math.floor(performance.now())
      const result = await translateRetrievalQuery({ query: input.query, enabled: true, complete, signal,
        expiresAt: now() + Math.floor(remainingMs), now })
      return { schemaVersion: 1, processorVersion: 'v1', output: {
        requestId: input.requestId, querySha256: input.querySha256, modelId: input.modelId,
        modelRevision: input.modelRevision, ...result
      } }
    }
  }
}
