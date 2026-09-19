import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

// Execute the actual route body against SQLite, without binding a server or touching real files.
const source = readFileSync(new URL('../src/routes/music.js', import.meta.url), 'utf8')
const start = source.indexOf("router.get('/playlists/:id/songs', authenticateToken, async (req, res) => {")
const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('\n})', start))
const execute = new (Object.getPrototypeOf(async function() {}).constructor)('req', 'res', 'getDatabase', 'PAGINATION', 'publicMusicMetadataStatus', 'publicMusicMetadataErrorCode', 'convertToUTC8', body)
test('playlist count and pages apply filters before slicing and exclude recycled songs', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE music(id INTEGER PRIMARY KEY,title TEXT,artist TEXT,album TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE playlist_songs(playlist_id INTEGER,music_id INTEGER,sort_order INTEGER,added_at TEXT);
      CREATE TABLE resource_trash_entries(resource_type TEXT,resource_id INTEGER);
      INSERT INTO music(id,title,artist,album) VALUES(1,'Sea A','A','One'),(2,'Sea B','A','One'),(3,'Other','B','Two'),(4,'Sea recycled','A','One');
      INSERT INTO playlist_songs VALUES(7,1,1,''),(7,2,2,''),(7,3,3,''),(7,4,4,'');
      INSERT INTO resource_trash_entries VALUES('music',4);`)
    let result
    const run = async query => {
      await execute({ params: { id: '7' }, query }, { json: value => { result = value }, status: () => { throw new Error('Route failed') } }, () => db, { DEFAULT_PAGE: 1, DEFAULT_PAGE_SIZE: 30 }, value => value, value => value, value => value)
      return result
    }
    assert.equal((await run({ keyword: 'Sea', page: '2', pageSize: '1' })).data[0].id, 2)
    assert.equal(result.total, 2)
    assert.equal((await run({ artist: 'B' })).total, 1)
    assert.equal((await run({ album: 'Two', keyword: 'Sea' })).total, 0)
    assert.equal((await run({ keyword: "' OR 1=1 --" })).total, 0)
    assert.equal((await run({})).total, 3)
  } finally { db.close() }
})
