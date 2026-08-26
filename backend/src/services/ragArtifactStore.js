import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { normalizeRagContentArtifact } from './pcWorkerProcessorCatalog.js'

export const RAG_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const FORMAT_PATTERN = /^(pdf|docx|epub)$/u
const POSITIVE_ID = /^[1-9]\d*$/u

export class RagArtifactStoreError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options)
    this.name = 'RagArtifactStoreError'
    this.code = code
  }
}

function fail(code, message = code) {
  throw new RagArtifactStoreError(code, message)
}

function taskId(value) {
  const normalized = typeof value === 'string' && POSITIVE_ID.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || normalized < 1) fail('RAG_ARTIFACT_INVALID', 'task id is invalid.')
  return normalized
}

function sourceInput(task) {
  if (task?.taskType !== 'rag.content.extract' || !task.input || typeof task.input !== 'object') {
    fail('RAG_ARTIFACT_UNSUPPORTED', 'task does not support content artifacts.')
  }
  return task.input
}

function metadataFor(task, metadata) {
  const input = sourceInput(task)
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('RAG_ARTIFACT_INVALID', 'artifact metadata is invalid.')
  const allowed = new Set(['sourceVersionId', 'sourceContentSha256', 'extractorVersion', 'artifactSha256', 'artifactBytes', 'sectionCount', 'format'])
  if (Object.keys(metadata).some((key) => !allowed.has(key))) fail('RAG_ARTIFACT_INVALID', 'artifact metadata contains unsupported fields.')
  const sourceVersionId = metadata.sourceVersionId
  const sourceContentSha256 = String(metadata.sourceContentSha256 ?? '').toLowerCase()
  const artifactSha256 = String(metadata.artifactSha256 ?? '').toLowerCase()
  const artifactBytes = Number(metadata.artifactBytes)
  const sectionCount = Number(metadata.sectionCount)
  const format = String(metadata.format ?? '').toLowerCase()
  if (sourceVersionId !== input.sourceVersionId || sourceContentSha256 !== input.sourceContentSha256 ||
      !HASH_PATTERN.test(artifactSha256) || !HASH_PATTERN.test(sourceContentSha256) ||
      !Number.isSafeInteger(artifactBytes) || artifactBytes < 1 || artifactBytes > RAG_ARTIFACT_MAX_BYTES ||
      !Number.isSafeInteger(sectionCount) || sectionCount < 1 || sectionCount > 100_000 ||
      !FORMAT_PATTERN.test(format) || format !== input.format) {
    fail('RAG_ARTIFACT_STALE', 'artifact metadata is not bound to the leased source.')
  }
  return Object.freeze({
    taskId: taskId(task.id),
    sourceVersionId,
    sourceContentSha256,
    artifactSha256,
    artifactBytes,
    sectionCount,
    format
  })
}

function currentMatches(task, current) {
  const input = sourceInput(task)
  if (!current || typeof current !== 'object') return false
  const currentHash = current.sha256 ?? current.sourceContentSha256
  const currentBytes = current.bytes ?? current.contentBytes
  if (currentHash !== input.sourceContentSha256 || Number(currentBytes) !== Number(input.contentBytes)) return false
  if (current.sourceVersionId !== undefined && String(current.sourceVersionId) !== String(input.sourceVersionId)) return false
  return true
}

function validateArtifact(value, metadata) {
  let normalized
  try {
    normalized = normalizeRagContentArtifact(value, {
      format: metadata.format,
      artifactSha256: metadata.artifactSha256,
      artifactBytes: metadata.artifactBytes,
      sectionCount: metadata.sectionCount
    })
  } catch (error) {
    if (error?.code === 'PC_WORKER_PROCESSOR_RESULT_TOO_LARGE') fail('RAG_ARTIFACT_TOO_LARGE', 'artifact exceeds its byte limit.')
    if (error?.code === 'PC_WORKER_PROCESSOR_RESULT_INPUT_MISMATCH' || error?.code === 'PC_WORKER_PROCESSOR_RESULT_STALE') {
      fail('RAG_ARTIFACT_STALE', 'artifact identity does not match the lease.')
    }
    fail('RAG_ARTIFACT_INVALID', 'artifact schema or content is invalid.')
  }
  return normalized
}

