import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sourceIdentity, checkSourceNovelty } from '../scripts/rag-source-novelty.mjs'

test('same Python source across HTML, version and raw RST is not new', () => {
  const urls = ['https://docs.python.org/3/library/queue.html', 'https://docs.python.org/3.14/library/queue.html#Queue',
    'https://raw.githubusercontent.com/python/cpython/v3.14.0/Doc/library/queue.rst',
    'https://raw.githubusercontent.com/python/cpython/refs/tags/v3.14.0/Doc/library/queue.rst']
  assert.equal(new Set(urls.map(sourceIdentity)).size, 1)
  assert.notEqual(sourceIdentity(urls[0]), sourceIdentity('https://docs.python.org/3/library/weakref.html'))
})
test('known Git revisions collapse; unknown URL query remains significant', () => {
  assert.equal(sourceIdentity('https://git-scm.com/docs/git-prune/2.43.0'), sourceIdentity('https://git-scm.com/docs/git-prune'))
  assert.notEqual(sourceIdentity('https://example.invalid/?doc=a'), sourceIdentity('https://example.invalid/?doc=b'))
  assert.throws(() => sourceIdentity('https://user:secret@example.invalid/'))
  assert.throws(() => sourceIdentity('file:///tmp/test'))
})

test('the same RFC cannot become unseen by changing publisher, format or fragment', () => {
  const urls = ['https://www.rfc-editor.org/rfc/rfc9116.html', 'https://www.rfc-editor.org/rfc/rfc9116.txt',
    'https://www.rfc-editor.org/info/rfc9116', 'https://datatracker.ietf.org/doc/html/rfc9116#section-3',
    'https://www.ietf.org/rfc/rfc9116.txt']
  assert.equal(new Set(urls.map(sourceIdentity)).size, 1)
  assert.notEqual(sourceIdentity(urls[0]), sourceIdentity('https://www.rfc-editor.org/rfc/rfc91160.txt'))
  assert.notEqual(sourceIdentity(urls[0]), sourceIdentity('https://example.invalid/rfc/rfc9116.txt'))
})

test('historical RFC text metadata blocks an HTML holdout before inference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-novelty-'))
  try {
    await writeFile(path.join(root, 'freeze.json'), JSON.stringify({ source: 'https://www.rfc-editor.org/rfc/rfc9116.txt' }))
    const r = await checkSourceNovelty(root, ['https://www.rfc-editor.org/rfc/rfc9116.html'])
    assert.equal(r.status, 'previously-seen')
    assert.equal(r.results[0].matches.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('recursive metadata catches previous batches; answer text is not source metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-novelty-'))
  try {
    await mkdir(path.join(root, 'older'))
    await writeFile(path.join(root, 'older', 'freeze.json'), JSON.stringify({ spec: { source: 'https://raw.githubusercontent.com/python/cpython/v3.14.0/Doc/library/weakref.rst' }, answer: 'https://example.invalid/answer' }))
    const r = await checkSourceNovelty(root, ['https://docs.python.org/3/library/weakref.html', 'https://example.invalid/answer'])
    assert.equal(r.status, 'previously-seen'); assert.equal(r.results[0].matches.length, 1); assert.equal(r.results[1].matches.length, 0)
    await writeFile(path.join(root, 'broken.json'), '{')
    assert.equal((await checkSourceNovelty(root, ['https://example.invalid/new'])).status, 'incomplete')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('empty history cannot certify a source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rag-novelty-'))
  try { assert.equal((await checkSourceNovelty(root, ['https://example.invalid/new'])).status, 'incomplete') }
  finally { await rm(root, { recursive: true, force: true }) }
})
