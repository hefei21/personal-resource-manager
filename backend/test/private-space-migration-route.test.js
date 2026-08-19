import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'

import { createPrivateSpaceMigrationRouter } from '../src/routes/privateSpaceMigration.js'

function testAuthentication(req, res, next) {
  const role = req.get('x-test-role')
  if (!role) return res.status(401).json({ code: 'SESSION_REQUIRED' })
  req.user = { principal: role }
  next()
}

function testOwner(req, res, next) {
  if (req.user?.principal !== 'owner') {
    return res.status(403).json({ code: 'OWNER_REQUIRED' })
  }
  next()
}

function resultFixture({ verified = true, issues = [] } = {}) {
  return {
    operation: 'expand',
    verified,
    checks: {
      oldRecordCount: verified,
      mappingCount: verified,
      sourceTotalBytes: verified,
      fileExistence: verified,
      sourceHashes: verified,
      targetStorage: verified,
      duplicateContent: verified,
      bounds: verified
    },
    stats: {
      recordCount: 2,
      mappingCount: 2,
      mappedCount: verified ? 2 : 1,
      sourceBytes: 18,
      targetBytes: verified ? 18 : 0,
      uniqueContentCount: 1,
      duplicateContentGroups: 1,
      duplicateContentCount: 1,
      uniqueObjectCount: 1,
      uniqueObjectBytes: 9,
      migratedCount: verified ? 2 : 1,
      skippedCount: 0,
      failedCount: verified ? 0 : 1,
      reusedObjectCount: 1,
      outsideRootCount: 0,
      missingSourceCount: 0,
      symlinkCount: 0,
      nonRegularFileCount: 0,
      sizeMismatchCount: 0,
      hashMismatchCount: 0,
      secretId: 9001
    },
    records: [{
      legacyDocumentId: 7,
      documentId: 41,
      versionId: 42,
      objectId: 'documents:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'private title',
      path: 'C:\\private\\secret.txt',
      content: 'private content',
      password: 'private password'
    }],
    issues
  }
}

async function withServer(options, callback) {
  const app = express()
  app.use(express.json())
  app.use('/api/private-space-migration', createPrivateSpaceMigrationRouter({
    authenticate: testAuthentication,
    authorize: testOwner,
    ...options
  }))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

function ownerHeaders() {
  return { 'x-test-role': 'owner' }
}

test('rejects anonymous and demo callers before invoking migration service', async () => {
  let expandCalls = 0
  let verifyCalls = 0
  await withServer({
    expand: async () => { expandCalls += 1; return resultFixture() },
    verify: async () => { verifyCalls += 1; return resultFixture() }
  }, async baseUrl => {
    const anonymous = await fetch(`${baseUrl}/api/private-space-migration/verify`)
    const demo = await fetch(`${baseUrl}/api/private-space-migration/verify`, {
      headers: { 'x-test-role': 'demo' }
    })
    assert.equal(anonymous.status, 401)
    assert.equal(demo.status, 403)
  })
  assert.equal(expandCalls, 0)
  assert.equal(verifyCalls, 0)
})

test('requires the exact expand confirmation and does not call service on rejection', async () => {
  let expandCalls = 0
  await withServer({
    expand: async () => { expandCalls += 1; return resultFixture() }
  }, async baseUrl => {
    const rejectedBodies = [
      {
        headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({})
      },
      {
        headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'expand_private_space' })
      },
      {
        headers: { ...ownerHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'confirmation=EXPAND_PRIVATE_SPACE'
      }
    ]
    for (const rejected of rejectedBodies) {
      const response = await fetch(`${baseUrl}/api/private-space-migration/expand`, {
        method: 'POST',
        headers: rejected.headers,
        body: rejected.body
      })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), {
        code: 'PRIVATE_MIGRATION_CONFIRMATION_REQUIRED'
      })
    }
  })
  assert.equal(expandCalls, 0)
})