function metadataEqual(left, right) {
  return left.taskId === right.taskId && left.sourceVersionId === right.sourceVersionId &&
    left.sourceContentSha256 === right.sourceContentSha256 && left.artifactSha256 === right.artifactSha256 &&
    left.artifactBytes === right.artifactBytes && left.sectionCount === right.sectionCount && left.format === right.format
}

function metadataPayload(value) {
  return {
    taskId: value.taskId,
    sourceVersionId: value.sourceVersionId,
    sourceContentSha256: value.sourceContentSha256,
    artifactSha256: value.artifactSha256,
    artifactBytes: value.artifactBytes,
    sectionCount: value.sectionCount,
    format: value.format
  }
}

function defaultRoot() {
  return process.env.RAG_ARTIFACT_ROOT || path.join(process.env.DATA_PATH || process.cwd(), 'rag-artifacts')
}

export function createRagArtifactStore({ rootPath = defaultRoot(), now = () => new Date().toISOString(), randomBytes = crypto.randomBytes } = {}) {
  const root = path.resolve(String(rootPath))
  const taskDirectory = (id, kind) => path.join(root, kind, String(taskId(id)))

  async function ensureDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  }

  async function readStaged(id) {
    const directory = taskDirectory(id, 'staging')
    let metadata
    try {
      metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'))
    } catch {
      fail('RAG_ARTIFACT_MISSING', 'staged artifact is missing.')
    }
    let artifact
    try {
      artifact = JSON.parse(await fs.readFile(path.join(directory, 'artifact.json'), 'utf8'))
    } catch {
      fail('RAG_ARTIFACT_INVALID', 'staged artifact cannot be read.')
    }
    return { directory, metadata, artifact }
  }

  return Object.freeze({
    async stage({ task, stream, metadata, current }) {
      const normalized = metadataFor(task, metadata)
      if (!currentMatches(task, current)) fail('RAG_ARTIFACT_STALE', 'source changed during artifact upload.')
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail('RAG_ARTIFACT_INVALID', 'artifact stream is invalid.')
      const directory = taskDirectory(normalized.taskId, 'staging')
      await ensureDirectory(directory)
      const nonce = randomBytes(16).toString('hex')
      const temporary = path.join(directory, `${nonce}.part`)
      const handle = await fs.open(temporary, 'wx', 0o600)
      const digest = crypto.createHash('sha256')
      let bytes = 0
      try {
        for await (const chunkValue of stream) {
          const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
          bytes += chunk.length
          if (bytes > RAG_ARTIFACT_MAX_BYTES || bytes > normalized.artifactBytes) fail('RAG_ARTIFACT_TOO_LARGE', 'artifact exceeds its declared byte limit.')
          digest.update(chunk)
          await handle.write(chunk)
        }
        if (bytes !== normalized.artifactBytes || digest.digest('hex') !== normalized.artifactSha256) {
          fail('RAG_ARTIFACT_INVALID', 'artifact hash or byte count does not match metadata.')
        }
        await handle.close()
        const serialized = await fs.readFile(temporary, 'utf8')
        let artifact
        try { artifact = JSON.parse(serialized) } catch { fail('RAG_ARTIFACT_INVALID', 'artifact JSON is invalid.') }
        const checked = validateArtifact(artifact, normalized)
        if (JSON.stringify(checked.artifact) !== serialized) fail('RAG_ARTIFACT_INVALID', 'artifact JSON is not canonical.')
        const artifactPath = path.join(directory, 'artifact.json')
        const metadataPath = path.join(directory, 'metadata.json')
        let existingArtifact = false
        try { await fs.access(artifactPath); existingArtifact = true } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        if (existingArtifact) {
          await fs.access(metadataPath)
          const existing = await readStaged(normalized.taskId)
          const { taskId: _existingTaskId, createdAt: _existingCreatedAt, committedAt: _existingCommittedAt, ...existingMetadataInput } = existing.metadata ?? {}
          const existingMetadata = metadataFor(task, existingMetadataInput)
          if (metadataEqual(normalized, existingMetadata) && JSON.stringify(existing.artifact) === serialized) {
            await fs.rm(temporary, { force: true })
            return Object.freeze({
              artifactSha256: normalized.artifactSha256,
              artifactBytes: normalized.artifactBytes,
              sectionCount: normalized.sectionCount,
              format: normalized.format
            })
          }
          fail('RAG_ARTIFACT_CONFLICT', 'a different artifact is already staged for this task.')
        }
        await fs.rename(temporary, artifactPath)
        await fs.writeFile(metadataPath, JSON.stringify({ ...metadataPayload(normalized), createdAt: now() }), { mode: 0o600 })
        return Object.freeze({
          artifactSha256: normalized.artifactSha256,
          artifactBytes: normalized.artifactBytes,
          sectionCount: normalized.sectionCount,
          format: normalized.format
        })
      } catch (error) {
        await handle.close().catch(() => {})
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    },

    async commit({ task, metadata, current }) {
      const normalized = metadataFor(task, metadata)
      if (!currentMatches(task, current)) fail('RAG_ARTIFACT_STALE', 'source changed before artifact activation.')
      const staged = await readStaged(normalized.taskId)
      if (staged.metadata?.taskId !== normalized.taskId) fail('RAG_ARTIFACT_STALE', 'staged artifact task identity does not match.')
      const { taskId: _stagedTaskId, createdAt: _createdAt, committedAt: _committedAt, ...stagedMetadataInput } = staged.metadata ?? {}
      const stagedMetadata = metadataFor(task, stagedMetadataInput)
      if (!metadataEqual(normalized, stagedMetadata)) fail('RAG_ARTIFACT_STALE', 'staged artifact metadata does not match completion.')
      const checked = validateArtifact(staged.artifact, normalized)
      const serialized = JSON.stringify(checked.artifact)
      if (serialized.length === 0 || Buffer.byteLength(serialized, 'utf8') !== normalized.artifactBytes) {
        fail('RAG_ARTIFACT_INVALID', 'staged artifact bytes are invalid.')
      }
      const directory = taskDirectory(normalized.taskId, 'committed')
      await ensureDirectory(directory)
      try {
        await fs.access(path.join(directory, 'artifact.json'))
        fail('RAG_ARTIFACT_CONFLICT', 'an artifact is already committed for this task.')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await fs.rename(path.join(staged.directory, 'artifact.json'), path.join(directory, 'artifact.json'))
      await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ ...metadataPayload(normalized), committedAt: now() }), { mode: 0o600 })
      await fs.rm(staged.directory, { recursive: true, force: true })
      return Object.freeze({
        artifactSha256: normalized.artifactSha256,
        artifactBytes: normalized.artifactBytes,
        sectionCount: normalized.sectionCount,
        format: normalized.format
      })
    },

    async discardTask(id) {
      const normalizedId = taskId(id)
      await Promise.all([
        fs.rm(taskDirectory(normalizedId, 'staging'), { recursive: true, force: true }),
        fs.rm(taskDirectory(normalizedId, 'committed'), { recursive: true, force: true })
      ])
    },

    async readCommitted(id) {
      const normalizedId = taskId(id)
      const directory = taskDirectory(normalizedId, 'committed')
      try {
        return JSON.parse(await fs.readFile(path.join(directory, 'artifact.json'), 'utf8'))
      } catch {
        fail('RAG_ARTIFACT_MISSING', 'committed artifact is missing.')
      }
    }
  })
}

export default createRagArtifactStore
