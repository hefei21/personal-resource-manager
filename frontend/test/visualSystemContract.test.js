import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = new URL('../src/', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('stage 7 visual baseline removes retired purple TDesign effects and hover lifts', () => {
  const global = read('styles/global.css')
  const card = read('components/native/NativeCard.vue')

  assert.doesNotMatch(global, /\.t-(button|card|input|table|tabs)/)
  assert.doesNotMatch(global, /#667eea|#764ba2/i)
  assert.doesNotMatch(card, /translateY\(/)
  assert.match(global, /--control-height-touch:\s*44px/)
  assert.match(card, /var\(--color-surface-raised\)/)
})

test('frontend source maps the retired palette to semantic design tokens', () => {
  const sourceRoot = fileURLToPath(root)
  const source = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:vue|css|js)$/i.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')

  assert.doesNotMatch(source, /#667eea|#764ba2|#0052d9|#00a870|#ed7b2f|#e34d59|#333(?:\b|;)|#666(?:\b|;)|#999(?:\b|;)|#f5f5f5|#e8e8e8/i)
})

test('frequent native controls use tokens, mobile touch density and keyboard semantics', () => {
  const input = read('components/native/NativeInput.vue')
  const listItem = read('components/native/NativeListItem.vue')
  const space = read('components/native/NativeSpace.vue')
  const tag = read('components/native/NativeTag.vue')

  assert.match(input, /:autocomplete="autocomplete"/)
  assert.match(input, /height:\s*var\(--control-height-touch\)/)
  assert.match(listItem, /@keydown\.enter\.prevent/)
  assert.match(listItem, /:alt="avatarAlt"/)
  assert.match(space, /start:\s*'flex-start'/)
  assert.match(space, /width:\s*auto/)
  assert.match(tag, /<button v-if="closable"/)
})

test('complex status selection uses the headless-backed NativeSelect and icons are route-loaded', () => {
  const anime = read('views/Anime.vue')
  const main = read('main.js')
  const layout = read('pc/layout/Layout.vue')

  assert.doesNotMatch(anime, /<NativeDropdown/)
  assert.match(anime, /<NativeSelect[\s\S]*aria-label="更新观看状态"/)
  assert.doesNotMatch(main, /app\.component\('NativeIcon'/)
  assert.match(layout, /NativeDialog, NativeIcon, NativeInput/)
})

test('demo workspace exposes four guided journeys and all three evidence layers', () => {
  const demo = read('views/DemoWorkspace.vue')
  const service = read('../../backend/src/services/demoWorkspace.js')

  for (const text of ['跨资源发现', '有证据的问答', '持久任务与恢复', '资源生命周期']) {
    assert.match(service, new RegExp(text))
  }
  for (const text of ['合成演示', '生产契约', '历史验收证据', '确定性模板不是实时模型输出']) {
    assert.match(demo, new RegExp(text))
  }
})
