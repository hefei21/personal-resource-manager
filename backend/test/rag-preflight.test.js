import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chunkTokenizedSections,
  compareChunkConfigurations,
  normalizeEmbeddingResponse,
  validateEmbeddingProviderContract
} from '../src/services/ragPreflight.js'

const tokenizer = {
  encode(text) {
    return text.split(/\s+/u).filter(Boolean)
  },
  decode(tokens) {
    return tokens.join(' ')
  }
}

const embeddingContract = {
  provider: 'local-openai-compatible',
  modelId: 'Qwen/Qwen3-Embedding-0.6B',
  modelRevision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3',
  dimensions: 1024,
  inputLimit: 32768,
  distance: 'cosine',
  normalization: 'l2',
  instruction: 'Represent this document for retrieval:'
}

test('requires immutable embedding identity and produces a stable config hash', () => {
  const first = validateEmbeddingProviderContract(embeddingContract)
  const second = validateEmbeddingProviderContract({ ...embeddingContract })
  assert.equal(first.configHash, second.configHash)
  assert.equal(first.dimensions, 1024)
  assert.throws(() => validateEmbeddingProviderContract({ ...embeddingContract, modelRevision: '' }), /modelRevision/u)
})

test('rejects stale, malformed, non-finite, and wrong-dimension embedding batches', () => {
  const vector = Array.from({ length: 1024 }, (_, index) => index / 1024)
  const accepted = normalizeEmbeddingResponse({
    model: embeddingContract.modelId,
    data: [{ index: 0, embedding: vector }]
  }, embeddingContract, { expectedCount: 1 })
  assert.equal(accepted.vectors.length, 1)
  assert.match(accepted.vectorSha256, /^[a-f0-9]{64}$/u)
  assert.throws(() => normalizeEmbeddingResponse({ model: 'stale-model', data: [{ index: 0, embedding: vector }] }, embeddingContract, { expectedCount: 1 }), /stale/u)
  assert.throws(() => normalizeEmbeddingResponse({ data: [{ index: 0, embedding: [1, 2] }] }, embeddingContract, { expectedCount: 1 }), /invalid/u)
  assert.throws(() => normalizeEmbeddingResponse({ data: [{ index: 0, embedding: [...vector.slice(0, -1), Number.NaN] }] }, embeddingContract, { expectedCount: 1 }), /invalid/u)
})

test('compares 384, 512, and 768 token chunks through an explicit tokenizer adapter', () => {
  const sections = [{ sectionPath: ['Book', 'Chapter 1'], text: Array.from({ length: 1800 }, (_, index) => `token-${index}`).join(' ') }]
  const reports = compareChunkConfigurations(sections, tokenizer, [
    { maxTokens: 384, overlapTokens: 48 },
    { maxTokens: 512, overlapTokens: 64 },
    { maxTokens: 768, overlapTokens: 96 }
  ])
  assert.deepEqual(reports.map((report) => report.maxTokens), [384, 512, 768])
  assert.ok(reports.every((report) => report.maxObservedTokens <= report.maxTokens))
  assert.ok(reports.every((report) => report.duplicatedTokens > 0))
  assert.ok(reports[0].chunkCount > reports[2].chunkCount)
})

test('never crosses section boundaries while applying overlap', () => {
  const chunks = chunkTokenizedSections([
    { sectionPath: ['A'], text: Array.from({ length: 80 }, (_, index) => `a${index}`).join(' ') },
    { sectionPath: ['B'], text: Array.from({ length: 80 }, (_, index) => `b${index}`).join(' ') }
  ], tokenizer, { maxTokens: 64, overlapTokens: 8 })
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.sectionPath[0]))], ['A', 'B'])
  assert.ok(chunks.filter((chunk) => chunk.sectionPath[0] === 'A').every((chunk) => !chunk.body.includes('b0')))
  assert.ok(chunks.filter((chunk) => chunk.sectionPath[0] === 'B').every((chunk) => !chunk.body.includes('a0')))
})
