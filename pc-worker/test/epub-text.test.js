import assert from 'node:assert/strict'
import test from 'node:test'
import { extractEpubHtml, EPUB_RUBY_BLOCK_BYTES } from '../src/epubText.js'
import { chunkRagSource, RAG_CHUNKER_DEFAULTS } from '../../backend/src/services/ragChunker.js'

test('simple Ruby preserves continuous prose and explicit annotation relationships', () => {
  const {body}=extractEpubHtml('<p>智に働けば<ruby>角<rp>(</rp><rt>かど</rt><rp>)</rp></ruby>が立つ。</p>')
  assert.equal(body.trim(), '智に働けば角が立つ。\n[Ruby "角" → "かど"]')
  const semantic=extractEpubHtml('<p><ruby><rb>H<sub>2</sub>O</rb><rt>water molecule</rt></ruby> remains.</p>').body
  assert.match(semantic,/H2O remains\./u)
  assert.match(semantic,/\[Ruby "H2O" → "water molecule"\]/u)
})

test('notes remain scoped to their own blocks with escaped annotation text', () => {
  const {body}=extractEpubHtml('<div><p><ruby>X<rt>a &quot;quoted&quot; note</rt></ruby> one.</p><p><ruby>X<rt>different note</rt></ruby> two.</p></div>')
  assert(body.indexOf('quoted')<body.indexOf('two.'))
  assert.match(body,/a \\"quoted\\" note/u)
  assert.equal((body.match(/\[Ruby /gu)??[]).length,2)
})

test('oversized blocks preserve original Ruby text instead of distant notes', () => {
  const tail=' surrounding prose'.repeat(200)
  const {body}=extractEpubHtml(`<p>Before <ruby>H2O<rt>water molecule</rt></ruby> after.${tail}</p>`)
  assert.equal(body.trim(),`Before H2Owater molecule after.${tail}`)
  assert(!body.includes('[Ruby'))
  assert(Buffer.byteLength(body)>EPUB_RUBY_BLOCK_BYTES)
  const longAnnotation='long annotation '.repeat(200)
  assert.equal(extractEpubHtml(`<p><ruby>X<rt>${longAnnotation}</rt></ruby></p>`).body.trim(),`X${longAnnotation}`.trim())
})

test('complex, nested and empty Ruby retain baseline traversal without partial rewriting', () => {
  for(const [html,expected] of [
    ['<ruby>A<rt>a</rt>B<rt>b</rt></ruby>','AaBb'],
    ['<ruby>A<rtc><rt>a</rt></rtc></ruby>','Aa'],
    ['<ruby>A<rt><ruby>B<rt>b</rt></ruby></rt></ruby>','ABb'],
    ['<ruby><ruby>A<rt>a</rt></ruby><rt>b</rt></ruby>','Aab'],
    ['<ruby>A<rt></rt></ruby>','A'],
    ['<ruby>A<br>B<rt>ab</rt></ruby>','A\nBab']
  ])assert.equal(extractEpubHtml(`<p>${html}</p>`).body.trim(),expected)
})

test('ordinary HTML, entity decoding and omitted executable markup stay unchanged', () => {
  assert.equal(extractEpubHtml('<p>one<br>two &amp;lt;tag&amp;gt;</p><script>hidden</script><table><tr><td>A</td><td>B</td></tr></table>').body,'\none\ntwo &lt;tag&gt;\n\n\n A  B \n\n')
  const body=extractEpubHtml('<p><ruby>A<rt>note<script>hidden</script></rt></ruby></p>').body
  assert(!body.includes('hidden'))
  assert(body.includes('[Ruby "A" → "note"]'))
})

test('deep untrusted inline nesting is traversed iteratively', () => {
  const html='<span>'.repeat(10000)+'<ruby>A<rt>a</rt></ruby>'+'</span>'.repeat(10000)
  assert.equal(extractEpubHtml(html).body,'A\n[Ruby "A" → "a"]')
})

test('Ruby budget matches the actual NAS chunker and keeps paired facts within neighbor reach', () => {
  assert.equal(EPUB_RUBY_BLOCK_BYTES, RAG_CHUNKER_DEFAULTS.deferredProseBytes)
  for (const count of [0, 20, 150, 400]) {
    const body=extractEpubHtml(`<p>${'prefix '.repeat(count)}</p><p>Target <ruby>H2O<rt>water molecule</rt></ruby> applies.</p>`).body
    const chunks=chunkRagSource({format:'ebook',body,locator:{route:'/books',bookId:1,chapterIndex:0}}).chunks
    const base=chunks.findIndex(c=>c.body.includes('Target H2O applies.'))
    const note=chunks.findIndex(c=>c.body.includes('[Ruby "H2O" → "water molecule"]'))
    assert(base>=0&&note>=0)
    assert(Math.abs(base-note)<=1)
  }
})
