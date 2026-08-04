import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  normalizeCommitLimit,
  resolveManagedRepositoryPath,
  resolveRepositoryEntry,
  validateCommitHash,
  validateGitRemoteUrl
} from '../src/services/repositorySecurity.js'

const codeRouteSource = fs.readFileSync(
  new URL('../src/routes/code.js', import.meta.url),
  'utf8'
)

function withRepository(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-code-security-'))
  const repository = path.join(root, 'managed-repository')
  fs.mkdirSync(repository)
  fs.writeFileSync(path.join(repository, 'README.md'), '# fixture')

  try {
    callback({ root, repository })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('managed repository paths must be children of the code storage root', () => {
  withRepository(({ root, repository }) => {
    assert.equal(
      resolveManagedRepositoryPath(root, repository, { mustExist: true }),
      fs.realpathSync(repository)
    )
    assert.throws(
      () => resolveManagedRepositoryPath(root, root),
      { code: 'REPOSITORY_PATH_OUTSIDE_ROOT' }
    )
    assert.throws(
      () => resolveManagedRepositoryPath(root, path.dirname(root)),
      { code: 'REPOSITORY_PATH_OUTSIDE_ROOT' }
    )
  })
})

test('repository entries reject traversal and sibling-prefix paths', () => {
  withRepository(({ root, repository }) => {
    assert.equal(
      resolveRepositoryEntry(root, repository, 'README.md'),
      fs.realpathSync(path.join(repository, 'README.md'))
    )
    assert.throws(
      () => resolveRepositoryEntry(root, repository, '../outside.txt'),
      { code: 'REPOSITORY_PATH_OUTSIDE_ROOT' }
    )
    assert.throws(
      () => resolveRepositoryEntry(root, repository, '..\\repo-sibling\\x'),
      { code: 'REPOSITORY_PATH_OUTSIDE_ROOT' }
    )
  })
})

test('Git remotes reject local helpers, embedded credentials and SVN URLs', () => {
  assert.equal(
    validateGitRemoteUrl('https://github.com/example/project.git'),
    'https://github.com/example/project.git'
  )
  assert.equal(
    validateGitRemoteUrl('ssh://git@example.com/project.git'),
    'ssh://git@example.com/project.git'
  )
  for (const remote of [
    'ext::sh -c calc',
    'file:///etc/passwd',
    '../local-repository',
    'svn://example.com/project',
    'https://token@example.com/project.git'
  ]) {
    assert.throws(() => validateGitRemoteUrl(remote))
  }
})

test('commit arguments are bounded before reaching Git', () => {
  assert.equal(validateCommitHash('0123abc'), '0123abc')
  assert.throws(
    () => validateCommitHash('--help'),
    { code: 'COMMIT_HASH_INVALID' }
  )
  assert.equal(normalizeCommitLimit('-20'), 1)
  assert.equal(normalizeCommitLimit('10000'), 100)
  assert.equal(normalizeCommitLimit('invalid'), 20)
})

test('code routes never build shell command strings or invoke SVN', () => {
  assert.doesNotMatch(codeRouteSource, /\bexecAsync\b|\bexec\(/)
  assert.doesNotMatch(
    codeRouteSource,
    /svn\s+(checkout|update|log|diff)/i
  )
  assert.match(codeRouteSource, /protocol\.file\.allow=never/)
  assert.match(codeRouteSource, /protocol\.ext\.allow=never/)
})
