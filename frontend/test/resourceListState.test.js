import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const read = (relativePath) => fs.readFileSync(
  new URL(`../src/${relativePath}`, import.meta.url),
  'utf8'
)

test('resource list state owns loading, empty, error, and retry feedback', () => {
  const source = read('components/common/ResourceListState.vue')
  assert.match(source, /state === 'loading'/u)
  assert.match(source, /state === 'error'/u)
  assert.match(source, /NativeEmpty/u)
  assert.match(source, /\$emit\('retry'\)/u)
})

test('stage 7.4 mobile collections reuse the shared list-state contract', () => {
  for (const page of [
    'MusicMobile.vue',
    'BookmarksMobile.vue',
    'GamesMobile.vue',
    'AnimeMobile.vue',
    'BlogMobile.vue'
  ]) {
    const source = read(`mobile/pages/${page}`)
    assert.match(source, /ResourceListState/u, `${page} does not use ResourceListState`)
    assert.match(source, /loadError/u, `${page} does not preserve an initial-load error`)
    assert.match(source, /@retry=/u, `${page} does not expose retry`)
  }
})
