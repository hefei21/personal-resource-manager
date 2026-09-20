import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequestLogger, isEmptyWorkerClaim, logActor, logPath } from '../src/services/requestLogPolicy.js'

const request = () => ({ method: 'POST', originalUrl: '/api/pc-worker-agent/tasks/claim?ignored=secret', path: '/tasks/claim', pcWorker: { id: 'pcw-synthetic' } })
test('only authenticated route-confirmed 204 claims are quiet', () => {
  const req = request(), res = { statusCode: 204, pcWorkerEmptyClaim: true }
  assert.equal(isEmptyWorkerClaim(req,res),true)
  for (const statusCode of [200, 400, 401, 403, 404, 409, 429, 500, 503])
    assert.equal(isEmptyWorkerClaim(req,{ ...res, statusCode }),false)
  assert.equal(isEmptyWorkerClaim({ ...req, pcWorker: null },res),false)
  assert.equal(isEmptyWorkerClaim(req,{ ...res, pcWorkerEmptyClaim: false }),false)
  assert.equal(isEmptyWorkerClaim({ ...req, originalUrl: '/api/pc-worker-agent/tasks/1/heartbeat' },res),false)
  assert.equal(logPath(req),'/api/pc-worker-agent/tasks/claim')
  assert.deepEqual(logActor(req),{ userId: null, username: 'worker:pcw-synthetic' })
  assert.deepEqual(logActor({ user: { id: 7, username: 'synthetic' } }),{ userId: 7, username: 'synthetic' })
})
test('container logger waits for response and aggregates idle claims without hiding errors or work', () => {
  const lines = []; let time = 0
  const log = createRequestLogger({ write: line => lines.push(line), now: () => time, intervalMs: 300_000 })
  const emit = (statusCode, authenticated = true) => {
    const req = request(); if (!authenticated) delete req.pcWorker
    const res = Object.assign(new EventEmitter(), { statusCode, pcWorkerEmptyClaim: statusCode === 204 })
    log(req,res,()=>{}); res.emit('finish')
  }
  for(let i=0;i<100;i++) emit(204)
  assert.equal(lines.length,0)
  time = 300_000; emit(204)
  assert.match(lines[0],/101 successful empty claims/)
  for(const status of [200,400,401,409,429,500]) emit(status,status!==401)
  assert.equal(lines.length,7); assert.match(lines[1],/actor=worker:/); assert.match(lines[3],/actor=guest/)
  assert.ok(lines.every(line=>!line.includes('secret')))
})
