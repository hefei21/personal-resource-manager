import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createRagArtifactStore, RAG_ARTIFACT_MAX_BYTES } from '../src/services/ragArtifactStore.js'

function fixture() {
  const sections = [{ ordinal: 0, title: 'Document', text: 'Grounded text.', locator: { paragraphStart: 0, paragraphEnd: 0 } }]
  const artifact = JSON.stringify({ schemaVersion: 1, format: 'docx', sections })
  const source = Buffer.from('source bytes')
  const sourceHash = createHash('sha256').update(source).digest('hex')
  const artifactHash = createHash('sha256').update(artifact).digest('hex')
  const task = {
    id: 41,
    taskType: 'rag.content.extract',
    input: {
      schemaVersion: 1, sourceType: 'document', sourceId: 7, sourceVersionId: 'version-7',
      sourceContentSha256: sourceHash, contentBytes: source.length, format: 'docx'
    }
  }
  const metadata = {
    sourceVersionId: task.input.sourceVersionId,
    sourceContentSha256: sourceHash,
    artifactSha256: artifactHash,
    artifactBytes: Buffer.byteLength(artifact),
    sectionCount: 1,
    format: 'docx'
  }
  return { artifact, sourceHash, source, task, metadata, current: { sourceVersionId: 'version-7', sourceContentSha256: sourceHash, contentBytes: source.length } }
}

test('stages and commits a canonical artifact without exposing a client path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-artifact-store-'))
  try {
    const value = fixture()
    const store = createRagArtifactStore({ rootPath: root })
    const staged = await store.stage({ ...value, stream: Readable.from([value.artifact]) })
    assert.deepEqual(staged, {
      artifactSha256: value.metadata.artifactSha256,
      artifactBytes: value.metadata.artifactBytes,
      sectionCount: 1,
      format: 'docx'
    })
    assert.deepEqual(await store.stage({ ...value, stream: Readable.from([value.artifact]) }), staged)
    const differentArtifact = value.artifact.replace('Grounded text.', 'Different text.')
    await assert.rejects(store.stage({
      ...value,
      artifact: differentArtifact,
      metadata: {
        ...value.metadata,
        artifactSha256: createHash('sha256').update(differentArtifact).digest('hex'),
        artifactBytes: Buffer.byteLength(differentArtifact)
      },
      stream: Readable.from([differentArtifact])
    }), (error) => error.code === 'RAG_ARTIFACT_CONFLICT')
    const committed = await store.commit(value)
    assert.deepEqual(committed, staged)
    assert.deepEqual((await store.readCommitted(value.task.id)).sections[0], {
      ordinal: 0, title: 'Document', text: 'Grounded text.', locator: { paragraphStart: 0, paragraphEnd: 0 }
    })
    assert.equal(JSON.stringify(committed).includes(root), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rejects hash, source, schema, oversized, and traversal-shaped artifact inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-artifact-store-invalid-'))
  try {
    const value = fixture()
    const store = createRagArtifactStore({ rootPath: root })
    await assert.rejects(store.stage({ ...value, metadata: { ...value.metadata, artifactSha256: 'a'.repeat(64) }, stream: Readable.from([value.artifact]) }),
      (error) => error.code === 'RAG_ARTIFACT_INVALID')
    await assert.rejects(store.stage({ ...value, current: { ...value.current, sourceContentSha256: 'b'.repeat(64) }, stream: Readable.from([value.artifact]) }),
      (error) => error.code === 'RAG_ARTIFACT_STALE')
    const unsafe = JSON.stringify({ schemaVersion: 1, format: 'docx', sections: [{ ordinal: 0, title: 'x', text: 'x', locator: { path: '../escape' } }] })
    const unsafeValue = { ...value, artifact: unsafe, metadata: { ...value.metadata, artifactSha256: createHash('sha256').update(unsafe).digest('hex'), artifactBytes: Buffer.byteLength(unsafe) } }
    await assert.rejects(store.stage({ ...unsafeValue, stream: Readable.from([unsafe]) }),
      (error) => error.code === 'RAG_ARTIFACT_INVALID')
    const huge = Buffer.alloc(RAG_ARTIFACT_MAX_BYTES + 1, 0x61)
    await assert.rejects(store.stage({ ...value, stream: Readable.from([huge]) }),
      (error) => error.code === 'RAG_ARTIFACT_TOO_LARGE' || error.code === 'RAG_ARTIFACT_INVALID')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
