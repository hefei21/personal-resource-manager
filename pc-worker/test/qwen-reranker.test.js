import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { QWEN_RERANKER_MODEL as model } from '../src/qwenReranker.js'
import { createRagRerankProcessor } from '../src/ragRerankProcessor.js'
import { createModelReadiness } from '../src/modelReadiness.js'
const apiKey = 'test-only-not-a-real-credential-0000'
const baseUrl = 'http://127.0.0.1:19091'
const config = { ...model, baseUrl, apiKey }
const hash = s => createHash('sha256').update(s).digest('hex')
function task(count = 50) {
  const candidates = Array.from({length:count}, (_,i) => ({candidateId:`C${i}`,text:`body${i}`}))
  return {taskType:'rag.rerank',processorVersion:'v1',executionClass:'gpu',input:{schemaVersion:1,model,query:'q',querySha256:hash('q'),
    candidateSetSha256:hash(JSON.stringify(candidates.map((c,index)=>({index,candidateId:c.candidateId,textSha256:hash(c.text)})))),candidates}}
}
test('Qwen configuration is explicit, pinned, local and authenticated', () => {
  const env = {PC_WORKER_NAS_BASE_URL:'https://nas.example.test',PC_WORKER_RERANKER_BASE_URL:baseUrl,PC_WORKER_RERANKER_MODEL_ID:model.modelId,PC_WORKER_RERANKER_API_KEY:apiKey}
  assert.equal(loadConfig(env).reranker.maxBatchItems,50)
  for (const change of [{PC_WORKER_RERANKER_API_KEY:''},{PC_WORKER_RERANKER_BASE_URL:'https://remote.test'}, {PC_WORKER_RERANKER_CONFIG_HASH:'a'.repeat(64)}]) assert.throws(()=>loadConfig({...env,...change}))
})
test('Qwen sends pinned identity and preserves a complete fifty-candidate permutation', async () => {
  const processor=createRagRerankProcessor({config,fetchImpl:async(url,options)=>{
    assert.equal(url,baseUrl+'/rerank');assert.equal(options.headers.authorization,'Bearer '+apiKey)
    const input=JSON.parse(options.body);assert.deepEqual(input.model,model);assert.equal(input.texts.length,50)
    return {ok:true,headers:new Headers(),json:async()=>input.texts.map((_,index)=>({index,score:index}))}
  }})
  const result=await processor.process(task());assert.equal(result.output.candidates[0].candidateId,'C49')
  await assert.rejects(processor.process(task(51)),{code:'WORKER_RERANK_INPUT_INVALID'})
  assert.equal(createRagRerankProcessor({config:{...config,modelRevision:'main'}}).configured,false)
})
test('Qwen readiness requires authenticated complete identity, not just health', async () => {
  for(const good of [true,false]){
    const readiness=createModelReadiness({reranker:config,fetchImpl:async(url,opts)=>{
      assert.equal(url,baseUrl+'/info');assert.equal(opts.headers.authorization,'Bearer '+apiKey)
      return {ok:true,json:async()=>({model_type:'reranker',model:good?model:{...model,configHash:'bad'}})}
    }})
    await readiness.refresh({force:true});assert.equal(readiness.isReady('reranker'),good)
  }
})
test('Qwen readiness never sends token to an overridden nonlocal endpoint', async () => {
  let calls=0
  const readiness=createModelReadiness({reranker:{...config,infoEndpoint:'https://evil.test/info',healthEndpoint:'https://evil.test/health'},fetchImpl:async()=>{calls++;throw Error('unexpected')}})
  await readiness.refresh({force:true});assert.equal(calls,0);assert.equal(readiness.isReady('reranker'),false)
})
