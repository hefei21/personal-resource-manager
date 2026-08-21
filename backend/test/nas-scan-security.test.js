import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_BYTES,
  normalizeNasScanRules
} from '../src/config/nasScan.js'
import {
  NAS_SCAN_ERROR_CODES,
  NAS_SCAN_EXCLUSION_CODES,
  NasScanSecurityError,
  canonicalizeNasScanRoot,
  walkNasScanRoot
} from '../src/services/nasScanSecurity.js'

function makeRoot(prefix = 'pr-nas-scan-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

async function collect(root, rules) {
  const entries = []
  for await (const entry of walkNasScanRoot(root, rules)) entries.push(entry)
  return entries
}

function byPath(entries, relativePath) {
  return entries.find((entry) => entry.relativePath === relativePath)
}

function assertSafeRecord(entry) {
  assert.ok(entry)
  assert.equal(typeof entry.relativePath, 'string')
  assert.ok(!path.isAbsolute(entry.relativePath))
  assert.ok(!entry.relativePath.includes('\\'))
  assert.equal(typeof entry.kind, 'string')
  assert.equal(typeof entry.size, 'string')
  assert.equal(typeof entry.mtimeNs, 'string')
  assert.ok(entry.fileIdentifier === null || typeof entry.fileIdentifier === 'string')
  assert.ok(['included', 'excluded'].includes(entry.decision))
  assert.ok(entry.exclusionCode === null || typeof entry.exclusionCode === 'string')
  assert.deepEqual(Object.keys(entry), [
    'relativePath',
    'kind',
    'size',
    'mtimeNs',
    'fileIdentifier',
    'decision',
    'exclusionCode'
  ])
}

test('canonicalizes only existing absolute, non-symlink directories', () => {
  const root = makeRoot()
  const sibling = makeRoot('pr-nas-scan-sibling-')
  const file = path.join(root, 'file.txt')
  fs.writeFileSync(file, 'fixture')
  fs.writeFileSync(path.join(sibling, 'outside.txt'), 'outside')
  try {
    assert.equal(canonicalizeNasScanRoot(root), fs.realpathSync.native(root))
    assert.throws(() => canonicalizeNasScanRoot('relative/root'), {
      code: NAS_SCAN_ERROR_CODES.ROOT_NOT_ABSOLUTE
    })
    assert.throws(() => canonicalizeNasScanRoot(path.join(root, 'missing')), {
      code: NAS_SCAN_ERROR_CODES.ROOT_MISSING
    })
    assert.equal(fs.existsSync(path.join(root, 'missing')), false)
    assert.throws(() => canonicalizeNasScanRoot(file), {
      code: NAS_SCAN_ERROR_CODES.ROOT_NOT_DIRECTORY
    })
    assert.throws(() => canonicalizeNasScanRoot(`${root}\0suffix`), {
      code: NAS_SCAN_ERROR_CODES.ROOT_INVALID
    })
  } finally {
    removeRoot(root)
    removeRoot(sibling)
  }
})

test('rejects same-prefix escapes and traversal permission failures with stable errors', async () => {
  const root = makeRoot()
  const sibling = makeRoot('pr-nas-scan-sibling-')
  const originalRealpath = fs.realpathSync.native
  const originalReaddir = fs.readdirSync
  try {
    fs.writeFileSync(path.join(root, 'escape.txt'), 'fixture')
    fs.writeFileSync(path.join(sibling, 'outside.txt'), 'outside')
    const entries = await collect(root, { useGitignore: false })
    assert.deepEqual(entries.map((entry) => entry.relativePath), ['escape.txt'])

    fs.realpathSync.native = function patchedRealpath(candidate, ...args) {
      if (path.basename(String(candidate)) === 'escape.txt') return path.join(sibling, 'outside.txt')
      return originalRealpath.call(this, candidate, ...args)
    }
    await assert.rejects(collect(root, { useGitignore: false }), {
      code: NAS_SCAN_ERROR_CODES.REALPATH_ESCAPE
    })
    fs.realpathSync.native = originalRealpath

    fs.readdirSync = function patchedReaddir(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.resolve(root)) {
        const error = new Error('permission denied')
        error.code = 'EACCES'
        throw error
      }
      return originalReaddir.call(this, candidate, ...args)
    }
    await assert.rejects(collect(root, { useGitignore: false }), {
      code: NAS_SCAN_ERROR_CODES.DIRECTORY_READ_FAILED
    })
  } finally {
    fs.realpathSync.native = originalRealpath
    fs.readdirSync = originalReaddir
    removeRoot(root)
    removeRoot(sibling)
  }
})

