import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  batchUpdateDocumentMetadata,
  createDocumentCategory,
  deleteDocumentCategoryTree,
  renameDocumentCategory,
  reorderDocumentCategories,
  updateDocumentMetadata
} from '../src/services/documentCategoryService.js'
const require = createRequire(import.meta.url)
let Database; let native = true
try { Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close() } catch (error) { if (!/^Could not locate the bindings file/u.test(String(error?.message))) throw error; native = false }
const options = process.env.CI || native ? undefined : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE, path TEXT NOT NULL, level INTEGER NOT NULL, sort_order INTEGER DEFAULT 0);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT, category_id INTEGER, category TEXT, subcategory TEXT, tags TEXT, updated_at TEXT);
    CREATE TABLE resource_trash_entries (resource_type TEXT, resource_id INTEGER, PRIMARY KEY (resource_type, resource_id));
    INSERT INTO categories (id,name,parent_id,path,level) VALUES (1,'技术',NULL,'技术',0),(2,'前端',1,'技术/前端',1),(3,'Vue',2,'技术/前端/Vue',2),(4,'后端',1,'技术/后端',1);
    INSERT INTO documents VALUES (7,'A',3,'技术','前端/Vue','vue,Vue',NULL),(8,'B',2,'技术','前端',NULL,NULL),(9,'Legacy',NULL,'技术','前端/Vue/组件',NULL,NULL);
  `); return db
}
test('deletes a category subtree transactionally and moves new and legacy documents to the surviving parent', options, () => { const db=setup(); try { assert.deepEqual(deleteDocumentCategoryTree(db,2),{deletedCategories:2,movedDocuments:3,categoryId:1,activeDocumentIds:[7,8,9]}); assert.equal(db.prepare('SELECT COUNT(*) count FROM documents').get().count,3); assert.deepEqual(db.prepare('SELECT category_id,category,subcategory FROM documents WHERE id=9').get(),{category_id:1,category:'技术',subcategory:null}) } finally {db.close()} })
test('deleting a root category leaves documents uncategorized', options, () => { const db=setup(); try { deleteDocumentCategoryTree(db,1); assert.deepEqual(db.prepare('SELECT category_id,category,subcategory FROM documents WHERE id=7').get(),{category_id:null,category:null,subcategory:null}) } finally {db.close()} })
test('renames the category tree and synchronizes document compatibility paths', options, () => { const db=setup(); try { const result=renameDocumentCategory(db,2,'Web'); assert.equal(result.newPath,'技术/Web'); assert.deepEqual(result.activeDocumentIds,[7,8,9]); assert.equal(db.prepare('SELECT path FROM categories WHERE id=3').get().path,'技术/Web/Vue'); assert.deepEqual(db.prepare('SELECT category_id,subcategory FROM documents WHERE id=7').get(),{category_id:3,subcategory:'Web/Vue'}); assert.deepEqual(db.prepare('SELECT category_id,subcategory FROM documents WHERE id=9').get(),{category_id:null,subcategory:'Web/Vue/组件'}) } finally {db.close()} })
test('creates normalized categories and reorders siblings only', options, () => { const db=setup(); try { const created=createDocumentCategory(db,{name:' API ',parentId:1}); assert.equal(created.path,'技术/API'); assert.equal(reorderDocumentCategories(db,[{id:2,sortOrder:2},{id:4,sortOrder:1}]).count,2); assert.throws(()=>reorderDocumentCategories(db,[{id:1,sortOrder:0},{id:2,sortOrder:1}]),{code:'DOCUMENT_CATEGORY_ORDER_INVALID'}); assert.throws(()=>createDocumentCategory(db,{name:'前端',parentId:1}),{code:'DOCUMENT_CATEGORY_DUPLICATE'}); assert.throws(()=>createDocumentCategory(db,{name:'bad/name'}),{code:'DOCUMENT_CATEGORY_NAME_INVALID'}) } finally {db.close()} })
test('normalizes single and batch metadata writes around authoritative category IDs', options, () => { const db=setup(); try { updateDocumentMetadata(db,7,{title:' Note ',categoryId:4,tags:'Vue,vue, API '}); assert.deepEqual(db.prepare('SELECT title,category_id,category,subcategory,tags FROM documents WHERE id=7').get(),{title:'Note',category_id:4,category:'技术',subcategory:'后端',tags:'API,Vue'}); assert.equal(batchUpdateDocumentMetadata(db,[7,8],{categoryId:null,tags:'x,X'}).count,2) } finally {db.close()} })
