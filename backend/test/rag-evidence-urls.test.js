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
