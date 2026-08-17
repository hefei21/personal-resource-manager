import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import {
  OWNER_SESSION_COOKIE,
  createOwnerSession
} from '../src/services/sessions.js'

const require = createRequire(import.meta.url)
const BLOG_ROUTE_SOURCE = fs.readFileSync(new URL('../src/routes/blog.js', import.meta.url), 'utf8')
const INDEX_SOURCE = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const BLOG_PC_SOURCE = fs.readFileSync(new URL('../../frontend/src/pc/pages/BlogPC.vue', import.meta.url), 'utf8')
const BLOG_MOBILE_SOURCE = fs.readFileSync(new URL('../../frontend/src/mobile/pages/BlogMobile.vue', import.meta.url), 'utf8')

function isKnownNativeBindingMissingError(error) {
  return /^Could not locate the bindings file\. Tried:\s*[\s\S]*better_sqlite3\.node\b/.test(
    String(error?.message ?? '')
  )
}

let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!isKnownNativeBindingMissingError(error)) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
const shouldRunNativeTests = process.env.CI || nativeBindingAvailable
const dataRoot = shouldRunNativeTests
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'pr-manager-blog-status-'))
  : null
const dbPath = dataRoot ? path.join(dataRoot, 'database', 'app.db') : null

let blogRouter
let getDatabase
let cache
if (shouldRunNativeTests) {
  process.env.DATA_PATH = dataRoot
  delete process.env.DB_PATH

  const blogModule = await import('../src/routes/blog.js')
  const databaseModule = await import('../src/config/database.js')
  const cacheModule = await import('../src/utils/cache.js')
  blogRouter = blogModule.default
  getDatabase = databaseModule.getDatabase
  cache = cacheModule.cache
}

function schemaRows(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE (type = 'table' AND name = 'blog_posts')
       OR (type = 'index' AND tbl_name = 'blog_posts')
    ORDER BY type, name
  `).all()
}

function createFixture() {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const database = new Database(dbPath)
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
    INSERT INTO users (id, username, password)
    VALUES (1, 'owner', 'test-only-session-user');

    CREATE TABLE blog_categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES blog_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      category_id INTEGER,
      status TEXT DEFAULT 'draft',
      is_top INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES blog_categories(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_blog_posts_status ON blog_posts(status);
    CREATE INDEX idx_blog_posts_category_id ON blog_posts(category_id);
    CREATE TABLE blog_tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT
    );
    CREATE TABLE blog_post_tags (
      post_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (post_id, tag_id),
      FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES blog_tags(id) ON DELETE CASCADE
    );
  `)

  const marker = `blog-status-retirement-${process.pid}`
  const postStmt = database.prepare(`
    INSERT INTO blog_posts (title, content, status, is_top)
    VALUES (?, ?, ?, ?)
  `)
  const firstPostId = Number(postStmt.run(
    `${marker} historical`,
    'Historical content',
    'legacy-history',
    1
  ).lastInsertRowid)
  const secondPostId = Number(postStmt.run(
    `${marker} draft-history`,
    'Draft history content',
    'draft',
    0
  ).lastInsertRowid)

  const schemaBefore = schemaRows(database)
  const ownerSession = createOwnerSession(
    database,
    { id: 1, username: 'owner' },
    { userAgent: 'blog-status-retirement-test' }
  )
  database.close()

  return {
    marker,
    firstPostId,
    secondPostId,
    ownerSession,
    schemaBefore
  }
}

const fixture = shouldRunNativeTests ? createFixture() : null

