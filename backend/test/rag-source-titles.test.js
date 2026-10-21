import assert from 'node:assert/strict'
import test from 'node:test'
import { attachRagSourceTitles } from '../src/services/ragSourceTitles.js'

const evidence = [{ sourceType: 'ebook', sourceId: 1, title: 'Introduction', body: 'original', snapshotId: 2 }]
const checks = { authoritativeActiveSnapshot: () => true, authoritativeVisibility: () => true }

test('source-title reads happen only after current snapshot and visibility checks', async () => {
  for (const denied of Object.keys(checks)) {
    let reads = 0
    const result = await attachRagSourceTitles({ evidence, checks: { ...checks, [denied]: () => false },
      database: { prepare() { reads++; throw Error('must not read') } } })
    assert.deepEqual(result, [])
    assert.equal(reads, 0)
  }
  await assert.rejects(attachRagSourceTitles({ evidence, checks: { ...checks, authoritativeVisibility: () => { throw Error('closed') } } }), /closed/)
})

test('missing or unsafe metadata never falls back to a chapter title', async () => {
  for (const title of [null, '', 'x'.repeat(2049), '/srv/private/file.pdf', 'password=synthetic-value']) {
    const result = await attachRagSourceTitles({ evidence, checks,
      database: { prepare: () => ({ get: () => ({ title }) }) } })
    assert.equal(result[0].title, null)
    assert.equal(result[0].body, 'original')
  }
  assert.equal((await attachRagSourceTitles({ evidence, checks }))[0].title, null)
  assert.equal((await attachRagSourceTitles({ evidence, checks, database: { prepare() { throw Error('missing table') } } }))[0].title, null)
  assert.equal(evidence[0].title, 'Introduction')
})

test('only fixed source tables and bound IDs supply identity', async () => {
  for (const [sourceType, table, column] of [['document', 'documents', 'title'], ['ebook', 'books', 'title'], ['code_repository', 'code_repositories', 'name']]) {
    const result = await attachRagSourceTitles({ evidence: [{ ...evidence[0], sourceType }], checks,
      database: { prepare(sql) { assert.equal(sql, `SELECT ${column} AS title FROM ${table} WHERE id = ?`); return { get(id) { assert.equal(id, 1); return { title: 'Verified source' } } } } } })
    assert.equal(result[0].title, 'Verified source')
  }
  for (const item of [{ sourceType: '__proto__' }, { sourceId: '1 OR 1=1' }]) {
    const result = await attachRagSourceTitles({ evidence: [{ ...evidence[0], ...item }], checks,
      database: { prepare() { throw Error('must not query') } } })
    assert.equal(result[0].title, null)
  }
})
