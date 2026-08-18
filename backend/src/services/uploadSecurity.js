import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/

export function ensureUploadDirectory(storageRoot, directoryName, fileSystem = fs) {
  const requestedRoot = path.resolve(storageRoot)
  fileSystem.mkdirSync(requestedRoot, { recursive: true })
  const rootStat = fileSystem.lstatSync(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('上传根目录无效')
  }

  const realRoot = fileSystem.realpathSync.native(requestedRoot)
  const requestedDirectory = uploadPath(realRoot, directoryName)
  fileSystem.mkdirSync(requestedDirectory, { recursive: true })
  const directoryStat = fileSystem.lstatSync(requestedDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('上传临时目录无效')
  }

  const realDirectory = fileSystem.realpathSync.native(requestedDirectory)
  const relative = path.relative(realRoot, realDirectory)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('上传临时目录越界')
  }
  return realDirectory
}

export function validateUploadDescriptor(input, policy) {
  const fileId = String(input.fileId || '')
  const fileName = path.basename(String(input.fileName || ''))
  const totalChunks = Number(input.totalChunks)
  const chunkIndex = input.chunkIndex === undefined && input.index === undefined
    ? undefined
    : Number(input.chunkIndex ?? input.index)
  const extension = path.extname(fileName).toLowerCase()

  if (!FILE_ID_PATTERN.test(fileId)) throw new Error('上传标识无效')
  if (!fileName || fileName !== String(input.fileName || '')) throw new Error('文件名无效')
  if (!policy.extensions.includes(extension)) throw new Error('不支持的文件格式')
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > policy.maxChunks) {
    throw new Error('分片数量无效')
  }
  if (chunkIndex !== undefined && (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks)) {
    throw new Error('分片序号无效')
  }

  return { fileId, fileName, extension, totalChunks, chunkIndex }
}

export function uploadPath(root, ...segments) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...segments)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('上传路径越界')
  }
  return resolved
}

export function inspectChunks(root, fileId, totalChunks, naming, maxTotalBytes) {
  const paths = []
  let totalBytes = 0
  for (let index = 0; index < totalChunks; index++) {
    const chunkPath = uploadPath(root, naming(fileId, index))
    if (!fs.existsSync(chunkPath)) throw new Error(`缺少分片 ${index}`)
    totalBytes += fs.statSync(chunkPath).size
    if (totalBytes > maxTotalBytes) throw new Error('文件超过允许的最大容量')
    paths.push(chunkPath)
  }
  return { paths, totalBytes }
}

export async function mergeChunkFiles(chunkPaths, destination) {
  const output = fs.createWriteStream(destination, { flags: 'wx' })
  try {
    for (const chunkPath of chunkPaths) {
      await pipeline(fs.createReadStream(chunkPath), output, { end: false })
    }
    output.end()
    await new Promise((resolve, reject) => {
      output.once('finish', resolve)
      output.once('error', reject)
    })
  } catch (error) {
    output.destroy()
    if (fs.existsSync(destination)) fs.rmSync(destination, { force: true })
    throw error
  }
}

export function readFileHeader(filePath, byteCount = 16) {
  const handle = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(byteCount)
    const bytesRead = fs.readSync(handle, buffer, 0, byteCount, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    fs.closeSync(handle)
  }
}

export function validateArchiveEntries(entries, policy = {}) {
  const maxEntries = policy.maxEntries ?? 10000
  const maxEntryBytes = policy.maxEntryBytes ?? 100 * 1024 * 1024
  const maxExpandedBytes = policy.maxExpandedBytes ?? 1024 * 1024 * 1024
  const maxCompressionRatio = policy.maxCompressionRatio ?? 200
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > maxEntries) {
    throw new Error('压缩包条目数量异常')
  }

  let expandedBytes = 0
  for (const entry of entries) {
    const name = String(entry.entryName || '').replace(/\\/g, '/')
    const normalized = path.posix.normalize(name)
    if (!name || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error('压缩包包含越界路径')
    }
    const size = Number(entry.header?.size ?? 0)
    const compressedSize = Number(entry.header?.compressedSize ?? size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxEntryBytes) throw new Error('压缩包条目过大')
    expandedBytes += size
    if (expandedBytes > maxExpandedBytes) throw new Error('压缩包解压后容量过大')
    if (size > 1024 * 1024 && compressedSize > 0 && size / compressedSize > maxCompressionRatio) {
      throw new Error('压缩包压缩率异常')
    }
  }
  return { entryCount: entries.length, expandedBytes }
}
