import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const mobileSource = (name) => fs.readFileSync(
  new URL(`../../frontend/src/mobile/pages/${name}`, import.meta.url),
  'utf8'
)

const sources = {
  music: mobileSource('MusicMobile.vue'),
  trash: fs.readFileSync(new URL('../../frontend/src/views/Trash.vue', import.meta.url), 'utf8'),
  bookmarks: fs.readFileSync(new URL('../../frontend/src/components/business/bookmarks/BookmarkWorkspace.vue', import.meta.url), 'utf8'),
  collections: fs.readFileSync(new URL('../../frontend/src/components/business/collections/CollectionWorkspace.vue', import.meta.url), 'utf8'),
  notes: fs.readFileSync(new URL('../../frontend/src/components/business/notes/NoteWorkspace.vue', import.meta.url), 'utf8')
}

function assertOmits(sourceName, forbidden) {
  const source = sources[sourceName]
  for (const token of forbidden) {
    assert.equal(
      source.includes(token),
      false,
      `${sourceName} mobile UI must not expose ${token}`
    )
  }
}

test('mobile resource modules omit batch, permanent, credential, and external sync actions', () => {
  assertOmits('music', [
    'api.music.batchDelete',
    'api.music.batchRemoveSongsFromPlaylist',
    'api.music.reparseMetadata',
    'api.music.permanentlyDeleteTrash'
  ])

  assert.match(sources.bookmarks, /v-if="!isMobile"[^>]*class="bookmark-inspection"/u)
  assert.match(sources.bookmarks, /v-if="!isMobile"[^>]*v-model="importOpen"/u)
  assert.match(sources.bookmarks, /if\s*\(\s*isMobile\.value\s*\|\|\s*deleting\.value/u)

  assert.match(sources.collections, /v-if="!isMobile && \(toolsOpen \|\| refreshOpen\)"/u)
  assert.match(sources.collections, /refresh && isMobile.value/u)
  assert.match(sources.collections, /v-if="!isMobile"[^>]*@click="toolsOpen = true"/u)

  // Notes now have a reversible trash contract. Shared category management is PC-only.
  assert.match(sources.notes, /v-if="!isMobile"[^>]*@click="categoryManager = true"/u)
  assert.match(sources.notes, /api\.blog\.deletePost/u)
})

test('mobile resource modules retain the approved reversible single-item actions', () => {
  assert.match(sources.music, /name: 'Trash', query: \{ type: 'music' \}/u)
  assert.match(sources.trash, /api\.trash\.restore\(/u)
  assert.match(sources.trash, /v-if="!isMobile"[\s\S]*?永久删除/u)
  assert.match(sources.music, /api\.music\.update\(/u)
  assert.match(sources.bookmarks, /api\.bookmarks\.(?:create|update)\(/u)
  assert.match(sources.collections, /client\.update\(/u)
  assert.match(sources.collections, /client\.delete\(/u)
  assert.match(sources.collections, /baseVersion/u)
  assert.match(sources.notes, /api\.blog\.(?:createPost|updatePost)\(/u)
})
