import { createHash } from 'node:crypto'

export const TRANSLATION_TASK_TYPE = 'rag.query.translate'
const error = () => { throw Object.assign(new Error('Invalid translation contract.'), { code: 'PC_WORKER_PROCESSOR_INPUT_INVALID' }) }
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) error()
}
export function projectTranslationInput(input) {
  exact(input, ['schemaVersion', 'requestId', 'query', 'querySha256', 'modelId', 'modelRevision', 'expiresAt'])
  if (input.schemaVersion !== 1 || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(input.query) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) error()
  for (const key of ['requestId', 'modelId', 'modelRevision']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(input[key])) error()
  }
  if (createHash('sha256').update(input.query).digest('hex') !== input.querySha256) error()
  return Object.freeze({ ...input })
}
export function normalizeTranslationResult(value, expected) {
  exact(value, ['schemaVersion', 'processorVersion', 'output'])
  if (value.schemaVersion !== 1 || value.processorVersion !== 'v1') error()
  const input = projectTranslationInput(expected?.input ?? expected)
  const output = value.output
  exact(output, ['requestId', 'querySha256', 'modelId', 'modelRevision', 'status', 'queries'])
  for (const key of ['requestId', 'querySha256', 'modelId', 'modelRevision']) if (output[key] !== input[key]) error()
  if (!['enhanced', 'timeout', 'unavailable', 'invalid', 'rejected', 'not_applicable'].includes(output.status) ||
      !Array.isArray(output.queries) || output.queries.length < 1 || output.queries.length > 3 || output.queries[0] !== input.query ||
      (output.status !== 'enhanced' && output.queries.length !== 1) ||
      (output.status === 'enhanced' && output.queries.length < 2)) error()
  const tokens = text => text.match(/(?:--?|\+)?[A-Za-z0-9][A-Za-z0-9_.]*(?:=[+-]?[A-Za-z0-9_.]+)?/gu) ?? []
  for (const query of output.queries.slice(1)) {
    if (typeof query !== 'string' || !query.trim() || query.length > 1024 || /[\u0000-\u001f\u007f]/u.test(query) || /https?:\/\//iu.test(query) ||
        tokens(input.query).some(token => !new Set(tokens(query)).has(token))) error()
  }
  if (new Set(output.queries).size !== output.queries.length) error()
  return Object.freeze({ ...value, output: Object.freeze({ ...output, queries: Object.freeze([...output.queries]) }) })
}
