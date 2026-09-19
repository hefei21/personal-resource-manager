import test from 'node:test'
import assert from 'node:assert/strict'
import { noteForm, sameNote, readNoteDrafts, writeNoteDraft, clearNoteDrafts, NOTE_DRAFT_PREFIX } from '../src/utils/noteDrafts.js'
const storage=()=>{const data=new Map();return {get length(){return data.size},key:i=>[...data.keys()][i],getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}}
test('note normalization keeps multiline Markdown and canonical tags',()=>{
  assert.equal(noteForm({content:'# title\n\nbody'}).content,'# title\n\nbody')
  assert.deepEqual(noteForm({tags:[' NAS ','ＮＡＳ']}).tags,['NAS'])
  assert.equal(sameNote({title:'a',is_top:1},{title:'a',is_top:true}),true)
})
test('drafts are owner scoped, malformed entries ignored and logout only clears notes',()=>{
  const s=storage(), key=NOTE_DRAFT_PREFIX+'owner:session1'
  writeNoteDraft(s,key,{form:{title:'草稿',content:'未保存内容'},baseRevision:2,mutationId:'mutation-fixture-001'})
  s.setItem(NOTE_DRAFT_PREFIX+'owner:broken','bad json'); s.setItem('other','keep')
  assert.equal(readNoteDrafts(s,'owner').length,1); assert.equal(readNoteDrafts(s,'someone-else').length,0)
  assert.equal(readNoteDrafts(s,'owner')[0].baseRevision,2)
  clearNoteDrafts(s); assert.equal(s.length,1); assert.equal(s.getItem('other'),'keep')
})
test('storage failure propagates so UI cannot falsely claim a protected draft',()=>{
  assert.throws(()=>writeNoteDraft({setItem(){throw new Error('quota')}},NOTE_DRAFT_PREFIX+'owner:one',{form:{title:'x'}}),/quota/)
})
