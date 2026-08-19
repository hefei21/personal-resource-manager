import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import express from 'express'

import { createStorageConsistencyRouter } from '../src/routes/storageConsistency.js'

function resultFixture() {
  return {
    inspectedAt: '2026-08-14T00:00:00.000Z',
    issueCount: 1,
    summary: { MISSING_OBJECT: 1 },
    issues: [{
      code: 'MISSING_OBJECT',
      severity: 'error',
      disposition: 'manual_confirmation',
      resourceType: 'documents',
      objectId: 'object:0123456789abcdef',
      evidence: { hiddenPath: 'C:\\private\\document.txt', originalName: 'private.txt' }
    }]
  }
}

function testAuthentication(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  next()
}

function testOwner(req, res, next) {
  if (req.user?.principal !== 'owner') return res.status(403).json({ code: 'OWNER_REQUIRED' })
  next()
}

async function withServer(inspect, callback) {
  const app = express()
  app.use('/api/storage-consistency', createStorageConsistencyRouter({
    authenticate: testAuthentication,
    authorize: testOwner,
    inspect
  }))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('rejects anonymous and demo callers before running the inspector', async () => {
  let calls = 0
  await withServer(async () => { calls += 1; return resultFixture() }, async baseUrl => {
    const anonymous = await fetch(`${baseUrl}/api/storage-consistency`)
    assert.equal(anonymous.status, 401)
    const demo = await fetch(`${baseUrl}/api/storage-consistency`, { headers: { 'x-test-role': 'demo' } })
    assert.equal(demo.status, 403)
  })
  assert.equal(calls, 0)
})

test('returns a stable owner-only summary without paths, names, contents or repair execution', async () => {
  await withServer(async () => resultFixture(), async baseUrl => {
    const request = () => fetch(`${baseUrl}/api/storage-consistency`, { headers: { 'x-test-role': 'owner' } })
    const first = await request()
    const second = await request()
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const firstBody = await first.json()
    const secondBody = await second.json()
    assert.deepEqual(firstBody, secondBody)
    assert.deepEqual(firstBody.data.counts, {
      total: 1,
      byCode: { MISSING_OBJECT: 1 },
      bySeverity: { error: 1 },
      byDisposition: { manual_confirmation: 1 }
    })
    assert.equal(firstBody.data.repairExecutionAvailable, false)
    assert.equal(firstBody.data.issues[0].code, 'MISSING_OBJECT')
    assert.match(firstBody.data.issues[0].risk, /数据库引用/)
    assert.match(firstBody.data.issues[0].suggestedAction, /备份|副本/)
    assert.match(firstBody.data.issues[0].recoveryPath, /恢复/)
    const serialized = JSON.stringify(firstBody)
    assert.equal(serialized.includes('C:\\private'), false)
    assert.equal(serialized.includes('private.txt'), false)
    assert.equal(serialized.includes('hiddenPath'), false)
    assert.equal(serialized.includes('evidence'), false)
  })
})

test('maps internal errors to a stable response without leaking paths or stacks', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    await withServer(async () => {
      const error = new Error('failed at C:\\private\\document.txt')
      error.code = 'CONSISTENCY_STORAGE_LAYOUT_INVALID'
      throw error
    }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/storage-consistency`, { headers: { 'x-test-role': 'owner' } })
      assert.equal(response.status, 500)
      const body = await response.json()
      assert.deepEqual(body, {
        message: '存储一致性巡检失败',
        code: 'STORAGE_CONSISTENCY_INSPECTION_FAILED'
      })
      assert.equal(JSON.stringify(body).includes('C:\\private'), false)
    })
  } finally {
    console.error = originalError
  }
})
