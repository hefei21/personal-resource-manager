import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(testDirectory, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

test('NAS Git repositories are read-only in task processor and routes', () => {
  const processorSource = read('backend/src/services/codeRepositoryTaskProcessor.js')
  const routeSource = read('backend/src/routes/code.js')
  assert.match(processorSource, /repo\.type === 'git_nas'[\s\S]*GIT_NAS_READ_ONLY/u)
  assert.match(routeSource, /GIT_NAS_READ_ONLY/u)
  assert.match(routeSource, /router\.get\('\/:id\/tree'/u)
  assert.match(routeSource, /listGitNasTree/u)
  assert.match(routeSource, /getGitNasCommitDetail/u)
  assert.match(routeSource, /readGitNasReadme/u)
  assert.match(routeSource, /readOnly: isGitNasRepository/u)
  assert.doesNotMatch(routeSource, /fs\.rmSync\([^\n]*repo\.local_path/u)
})

test('NAS Git task code only exposes opaque IDs and fixed read-only Git commands', () => {
  const serviceSource = read('backend/src/services/gitNasRepositoryService.js')
  const taskSource = read('backend/src/services/gitNasTaskProcessor.js')
  assert.match(serviceSource, /execFile/u)
  assert.match(serviceSource, /--no-optional-locks/u)
  assert.match(serviceSource, /GIT_CONFIG_NOSYSTEM/u)
  assert.match(serviceSource, /SAFE_REV_PARSE_ARGUMENTS/u)
  assert.match(serviceSource, /safeGitEnvironment/u)
  assert.match(serviceSource, /--no-ext-diff/u)
  assert.match(serviceSource, /--no-textconv/u)
  assert.match(serviceSource, /O_NOFOLLOW/u)
  assert.match(serviceSource, /fstatSync/u)
  assert.doesNotMatch(serviceSource, /execFile\([^\n]*\b(?:fetch|pull|clone|checkout|reset|clean|stash|commit|merge|rebase)\b/u)
  assert.match(taskSource, /GIT_NAS_DISCOVER_TASK_TYPE/u)
  assert.match(taskSource, /GIT_NAS_IMPORT_TASK_TYPE/u)
  assert.doesNotMatch(taskSource, /root_path|relative_path|local_path/u)
})
