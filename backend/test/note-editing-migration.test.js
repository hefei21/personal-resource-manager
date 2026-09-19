import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NOTE_EDITING_MIGRATIONS } from '../src/config/noteEditingSchema.js'
import { ensureMigrationControlTables } from '../src/config/migrationControlStore.js'
import { executeMigrationBatch } from '../src/config/migrationExecutor.js'
import { checkMigrationCompatibility } from '../src/config/migrationCompatibility.js'
import { createMigrationPlan, createMigrationRegistry } from '../src/config/migrationPlan.js'
test('note expand migration preserves legacy content/status and is restart safe',()=>{
  const db=new Database(':memory:')
  try {
    db.exec("CREATE TABLE blog_posts(id INTEGER PRIMARY KEY, title TEXT, content TEXT, status TEXT); INSERT INTO blog_posts VALUES(1,'legacy','keep markdown','published')")
    ensureMigrationControlTables(db)
    const registry=createMigrationRegistry(NOTE_EDITING_MIGRATIONS)
    const run=()=>executeMigrationBatch({database:db,registry,plan:createMigrationPlan(registry,[]),lock:{state:'active'},now:()=> '2026-09-19T00:00:00.000Z'})
    assert.equal(run().executed.length,3); assert.equal(run().executed.length,0)
    for(const migration of NOTE_EDITING_MIGRATIONS) assert.equal(checkMigrationCompatibility(db,migration.compatibility).status,'satisfied')
    assert.deepEqual(db.prepare('SELECT * FROM blog_posts').get(),{id:1,title:'legacy',content:'keep markdown',status:'published',revision:0,creation_key:null,last_mutation_id:null})
  } finally {db.close()}
})
