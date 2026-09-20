import test from 'node:test'
import assert from 'node:assert/strict'
import { collectionStatuses, collectionSorts, collectionTitle, collectionCover, playtimeLabel } from '../src/utils/collectionPresentation.js'

test('personal statuses do not pretend playtime is completion or add watched episode state', () => {
  assert.equal(collectionStatuses.game.find(row=>row.value==='played').label,'已玩')
  assert.ok(collectionStatuses.anime.some(row=>row.value==='on_hold'))
  assert.equal(collectionTitle({title:'Original',name_cn:'中文'}),'中文')
  assert.equal(playtimeLabel(0),'尚无游玩记录')
  assert.equal(playtimeLabel(-10),'尚无游玩记录')
  assert.equal(playtimeLabel(90),'1.5 小时')
  assert.equal(playtimeLabel(20),'20 分钟')
  assert.ok(collectionSorts.game.some(row=>row.value==='title'))
})
test('covers use owned endpoints or safe provider URLs and reject executable schemes', () => {
  assert.equal(collectionCover({steam_appid:10},'game'),'/api/games/cover-proxy?appid=10&type=library')
  assert.equal(collectionCover({id:1,cover_image:'https://evil.test/tracker'},'anime'),'/api/anime/1/cover-image')
  assert.equal(collectionCover({cover_image:'javascript:alert(1)'},'anime'),'')
  assert.equal(collectionCover({cover_image:'https://evil.test/cover'},'anime'),'')
  assert.equal(collectionCover({cover_image_data:'data:image/svg+xml;base64,xxx'},'anime'),'')
})
