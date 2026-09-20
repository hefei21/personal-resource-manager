import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { dashboardStats } from '../src/services/dashboardStats.js'

test('dashboard active totals agree with resource lifecycles and preserve anime visibility/status', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE resource_trash_entries(resource_type TEXT,resource_id INTEGER); CREATE TABLE code_repositories(id INTEGER); INSERT INTO code_repositories VALUES(1)')
    const mappings = { documents: 'document', music: 'music', books: 'ebook', games: 'game', bookmarks: 'bookmark', blog_posts: 'note', anime: 'anime' }
    for (const [table, type] of Object.entries(mappings)) {
      db.exec(`CREATE TABLE ${table}(id INTEGER,status TEXT,is_hidden INTEGER); INSERT INTO ${table} VALUES(1,'watching',0),(2,'watched',0),(3,'want_to_watch',1)`)
      db.prepare('INSERT INTO resource_trash_entries VALUES(?,?)').run(type,2)
    }
    const owner = dashboardStats(db)
    assert.deepEqual(owner, { documents:2, music:2, books:2, games:2, code:1, bookmarks:2, blog:{total:2}, anime:{total:2,want_to_watch:1,watching:1,watched:0} })
    assert.deepEqual(dashboardStats(db,{isGuest:true}).anime,{total:1,want_to_watch:0,watching:1,watched:0})
    db.exec('DELETE FROM resource_trash_entries')
    assert.equal(dashboardStats(db).documents,3)
  } finally { db.close() }
})
