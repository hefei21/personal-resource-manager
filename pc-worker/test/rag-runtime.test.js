import test from 'node:test'
import assert from 'node:assert/strict'
import { RAG_RUNTIME as profile, RAG_RUNTIME_HASH, runtimeUrl, assertRuntime, assertPrediction, createRagRuntimeFetch } from '../src/ragRuntime.js'
import { loadConfig } from '../src/config.js'

const config = { baseUrl: 'http://127.0.0.1:1234', modelId: profile.alias, runtimeProfile: profile.id }
const info = { identifier: profile.alias, path: profile.modelKey }
const body = { model: profile.alias, messages: [{ role: 'user', content: 'public fixture' }],
  response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } } }
const request = (signal, value = body) => ({ signal, body: JSON.stringify(value) })
const success = { stats: { stopReason: 'eosFound' }, nonReasoningContent: '{"answer":"ok"}' }
function effective(p) {
  const checked = value => ({ checked: true, value })
  return { fields: Object.entries({ temperature:p.temperature,topKSampling:p.topKSampling,
    topPSampling:checked(p.topPSampling),minPSampling:checked(p.minPSampling),repeatPenalty:checked(p.repeatPenalty),
    'llama.presencePenalty':checked(p.presencePenalty),'reasoning.budgetTokens':checked(p.reasoningBudget),
    'reasoning.enableThinking':p.enableThinking,maxPredictedTokens:checked(p.maxTokens),contextOverflowPolicy:p.contextOverflowPolicy,
    stopStrings:[],promptTemplate:p.promptTemplate,structured:p.structured,tools:{type:'none'}
  }).map(([key,value])=>({key:`llm.prediction.${key}`,value})) }
}
function fixture(overrides = {}) {
  const calls = []
  const model = { getModelInfo: async () => info, getLoadConfig: async () => structuredClone(profile.load),
    respond: (messages, prediction) => { calls.push({ messages, prediction }); return Promise.resolve({...success,predictionConfig:effective(prediction)}) }, ...overrides }
  const fetch = createRagRuntimeFetch({ config, clientFactory: async () => ({ llm: { model: async alias => {
    assert.equal(alias, profile.alias); return model
  } } }) })
  return { fetch, calls }
}
test('runtime profile is immutable, identified and strictly loopback', () => {
  assert.match(RAG_RUNTIME_HASH, /^[a-f0-9]{64}$/)
  assert.throws(() => { profile.load.reasoningBudgetMessage = 'roleplay' })
  assert.equal(runtimeUrl(config.baseUrl + '/v1'), 'ws://127.0.0.1:1234')
  for (const url of ['https://example.com', 'http://127.0.0.1/x', 'http://user@localhost', 'http://localhost/?token=x']) assert.throws(() => runtimeUrl(url))
  assert.throws(() => createRagRuntimeFetch({ config: { ...config, apiKey: 'secret' } }))
})
test('runtime validates every required load field and model before evidence is sent', async () => {
  assertRuntime(info, profile.load)
  assert.throws(() => assertRuntime({ ...info, path: 'another-model' }, profile.load))
  for (const [key, value] of Object.entries(profile.load)) {
    const changed = structuredClone(profile.load); delete changed[key]
    assert.throws(() => assertRuntime(info, changed), key)
    changed[key] = typeof value === 'string' ? 'changed' : null
    assert.throws(() => assertRuntime(info, changed), key)
  }
  const f = fixture({ getLoadConfig: async () => ({ ...profile.load, reasoningBudgetMessage: 'roleplay' }) })
  await assert.rejects(f.fetch(config.baseUrl, request()))
  assert.equal(f.calls.length, 0)
})
test('answer requests pin sampling/template/budget; translation alone disables thinking', async () => {
  const f = fixture()
  const result = await (await f.fetch(config.baseUrl, request())).json()
  assert.equal(result.model, profile.alias)
  assert.equal(result.choices[0].finish_reason, 'stop')
  const params = f.calls[0].prediction
  for (const [key, value] of Object.entries(profile.prediction)) assert.deepEqual(params[key], value)
  assert.deepEqual(params.promptTemplate, { ...profile.load.promptTemplate, stopStrings: [] })
  const translate = structuredClone(body); translate.response_format.json_schema.name = 'search_queries'
  await f.fetch(config.baseUrl, request(undefined, translate))
  assert.equal(f.calls[1].prediction.enableThinking, false)
  assert.equal(f.calls[1].prediction.maxTokens, 2048)
})
test('pre-cancel and cancellation during readiness cannot send evidence later', async () => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const f = fixture({ getLoadConfig: () => ready })
  const controller = new AbortController()
  const pending = f.fetch(config.baseUrl, request(controller.signal))
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  release(profile.load)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.fetch(config.baseUrl, request(controller.signal)))
})
test('inference cancellation calls prediction.cancel and ignores late output', async () => {
  let started, finish, cancelled = 0
  const began = new Promise(resolve => { started = resolve })
  const prediction = new Promise(resolve => { finish = resolve }); prediction.cancel = () => { cancelled++ }
  const f = fixture({ respond: () => { started(); return prediction } })
  const controller = new AbortController()
  const pending = f.fetch(config.baseUrl, request(controller.signal))
  await began; controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  assert.equal(cancelled, 1); finish(success)
})
test('missing model, wrong endpoint or identity never falls back or loads a model', async () => {
  const f = fixture({ getModelInfo: async () => { throw new Error('offline') } })
  await assert.rejects(f.fetch(config.baseUrl, request()), /offline/)
  await assert.rejects(f.fetch('http://127.0.0.1:9999', request()))
  await assert.rejects(f.fetch(config.baseUrl, request(undefined, { ...body, model: 'chat' })))
  assert.equal(f.calls.length, 0)
})
test('ignored prediction settings fail closed instead of returning an answer', async () => {
  const f = fixture({ respond: async () => success })
  await assert.rejects(f.fetch(config.baseUrl, request()), /mismatch/)
  const p = {...profile.prediction,promptTemplate:{...profile.load.promptTemplate,stopStrings:[]},structured:{type:'json',jsonSchema:{}}}
  for(const field of effective(p).fields){
    const changed=effective(p);changed.fields.find(f=>f.key===field.key).value=null
    assert.throws(()=>assertPrediction(changed,p),field.key)
  }
})
test('opt-in config rejects incomplete profiles and hashes bind runtime identity', () => {
  const env = { PC_WORKER_NAS_BASE_URL: 'https://nas.example.test', PC_WORKER_ANSWER_BASE_URL: config.baseUrl,
    PC_WORKER_ANSWER_PROVIDER: 'lm-studio', PC_WORKER_ANSWER_MODEL_ID: profile.alias,
    PC_WORKER_ANSWER_MODEL_REVISION: 'q6-test', PC_WORKER_ANSWER_CONTEXT_LIMIT: '32768',
    PC_WORKER_ANSWER_MAX_OUTPUT_BYTES: '16384' }
  const old = loadConfig(env).answer
  const explicit = loadConfig({ ...env, PC_WORKER_ANSWER_RUNTIME_PROFILE: profile.id }).answer
  assert.equal(old.runtimeProfile, undefined)
  assert.notEqual(old.configHash, explicit.configHash)
  assert.equal(explicit.runtimeProfile, profile.id)
  for (const change of [{ PC_WORKER_ANSWER_MODEL_ID: 'chat' }, { PC_WORKER_ANSWER_CONFIG_HASH: old.configHash },
    { PC_WORKER_ANSWER_API_KEY: 'secret' }, { PC_WORKER_ANSWER_BASE_URL: 'https://example.com' }]) {
    assert.throws(() => loadConfig({ ...env, PC_WORKER_ANSWER_RUNTIME_PROFILE: profile.id, ...change }))
  }
  assert.throws(() => loadConfig({ PC_WORKER_NAS_BASE_URL: env.PC_WORKER_NAS_BASE_URL, PC_WORKER_ANSWER_RUNTIME_PROFILE: profile.id }))
})
