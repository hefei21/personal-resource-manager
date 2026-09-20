import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { CREATE_TASK_SCHEMA_SQL } from '../src/config/taskSchema.js'
import { createOwnerSession, OWNER_SESSION_COOKIE } from '../src/services/sessions.js'

test('authenticated collection routes enforce version, lifecycle, stats ordering and safe config projection', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'collection-routes-'))
  process.env.DATA_PATH = directory
  process.env.DB_PATH = path.join(directory, 'test.db')
  const { getDatabase } = await import('../src/config/database.js')
  const { authenticateToken, requireOwner } = await import('../src/middlewares/auth.js')
  const { default: games } = await import('../src/routes/games.js')
  const { default: anime } = await import('../src/routes/anime.js')
  const db = getDatabase()
  const schema = readFileSync(new URL('../src/config/database.js', import.meta.url), 'utf8')
  for (const table of ['games', 'anime', 'steam_config', 'game_achievements']) {
    db.exec(schema.match(new RegExp('`(CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\))`'))[1])
  }
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT); CREATE TABLE resource_trash_entries(resource_type TEXT,resource_id INTEGER,deleted_at TEXT,purge_after TEXT,metadata_json TEXT,PRIMARY KEY(resource_type,resource_id)); INSERT INTO games(steam_appid,title) VALUES(10,'Synthetic game'); INSERT INTO anime(bangumi_id,title) VALUES(20,'Synthetic anime'); INSERT INTO steam_config(id,steam_id,api_key) VALUES(1,'synthetic-owner','not-a-real-key')")
  db.exec(CREATE_TASK_SCHEMA_SQL)
  const user = {id: 1, username: randomUUID()}
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(user.id,user.username)
  const session = createOwnerSession(db,user)
  const app = express()
  app.use(express.json(),cookieParser())
  app.use('/games',authenticateToken,requireOwner,games)
  app.use('/anime',authenticateToken,requireOwner,anime)
  const server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(directory,{recursive:true,force:true})})
  const request=async(url,method='GET',data)=>{
    const response=await fetch(base+url,{method,headers:{cookie:`${OWNER_SESSION_COOKIE}=${session.token}`,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})})
    return {status:response.status,body:await response.json()}
  }
  assert.equal((await fetch(base+'/games')).status,401)
  assert.equal((await request('/games/stats')).body.data.totalGames,1)
  const config=(await request('/games/steam/config')).body.data
  assert.equal(config.hasApiKey,true);assert.equal('api_key' in config,false)
  assert.equal((await request('/games?page=-1')).status,400)
  for(const kind of ['games','anime']){
    const item=(await request(`/${kind}/1`)).body.data
    assert.equal((await request(`/${kind}/1`,'PUT',{isFavorite:true})).status,428)
    const updated=await request(`/${kind}/1`,'PUT',{baseVersion:item.version,isFavorite:true})
    assert.equal(updated.status,200);assert.equal(updated.body.data.is_favorite,1)
    assert.equal((await request(`/${kind}/1`,'PUT',{baseVersion:item.version,userRating:5})).status,409)
    assert.equal((await request(`/${kind}/1`,'DELETE',{baseVersion:updated.body.data.version})).status,200)
    assert.equal((await request(`/${kind}/1`)).status,404)
    assert.equal((await request(`/${kind}/1/rating`,'POST',{baseVersion:updated.body.data.version,rating:8})).status,404)
    assert.equal((await request(`/${kind}`)).body.total,0)
  }
  assert.equal((await request('/games/stats')).body.data.totalGames,0)
  assert.equal((await request('/anime/bangumi/20')).status,404)
  assert.equal((await request('/anime/1/cover-image')).status,404)
  assert.equal((await request('/games/1/achievements')).status,404)
})
