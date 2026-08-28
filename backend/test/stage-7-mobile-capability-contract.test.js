import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const mobileSource = (name) => fs.readFileSync(
  new URL(`../../frontend/src/mobile/pages/${name}`, import.meta.url),
  'utf8'
)

const sources = {
  music: mobileSource('MusicMobile.vue'),
  bookmarks: mobileSource('BookmarksMobile.vue'),
  games: mobileSource('GamesMobile.vue'),
  anime: mobileSource('AnimeMobile.vue'),
  animeDetail: mobileSource('AnimeDetailMobile.vue'),
  notes: mobileSource('BlogMobile.vue')
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

  assertOmits('bookmarks', [
    'api.bookmarks.delete',
    'api.bookmarks.batchDelete'
  ])

  assertOmits('games', [
    'api.games.getSteamConfig',
    'api.games.saveSteamConfig',
    'api.games.syncSteam',
    'api.games.fetchAchievements',
    'api.games.refreshCover',
    'api.games.batchDownloadCovers'
  ])

  assertOmits('anime', [
    'api.anime.search(',
    'api.anime.import(',
    'api.anime.delete(',
    'api.anime.getTokenStatus'
  ])
  assertOmits('animeDetail', [
    'api.anime.import(',
    'api.anime.refresh(',
    'api.anime.delete('
  ])

  assertOmits('notes', [
    'api.blog.deletePost',
    'api.blog.deleteCategory'
  ])
})

test('mobile resource modules retain the approved reversible single-item actions', () => {
  assert.match(sources.music, /api\.music\.restoreTrash\(/u)
  assert.match(sources.music, /api\.music\.update\(/u)
  assert.match(sources.bookmarks, /api\.bookmarks\.(?:create|update)\(/u)
  assert.match(sources.animeDetail, /api\.anime\.updateStatus\(/u)
  assert.match(sources.animeDetail, /api\.anime\.updateRating\(/u)
  assert.match(sources.notes, /api\.blog\.(?:createPost|updatePost)\(/u)
})
