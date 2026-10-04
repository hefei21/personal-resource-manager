import { LMStudioClient } from '@lmstudio/sdk'
import { RAG_RUNTIME, RAG_RUNTIME_HASH, runtimeUrl, assertRuntime } from '../src/ragRuntime.js'

// Explicit operator action only. No automatic eject, model download or saved
// preset mutation. SDK load rejects an identifier that is already in use.
const client = new LMStudioClient({ baseUrl: runtimeUrl(process.env.PC_WORKER_ANSWER_BASE_URL || 'http://127.0.0.1:1234') })
let model
try {
  model = await client.llm.load(RAG_RUNTIME.modelKey, { identifier: RAG_RUNTIME.alias, config: RAG_RUNTIME.load, verbose: false })
  assertRuntime(await model.getModelInfo(), await model.getLoadConfig())
  console.log(JSON.stringify({ modelId: RAG_RUNTIME.alias, runtimeProfile: RAG_RUNTIME.id, profileHash: RAG_RUNTIME_HASH }))
} catch {
  // Only unload the instance created by this invocation, never an existing one.
  if (model) await model.unload().catch(() => {})
  console.error('RAG runtime did not start. Check local server, model availability and profile compatibility.')
  process.exitCode = 1
}