async function withServer(run) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/blog', blogRouter)

  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  try {
    const { port } = server.address()
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function ownerHeaders(headers = {}) {
  return {
    cookie: `${OWNER_SESSION_COOKIE}=${fixture.ownerSession.token}`,
    ...headers
  }
}

async function ownerRequest(baseUrl, route, init = {}) {
  return fetch(`${baseUrl}/api/blog${route}`, {
    ...init,
    headers: ownerHeaders(init.headers)
  })
}

function hasLegacyField(value) {
  return Object.prototype.hasOwnProperty.call(value, 'status')
}

test('blog runtime and both owner UIs no longer expose publishing-state semantics', () => {
  for (const forbidden of [
    'p.status',
    "updateFields.push('status = ?')",
    'INSERT INTO blog_posts (title, content, category_id, status'
  ]) {
    assert.equal(BLOG_ROUTE_SOURCE.includes(forbidden), false, `blog route still contains ${forbidden}`)
  }

  for (const forbidden of ["status = 'published'", "status = 'draft'"]) {
    assert.equal(INDEX_SOURCE.includes(forbidden), false, `dashboard still contains ${forbidden}`)
  }

  for (const [name, source] of [
    ['PC', BLOG_PC_SOURCE],
    ['mobile', BLOG_MOBILE_SOURCE]
  ]) {
    for (const forbidden of [
      'statusFilter',
      'handleSaveDraft',
      'handlePublish',
      'published',
      "status: 'draft'",
      '保存草稿',
      '发布文章'
    ]) {
      assert.equal(source.includes(forbidden), false, `${name} blog UI still contains ${forbidden}`)
    }
  }
})

test('blog remains owner-only while a valid owner can access notes', nativeTestOptions, async () => {
  await withServer(async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/blog/posts`)
    assert.equal(anonymous.status, 401)

    const demo = await fetch(`${baseUrl}/api/blog/posts`, {
      headers: { cookie: 'pr_demo_session=opaque-demo-session' }
    })
    assert.equal(demo.status, 401)

    const owner = await ownerRequest(baseUrl, '/posts')
    assert.equal(owner.status, 200)
  })
})

test('legacy status values stay in storage but leave the runtime contract', nativeTestOptions, async () => {
  await withServer(async (baseUrl) => {
    const observedCacheKeys = []
    const originalGet = cache.get
    const originalSet = cache.set
    cache.get = async function (key) {
      observedCacheKeys.push(key)
      return originalGet.call(this, key)
    }
    cache.set = async function (key, value, ttl) {
      observedCacheKeys.push(key)
      return originalSet.call(this, key, value, ttl)
    }

    let firstList
    let secondList
    try {
      const firstResponse = await ownerRequest(
        baseUrl,
        `/posts?status=published&keyword=${encodeURIComponent(fixture.marker)}`
      )
      assert.equal(firstResponse.status, 200)
      firstList = await firstResponse.json()

      const secondResponse = await ownerRequest(
        baseUrl,
        `/posts?status=draft&keyword=${encodeURIComponent(fixture.marker)}`
      )
      assert.equal(secondResponse.status, 200)
      secondList = await secondResponse.json()
    } finally {
      cache.get = originalGet
      cache.set = originalSet
    }

    const expectedIds = [fixture.firstPostId, fixture.secondPostId]
    assert.deepEqual(firstList.data.map((post) => post.id), expectedIds)
    assert.deepEqual(secondList.data.map((post) => post.id), expectedIds)
    assert.equal(firstList.total, 2)
    assert.equal(secondList.total, 2)
    assert.ok(firstList.data.every((post) => !hasLegacyField(post)))
    assert.ok(secondList.data.every((post) => !hasLegacyField(post)))

    const listCacheKeys = observedCacheKeys.filter((key) => key.startsWith('blog:posts:'))
    assert.equal(new Set(listCacheKeys).size, 1)

    const singleResponse = await ownerRequest(
      baseUrl,
      `/posts/${fixture.firstPostId}`
    )
    assert.equal(singleResponse.status, 200)
    const single = await singleResponse.json()
    assert.equal(hasLegacyField(single.data), false)

    const createResponse = await ownerRequest(baseUrl, '/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `${fixture.marker} new note`,
        content: 'Created content',
        status: 'published',
        is_top: false
      })
    })
    assert.equal(createResponse.status, 200)
    const created = await createResponse.json()
    const database = getDatabase()
    const createdRow = database.prepare(
      'SELECT status FROM blog_posts WHERE id = ?'
    ).get(created.data.id)
    assert.equal(createdRow.status, 'draft')

    const updateResponse = await ownerRequest(
      baseUrl,
      `/posts/${fixture.firstPostId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `${fixture.marker} updated`,
          status: 'published',
          is_top: false
        })
      }
    )
    assert.equal(updateResponse.status, 200)
    const updatedRow = database.prepare(
      'SELECT title, status FROM blog_posts WHERE id = ?'
    ).get(fixture.firstPostId)
    assert.equal(updatedRow.title, `${fixture.marker} updated`)
    assert.equal(updatedRow.status, 'legacy-history')

    assert.deepEqual(schemaRows(database), fixture.schemaBefore)
    const statusColumn = database.prepare('PRAGMA table_info(blog_posts)').all()
      .find((column) => column.name === 'status')
    assert.equal(statusColumn.dflt_value, "'draft'")
    assert.ok(fixture.schemaBefore.some((row) => row.name === 'idx_blog_posts_status'))
  })
})
