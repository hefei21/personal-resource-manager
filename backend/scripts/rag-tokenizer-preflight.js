import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { compareChunkConfigurations } from '../src/services/ragPreflight.js'

const corpusDirectory = path.resolve(process.argv[2] || '.rag-evaluation-corpus')
const transformersModule = process.env.TRANSFORMERS_MODULE
const modelId = process.env.EMBEDDING_MODEL_ID || 'Qwen/Qwen3-Embedding-0.6B'
const revision = process.env.EMBEDDING_MODEL_REVISION || '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
const modelPath = process.env.EMBEDDING_MODEL_PATH
if (!transformersModule) throw new Error('TRANSFORMERS_MODULE must point to an isolated Transformers.js module')

const { AutoTokenizer } = await import(pathToFileURL(path.resolve(transformersModule)).href)
const tokenizer = await AutoTokenizer.from_pretrained(modelPath ? path.resolve(modelPath) : modelId, {
  revision,
  local_files_only: Boolean(modelPath)
})
const manifest = JSON.parse(await fs.readFile(path.join(corpusDirectory, 'manifest.json'), 'utf8'))
const sections = await Promise.all(manifest.sources.map(async (source) => ({
  sectionPath: [source.id],
  text: await fs.readFile(path.join(corpusDirectory, source.file), 'utf8')
})))
const adapter = {
  encode(text) {
    return tokenizer.encode(text, { add_special_tokens: false })
  },
  decode(tokens) {
    return tokenizer.decode(tokens, { skip_special_tokens: false })
  }
}
const sourceTokenCounts = sections.map((section) => adapter.encode(section.text).length)
const reports = compareChunkConfigurations(sections, adapter, [
  { maxTokens: 384, overlapTokens: 48 },
  { maxTokens: 512, overlapTokens: 64 },
  { maxTokens: 768, overlapTokens: 96 }
]).map(({ chunks, ...report }) => ({
  ...report,
  duplicateRatio: Number((report.duplicatedTokens / chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0)).toFixed(4))
}))

console.log(`RAG_TOKENIZER_PREFLIGHT ${JSON.stringify({
  modelId,
  revision,
  sourceCount: sections.length,
  totalTokens: sourceTokenCounts.reduce((sum, count) => sum + count, 0),
  minSourceTokens: Math.min(...sourceTokenCounts),
  maxSourceTokens: Math.max(...sourceTokenCounts),
  configurations: reports
})}`)