test('returns a sanitized 200 summary for a verified expand', async () => {
  let expandCalls = 0
  await withServer({
    expand: async () => { expandCalls += 1; return resultFixture() }
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/private-space-migration/expand`, {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'EXPAND_PRIVATE_SPACE' })
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.operation, 'expand')
    assert.equal(body.verified, true)
    assert.equal(body.legacyCleanupAvailable, false)
    assert.equal(body.contractRetirementAllowed, true)
    assert.equal(body.issueCounts.total, 0)
    assert.equal(body.stats.secretId, undefined)
    assert.equal(body.records, undefined)
    assert.equal(body.cleanup, undefined)
    assert.equal(body.contractRetirement, undefined)
    const serialized = JSON.stringify(body)
    for (const secret of [
      'private title',
      'C:\\private\\secret.txt',
      'private content',
      'private password',
      'documents:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ]) {
      assert.equal(serialized.includes(secret), false)
    }

    const cleanupResponse = await fetch(`${baseUrl}/api/private-space-migration/cleanup`, {
      method: 'POST',
      headers: ownerHeaders()
    })
    assert.equal(cleanupResponse.status, 404)
  })
  assert.equal(expandCalls, 1)
})

test('returns a sanitized 409 summary when expand is blocked', async () => {
  const issues = [
    {
      code: 'PRIVATE_MIGRATION_SOURCE_MISSING',
      severity: 'error',
      disposition: 'blocked',
      legacyDocumentId: 7,
      objectId: 'documents:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      path: 'C:\\private\\missing.txt'
    },
    {
      code: 'PRIVATE_MIGRATION_SOURCE_MISSING',
      severity: 'error',
      disposition: 'blocked',
      legacyDocumentId: 8
    }
  ]
  await withServer({ expand: async () => resultFixture({ verified: false, issues }) }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/private-space-migration/expand`, {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'EXPAND_PRIVATE_SPACE' })
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'PRIVATE_MIGRATION_EXPAND_BLOCKED')
    assert.equal(body.summary.operation, 'expand')
    assert.equal(body.summary.verified, false)
    assert.equal(body.summary.contractRetirementAllowed, false)
    assert.deepEqual(body.summary.issueCounts, {
      total: 2,
      byCode: { PRIVATE_MIGRATION_SOURCE_MISSING: 2 },
      bySeverity: { error: 2 },
      byDisposition: { blocked: 2 }
    })
    assert.equal(JSON.stringify(body).includes('missing.txt'), false)
    assert.equal(JSON.stringify(body).includes('bbbbbbbb'), false)
  })
})

test('verify returns 200 for both an open and a blocked gate', async () => {
  for (const verified of [true, false]) {
    let verifyCalls = 0
    await withServer({
      verify: async () => { verifyCalls += 1; return resultFixture({ verified }) }
    }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/private-space-migration/verify`, {
        headers: ownerHeaders()
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.operation, 'verify')
      assert.equal(body.verified, verified)
      assert.equal(body.contractRetirementAllowed, verified)
      assert.equal(body.legacyCleanupAvailable, false)
    })
    assert.equal(verifyCalls, 1)
  }
})

test('maps service exceptions to stable 500 responses without leaking details', async () => {
  await withServer({
    expand: async () => {
      const error = new Error('failed at C:\\private\\secret.txt')
      error.code = 'PRIVATE_MIGRATION_SOURCE_MISSING'
      throw error
    },
    verify: async () => {
      throw new Error('failed at C:\\private\\secret.txt')
    }
  }, async baseUrl => {
    const expandResponse = await fetch(`${baseUrl}/api/private-space-migration/expand`, {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'EXPAND_PRIVATE_SPACE' })
    })
    const verifyResponse = await fetch(`${baseUrl}/api/private-space-migration/verify`, {
      headers: ownerHeaders()
    })
    assert.equal(expandResponse.status, 500)
    assert.equal(verifyResponse.status, 500)
    assert.deepEqual(await expandResponse.json(), {
      code: 'PRIVATE_MIGRATION_EXPAND_FAILED'
    })
    assert.deepEqual(await verifyResponse.json(), {
      code: 'PRIVATE_MIGRATION_VERIFY_FAILED'
    })
  })
})
