import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  isRagRequest,
  requestBodyForLog,
  serializeRagLogMetadata
} from '../src/services/logRedaction.js'

const require = createRequire(import.meta.url)
let Database
let nativeBindingAvailable = true
try {
  Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  if (!/^Could not locate the bindings file\. Tried:/u.test(String(error?.message ?? ''))) throw error
  nativeBindingAvailable = false
}

const nativeTestOptions = process.env.CI || nativeBindingAvailable
  ? undefined
  : { skip: 'better-sqlite3 native binding is unavailable locally; Linux CI must run this test' }
const shouldRunNativeTests = Boolean(process.env.CI || nativeBindingAvailable)

const previousDbPath = process.env.DB_PATH
const previousDataPath = process.env.DATA_PATH
const dataRoot = shouldRunNativeTests
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'pr-manager-rag-log-'))
  : null
const dbPath = dataRoot ? path.join(dataRoot, 'database', 'app.db') : null

let database = null
let accessLogger = null
let queryLogs = null
if (shouldRunNativeTests) {
  process.env.DB_PATH = dbPath
  delete process.env.DATA_PATH
  const databaseModule = await import('../src/config/database.js')
  const loggerModule = await import('../src/services/logger.js')
  database = databaseModule.getDatabase()
  accessLogger = loggerModule.accessLogger
  queryLogs = loggerModule.queryLogs
  database.exec(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT,
      method TEXT,
      path TEXT,
      module TEXT,
      ip_address TEXT,
      ip_location TEXT,
      user_agent TEXT,
      request_body TEXT,
      response_status INTEGER,
      duration INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

test.after(() => {
  if (database?.open) database.close()
  if (previousDbPath === undefined) delete process.env.DB_PATH
  else process.env.DB_PATH = previousDbPath
  if (previousDataPath === undefined) delete process.env.DATA_PATH
  else process.env.DATA_PATH = previousDataPath
  if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true })
})

function request({ body, context, originalUrl = '/api/rag/queries?q=RAG_PRIVATE_QUERY' } = {}) {
  return {
    method: 'POST',
    path: '/rag/queries',
    url: '/rag/queries?q=RAG_PRIVATE_QUERY',
    originalUrl,
    body,
    ...(context === undefined ? {} : { ragLogContext: context }),
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    user: { id: 1, username: 'owner' },
    get: () => 'logger-rag-privacy-test'
  }
}

function response() {
  return {
    statusCode: 200,
    end() {}
  }
}

async function writeLog(req) {
  const res = response()
  accessLogger(req, res, () => {})
  await res.end()
}

async function writeBatch(reqFactory) {
  // logger.js flushes at ten queued records; use the production threshold so
  // the test does not need a test-only flush export or a five-second wait.
  for (let index = 0; index < 10; index += 1) await writeLog(reqFactory(index))
}

const sentinels = Object.freeze({
  query: 'RAG_PRIVATE_QUERY',
  body: 'RAG_PRIVATE_BODY',
  answer: 'RAG_PRIVATE_ANSWER',
  evidence: 'RAG_PRIVATE_EVIDENCE',
  context: 'RAG_PRIVATE_CONTEXT',
  citations: 'RAG_PRIVATE_CITATIONS',
  prompt: 'RAG_PRIVATE_PROMPT'
})

test('classifies the mounted RAG path from originalUrl and keeps non-RAG compatibility', () => {
  const mountedRequest = request({ body: { q: sentinels.query } })
  assert.equal(isRagRequest(mountedRequest), true)
  assert.equal(isRagRequest({
    originalUrl: `/api/rag?keyword=${encodeURIComponent(sentinels.query)}`,
    path: '/rag',
    baseUrl: '/api'
  }), true)
  assert.equal(isRagRequest({
    originalUrl: `/api/ragging?q=${encodeURIComponent(sentinels.query)}`,
    path: '/ragging',
    baseUrl: '/api'
  }), false)

  const generic = requestBodyForLog({
    originalUrl: '/api/search?keyword=normal',
    body: { keyword: 'normal', token: 'do-not-persist' }
  })
  assert.deepEqual(JSON.parse(generic), {
    keyword: 'normal',
    token: '[REDACTED]'
  })
  assert.equal(serializeRagLogMetadata({ answer: sentinels.answer }), null)
})

test('global request console logging uses the path component and never the query', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(source, /console\.log\(.*req\.method.*req\.path/u)
  assert.doesNotMatch(source, /console\.log\(.*req\.method.*req\.url/u)
})

test('RAG request bodies and content-shaped nested fields never enter access_logs or queryLogs', nativeTestOptions, async () => {
  database.exec('DELETE FROM access_logs')
  const body = {
    q: sentinels.query,
    body: sentinels.body,
    answer: sentinels.answer,
    nested: {
      context: sentinels.context,
      evidence: [{ body: sentinels.evidence }],
      citations: [sentinels.citations],
      prompt: sentinels.prompt,
      arbitrary: { text: sentinels.body }
    }
  }

  await writeBatch(() => request({ body }))

  const rows = database.prepare(
    'SELECT path, request_body FROM access_logs ORDER BY id'
  ).all()
  const adminQuery = queryLogs({ page: 1, pageSize: 50 })
  assert.equal(rows.length, 10)
  assert.equal(adminQuery.data.length, 10)
  assert.ok(rows.every((row) => row.path === '/rag/queries'))
  assert.ok(rows.every((row) => row.request_body === null))
  assert.doesNotMatch(JSON.stringify(rows), /RAG_PRIVATE_/u)
  assert.doesNotMatch(JSON.stringify(adminQuery), /RAG_PRIVATE_/u)
})

test('RAG logs accept only stable server metadata and ignore content fields at any depth', nativeTestOptions, async () => {
  database.exec('DELETE FROM access_logs')
  await writeBatch(() => request({
    body: { q: sentinels.query, answer: sentinels.answer },
    context: {
      requestId: '00000000-0000-4000-8000-000000000001',
      queryId: '00000000-0000-4000-8000-000000000002',
      retrievalMode: 'hybrid',
      evidenceCount: 3,
      answer: sentinels.answer,
      nested: { q: sentinels.query }
    }
  }))

  const rows = database.prepare('SELECT request_body FROM access_logs ORDER BY id').all()
  const adminQuery = queryLogs({ page: 1, pageSize: 50 })
  assert.ok(rows.every((row) => row.request_body === JSON.stringify({
    requestId: '00000000-0000-4000-8000-000000000001',
    queryId: '00000000-0000-4000-8000-000000000002',
    retrievalMode: 'hybrid',
    evidenceCount: 3
  })))
  assert.doesNotMatch(JSON.stringify(rows), /RAG_PRIVATE_/u)
  assert.doesNotMatch(JSON.stringify(adminQuery), /RAG_PRIVATE_/u)
})
