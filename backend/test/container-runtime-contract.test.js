import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const backendDirectory = path.resolve(testDirectory, '..')
const projectDirectory = path.resolve(backendDirectory, '..')
const dockerfile = fs.readFileSync(path.join(backendDirectory, 'Dockerfile'), 'utf8')
const containerWorkflow = fs.readFileSync(
  path.join(projectDirectory, '.github', 'workflows', 'container-build-check.yml'),
  'utf8'
)

test('backend runtime explicitly installs and refreshes the system CA bundle', () => {
  const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'))
  assert.match(runtime, /apt-get install -y --no-install-recommends[\s\S]*ca-certificates/u)
  assert.match(runtime, /update-ca-certificates/u)
  assert.doesNotMatch(runtime, /GIT_SSL_NO_VERIFY|http\.sslVerify=false/u)
})

test('container gate verifies the CA bundle and a real GitHub TLS handshake', () => {
  assert.match(containerWorkflow, /test -s \/etc\/ssl\/certs\/ca-certificates\.crt/u)
  assert.match(containerWorkflow, /git -c http\.sslVerify=true ls-remote --exit-code/u)
  assert.match(
    containerWorkflow,
    /https:\/\/github\.com\/hefei21\/personal-resource-manager\.git HEAD/u
  )
  assert.doesNotMatch(containerWorkflow, /GIT_SSL_NO_VERIFY|http\.sslVerify=false/u)
})
