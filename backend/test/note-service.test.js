import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NOTE_EDITING_MIGRATIONS } from '../src/config/noteEditingSchema.js'
import { CREATE_RESOURCE_TRASH_SQL } from '../src/config/resourceTrashSchema.js'
import { createNote, updateNote, getNote, listNotes, trashNote, restoreNoteFromTrash, permanentlyDeleteNote, noteTags, noteCategories } from '../src/services/noteService.js'
function fixture(t) {
  const db=new Database(':memory:'); db.pragma('foreign_keys=ON'); t.after(()=>db.close())
  db.exec(`CREATE TABLE blog_categories(id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, sort_order INTEGER DEFAULT 0);
    CREATE TABLE blog_posts(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,content TEXT,category_id INTEGER REFERENCES blog_categories(id),is_top INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'draft');
    CREATE TABLE blog_tags(id INTEGER PRIMARY KEY,name TEXT UNIQUE,color TEXT);
    CREATE TABLE blog_post_tags(post_id INTEGER REFERENCES blog_posts(id) ON DELETE CASCADE,tag_id INTEGER REFERENCES blog_tags(id) ON DELETE CASCADE,PRIMARY KEY(post_id,tag_id));
    INSERT INTO blog_categories(id,name) VALUES(1,'工作');`)
  db.exec(CREATE_RESOURCE_TRASH_SQL)
  for(const migration of NOTE_EDITING_MIGRATIONS) db.exec(migration.source)
  return db
}
test('note creation retry is idempotent; normalized tags and summary payload preserve all tags',t=>{
  const db=fixture(t), input={title:'笔记',content:'正文关键词',category_id:1,tags:[' NAS ','ＮＡＳ','标签,保留'],mutationId:'create-note-fixture-0001'}
  const a=createNote(db,input), b=createNote(db,input)
  assert.equal(a.id,b.id); assert.deepEqual(a.tags,['NAS','标签,保留']); assert.equal(a.revision,0)
  const result=listNotes(db,{keyword:'正文关键词',tag_id:db.prepare("SELECT id FROM blog_tags WHERE name='NAS'").get().id})
  assert.equal(result.total,1); assert.equal(result.data[0].content,undefined); assert.deepEqual(result.data[0].tags,a.tags)
  assert.throws(()=>createNote(db,{...input,content:'不同请求'}),e=>e.status===409)
})
test('concurrent saves conflict without overwriting; retries do not increment revision',t=>{
  const db=fixture(t), original=createNote(db,{title:'原版',content:'original'})
  const input={title:'PC 保存',content:'PC正文',baseRevision:0,mutationId:'update-note-fixture-0001'}
  const saved=updateNote(db,original.id,input)
  assert.equal(saved.revision,1); assert.equal(updateNote(db,original.id,input).revision,1)
  assert.throws(()=>updateNote(db,original.id,{...input,title:'手机修改',mutationId:'update-note-fixture-0002'}),e=>e.status===409&&e.current.content==='PC正文')
  assert.throws(()=>updateNote(db,original.id,{title:'旧客户端',mutationId:'update-note-fixture-0003'}),e=>e.status===428)
  assert.equal(getNote(db,original.id).title,'PC 保存')
})
test('invalid metadata rolls back content and associations atomically',t=>{
  const db=fixture(t), original=createNote(db,{title:'原版',tags:['原标签']})
  assert.throws(()=>updateNote(db,original.id,{title:'不能保存',category_id:99,baseRevision:0,mutationId:'update-note-fixture-0001'}))
  assert.deepEqual(getNote(db,original.id),original)
  assert.throws(()=>createNote(db,{title:'invalid',tags:['a',{}]}))
  assert.equal(listNotes(db).total,1)
})
test('trash retains text and tags, excludes counts, restore advances revision, purge requires trash',t=>{
  const db=fixture(t), note=createNote(db,{title:'保留',content:'重要正文',category_id:1,tags:['标签']})
  assert.throws(()=>permanentlyDeleteNote({database:db,id:note.id}))
  trashNote(db,note.id); assert.equal(listNotes(db).total,0); assert.throws(()=>getNote(db,note.id),e=>e.status===404)
  assert.equal(noteCategories(db)[0].post_count,0); assert.equal(noteTags(db)[0].post_count,0)
  assert.equal(db.prepare('SELECT content FROM blog_posts WHERE id=?').get(note.id).content,'重要正文')
  restoreNoteFromTrash({database:db,id:note.id}); const restored=getNote(db,note.id)
  assert.equal(restored.revision,2); assert.deepEqual(restored.tags,['标签'])
  assert.throws(()=>updateNote(db,note.id,{title:'旧页',baseRevision:0,mutationId:'update-note-fixture-0004'}),e=>e.status===409)
  trashNote(db,note.id); permanentlyDeleteNote({database:db,id:note.id})
  assert.equal(db.prepare('SELECT count(*) AS n FROM blog_posts').get().n,0); assert.equal(db.prepare('SELECT count(*) AS n FROM blog_post_tags').get().n,0)
})
test('literal keyword escaping and stable pagination, no private status projection',t=>{
  const db=fixture(t); for(let i=0;i<4;i++) createNote(db,{title:'row'+i,content:i===2?'100% literal':'normal'})
  assert.equal(listNotes(db,{keyword:'%'}).total,1)
  assert.equal(listNotes(db,{page:2,pageSize:2}).data[0].title,'row1')
  assert.equal(Object.hasOwn(getNote(db,1),'status'),false)
  assert.throws(()=>listNotes(db,{page:-1}),e=>e.status===400)
})