test('normalizes version-one rules and keeps symlink following out of the contract', () => {
  assert.deepEqual(normalizeNasScanRules(), {
    version: 1,
    useGitignore: true,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    allowedExtensions: null,
    excludedGlobs: [],
    credentialGlobs: [],
    maxDepth: DEFAULT_MAX_DEPTH
  })
  assert.deepEqual(normalizeNasScanRules({
    rulesVersion: 1,
    useGitignore: false,
    maxFileBytes: 10,
    allowedExtensions: ['TXT', '.Md', 'txt'],
    excludedGlobs: ['foo\\bar', 'foo\\bar'],
    credentialGlobs: ['private\\*.json'],
    maxDepth: 2
  }), {
    version: 1,
    useGitignore: false,
    maxFileBytes: 10,
    allowedExtensions: ['.txt', '.md'],
    excludedGlobs: ['foo/bar', 'foo/bar'],
    credentialGlobs: ['private/*.json'],
    maxDepth: 2
  })
  assert.throws(() => normalizeNasScanRules({ followSymlinks: true }), {
    code: 'NAS_SCAN_FOLLOW_SYMLINKS_UNSUPPORTED'
  })
  assert.throws(() => normalizeNasScanRules({ maxFileBytes: DEFAULT_MAX_FILE_BYTES + 1 }), {
    code: 'NAS_SCAN_MAX_FILE_BYTES_INVALID'
  })
  assert.throws(() => normalizeNasScanRules({ rootPath: '/private/root' }), {
    code: 'NAS_SCAN_RULES_INVALID'
  })
})

