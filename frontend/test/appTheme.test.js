import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createThemeController, normalizeTheme, resolveTheme, THEME_STORAGE_KEY } from '../src/domain/appTheme.js'

test('appearance defaults to system, follows changes, persists manual choice and handles unavailable storage', () => {
  const root = { dataset: {}, style: {} }, saved = new Map(), listeners = new Set(), changes = []
  const media = { matches: true, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  const controller = createThemeController({ root, media, storage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v) }, onChange: v => changes.push(v) })
  assert.equal(root.dataset.theme, 'dark')
  media.matches = false; listeners.forEach(fn=>fn()); assert.equal(root.dataset.theme,'light')
  controller.set('dark'); assert.equal(saved.get(THEME_STORAGE_KEY),'dark')
  listeners.forEach(fn=>fn()); assert.equal(root.dataset.theme,'dark')
  controller.syncStorage({key:THEME_STORAGE_KEY,newValue:'system'});assert.equal(root.dataset.theme,'light')
  controller.dispose();assert.equal(listeners.size,0)
  const blocked=createThemeController({root,media,storage:{getItem(){throw Error()},setItem(){throw Error()}}})
  blocked.set('dark');assert.equal(root.dataset.theme,'dark');blocked.dispose()
  assert.equal(normalizeTheme('invalid'),'system');assert.equal(resolveTheme('invalid',true),'dark')
})

const rgb = hex => hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
const luminance = hex => rgb(hex).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0)
const contrast = (a,b) => { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05) }
test('semantic normal text and solid action labels meet 4.5:1 in both palettes', () => {
  const css=readFileSync(new URL('../src/styles/global.css',import.meta.url),'utf8')
  const blocks=css.split(":root[data-theme='dark'], .ebook-reader--dark")
  const tokens=block=>Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(m=>[m[1],m[2]]))
  const light=tokens(blocks[0]),dark={...light,...tokens(blocks[1].split('/* Native controls')[0])}
  for(const palette of [light,dark]){
    for(const text of ['color-text-primary','color-text-secondary','color-text-muted','color-primary','color-success','color-warning','color-danger'])
      for(const surface of ['color-surface-page','color-surface-raised','color-surface-subtle'])
        assert.ok(contrast(palette[text],palette[surface])>=4.5,`${text} on ${surface}: ${contrast(palette[text],palette[surface])}`)
    for(const kind of ['primary','success','warning','danger','neutral'])
      assert.ok(contrast(palette['color-text-inverse'],palette[`color-${kind}-solid`])>=4.5,kind)
  }
})
test('theme boot is before the app, and reader paper palettes remain independent', () => {
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8')
  assert.ok(html.indexOf('prm.appearance')<html.indexOf('/src/main.js'))
  const reader=readFileSync(new URL('../src/components/books/EbookReaderDialog.vue',import.meta.url),'utf8')
  assert.match(reader,/surface--warm \.ebook-reader__paper\{background:#fbf3e4/)
  assert.match(reader,/surface--dark \.ebook-reader__paper\{border-color:#333a47;background:#232832/)
})
