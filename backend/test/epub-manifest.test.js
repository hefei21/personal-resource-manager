import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEpubManifest } from '../src/services/epubManifest.js'

test('reader manifest accepts either XML attribute order and multiline items', () => {
  const manifest = parseEpubManifest(`<package><manifest>
    <item href="Text/chapter1.xhtml" id="first" media-type="application/xhtml+xml"/>
    <item id='second' media-type='application/xhtml+xml'
      href='Text/chapter2.xhtml'/>
    </manifest><spine><itemref idref="first"/></spine></package>`)
  assert.deepEqual(Object.entries(manifest), [
    ['first', 'Text/chapter1.xhtml'], ['second', 'Text/chapter2.xhtml']
  ])
})

test('manifest namespaces and escaped hrefs retain exact archive identity', () => {
  const manifest = parseEpubManifest(`<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
    <opf:manifest><opf:item href="Text/a&amp;b.xhtml" id="__proto__"/>
    <opf:item id="missing"/></opf:manifest>
    <opf:item id="outside" href="wrong.xhtml"/></opf:package>`)
  assert.equal(manifest.__proto__, 'Text/a&b.xhtml')
  assert.equal(manifest.missing, undefined)
  assert.equal(manifest.outside, undefined)
  assert.equal(Object.getPrototypeOf(manifest), null)
})