test('applies root and nested gitignore rules, BOM/CRLF, negation and escaped literals', async () => {
  const root = makeRoot()
  try {
    fs.writeFileSync(
      path.join(root, '.gitignore'),
      '\uFEFFignored/*\r\n!ignored/keep.txt\r\nfoo/bar.txt\r\n\\#literal.txt\r\n\\!literal.txt\r\n'
    )
    fs.mkdirSync(path.join(root, 'ignored'))
    fs.writeFileSync(path.join(root, 'ignored', 'drop.txt'), 'drop')
    fs.writeFileSync(path.join(root, 'ignored', 'keep.txt'), 'keep')
    fs.mkdirSync(path.join(root, 'foo'))
    fs.writeFileSync(path.join(root, 'foo', 'bar.txt'), 'bar')
    fs.writeFileSync(path.join(root, '#literal.txt'), 'hash')
    fs.writeFileSync(path.join(root, '!literal.txt'), 'bang')
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'nested', '.gitignore'), '\uFEFF*.tmp\r\n!keep.tmp\r\n')
    fs.writeFileSync(path.join(root, 'nested', 'drop.tmp'), 'drop')
    fs.writeFileSync(path.join(root, 'nested', 'keep.tmp'), 'keep')

    const entries = await collect(root)
    assert.equal(byPath(entries, 'ignored/drop.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
    assert.equal(byPath(entries, 'ignored/keep.txt').decision, 'included')
    assert.equal(byPath(entries, 'foo/bar.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
    assert.equal(byPath(entries, '#literal.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
    assert.equal(byPath(entries, '!literal.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
    assert.equal(byPath(entries, 'nested/drop.tmp').exclusionCode, NAS_SCAN_EXCLUSION_CODES.GITIGNORE)
    assert.equal(byPath(entries, 'nested/keep.tmp').decision, 'included')

    const withoutGitignore = await collect(root, { useGitignore: false })
    assert.equal(byPath(withoutGitignore, 'ignored/drop.txt').decision, 'included')
    assert.equal(byPath(withoutGitignore, 'foo/bar.txt').decision, 'included')
  } finally {
    removeRoot(root)
  }
})

test('safety denylist remains stronger than custom negation and protects credentials', async () => {
  const root = makeRoot()
  try {
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'node_modules', 'keep.txt'), 'dependency')
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(path.join(root, 'secrets', 'keep.txt'), 'secret')
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=private')
    fs.writeFileSync(path.join(root, '.env.dev'), 'TOKEN=private')
    fs.writeFileSync(path.join(root, '.env.example'), 'TOKEN=example')
    fs.writeFileSync(path.join(root, '.env.dev.example'), 'TOKEN=example')
    fs.writeFileSync(path.join(root, 'credentials.json'), '{}')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'safe')
    const entries = await collect(root, {
      excludedGlobs: ['!node_modules/keep.txt', '!secrets/keep.txt', '!credentials.json']
    })

    assert.equal(byPath(entries, 'node_modules').exclusionCode, NAS_SCAN_EXCLUSION_CODES.DEFAULT)
    assert.equal(byPath(entries, 'node_modules/keep.txt'), undefined)
    assert.equal(byPath(entries, 'secrets').exclusionCode, NAS_SCAN_EXCLUSION_CODES.CREDENTIAL)
    assert.equal(byPath(entries, 'secrets/keep.txt'), undefined)
    assert.equal(byPath(entries, '.env').exclusionCode, NAS_SCAN_EXCLUSION_CODES.CREDENTIAL)
    assert.equal(byPath(entries, '.env.dev').exclusionCode, NAS_SCAN_EXCLUSION_CODES.CREDENTIAL)
    assert.equal(byPath(entries, 'credentials.json').exclusionCode, NAS_SCAN_EXCLUSION_CODES.CREDENTIAL)
    assert.equal(byPath(entries, '.env.example').decision, 'included')
    assert.equal(byPath(entries, '.env.dev.example').decision, 'included')
    assert.equal(byPath(entries, 'notes.txt').decision, 'included')
  } finally {
    removeRoot(root)
  }
})

test('enforces extension, size and depth boundaries without reading file contents', async () => {
  const root = makeRoot()
  const originalReadFileSync = fs.readFileSync
  try {
    fs.writeFileSync(path.join(root, 'exact.txt'), '12345')
    fs.writeFileSync(path.join(root, 'too-large.txt'), '123456')
    fs.writeFileSync(path.join(root, 'not-allowed.md'), '12345')
    fs.mkdirSync(path.join(root, 'level'))
    fs.writeFileSync(path.join(root, 'level', 'deep.txt'), '12345')
    const reads = []
    fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
      reads.push(String(filePath))
      return originalReadFileSync.call(this, filePath, ...args)
    }
    const entries = await collect(root, {
      maxFileBytes: 5,
      allowedExtensions: ['txt'],
      maxDepth: 1,
      useGitignore: false
    })
    assert.equal(byPath(entries, 'exact.txt').decision, 'included')
    assert.equal(byPath(entries, 'too-large.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.SIZE)
    assert.equal(byPath(entries, 'not-allowed.md').exclusionCode, NAS_SCAN_EXCLUSION_CODES.EXTENSION)
    assert.equal(byPath(entries, 'level/deep.txt').exclusionCode, NAS_SCAN_EXCLUSION_CODES.DEPTH)
    assert.deepEqual(reads, [])
  } finally {
    fs.readFileSync = originalReadFileSync
    removeRoot(root)
  }
})

test('rejects child, broken and escaping symlinks as security errors', async (context) => {
  if (process.platform === 'win32') {
    context.diagnostic('symlink rejection is covered by Linux CI when Windows lacks symlink privilege')
    return
  }
  const root = makeRoot()
  const outside = makeRoot('pr-nas-scan-outside-')
  try {
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside')
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'escape.txt'))
    await assert.rejects(collect(root), (error) => {
      assert.ok(error instanceof NasScanSecurityError)
      assert.equal(error.code, NAS_SCAN_ERROR_CODES.SYMLINK_FORBIDDEN)
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      return true
    })
    removeRoot(root)
    fs.mkdirSync(root)
    fs.symlinkSync(path.join(root, 'missing.txt'), path.join(root, 'broken.txt'))
    await assert.rejects(collect(root), { code: NAS_SCAN_ERROR_CODES.SYMLINK_FORBIDDEN })
  } finally {
    removeRoot(root)
    removeRoot(outside)
  }
})

test('reports special files as excluded and does not open them', async (context) => {
  if (process.platform === 'win32') {
    context.diagnostic('FIFO special-file coverage is executed in Linux CI')
    return
  }
  const root = makeRoot()
  try {
    const fifo = path.join(root, 'pipe')
    childProcess.execFileSync('mkfifo', [fifo])
    const entries = await collect(root, { useGitignore: false })
    const record = byPath(entries, 'pipe')
    assert.equal(record.kind, 'special')
    assert.equal(record.decision, 'excluded')
    assert.equal(record.exclusionCode, NAS_SCAN_EXCLUSION_CODES.SPECIAL)
    assert.equal(record.fileIdentifier, null)
  } finally {
    removeRoot(root)
  }
})

test('never exposes an absolute root in records or security errors', async () => {
  const root = makeRoot()
  try {
    fs.writeFileSync(path.join(root, 'safe.txt'), 'safe')
    for (const entry of await collect(root, { useGitignore: false })) {
      assertSafeRecord(entry)
      assert.doesNotMatch(JSON.stringify(entry), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    }
    await assert.rejects(collect(path.join(root, 'missing')), (error) => {
      assert.ok(error instanceof NasScanSecurityError)
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      assert.doesNotMatch(error.stack, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      return true
    })
  } finally {
    removeRoot(root)
  }
})
