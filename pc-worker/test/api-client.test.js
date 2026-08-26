import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkerApiClient } from '../src/apiClient.js'

test('uploads artifacts as bounded binary JSON with lease and metadata headers', async () => {
  let request
  const client = new WorkerApiClient({
    baseUrl: 'http://nas.test',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 201, json: async () => ({ data: { artifactBytes: 1 } }) }
    }
  })
  const artifact = { schemaVersion: 1, format: 'docx', sections: [] }
  const metadata = { artifactSha256: 'a'.repeat(64), artifactBytes: 42, sectionCount: 0, format: 'docx' }
  const result = await client.uploadArtifact('access', { id: 17, leaseToken: 'lease' }, { artifact, metadata })
  assert.deepEqual(result, { artifactBytes: 1 })
  assert.equal(request.url, 'http://nas.test/api/pc-worker-agent/tasks/17/artifact')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.authorization, 'Bearer access')
  assert.equal(request.options.headers['x-worker-lease'], 'lease')
  assert.equal(request.options.headers['content-type'], 'application/octet-stream')
  assert.equal(request.options.headers['x-artifact-sha256'], metadata.artifactSha256)
  assert.equal(request.options.body, JSON.stringify(artifact))
  assert.equal(request.options.body.includes('base64'), false)
})
