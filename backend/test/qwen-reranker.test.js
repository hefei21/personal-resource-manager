import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QWEN_RERANKER_MODEL as model } from '../src/config/qwenReranker.js'
import { loadRagRerankerModel, RAG_RERANKER_MODEL } from '../src/config/ragReranker.js'
import { createRagRerankService } from '../src/services/ragRerankService.js'
test('Qwen profile copies stay identical across independently packaged components',()=>{
  assert.deepEqual(JSON.parse(readFileSync(new URL('../src/config/qwenRerankerProfile.json',import.meta.url))),JSON.parse(readFileSync(new URL('../../pc-worker/reranker/profile.json',import.meta.url))))
})
test('Qwen backend configuration defaults off and rejects partial identities',()=>{
  const env={RAG_RERANKER_ENABLED:'true',RAG_RERANKER_PROVIDER:model.provider,RAG_RERANKER_MODEL_ID:model.modelId,RAG_RERANKER_MODEL_REVISION:model.modelRevision,RAG_RERANKER_DIMENSIONS:'1',RAG_RERANKER_INPUT_LIMIT:'2048',RAG_RERANKER_CONFIG_HASH:model.configHash}
  assert.deepEqual(loadRagRerankerModel(env),model)
  assert.equal(loadRagRerankerModel({...env,RAG_RERANKER_ENABLED:'false'}),null)
  assert.equal(loadRagRerankerModel({...env,RAG_RERANKER_CONFIG_HASH:'bad'}),null)
})
test('Qwen fifty-candidate tasks traverse catalog and results without widening BGE',async()=>{
  assert.throws(()=>createRagRerankService({model:RAG_RERANKER_MODEL,maxCandidates:50}))
  const candidates=Array.from({length:50},(_,i)=>({citationId:`C${i}`,body:`evidence ${i}`}))
  const service=createRagRerankService({model,maxCandidates:50,workerAvailable:async()=>true,taskStore:{async enqueueExclusiveRun(request){
    const input=request.input;assert.equal(input.candidates.length,50)
    return {task:{id:7,status:'succeeded',result:{schemaVersion:1,processorVersion:'v1',output:{model,querySha256:input.querySha256,candidateSetSha256:input.candidateSetSha256,candidates:input.candidates.map(c=>({candidateId:c.candidateId,score:1}))}}}}
  }}})
  const result=await service.rerank({query:'q',candidates});assert.equal(result.applied,true);assert.deepEqual(result.candidates,candidates)
  const offline=createRagRerankService({model,maxCandidates:50,workerAvailable:async()=>false})
  const degraded=await offline.rerank({query:'q',candidates});assert.equal(degraded.applied,false);assert.deepEqual(degraded.candidates,candidates)
})
