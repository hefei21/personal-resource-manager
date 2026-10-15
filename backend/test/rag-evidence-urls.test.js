import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { evidenceUrls, hasOnlyCitedUrls } from '../src/services/ragEvidenceUrls.js'

test('independent Worker and server URL contracts remain identical', () => {
  assert.equal(fs.readFileSync(new URL('../src/services/ragEvidenceUrls.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../pc-worker/src/ragEvidenceUrls.js', import.meta.url), 'utf8'))
})

test('quoted URL boundaries do not allow prefixes, suffixes or normalized inventions', () => {
  const url = 'https://example.invalid/path?q=1&x=2#part'
  assert.deepEqual(evidenceUrls(`原文：[${url}]，以及命令 \`${url}\`。`), [url, url])
  assert.equal(hasOnlyCitedUrls(`原样 ${url}。`, [url]), true)
  for (const value of [url + 'extra', url.replace('https:', 'http:'), url.replace('#part', ''),
    'https://example.invalid/path', 'ｈｔｔｐｓ：／／example.invalid/path', 'https://user:pass@example.invalid/']) {
    assert.equal(hasOnlyCitedUrls(value, [url]), false)
  }
  assert.equal(hasOnlyCitedUrls('https://user:pass@example.invalid/', ['https://user:pass@example.invalid/']), false)
  for (const tail of ['.', '?', '!', ';', '(part)']) {
    const exact = 'https://example.invalid/path' + tail
    assert.deepEqual(evidenceUrls(exact), [exact])
    assert.equal(hasOnlyCitedUrls('https://example.invalid/path', evidenceUrls(exact)), false)
  }
})

test('Markdown destinations exclude following prose without trimming URI punctuation', () => {
  const base = 'https://example.invalid/builder'
  for (const tail of ['', '.', '?', '!', ';', '(part)', '(part(nested))', '?x=(a)&y=2#section']) {
    const exact = base + tail
    for (const punctuation of ['', '.', ',', ';', ':', '!', '?']) {
      const source = `See [builder](${exact})${punctuation}`
      assert.deepEqual(evidenceUrls(source), [exact])
      assert.equal(hasOnlyCitedUrls(`原文 (${exact})。`, evidenceUrls(source)), true)
      assert.equal(hasOnlyCitedUrls(exact + '/extra', evidenceUrls(source)), false)
      if (tail) assert.equal(hasOnlyCitedUrls(base, evidenceUrls(source)), false)
    }
  }
  assert.deepEqual(evidenceUrls(`Bare ${base}).`), [base + ').'])
  assert.deepEqual(evidenceUrls(`[malformed](${base}).evil`), [base + ').evil'])
  assert.equal(hasOnlyCitedUrls(base, evidenceUrls(`[malformed](${base}).evil`)), false)
  assert.equal(hasOnlyCitedUrls('https://user:pass@example.invalid/builder',
    evidenceUrls('[login](https://user:pass@example.invalid/builder).')), false)
  assert.equal(hasOnlyCitedUrls(base, evidenceUrls('[other](https://other.invalid/builder).')), false)
})
