import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const routeSource = fs.readFileSync(new URL('../src/routes/code.js', import.meta.url), 'utf8')
const apiSource = fs.readFileSync(new URL('../../frontend/src/api/index.js', import.meta.url), 'utf8')
const pcSource = fs.readFileSync(new URL('../../frontend/src/pc/pages/CodePC.vue', import.meta.url), 'utf8')
const mobileSource = fs.readFileSync(new URL('../../frontend/src/mobile/pages/CodeMobile.vue', import.meta.url), 'utf8')

test('commit-bound symbol navigation verifies current HEAD before reading a file', () => {
  assert.match(routeSource, /assertRequestedSnapshot\(db, req\.params\.id, repo, requestedCommit\)/u)
  assert.match(routeSource, /\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$/u)
  assert.match(routeSource, /CODE_SNAPSHOT_STALE/u)
  assert.match(routeSource, /res\.status\(409\)\.json\(\{ code: error\.code \}\)/u)
  assert.doesNotMatch(routeSource, /res\.status\(409\)\.json\(\{[^}]*commit/u)
})

test('PC and mobile clients forward opaque commit locators without filesystem paths', () => {
  assert.match(apiSource, /getFile: \(id, path, commit\).*\{ commit \}/u)
  assert.match(pcSource, /api\.code\.getFile\(currentRepo\.value\.id, path, commit\)/u)
  assert.match(pcSource, /route\.query\.commit/u)
  assert.match(mobileSource, /api\.code\.getFile\(currentRepo\.value\.id, file\.path, file\.commit\)/u)
  assert.match(mobileSource, /route\.query\.commit/u)
})
