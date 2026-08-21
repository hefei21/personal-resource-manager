import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { cache, CacheKeys, CacheTTL } from '../utils/cache.js'
import { compressBase64Image } from '../utils/imageCompress.js'
import { convertToUTC8 } from '../utils/time.js'
import { PAGINATION, TIMEOUT } from '../config/constants.js'
import { ensureUploadDirectory, inspectChunks, mergeChunkFiles, readFileHeader, uploadPath, validateUploadDescriptor } from '../services/uploadSecurity.js'
import { getResourceStorageRuntime } from '../services/resourceStorageRuntime.js'
import { getStorageCommitOperation } from '../services/storageCommitCoordinator.js'
import { commitMusicUpload } from '../services/musicStorageService.js'
import { hashMusicFile, musicContentType, parseMusicRange } from '../services/musicPlaybackService.js'
import { registerTaskProcessor } from '../services/taskRuntime.js'
import { enqueueExclusiveRun, getTaskById } from '../services/taskStore.js'
import {
  createMusicMetadataTaskProcessor,
  enqueueMusicMetadataTask,
  MUSIC_METADATA_EXECUTION_CLASS,
  MUSIC_METADATA_PARSER_VERSION,
  MUSIC_METADATA_PROCESSOR_VERSION,
  MUSIC_METADATA_SUBJECT_TYPE,
  MUSIC_METADATA_TASK_TYPE,
  projectMusicMetadataTask
} from '../services/musicMetadataTaskProcessor.js'
import {
  createMusicLyricsTaskProcessor,
  MUSIC_LYRICS_EXECUTION_CLASS,
  MUSIC_LYRICS_PROCESSOR_VERSION,
  MUSIC_LYRICS_SUBJECT_ID,
  MUSIC_LYRICS_SUBJECT_TYPE,
  MUSIC_LYRICS_TASK_TYPES,
  normalizeMusicLyricsTaskInput
} from '../services/musicLyricsTaskProcessor.js'
import {
  listDeletedMusic,
  permanentlyDeleteMusic,
  restoreMusicFromTrash,
  softDeleteMusic,
  softDeleteMusics
} from '../services/musicTrashService.js'

const execFileAsync = promisify(execFile)
const MUSIC_UPLOAD_POLICY = {
  extensions: ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.ape'],
  maxChunks: 1000,
  maxChunkBytes: 11 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
}

// 创建代理 agent
const httpsAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

// 上传取消管理
// 使用 Set 存储已取消的 fileId，实现实时取消功能
const cancelledUploads = new Set()

// 存储正在上传的文件进度（用于跨标签页同步和断点续传）
// uploadProgress: Map<fileId, { fileName, fileSize, totalChunks, receivedChunks: Set<number>, status, timestamp, fileData? }>
const uploadProgress = new Map()

// 定期清理过期的取消标记（避免内存泄漏）
const uploadCleanupTimer = setInterval(() => {
  // 清理 10 分钟前的取消标记（保留足够时间让正在进行的请求检测到）
  if (cancelledUploads.size > 100) {
    cancelledUploads.clear()
    console.log('[上传取消] 清理取消标记缓存')
  }
  
  // 清理超过 60 分钟的上传进度记录（给断点续传足够时间）
  const now = Date.now()
  for (const [fileId, progress] of uploadProgress) {
    if (now - progress.timestamp > 60 * 60 * 1000) {
      // 清理临时分片文件
      for (let i = 0; i < (progress.totalChunks || 0); i++) {
        const chunkPath = path.join(currentMusicTempDir(), `${fileId}_${i}`)
        try {
          if (fs.existsSync(chunkPath)) {
            fs.unlinkSync(chunkPath)
          }
        } catch (e) {}
      }
      uploadProgress.delete(fileId)
      console.log(`[上传清理] 清理过期上传: ${fileId}`)
    }
  }
}, 10 * 60 * 1000)
uploadCleanupTimer.unref?.()

// 中文拼音排序（使用 Intl.Collator）
// 使用 JavaScript 内置的 Intl.Collator 实现中文拼音排序
const zhCollator = new Intl.Collator('zh-CN', { 
  sensitivity: 'base',  // 不区分大小写和声调
  numeric: true         // 数字按数值排序
})

// 比较函数：按拼音排序
function compareByPinyin(a, b, field) {
  const valueA = a[field] || ''
  const valueB = b[field] || ''
  return zhCollator.compare(valueA, valueB)
}

// 元数据解析（降级方案）

// 简单解析 FLAC Vorbis Comments（纯 JS，无需外部依赖）
function parseFlacVorbisComments(buffer) {
  try {
    // FLAC 文件结构：fLaC + metadata blocks
    if (buffer.length < 4 || buffer.slice(0, 4).toString('ascii') !== 'fLaC') {
      return null
    }

    let offset = 4 // 跳过 fLaC 标记
    const metadata = { title: null, artist: null, album: null }

    // 遍历 metadata blocks
    while (offset + 4 <= buffer.length) {
      // 读取 block header（4字节）
      const isLast = (buffer[offset] & 0x80) !== 0
      const blockType = buffer[offset] & 0x7F
      const blockSize = buffer.readUInt32BE(offset + 1) & 0x00FFFFFF
      
      offset += 4

      // Vorbis Comment block (type 4)
      if (blockType === 4 && offset + blockSize <= buffer.length) {
        const blockData = buffer.slice(offset, offset + blockSize)
        
        // 解析 Vorbis Comment
        // 格式：vendor_length(4) + vendor_string + comment_count(4) + comments
        let pos = 0
        const vendorLength = blockData.readUInt32LE(pos)
        pos += 4 + vendorLength // 跳过 vendor string
        
        const commentCount = blockData.readUInt32LE(pos)
        pos += 4

        // 读取每个 comment
        for (let i = 0; i < commentCount && pos < blockData.length; i++) {
          const commentLength = blockData.readUInt32LE(pos)
          pos += 4
          
          if (pos + commentLength > blockData.length) break
          
          const comment = blockData.slice(pos, pos + commentLength).toString('utf8')
          pos += commentLength

          // 解析 key=value
          const equalIndex = comment.indexOf('=')
          if (equalIndex > 0) {
            const key = comment.slice(0, equalIndex).toUpperCase()
            const value = comment.slice(equalIndex + 1)

            if (key === 'TITLE' && !metadata.title) metadata.title = value
            else if (key === 'ARTIST' && !metadata.artist) metadata.artist = value
            else if (key === 'ALBUM' && !metadata.album) metadata.album = value
          }
        }

        return metadata
      }

      offset += blockSize
      if (isLast) break
    }

    return metadata
  } catch (error) {
    const failure = new Error('Lightweight music metadata parsing failed.')
    failure.code = 'MUSIC_METADATA_LIGHTWEIGHT_PARSE_FAILED'
    throw failure
  }
}

// 简单解析 MP3 ID3v2 标签（纯 JS）
function parseMp3Id3Tags(buffer) {
  try {
    // 检查 ID3v2 标签
    if (buffer.length < 10 || buffer.slice(0, 3).toString('ascii') !== 'ID3') {
      return { title: null, artist: null, album: null }
    }

    const metadata = { title: null, artist: null, album: null }
    const id3Size = ((buffer[6] & 0x7F) << 21) | 
                    ((buffer[7] & 0x7F) << 14) | 
                    ((buffer[8] & 0x7F) << 7) | 
                    (buffer[9] & 0x7F)

    let offset = 10
    const end = Math.min(10 + id3Size, buffer.length)

    // 简单遍历帧（只提取常见字段）
    while (offset < end) {
      if (offset + 10 > end) break

      const frameId = buffer.slice(offset, offset + 4).toString('ascii')
      const frameSize = buffer.readUInt32BE(offset + 4)
      offset += 10

      if (frameSize === 0 || offset + frameSize > end) break

      // 提取帧内容
      const frameData = buffer.slice(offset, offset + frameSize)
      offset += frameSize

      // 跳过编码字节（第一个字节）
      let value = ''
      if (frameData.length > 1) {
        const encoding = frameData[0]
        try {
          if (encoding === 0) {
            // ISO-8859-1
            value = frameData.slice(1).toString('latin1').replace(/\0/g, '')
          } else if (encoding === 1 || encoding === 2) {
            // UTF-16/UTF-16BE
            value = frameData.slice(1).toString('utf16le').replace(/\0/g, '')
          } else if (encoding === 3) {
            // UTF-8
            value = frameData.slice(1).toString('utf8').replace(/\0/g, '')
          }
        } catch (e) {
          value = frameData.slice(1).toString('utf8').replace(/\0/g, '')
        }
      }

      // 映射帧 ID 到字段
      if (frameId === 'TIT2' && !metadata.title) metadata.title = value
      else if (frameId === 'TPE1' && !metadata.artist) metadata.artist = value
      else if (frameId === 'TALB' && !metadata.album) metadata.album = value
    }

    return metadata
  } catch (error) {
    const failure = new Error('Lightweight music metadata parsing failed.')
    failure.code = 'MUSIC_METADATA_LIGHTWEIGHT_PARSE_FAILED'
    throw failure
  }
}

// 轻量级元数据解析（降级方案）
function parseMetadataLightweight(filePath, originalName) {
  try {
    const ext = path.extname(originalName).toLowerCase()
    const handle = fs.openSync(filePath, 'r')
    let buffer
    try {
      const prefix = Buffer.allocUnsafe(64 * 1024)
      const bytesRead = fs.readSync(handle, prefix, 0, prefix.length, 0)
      buffer = prefix.subarray(0, bytesRead)
    } finally {
      fs.closeSync(handle)
    }
    
    if (ext === '.flac') {
      return parseFlacVorbisComments(buffer)
    } else if (ext === '.mp3') {
      return parseMp3Id3Tags(buffer)
    }
    
    return null
  } catch (error) {
    const failure = new Error('Lightweight music metadata source could not be read.')
    failure.code = 'MUSIC_METADATA_LIGHTWEIGHT_PARSE_FAILED'
    throw failure
  }
}

// 主解析函数

const router = express.Router()

// 最终存储目录
const musicDir = getStoragePath('music')

// 临时上传目录
const currentMusicTempDir = () => ensureUploadDirectory(musicDir, 'temp')
currentMusicTempDir()

// 配置分片上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try { cb(null, currentMusicTempDir()) } catch (error) { cb(error) }
  },
  filename: (req, file, cb) => {
    try {
      const descriptor = validateUploadDescriptor(req.body, MUSIC_UPLOAD_POLICY)
      cb(null, `${descriptor.fileId}_${descriptor.chunkIndex}`)
    } catch (error) {
      cb(error)
    }
  }
})

const upload = multer({ storage, limits: { fileSize: MUSIC_UPLOAD_POLICY.maxChunkBytes, files: 1 } })

// 解析音乐元数据（三层降级策略）。解析器只返回安全字段；原始标签和异常正文
// 不进入日志、响应或持久任务。
export async function parseMusicMetadata(filePath, originalName, { signal } = {}) {
  const ext = path.extname(String(originalName || '')).toLowerCase()
  const fallback = fallbackMusicMetadata(originalName)
  let probeFailure = null

  // 第一层：尝试使用 FFprobe（最可靠，需要 FFmpeg）。
  try {
    const { stdout } = await execFileAsync(
      'ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 50 * 1024 * 1024, timeout: 10_000, signal }
    )

    const probeData = JSON.parse(stdout)
    const format = probeData.format || {}
    const tags = format.tags || {}
    const metadata = {
      title: tags.title || tags.TITLE || fallback.title,
      artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST || tags.artists || null,
      album: tags.album || tags.ALBUM || null,
      duration: format.duration ? Math.round(Number.parseFloat(format.duration)) : 0,
      coverImage: null
    }

    const videoStream = probeData.streams?.find(s =>
      s.codec_type === 'video' && s.disposition?.attached_pic === 1
    )
    if (videoStream) {
      try {
        const { stdout: coverData } = await execFileAsync(
          'ffmpeg', ['-v', 'quiet', '-i', filePath, '-an', '-vcodec', 'copy', '-f', 'image2pipe', '-'],
          {
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5_000,
            signal
          }
        )
        const mimeType = videoStream.codec_name === 'png' ? 'image/png' : 'image/jpeg'
        const rawCoverImage = `data:${mimeType};base64,${coverData.toString('base64')}`
        metadata.coverImage = await compressBase64Image(rawCoverImage, {
          maxWidth: 500,
          maxHeight: 500,
          quality: 85
        })
      } catch {
        // A missing cover is a partial metadata result, not an upload failure.
      }
    }

    const stats = fs.statSync(filePath)
    const normalized = { ...fallback, ...metadata, fileSize: stats.size, fileType: ext.replace('.', '') }
    return {
      ...normalized,
      status: musicMetadataStatusForValues(normalized),
      errorCode: null,
      needsReparse: false
    }
  } catch (error) {
    probeFailure = error
  }

  // 第二层：轻量级纯 JS 解析（无需外部依赖）。标签缺失仍是可用的 partial
  // 结果；只有轻量解析本身异常时才把错误交给持久任务恢复。
  let lightweightMetadata
  try {
    lightweightMetadata = parseMetadataLightweight(filePath, originalName)
  } catch (error) {
    const failure = new Error('Music metadata parsers failed.')
    failure.code = probeFailure?.code === 'ETIMEDOUT' || probeFailure?.killed
      ? 'MUSIC_METADATA_PARSE_TIMEOUT'
      : 'MUSIC_METADATA_PARSE_FAILED'
    throw failure
  }

  if (lightweightMetadata === null) {
    const failure = new Error('Music metadata parsers failed.')
    failure.code = probeFailure?.code === 'ETIMEDOUT' || probeFailure?.killed
      ? 'MUSIC_METADATA_PARSE_TIMEOUT'
      : 'MUSIC_METADATA_PARSE_FAILED'
    throw failure
  }

  const stats = fs.statSync(filePath)
  const normalized = {
    ...fallback,
    title: lightweightMetadata.title || fallback.title,
    artist: lightweightMetadata.artist || null,
    album: lightweightMetadata.album || null,
    duration: 0,
    coverImage: null,
    fileSize: stats.size,
    fileType: ext.replace('.', '')
  }
  return {
    ...normalized,
    status: 'partial',
    errorCode: null,
    needsReparse: false
  }
}

const MUSIC_METADATA_PUBLIC_ERROR_CODES = new Set([
  'MUSIC_METADATA_MUSIC_NOT_FOUND',
  'MUSIC_METADATA_SOURCE_MISSING',
  'MUSIC_METADATA_SOURCE_INVALID',
  'MUSIC_METADATA_CONTENT_HASH_MISSING',
  'MUSIC_METADATA_CONTENT_CHANGED',
  'MUSIC_METADATA_NO_FIELDS',
  'MUSIC_METADATA_PARSE_FAILED',
  'MUSIC_METADATA_PARSE_TIMEOUT',
  'MUSIC_METADATA_INPUT_INVALID',
  'MUSIC_METADATA_DATABASE_UNAVAILABLE',
  'MUSIC_METADATA_CANCELLED',
  'MUSIC_METADATA_TASK_ENQUEUE_FAILED'
])
const MUSIC_METADATA_STATUS_SET = new Set(['ready', 'pending', 'partial', 'failed'])

function metadataValuePresent(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function fallbackMusicMetadata(originalName) {
  const fileName = path.basename(String(originalName || '').replace(/\\/gu, '/'))
  const title = path.basename(fileName, path.extname(fileName)).normalize('NFKC').trim() || '未命名音乐'
  return {
    title,
    artist: null,
    album: null,
    duration: 0,
    coverImage: null
  }
}

function musicMetadataStatusForValues(metadata) {
  return ['title', 'artist', 'album'].every(field => metadataValuePresent(metadata?.[field])) &&
    Number(metadata?.duration) > 0
    ? 'ready'
    : 'partial'
}

function initialMusicMetadataState(metadataState) {
  return Object.freeze({
    status: metadataState.status === 'pending' ? 'failed' : metadataState.status,
    errorCode: metadataState.errorCode ?? null,
    parserVersion: MUSIC_METADATA_PARSER_VERSION
  })
}

function persistedMusicRecoveryState(music) {
  const status = publicMusicMetadataStatus(music?.metadata_status)
  if (status !== 'failed') return Object.freeze({ status, errorCode: music?.metadata_error_code ?? null })
  return Object.freeze({
    status: 'pending',
    errorCode: publicMusicMetadataErrorCode(music?.metadata_error_code) || 'MUSIC_METADATA_PARSE_FAILED'
  })
}

function stableMusicMetadataErrorCode(error) {
  const code = String(error?.code || '')
  return MUSIC_METADATA_PUBLIC_ERROR_CODES.has(code) ? code : 'MUSIC_METADATA_PARSE_FAILED'
}

function publicMusicMetadataErrorCode(value) {
  if (value === null || value === undefined || value === '') return null
  return stableMusicMetadataErrorCode({ code: value })
}

function publicMusicMetadataStatus(value) {
  return MUSIC_METADATA_STATUS_SET.has(value) ? value : 'ready'
}

async function bestEffortMusicMetadata(filePath, originalName) {
  const fallback = fallbackMusicMetadata(originalName)
  try {
    const parsed = await parseMusicMetadata(filePath, originalName)
    const metadata = {
      ...fallback,
      title: parsed.title || fallback.title,
      artist: parsed.artist || null,
      album: parsed.album || null,
      duration: parsed.duration || 0,
      coverImage: parsed.coverImage || null,
      fileSize: parsed.fileSize ?? null,
      fileType: parsed.fileType || path.extname(String(originalName || '')).replace(/^\./u, '').toLowerCase()
    }
    return Object.freeze({
      metadata,
      status: musicMetadataStatusForValues(metadata),
      errorCode: null,
      needsReparse: false
    })
  } catch (error) {
    return Object.freeze({
      metadata: {
        ...fallback,
        fileSize: null,
        fileType: path.extname(String(originalName || '')).replace(/^\./u, '').toLowerCase()
      },
      status: 'pending',
      errorCode: stableMusicMetadataErrorCode(error),
      needsReparse: true
    })
  }
}

function persistMusicMetadataState(database, musicId, status, errorCode = null) {
  const normalizedCode = errorCode === null ? null : stableMusicMetadataErrorCode({ code: errorCode })
  database.prepare(`
    UPDATE music
       SET metadata_status = ?,
           metadata_error_code = ?,
           metadata_parser_version = ?,
           metadata_updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(status, normalizedCode, MUSIC_METADATA_PARSER_VERSION, musicId)
}

function runMusicMetadataTransaction(database, callback) {
  const transaction = database.transaction(callback)
  return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction()
}

export function completeMusicMetadataUpload({
  database,
  musicId,
  originalName,
  contentSha256,
  metadataState = { status: 'ready', errorCode: null }
}) {
  const extension = path.extname(String(originalName || '')).toLowerCase()
  if (!MUSIC_UPLOAD_POLICY.extensions.includes(extension)) {
    return Object.freeze({ metadataStatus: 'ready', metadataErrorCode: null, metadataTask: null })
  }

  let status = metadataState.status
  let errorCode = metadataState.errorCode ?? null
  let metadataTask = null
  let activeConflict = false
  if (status === 'pending') {
    try {
      const outcome = runMusicMetadataTransaction(database, () => {
        persistMusicMetadataState(database, musicId, status, errorCode)
        const queued = enqueueMusicMetadataTask(database, musicId, contentSha256)
        const projected = projectMusicMetadataTask(queued.task)
        if (!projected) {
          const error = new Error('Music metadata task projection failed.')
          error.code = 'MUSIC_METADATA_TASK_ENQUEUE_FAILED'
          throw error
        }
        return { ...queued, task: projected }
      })
      metadataTask = outcome.task
      activeConflict = outcome.activeConflict === true
    } catch {
      status = 'failed'
      errorCode = 'MUSIC_METADATA_TASK_ENQUEUE_FAILED'
      try { persistMusicMetadataState(database, musicId, status, errorCode) } catch {}
    }
  } else {
    try {
      persistMusicMetadataState(database, musicId, status, errorCode)
    } catch {
      status = 'failed'
      errorCode = 'MUSIC_METADATA_DATABASE_UNAVAILABLE'
    }
  }

  return Object.freeze({
    metadataStatus: publicMusicMetadataStatus(status),
    metadataErrorCode: publicMusicMetadataErrorCode(errorCode),
    metadataTask,
    activeConflict
  })
}

function isRegularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function removeUploadFile(filePath) {
  try { fs.rmSync(filePath, { force: true }) } catch {}
}

function musicChunkPath(fileId, index) {
  return uploadPath(currentMusicTempDir(), `${fileId}_${index}`)
}

function clearMusicUploadInputs(fileId, totalChunks, mergedPath) {
  for (let index = 0; index < totalChunks; index++) {
    removeUploadFile(musicChunkPath(fileId, index))
  }
  if (mergedPath) removeUploadFile(mergedPath)
}

function musicUploadIdempotencyKey(fileId) {
  return `music-upload:${fileId}`
}

function existingMusicUpload(database, operation) {
  if (!operation?.storageKey) return null
  const music = database.prepare(`
    SELECT id, title, artist, album, original_name, metadata_status, metadata_error_code,
           storage_key, content_sha256, content_bytes
      FROM music
     WHERE storage_key = ?
     LIMIT 1
  `).get(operation.storageKey)
  return music ? Object.freeze({
    response: Object.freeze({
      id: music.id,
      title: music.title,
      artist: music.artist,
      album: music.album,
      message: '上传成功',
      metadataStatus: publicMusicMetadataStatus(music.metadata_status),
      metadataErrorCode: publicMusicMetadataErrorCode(music.metadata_error_code)
    }),
    reference: Object.freeze({
      storage_key: music.storage_key,
      content_sha256: music.content_sha256,
      content_bytes: music.content_bytes
    }),
    recovery: Object.freeze({
      id: music.id,
      originalName: music.original_name,
      contentSha256: music.content_sha256,
      metadataState: persistedMusicRecoveryState(music)
    })
  }) : null
}

async function verifyMusicUploadContent(runtime, reference) {
  await runtime.contentServiceFor('music').stat(reference)
}

function sendMusicRouteError(res, error) {
  const code = String(error?.code || '')
  if (code === 'RESOURCE_CONTENT_MISSING' || code === 'MUSIC_CONTENT_MISSING') {
    return res.status(404).json({ code, message: '音乐文件不存在' })
  }
  if (code === 'MUSIC_RANGE_INVALID' || code === 'RESOURCE_CONTENT_RANGE_INVALID') {
    return res.status(416).json({ code, message: '请求范围无效' })
  }
  if (code === 'MUSIC_NOT_FOUND' || code === 'MUSIC_TRASH_NOT_FOUND') {
    return res.status(404).json({ code, message: '资源不存在' })
  }
  if (code === 'MUSIC_ALREADY_TRASHED' || code === 'MUSIC_TRASH_PURGE_IN_PROGRESS' ||
      code === 'MUSIC_TRASH_LEGACY_MIGRATION_REQUIRED' || code === 'MUSIC_TRASH_CONTENT_REFERENCE_MISSING') {
    return res.status(409).json({ code, message: '资源状态冲突' })
  }
  if (code.endsWith('_INVALID') || code === 'RESOURCE_STORAGE_METADATA_INCOMPLETE' ||
      code === 'RESOURCE_STORAGE_METADATA_MISMATCH' || code === 'RESOURCE_STORAGE_KIND_INVALID') {
    return res.status(400).json({ code, message: '请求无效' })
  }
  return res.status(500).json({ code: code || 'MUSIC_OPERATION_FAILED', message: '服务器错误' })
}

function sendMusicMetadataRouteError(res, error) {
  const code = stableMusicMetadataErrorCode(error)
  if (code === 'MUSIC_METADATA_INPUT_INVALID') {
    return res.status(400).json({ code, message: '请求无效' })
  }
  if (code === 'MUSIC_METADATA_MUSIC_NOT_FOUND' || code === 'MUSIC_METADATA_SOURCE_MISSING') {
    return res.status(404).json({ code, message: '资源不存在' })
  }
  if (code === 'MUSIC_METADATA_CONTENT_HASH_MISSING' || code === 'MUSIC_METADATA_CONTENT_CHANGED') {
    return res.status(409).json({ code, message: '资源状态冲突' })
  }
  console.error('音乐元数据任务失败:', code)
  return res.status(500).json({ code, message: '服务器错误' })
}

function activeMusic(database, id) {
  return database.prepare(`
    SELECT m.* FROM music m WHERE m.id = ? AND NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'music' AND t.resource_id = m.id
    )
  `).get(id)
}

async function invalidateMusicCaches() {
  await cache.delPattern('music:list:*')
  await cache.del(CacheKeys.MUSIC_ARTISTS)
  await cache.del(CacheKeys.MUSIC_ALBUMS)
  await cache.del(CacheKeys.MUSIC_PLAYLISTS)
}

// 分片上传

// 上传分片
router.post('/upload-chunk', authenticateToken, requireWritePermission, upload.single('chunk'), async (req, res) => {
  try {
    const descriptor = validateUploadDescriptor(req.body, MUSIC_UPLOAD_POLICY)
    const { fileId, fileName, chunkIndex: chunkIdx, totalChunks: totalChs } = descriptor
    
    console.log(`收到分片: ${fileId}, 分片 ${chunkIdx}/${totalChs}`)
    
    // 初始化或更新上传进度
    let progress = uploadProgress.get(fileId)
    if (!progress) {
      progress = {
        fileName,
        totalChunks: totalChs,
        receivedChunks: new Set(),
        status: 'uploading',
        timestamp: Date.now()
      }
      uploadProgress.set(fileId, progress)
    }
    
    // 记录已接收的分片
    progress.receivedChunks.add(chunkIdx)
    progress.timestamp = Date.now()
    
    // 计算进度
    const receivedCount = progress.receivedChunks.size
    const percent = Math.round((receivedCount / totalChs) * 100)
    
    res.json({ 
      message: '分片上传成功',
      chunkIndex: chunkIdx,
      totalChunks: totalChs,
      receivedCount,
      percent
    })
  } catch (error) {
    console.error('分片上传失败:', error)
    if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true })
    res.status(400).json({ message: '上传失败' })
  }
})

// 检查文件是否重复（通过文件大小和标题）
router.post('/check-duplicate', authenticateToken, async (req, res) => {
  try {
    const { fileName, fileSize, fileHash } = req.body
    const db = getDatabase()
    
    // 从文件名提取标题（去掉扩展名）
    const title = path.basename(fileName, path.extname(fileName))
    
    // 精确匹配：文件大小完全相同且标题相同
    const exactMatch = db.prepare(`
      SELECT id, title, artist, album, file_size, duration, created_at 
      FROM music 
      WHERE file_size = ? AND title = ?
      LIMIT 1
    `).get(fileSize, title)
    
    if (exactMatch) {
      return res.json({ 
        duplicate: true, 
        matches: [{
          ...exactMatch,
          created_at: convertToUTC8(exactMatch.created_at),
          matchType: 'exact'
        }]
      })
    }
    
    // 模糊匹配：文件大小相近（±1KB）且标题相同
    const fuzzyMatch = db.prepare(`
      SELECT id, title, artist, album, file_size, duration, created_at 
      FROM music 
      WHERE ABS(file_size - ?) < 1024 AND title = ?
      LIMIT 1
    `).get(fileSize, title)
    
    if (fuzzyMatch) {
      return res.json({ 
        duplicate: true, 
        matches: [{
          ...fuzzyMatch,
          created_at: convertToUTC8(fuzzyMatch.created_at),
          matchType: 'fuzzy'
        }]
      })
    }
    
    // 文件大小完全相同（可能是同一文件的不同标签版本）
    const sizeMatch = db.prepare(`
      SELECT id, title, artist, album, file_size, duration, created_at 
      FROM music 
      WHERE file_size = ?
      LIMIT 5
    `).all(fileSize)
    
    if (sizeMatch.length > 0) {
      return res.json({ 
        duplicate: true, 
        matches: sizeMatch.map(e => ({
          ...e,
          created_at: convertToUTC8(e.created_at),
          matchType: 'size'
        }))
      })
    }
    
    res.json({ duplicate: false })
  } catch (error) {
    console.error('检查重复失败:', error)
    res.status(500).json({ message: '检查失败' })
  }
})

// 合并分片
router.post('/merge-chunks', authenticateToken, requireWritePermission, async (req, res) => {
  let lockFile = null
  try {
    const descriptor = validateUploadDescriptor(req.body, MUSIC_UPLOAD_POLICY)
    const { fileId, fileName, totalChunks, extension: ext } = descriptor
    const { skipDuplicate } = req.body
    const db = getDatabase()
    const runtime = getResourceStorageRuntime()
    const idempotencyKey = musicUploadIdempotencyKey(fileId)
    const mergedPath = uploadPath(currentMusicTempDir(), `${fileId}.merged`)
    const operation = getStorageCommitOperation(db, idempotencyKey)

    if (operation?.state === 'database_committed') {
      const existing = existingMusicUpload(db, operation)
      if (!existing) return res.status(500).json({ message: '上传状态异常' })
      await verifyMusicUploadContent(runtime, existing.reference)
      const recovery = completeMusicMetadataUpload({
        database: db,
        musicId: existing.recovery.id,
        originalName: existing.recovery.originalName,
        contentSha256: existing.recovery.contentSha256,
        metadataState: existing.recovery.metadataState
      })
      clearMusicUploadInputs(fileId, totalChunks, mergedPath)
      uploadProgress.delete(fileId)
      cancelledUploads.delete(fileId)
      return res.json({
        ...existing.response,
        metadataStatus: recovery.metadataStatus,
        metadataErrorCode: recovery.metadataErrorCode,
        metadataTask: recovery.metadataTask
      })
    }

    // A cancelled upload without a commit ledger is no longer retryable.
    // An existing ledger must still be allowed to finish its compensation retry.
    if (!operation && cancelledUploads.has(fileId)) {
      console.log(`[合并取消] 文件 ${fileId} 已取消，拒绝合并`)
      clearMusicUploadInputs(fileId, totalChunks, mergedPath)
      return res.status(400).json({ message: '上传已取消', cancelled: true })
    }

    lockFile = uploadPath(currentMusicTempDir(), `${fileId}.lock`)
    if (fs.existsSync(lockFile)) {
      return res.status(409).json({ 
        message: '文件正在处理中，请稍后重试',
        error: 'concurrent_upload'
      })
    }

    try {
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        return res.status(409).json({ message: '文件正在处理中，请稍后重试', error: 'concurrent_upload' })
      }
      throw error
    }

    try {
      let sourcePath
      let staged

      if (!operation) {
        // The only physical merge target is a controlled temporary file. It is
        // kept until the database commit succeeds so a retry can rebuild or
        // restage the same input safely.
        const inspected = inspectChunks(
          currentMusicTempDir(),
          fileId,
          totalChunks,
          (id, index) => `${id}_${index}`,
          MUSIC_UPLOAD_POLICY.maxTotalBytes
        )
        if (!skipDuplicate) {
          const existing = db.prepare(`
            SELECT id, title, artist, album, file_size
              FROM music
             WHERE file_size = ?
             LIMIT 1
          `).get(inspected.totalBytes)

          if (existing) {
            return res.status(409).json({
              message: '检测到重复文件',
              duplicate: true,
              existing: {
                id: existing.id,
                title: existing.title,
                artist: existing.artist,
                album: existing.album
              }
            })
          }
        }

        // Rebuild from the retained chunks on every new ledger attempt. The
        // chunks remain available until the database commit has succeeded.
        removeUploadFile(mergedPath)
        await mergeChunkFiles(inspected.paths, mergedPath)
        sourcePath = mergedPath
      } else if (operation.state === 'staged') {
        sourcePath = runtime.storageService.stagingFile(operation.stagingToken)
        if (!isRegularFile(sourcePath)) {
          throw Object.assign(new Error('Music staging input is missing.'), { code: 'MUSIC_UPLOAD_STAGING_MISSING' })
        }
        const stagedMetadata = await hashMusicFile(sourcePath)
        staged = { token: operation.stagingToken, ...stagedMetadata }
      } else if (operation.state === 'object_committed' || operation.state === 'orphaned') {
        const managedReference = {
          storage_key: operation.storageKey,
          content_sha256: operation.sha256,
          content_bytes: operation.bytes
        }
        sourcePath = (await runtime.contentServiceFor('music').resolveVerifiedFilePath(managedReference)).filePath
        staged = {
          token: operation.stagingToken,
          sha256: operation.sha256,
          bytes: operation.bytes
        }
      } else {
        throw Object.assign(new Error('Music upload operation is not retryable.'), { code: 'MUSIC_UPLOAD_STATE_INVALID' })
      }

      const fileHeader = readFileHeader(sourcePath).toString('hex')
      const extLower = ext.toLowerCase()
      let isFormatValid = true
      if (extLower === '.flac') {
        isFormatValid = fileHeader.startsWith('664c6143')
      } else if (extLower === '.mp3') {
        isFormatValid = fileHeader.startsWith('494433') || fileHeader.startsWith('fffb') ||
          fileHeader.startsWith('fff3') || fileHeader.startsWith('fff2')
      }

      if (!isFormatValid) {
        return res.status(400).json({
          message: `文件格式验证失败：${ext} 文件头签名无效，可能不是有效的音频文件或文件已损坏`,
          error: 'invalid_format'
        })
      }

      const metadataAttempt = await bestEffortMusicMetadata(sourcePath, fileName)
      const metadata = metadataAttempt.metadata
      const initialMetadataState = initialMusicMetadataState(metadataAttempt)
      if (!staged) {
        staged = await runtime.storageService.stageFromStream(fs.createReadStream(sourcePath))
      }

      const committed = await commitMusicUpload({
        database: db,
        storageService: runtime.storageService,
        staged,
        idempotencyKey,
        music: {
          title: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          duration: metadata.duration,
          originalName: fileName,
          fileType: metadata.fileType,
          coverImage: metadata.coverImage,
          metadataStatus: initialMetadataState.status,
          metadataErrorCode: initialMetadataState.errorCode,
          metadataParserVersion: initialMetadataState.parserVersion
        }
      })
      await verifyMusicUploadContent(runtime, {
        storage_key: committed.storageKey,
        content_sha256: committed.sha256,
        content_bytes: committed.bytes
      })

      const metadataResult = completeMusicMetadataUpload({
        database: db,
        musicId: committed.id,
        originalName: fileName,
        contentSha256: committed.sha256,
        metadataState: metadataAttempt
      })

      const response = {
        id: committed.id,
        title: committed.title,
        artist: metadata.artist,
        album: metadata.album,
        message: '上传成功',
        metadataStatus: metadataResult.metadataStatus,
        metadataErrorCode: metadataResult.metadataErrorCode,
        metadataTask: metadataResult.metadataTask
      }
      clearMusicUploadInputs(fileId, totalChunks, mergedPath)
      uploadProgress.delete(fileId)
      cancelledUploads.delete(fileId)
      return res.json(response)
    } catch (error) {
      // Keep chunks and the controlled merge target for database, staging, or
      // compensation retries. The commit coordinator owns object cleanup.
      console.error('合并分片失败:', error?.code || error?.name || 'UNKNOWN')
      const code = String(error?.code || '')
      const status = code.endsWith('_INVALID') || code.startsWith('MUSIC_UPLOAD_') ? 400 : 500
      return res.status(status).json({
        message: status === 400 ? '文件合并失败，请重试' : '合并失败'
      })
    } finally {
      removeUploadFile(lockFile)
    }
  } catch (error) {
    console.error('合并分片失败:', error?.code || error?.name || 'UNKNOWN')
    const code = String(error?.code || '')
    const status = code.endsWith('_INVALID') || code.startsWith('MUSIC_UPLOAD_') ? 400 : 500
    res.status(status).json({ message: status === 400 ? '合并失败' : '服务器错误' })
  }
})

// 取消上传（清理临时文件 + 设置取消标志）
router.delete('/cancel-upload', authenticateToken, async (req, res) => {
  try {
    const fileId = String(req.body?.fileId || '')
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(fileId)) return res.status(400).json({ message: '上传标识无效' })
    
    console.log(`[上传取消] 收到取消请求: ${fileId}`)
    
    cancelledUploads.add(fileId)
    
    // 删除临时分片
    const files = fs.readdirSync(currentMusicTempDir())
    let deletedCount = 0
    files.forEach(file => {
      if (file.startsWith(`${fileId}_`) || file === `${fileId}.lock` || file === `${fileId}.merged`) {
        fs.unlinkSync(path.join(currentMusicTempDir(), file))
        deletedCount++
      }
    })
    
    uploadProgress.delete(fileId)
    
    console.log(`[上传取消] 已删除 ${deletedCount} 个临时分片`)
    
    // 5分钟后清理取消标记
    setTimeout(() => {
      cancelledUploads.delete(fileId)
    }, 5 * 60 * 1000)
    
    res.json({ message: '已取消上传', deletedChunks: deletedCount })
  } catch (error) {
    console.error('取消上传失败:', error)
    res.status(500).json({ message: '操作失败' })
  }
})

// 获取当前上传进度（用于跨标签页同步和断点续传）
router.get('/upload-progress', authenticateToken, async (req, res) => {
  try {
    const progress = []
    for (const [fileId, data] of uploadProgress) {
      const receivedChunks = Array.from(data.receivedChunks || [])
      const percent = data.totalChunks ? Math.round((receivedChunks.length / data.totalChunks) * 100) : 0
      progress.push({
        fileId,
        fileName: data.fileName,
        fileSize: data.fileSize,
        totalChunks: data.totalChunks,
        receivedChunks,
        receivedCount: receivedChunks.length,
        percent,
        status: data.status,
        timestamp: data.timestamp
      })
    }
    res.json({ data: progress })
  } catch (error) {
    console.error('获取上传进度失败:', error)
    res.status(500).json({ message: '获取失败' })
  }
})

// 开始上传会话（保存文件元数据）
router.post('/start-upload', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const descriptor = validateUploadDescriptor(req.body, MUSIC_UPLOAD_POLICY)
    const { fileId, fileName, totalChunks } = descriptor
    const fileSize = Number(req.body.fileSize)
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > MUSIC_UPLOAD_POLICY.maxTotalBytes) {
      return res.status(400).json({ message: '文件大小无效' })
    }
    
    uploadProgress.set(fileId, {
      fileName,
      fileSize,
      totalChunks,
      receivedChunks: new Set(),
      status: 'uploading',
      timestamp: Date.now()
    })
    
    console.log(`[上传开始] ${fileId}: ${fileName}, ${fileSize} bytes, ${totalChunks} chunks`)
    
    res.json({ message: '上传会话已创建', fileId })
  } catch (error) {
    console.error('创建上传会话失败:', error)
    res.status(400).json({ message: '创建失败' })
  }
})

// 获取单个文件的上传状态（用于断点续传）
router.get('/upload-status/:fileId', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.params
    const progress = uploadProgress.get(fileId)
    
    if (!progress) {
      return res.status(404).json({ message: '上传任务不存在或已过期' })
    }
    
    const receivedChunks = Array.from(progress.receivedChunks || [])
    const percent = progress.totalChunks ? Math.round((receivedChunks.length / progress.totalChunks) * 100) : 0
    
    res.json({
      fileId,
      fileName: progress.fileName,
      fileSize: progress.fileSize,
      totalChunks: progress.totalChunks,
      receivedChunks,
      receivedCount: receivedChunks.length,
      percent,
      status: progress.status,
      timestamp: progress.timestamp
    })
  } catch (error) {
    console.error('获取上传状态失败:', error)
    res.status(500).json({ message: '获取失败' })
  }
})

// 取消所有上传
router.delete('/cancel-all-uploads', authenticateToken, async (req, res) => {
  try {
    console.log('[上传取消] 取消所有上传')
    
    for (const [fileId] of uploadProgress) {
      cancelledUploads.add(fileId)
    }
    
    // 删除所有临时分片
    const files = fs.readdirSync(currentMusicTempDir())
    let deletedCount = 0
    files.forEach(file => {
      try {
        fs.unlinkSync(path.join(currentMusicTempDir(), file))
        deletedCount++
      } catch (e) {
        // 忽略删除失败
      }
    })
    
    const cancelledCount = uploadProgress.size
    uploadProgress.clear()
    
    console.log(`[上传取消] 已取消 ${cancelledCount} 个上传，删除 ${deletedCount} 个临时文件`)
    
    // 5分钟后清理取消标记
    setTimeout(() => {
      cancelledUploads.clear()
    }, 5 * 60 * 1000)
    
    res.json({ 
      message: '已取消所有上传', 
      cancelledCount,
      deletedChunks: deletedCount 
    })
  } catch (error) {
    console.error('取消所有上传失败:', error)
    res.status(500).json({ message: '操作失败' })
  }
})

// 音乐管理

// 获取所有音乐 ID（用于全选）
router.get('/all-ids', authenticateToken, async (req, res) => {
  try {
    const { keyword, artist, album } = req.query
    const db = getDatabase()

    let whereClause = `WHERE NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'music' AND t.resource_id = music.id
    )`
    const params = []

    if (keyword) {
      whereClause += ' AND title LIKE ?'
      params.push(`%${keyword}%`)
    }

    if (artist) {
      whereClause += ' AND artist = ?'
      params.push(artist)
    }

    if (album) {
      whereClause += ' AND album = ?'
      params.push(album)
    }

    const rows = db.prepare(`SELECT id FROM music ${whereClause}`).all(...params)
    const ids = rows.map(r => r.id)

    res.json({ data: ids, total: ids.length })
  } catch (error) {
    console.error('获取音乐 ID 失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取音乐列表（支持排序和筛选）
router.get('/', authenticateToken, async (req, res) => {
  try {
    const {
      keyword,
      artist,
      album,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      page = PAGINATION.DEFAULT_PAGE,
      pageSize = PAGINATION.DEFAULT_PAGE_SIZE
    } = req.query

    // 尝试从缓存获取（相同查询条件）
    const cacheKey = `music:list:${keyword || ''}:${artist || ''}:${album || ''}:${sortBy}:${sortOrder}:${page}:${pageSize}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log('[音乐列表] 命中缓存')
      return res.json(cached)
    }

    const db = getDatabase()

    // 检查表结构，确定可用字段（缓存结果，避免每次都查询）
    const columnsCacheKey = 'music:columns'
    let columnNames = await cache.get(columnsCacheKey)
    if (!columnNames) {
      const columns = db.prepare("PRAGMA table_info(music)").all()
      columnNames = columns.map(c => c.name)
      await cache.set(columnsCacheKey, columnNames, CacheTTL.VERY_LONG)
      console.log('[音乐列表] 缓存表结构:', columnNames.join(', '))
    }

    // 动态构建 SELECT 字段（不包含 cover_image，减少数据量）
    // 但添加 has_cover 标志位
    const selectFields = ['id', 'title']
    if (columnNames.includes('artist')) selectFields.push('artist')
    if (columnNames.includes('album')) selectFields.push('album')
    if (columnNames.includes('duration')) selectFields.push('duration')
    if (columnNames.includes('file_size')) selectFields.push('file_size')
    if (columnNames.includes('file_type')) selectFields.push('file_type')
    if (columnNames.includes('metadata_status')) selectFields.push('metadata_status')
    if (columnNames.includes('metadata_error_code')) selectFields.push('metadata_error_code')
    // 添加 has_cover 标志位（封面是否存在）
    if (columnNames.includes('cover_image')) {
      selectFields.push("CASE WHEN cover_image IS NOT NULL AND cover_image != '' THEN 1 ELSE 0 END as has_cover")
    }
    // 添加 has_lyrics 标志位（歌词是否存在）
    if (columnNames.includes('has_lyrics')) {
      selectFields.push('has_lyrics')
    } else if (columnNames.includes('lyrics')) {
      // 兼容旧版本：通过 lyrics 字段判断
      selectFields.push("CASE WHEN lyrics IS NOT NULL AND lyrics != '' THEN 1 ELSE 0 END as has_lyrics")
    }
    selectFields.push('created_at', 'updated_at')

    // 构建基础查询条件（不包含排序和分页）
    let whereClause = `WHERE NOT EXISTS (
      SELECT 1 FROM resource_trash_entries t
      WHERE t.resource_type = 'music' AND t.resource_id = music.id
    )`
    const params = []

    if (keyword) {
      whereClause += ' AND title LIKE ?'
      params.push(`%${keyword}%`)
    }

    if (artist && columnNames.includes('artist')) {
      whereClause += ' AND artist = ?'
      params.push(artist)
    }

    if (album && columnNames.includes('album')) {
      whereClause += ' AND album = ?'
      params.push(album)
    }

    // 获取总数（直接 COUNT，不需要子查询）
    const countSql = `SELECT COUNT(*) as total FROM music ${whereClause}`
    const countStmt = db.prepare(countSql)
    const countResult = countStmt.get(...params)
    const total = countResult.total

    // 排序（确保字段存在）
    const validSortFields = ['title', 'created_at', 'updated_at']
    if (columnNames.includes('artist')) validSortFields.push('artist')
    if (columnNames.includes('album')) validSortFields.push('album')
    if (columnNames.includes('duration')) validSortFields.push('duration')

    const validSortOrders = ['ASC', 'DESC']
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'created_at'
    const order = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC'

    // 文本字段排序：使用 SQL COLLATE NOCASE
    const textFieldPattern = ['title', 'artist', 'album']
    const isTextField = textFieldPattern.includes(sortField)

    // 构建完整的查询 SQL（总是使用 LIMIT 分页）
    let sql = `SELECT ${selectFields.join(', ')} FROM music ${whereClause}`

    // 使用 SQL 排序（不区分大小写）
    sql += ` ORDER BY CASE WHEN ${sortField} IS NULL THEN 1 ELSE 0 END, ${sortField} COLLATE NOCASE ${order}`
    sql += ' LIMIT ? OFFSET ?'
    const queryParams = [...params, parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)]

    const stmt = db.prepare(sql)
    const rows = stmt.all(...queryParams)

    // 转换时间
    const musicList = rows.map(row => ({
      ...row,
      metadataStatus: publicMusicMetadataStatus(row.metadata_status),
      metadataErrorCode: publicMusicMetadataErrorCode(row.metadata_error_code),
      created_at: convertToUTC8(row.created_at),
      updated_at: convertToUTC8(row.updated_at)
    }))

    const response = { data: musicList, total }

    // 缓存结果（5分钟）
    await cache.set(cacheKey, response, CacheTTL.SHORT)

    res.json(response)
  } catch (error) {
    console.error('获取音乐失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取所有艺术家列表
router.get('/artists', authenticateToken, async (req, res) => {
  try {
    // 尝试从缓存获取
    const cacheKey = CacheKeys.MUSIC_ARTISTS
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()
    // 检查 artist 字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const hasArtist = columns.some(col => col.name === 'artist')

    if (!hasArtist) {
      return res.json({ data: [] })
    }

    // 获取所有艺术家
    const rows = db.prepare(`
      SELECT DISTINCT TRIM(artist) as artist
      FROM music
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_trash_entries t
        WHERE t.resource_type = 'music' AND t.resource_id = music.id
      )
        AND artist IS NOT NULL AND TRIM(artist) != ''
    `).all()
    
    // 按拼音排序（使用 Intl.Collator，支持中文拼音排序）
    const artists = rows.map(r => r.artist).sort((a, b) => zhCollator.compare(a, b))
    
    // 缓存结果（30分钟）
    await cache.set(cacheKey, artists, CacheTTL.VERY_LONG)

    res.json({ data: artists })
  } catch (error) {
    console.error('获取艺术家列表失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 获取所有专辑列表
router.get('/albums', authenticateToken, async (req, res) => {
  try {
    // 尝试从缓存获取
    const cacheKey = CacheKeys.MUSIC_ALBUMS
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    const db = getDatabase()
    // 检查 album 字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const hasAlbum = columns.some(col => col.name === 'album')

    if (!hasAlbum) {
      return res.json({ data: [] })
    }

    // 获取所有专辑
    const rows = db.prepare(`
      SELECT DISTINCT TRIM(album) as album
      FROM music
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_trash_entries t
        WHERE t.resource_type = 'music' AND t.resource_id = music.id
      )
        AND album IS NOT NULL AND TRIM(album) != ''
    `).all()
    
    // 按拼音排序（使用 Intl.Collator，支持中文拼音排序）
    const albums = rows.map(r => r.album).sort((a, b) => zhCollator.compare(a, b))
    
    // 缓存结果（30分钟）
    await cache.set(cacheKey, albums, CacheTTL.VERY_LONG)

    res.json({ data: albums })
  } catch (error) {
    console.error('获取专辑列表失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 手动触发音乐元数据重解析；解析在持久任务运行时中异步执行。
router.post('/:id/reparse', authenticateToken, requireWritePermission, async (req, res) => {
  const musicId = Number(req.params.id)
  if (!Number.isSafeInteger(musicId) || musicId <= 0) {
    return sendMusicMetadataRouteError(res, { code: 'MUSIC_METADATA_INPUT_INVALID' })
  }

  try {
    const database = getDatabase()
    const music = activeMusic(database, musicId)
    if (!music) return sendMusicMetadataRouteError(res, { code: 'MUSIC_METADATA_MUSIC_NOT_FOUND' })

    const contentSha256 = String(music.content_sha256 || '').toLowerCase()
    if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
      return sendMusicMetadataRouteError(res, { code: 'MUSIC_METADATA_CONTENT_HASH_MISSING' })
    }

    let outcome
    try {
      outcome = runMusicMetadataTransaction(database, () => {
        persistMusicMetadataState(database, musicId, 'pending', null)
        const queued = enqueueMusicMetadataTask(database, musicId, contentSha256)
        const projected = projectMusicMetadataTask(queued.task)
        if (!projected) {
          const error = new Error('Music metadata task projection failed.')
          error.code = 'MUSIC_METADATA_TASK_ENQUEUE_FAILED'
          throw error
        }
        return { ...queued, task: projected }
      })
    } catch (error) {
      try { persistMusicMetadataState(database, musicId, 'failed', 'MUSIC_METADATA_TASK_ENQUEUE_FAILED') } catch {}
      throw Object.assign(new Error('Music metadata task enqueue failed.', { cause: error }), {
        code: 'MUSIC_METADATA_TASK_ENQUEUE_FAILED'
      })
    }

    res.setHeader('Cache-Control', 'no-store')
    return res.status(outcome.activeConflict ? 409 : 202).json({
      data: outcome.task,
      task: outcome.task,
      created: outcome.created,
      activeConflict: outcome.activeConflict
    })
  } catch (error) {
    return sendMusicMetadataRouteError(res, error)
  }
})

// 更新音乐信息
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { title, artist, album, coverImage } = req.body
    const db = getDatabase()

    const stmt = db.prepare(`
      UPDATE music SET 
        title = ?, 
        artist = ?, 
        album = ?, 
        cover_image = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `)
    stmt.run(title, artist, album, coverImage, req.params.id)

    // 清除艺术家和专辑缓存
    await cache.del(CacheKeys.MUSIC_ARTISTS)
    await cache.del(CacheKeys.MUSIC_ALBUMS)

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除音乐
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = softDeleteMusic({ database: getDatabase(), id: req.params.id })
    await invalidateMusicCaches()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '已移入回收站' })
  } catch (error) {
    console.error('删除音乐失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

// 批量删除音乐
router.post('/batch-delete', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { ids } = req.body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: '请选择要删除的音乐' })
    }
    const result = softDeleteMusics({ database: getDatabase(), ids })
    await invalidateMusicCaches()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '已批量移入回收站', count: result.length })
  } catch (error) {
    console.error('批量删除音乐失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

// 音乐回收站
router.get('/trash', authenticateToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: listDeletedMusic(getDatabase()) })
  } catch (error) {
    console.error('获取音乐回收站失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

router.post('/trash/:id/restore', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = restoreMusicFromTrash({ database: getDatabase(), id: req.params.id })
    await invalidateMusicCaches()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '恢复成功' })
  } catch (error) {
    console.error('恢复音乐失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

router.delete('/trash/:id/permanent', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const result = await permanentlyDeleteMusic({
      database: getDatabase(),
      storageService: getResourceStorageRuntime().storageService,
      id: req.params.id
    })
    await invalidateMusicCaches()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: result, message: '已永久删除' })
  } catch (error) {
    console.error('永久删除音乐失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

// 查找重复音乐
router.get('/duplicates', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 检查表结构
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    let duplicates = []
    
    if (columnNames.includes('title') && columnNames.includes('artist')) {
      // 按 标题+艺术家 查找重复
      const rows = db.prepare(`
        SELECT
          m1.id, m1.title, m1.artist, m1.album, m1.duration, m1.file_size, m1.created_at
        FROM music m1
        WHERE NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'music' AND t.resource_id = m1.id
        )
          AND m1.id IN (
          SELECT MIN(m3.id) FROM music m3 
          WHERE NOT EXISTS (
            SELECT 1 FROM resource_trash_entries t3
            WHERE t3.resource_type = 'music' AND t3.resource_id = m3.id
          )
            AND EXISTS (
            SELECT 1 FROM music m4 WHERE m4.id != m3.id AND 
              NOT EXISTS (
                SELECT 1 FROM resource_trash_entries t4
                WHERE t4.resource_type = 'music' AND t4.resource_id = m4.id
              ) AND
            LOWER(TRIM(m4.title)) = LOWER(TRIM(m3.title)) AND
            (LOWER(TRIM(m4.artist)) = LOWER(TRIM(m3.artist)) OR (m4.artist IS NULL AND m3.artist IS NULL))
          )
          GROUP BY LOWER(TRIM(m3.title)), LOWER(TRIM(COALESCE(m3.artist, '')))
        )
        ORDER BY m1.title, m1.artist
      `).all()
      
      // 获取每个重复组的所有歌曲
      for (const row of rows) {
        const groupSongs = db.prepare(`
          SELECT id, title, artist, album, duration, file_size, created_at
          FROM music
          WHERE NOT EXISTS (
                  SELECT 1 FROM resource_trash_entries t
                  WHERE t.resource_type = 'music' AND t.resource_id = music.id
                )
            AND LOWER(TRIM(title)) = LOWER(TRIM(?)) AND
                (LOWER(TRIM(artist)) = LOWER(TRIM(?)) OR (artist IS NULL AND ? IS NULL))
          ORDER BY created_at ASC
        `).all(row.title, row.artist, row.artist)
        
        if (groupSongs.length > 1) {
          duplicates.push({
            key: `${row.title}-${row.artist || 'unknown'}`,
            title: row.title,
            artist: row.artist || '未知艺术家',
            count: groupSongs.length,
            songs: groupSongs.map(s => ({
              ...s,
              created_at: convertToUTC8(s.created_at)
            }))
          })
        }
      }
    }
    
    res.json({ 
      data: duplicates,
      total: duplicates.reduce((sum, d) => sum + d.count - 1, 0) // 可删除的总数
    })
  } catch (error) {
    console.error('查找重复音乐失败:', error?.code || error?.name || 'UNKNOWN')
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除重复音乐（保留最早添加的）
router.post('/remove-duplicates', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 检查表结构
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    if (!columnNames.includes('title') || !columnNames.includes('artist')) {
      return res.status(400).json({ message: '数据库缺少必要字段' })
    }
    
    // 查找所有重复组
    const duplicateGroups = db.prepare(`
      SELECT 
        LOWER(TRIM(title)) as title_key,
        LOWER(TRIM(COALESCE(artist, ''))) as artist_key,
        MIN(id) as keep_id
      FROM music
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_trash_entries t
        WHERE t.resource_type = 'music' AND t.resource_id = music.id
      )
      GROUP BY title_key, artist_key
      HAVING COUNT(*) > 1
    `).all()

    const toTrashIds = []
    for (const group of duplicateGroups) {
      // 获取要移入回收站的歌曲（保留 ID 最小的）
      const toTrash = db.prepare(`
        SELECT id
        FROM music
        WHERE NOT EXISTS (
                SELECT 1 FROM resource_trash_entries t
                WHERE t.resource_type = 'music' AND t.resource_id = music.id
              )
          AND LOWER(TRIM(title)) = ?
          AND LOWER(TRIM(COALESCE(artist, ''))) = ?
          AND id != ?
      `).all(group.title_key, group.artist_key, group.keep_id)
      toTrashIds.push(...toTrash.map(({ id }) => id))
    }

    const trashed = toTrashIds.length === 0
      ? []
      : softDeleteMusics({ database: db, ids: toTrashIds })
    if (trashed.length > 0) await invalidateMusicCaches()

    res.json({
      message: '去重完成',
      deletedCount: trashed.length,
      trashedCount: trashed.length
    })
  } catch (error) {
    console.error('删除重复音乐失败:', error?.code || error?.name || 'UNKNOWN')
    sendMusicRouteError(res, error)
  }
})

// 播放音乐（返回文件流）
router.get('/play/:id', authenticateToken, async (req, res) => {
  let contentSize
  try {
    const db = getDatabase()
    const music = db.prepare('SELECT * FROM music WHERE id = ?').get(req.params.id)

    if (!music) {
      return res.status(404).json({ message: '音乐不存在' })
    }

    const contentService = getResourceStorageRuntime().contentServiceFor('music')
    const metadata = await contentService.stat(music)
    contentSize = metadata.bytes
    let range
    try {
      range = parseMusicRange(req.headers.range, metadata.bytes)
    } catch (error) {
      if (error?.code !== 'MUSIC_RANGE_INVALID') throw error
      res.setHeader('Content-Range', `bytes */${metadata.bytes}`)
      res.setHeader('Accept-Ranges', 'bytes')
      return res.status(416).json({ message: '请求范围无效' })
    }

    const readable = await contentService.createReadStream(music, range || {})
    const contentType = musicContentType(music.original_name, music.file_type)
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range ? range.length : metadata.bytes),
      'Content-Type': contentType
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${metadata.bytes}`
      res.writeHead(206, headers)
    } else {
      res.writeHead(200, headers)
    }

    readable.stream.on('error', (streamError) => {
      console.error('文件流错误:', streamError?.code || streamError?.name || 'UNKNOWN')
      if (!res.headersSent) res.status(500).json({ message: '文件读取失败' })
      else res.destroy()
    })
    readable.stream.pipe(res)
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('播放失败:', error?.code || error?.name || 'UNKNOWN')
    if ((error?.code === 'MUSIC_RANGE_INVALID' || error?.code === 'RESOURCE_CONTENT_RANGE_INVALID') &&
        Number.isSafeInteger(contentSize)) {
      res.setHeader('Content-Range', `bytes */${contentSize}`)
      res.setHeader('Accept-Ranges', 'bytes')
    }
    if (!res.headersSent) sendMusicRouteError(res, error)
  }
})

// 歌单管理

// 获取歌单列表
router.get('/playlists', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*)
         FROM playlist_songs ps
         JOIN music m ON m.id = ps.music_id
         WHERE ps.playlist_id = p.id
           AND NOT EXISTS (
             SELECT 1 FROM resource_trash_entries t
             WHERE t.resource_type = 'music' AND t.resource_id = m.id
           )) as song_count
      FROM playlists p
      ORDER BY p.created_at DESC
    `).all()
    
    const playlists = rows.map(row => ({
      ...row,
      created_at: convertToUTC8(row.created_at),
      updated_at: convertToUTC8(row.updated_at)
    }))
    
    res.json({ data: playlists })
  } catch (error) {
    console.error('获取歌单失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 创建歌单
router.post('/playlists', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { name, description } = req.body
    const db = getDatabase()

    // 检查重名
    const existing = db.prepare('SELECT id FROM playlists WHERE name = ?').get(name)
    if (existing) {
      return res.status(400).json({ message: '歌单名称已存在' })
    }

    const stmt = db.prepare('INSERT INTO playlists (name, description) VALUES (?, ?)')
    const result = stmt.run(name, description)

    res.json({ id: result.lastInsertRowid, message: '创建成功' })
  } catch (error) {
    console.error('创建歌单失败:', error)
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ message: '歌单名称已存在' })
    }
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新歌单
router.put('/playlists/:id', authenticateToken, async (req, res) => {
  try {
    const { name, description, coverImage } = req.body
    const db = getDatabase()

    db.prepare(`
      UPDATE playlists SET 
        name = ?, 
        description = ?, 
        cover_image = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(name, description, coverImage, req.params.id)

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新歌单失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除歌单
router.delete('/playlists/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除歌单失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取歌单内的歌曲
router.get('/playlists/:id/songs', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const playlistId = req.params.id
    
    // 分页参数
    const page = parseInt(req.query.page) || PAGINATION.DEFAULT_PAGE
    const pageSize = parseInt(req.query.pageSize) || PAGINATION.DEFAULT_PAGE_SIZE
    const offset = (page - 1) * pageSize
    
    // 检查表结构
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    // 动态构建 SELECT 字段（不包含 cover_image，减少数据量）
    const selectFields = ['m.id', 'm.title']
    if (columnNames.includes('artist')) selectFields.push('m.artist')
    if (columnNames.includes('album')) selectFields.push('m.album')
    if (columnNames.includes('duration')) selectFields.push('m.duration')
    if (columnNames.includes('file_size')) selectFields.push('m.file_size')
    if (columnNames.includes('file_type')) selectFields.push('m.file_type')
    if (columnNames.includes('metadata_status')) selectFields.push('m.metadata_status')
    if (columnNames.includes('metadata_error_code')) selectFields.push('m.metadata_error_code')
    // 添加 has_cover 标志位
    if (columnNames.includes('cover_image')) {
      selectFields.push("CASE WHEN m.cover_image IS NOT NULL AND m.cover_image != '' THEN 1 ELSE 0 END as has_cover")
    }
    selectFields.push('m.created_at', 'm.updated_at', 'ps.sort_order', 'ps.added_at')
    
    // 获取总数
    const countResult = db.prepare(`
      SELECT COUNT(*) as total
      FROM music m
      JOIN playlist_songs ps ON m.id = ps.music_id
      WHERE ps.playlist_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'music' AND t.resource_id = m.id
        )
    `).get(playlistId)
    const total = countResult ? countResult.total : 0
    
    // 获取分页数据
    const rows = db.prepare(`
      SELECT ${selectFields.join(', ')}
      FROM music m
      JOIN playlist_songs ps ON m.id = ps.music_id
      WHERE ps.playlist_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'music' AND t.resource_id = m.id
        )
      ORDER BY ps.sort_order
      LIMIT ? OFFSET ?
    `).all(playlistId, pageSize, offset)
    
    const songs = rows.map(row => ({
      ...row,
      metadataStatus: publicMusicMetadataStatus(row.metadata_status),
      metadataErrorCode: publicMusicMetadataErrorCode(row.metadata_error_code),
      created_at: convertToUTC8(row.created_at),
      updated_at: convertToUTC8(row.updated_at),
      added_at: convertToUTC8(row.added_at)
    }))
    
    res.json({ 
      data: songs,
      total: total,
      page: page,
      pageSize: pageSize
    })
  } catch (error) {
    console.error('获取歌单歌曲失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取歌单内所有歌曲ID（用于全选）
router.get('/playlists/:id/all-ids', authenticateToken, async (req, res) => {
  try {
    const playlistId = req.params.id
    const db = getDatabase()
    
    const rows = db.prepare(`
      SELECT m.id 
      FROM music m
      JOIN playlist_songs ps ON m.id = ps.music_id
      WHERE ps.playlist_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM resource_trash_entries t
          WHERE t.resource_type = 'music' AND t.resource_id = m.id
        )
      ORDER BY ps.sort_order
    `).all(playlistId)
    
    const ids = rows.map(r => r.id)
    res.json({ data: ids, total: ids.length })
  } catch (error) {
    console.error('获取歌单歌曲ID失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 向歌单添加歌曲
router.post('/playlists/:id/songs', authenticateToken, async (req, res) => {
  try {
    const { songIds } = req.body
    const playlistId = parseInt(req.params.id)
    const db = getDatabase()

    // 获取当前最大排序号
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM playlist_songs WHERE playlist_id = ?').get(playlistId)
    let nextOrder = (maxOrder.max || 0) + 1

    const transaction = db.transaction(() => {
      for (const songId of songIds) {
        // 检查是否已存在
        const existing = db.prepare('SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND music_id = ?').get(playlistId, songId)
        if (!existing) {
          db.prepare('INSERT INTO playlist_songs (playlist_id, music_id, sort_order) VALUES (?, ?, ?)').run(playlistId, songId, nextOrder++)
        }
      }
    })

    transaction()

    res.json({ message: '添加成功', addedCount: songIds.length })
  } catch (error) {
    console.error('添加歌曲失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 从歌单移除歌曲
router.delete('/playlists/:id/songs/:songId', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND music_id = ?').run(
      parseInt(req.params.id),
      parseInt(req.params.songId)
    )
    
    // 清除歌单相关缓存
    await cache.del(CacheKeys.MUSIC_PLAYLISTS)
    
    res.json({ message: '移除成功' })
  } catch (error) {
    console.error('移除歌曲失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量从歌单移除歌曲（不删除源文件）
router.post('/playlists/:id/songs/batch-remove', authenticateToken, async (req, res) => {
  try {
    const { songIds } = req.body
    const playlistId = parseInt(req.params.id)
    const db = getDatabase()

    const transaction = db.transaction(() => {
      for (const songId of songIds) {
        db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND music_id = ?').run(playlistId, songId)
      }
    })

    transaction()
    
    // 清除歌单相关缓存
    await cache.del(CacheKeys.MUSIC_PLAYLISTS)

    res.json({ message: '移除成功', count: songIds.length })
  } catch (error) {
    console.error('批量移除失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 歌单歌曲排序
router.put('/playlists/:id/songs/reorder', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { songOrders } = req.body // [{ musicId: 1, sortOrder: 0 }, ...]
    const playlistId = parseInt(req.params.id)
    const db = getDatabase()

    const transaction = db.transaction(() => {
      for (const item of songOrders) {
        db.prepare('UPDATE playlist_songs SET sort_order = ? WHERE playlist_id = ? AND music_id = ?').run(
          item.sortOrder,
          playlistId,
          item.musicId
        )
      }
    })

    transaction()

    res.json({ message: '排序更新成功' })
  } catch (error) {
    console.error('更新排序失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 歌词管理

function isLyricAbortError(error, signal) {
  return Boolean(signal?.aborted) ||
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError'
}

function throwIfLyricAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('歌词任务已取消')
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    throw error
  }
}

// 歌词源配置（按优先级顺序）
const LYRIC_SOURCES = [
  {
    name: '网易云音乐',
    search: searchNeteaseMusic,
    getLyric: getNeteaseLyric
  },
  {
    name: 'QQ音乐',
    search: searchQQMusic,
    getLyric: getQQMusicLyric
  },
  {
    name: '酷狗音乐',
    search: searchKugouMusic,
    getLyric: getKugouLyric
  }
]

// 网易云音乐
const NETEASE_API_BASE = 'https://music.163.com/api'

// 计算字符串相似度（Levenshtein距离）
function stringSimilarity(s1, s2) {
  const s1Lower = s1.toLowerCase()
  const s2Lower = s2.toLowerCase()
  
  if (s1Lower === s2Lower) return 1.0
  
  const len1 = s1Lower.length
  const len2 = s2Lower.length
  
  if (len1 === 0 || len2 === 0) return 0.0
  
  const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0))
  
  for (let i = 0; i <= len1; i++) dp[i][0] = i
  for (let j = 0; j <= len2; j++) dp[0][j] = j
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1Lower[i - 1] === s2Lower[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  
  const maxLen = Math.max(len1, len2)
  return (maxLen - dp[len1][len2]) / maxLen
}

// 计算歌曲匹配度
function calculateSongMatchScore(song, targetTitle, targetArtist) {
  const songName = song.name || ''
  const songArtists = song.artists ? song.artists.map(a => a.name).join('') : ''
  
  // 标题匹配度（权重0.7）
  const titleScore = stringSimilarity(songName, targetTitle) * 0.7
  
  // 艺术家匹配度（权重0.3）
  let artistScore = 0
  if (targetArtist) {
    artistScore = stringSimilarity(songArtists, targetArtist) * 0.3
    // 如果艺术家包含目标艺术家，加分
    if (songArtists.toLowerCase().includes(targetArtist.toLowerCase())) {
      artistScore = 0.3
    }
  } else {
    artistScore = 0.15 // 无目标艺术家时给一半分数
  }
  
  return titleScore + artistScore
}

async function searchNeteaseMusic(title, artist, { signal } = {}) {
  try {
    // 第一次搜索：标题 + 艺术家
    let keyword = artist ? `${title} ${artist}` : title
    let searchUrl = `${NETEASE_API_BASE}/search/get`
    
    console.log(`[网易云音乐] 第一次搜索: ${keyword}`)
    
    let response = await axios.get(searchUrl, {
      params: {
        s: keyword,
        type: 1, // 单曲
        offset: 0,
        limit: 10
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com',
        'Accept': 'application/json'
      }
    })

    let songs = response.data?.result?.songs || []
    
    // 如果第一次搜索没有结果，且艺术家不为空，尝试只用标题搜索
    if (songs.length === 0 && artist) {
      keyword = title
      console.log(`[网易云音乐] 第二次搜索（仅标题）: ${keyword}`)
      
      response = await axios.get(searchUrl, {
        params: {
          s: keyword,
          type: 1,
          offset: 0,
          limit: 10
        },
        httpsAgent,
        timeout: 10000,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://music.163.com',
          'Accept': 'application/json'
        }
      })
      
      songs = response.data?.result?.songs || []
    }
    
    if (songs.length > 0) {
      // 计算每首歌曲的匹配度并排序
      const songsWithScore = songs.map(song => ({
        song,
        score: calculateSongMatchScore(song, title, artist)
      }))
      
      // 按匹配度排序
      songsWithScore.sort((a, b) => b.score - a.score)
      
      const bestMatch = songsWithScore[0]
      console.log(`[网易云音乐] 最佳匹配: "${bestMatch.song.name}" - "${bestMatch.song.artists?.map(a => a.name).join('/')}" (匹配度: ${(bestMatch.score * 100).toFixed(1)}%)`)
      
      return {
        id: bestMatch.song.id,
        name: bestMatch.song.name,
        artists: bestMatch.song.artists ? bestMatch.song.artists.map(a => a.name).join('/') : '',
        album: bestMatch.song.album ? bestMatch.song.album.name : '',
        matchScore: bestMatch.score
      }
    }

    console.log('[网易云音乐] 未找到匹配的歌曲')
    return null
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[网易云音乐] 搜索失败:', error.message)
    return null
  }
}

// 合并原文歌词和翻译歌词（双语显示）
function mergeLrcWithTranslation(originalLrc, translationLrc) {
  if (!originalLrc) return null
  
  // 如果没有翻译，直接返回原文
  if (!translationLrc) return originalLrc
  
  // 解析歌词为时间戳映射
  const parseLrcToMap = (lrcText) => {
    const map = new Map()
    const lines = lrcText.split('\n')
    
    for (const line of lines) {
      // 匹配时间标签 [mm:ss.xx] 或 [mm:ss.xxx]
      const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
      if (match) {
        const minutes = parseInt(match[1])
        const seconds = parseInt(match[2])
        const ms = match[3].length === 2 ? parseInt(match[3]) * 10 : parseInt(match[3])
        const time = minutes * 60 + seconds + ms / 1000
        const text = match[4].trim()
        
        // 只保留第一个时间标签（同一行可能有多个时间标签）
        if (text && !map.has(time)) {
          map.set(time, text)
        }
      }
    }
    return map
  }
  
  const originalMap = parseLrcToMap(originalLrc)
  const translationMap = parseLrcToMap(translationLrc)
  
  // 合并歌词
  const mergedLines = []
  const sortedTimes = Array.from(originalMap.keys()).sort((a, b) => a - b)
  
  for (const time of sortedTimes) {
    const originalText = originalMap.get(time)
    const translatedText = translationMap.get(time)
    
    // 格式化时间戳
    const minutes = Math.floor(time / 60)
    const seconds = Math.floor(time % 60)
    const ms = Math.round((time - Math.floor(time)) * 1000)
    const timeTag = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}]`
    
    mergedLines.push(`${timeTag}${originalText}`)
    
    // 如果有翻译，在下一行添加翻译（不带标记）
    if (translatedText) {
      mergedLines.push(`${timeTag}${translatedText}`)
    }
  }
  
  return mergedLines.join('\n')
}

async function getNeteaseLyric(songId, { signal } = {}) {
  try {
    const lyricUrl = `${NETEASE_API_BASE}/song/lyric`

    console.log(`[网易云音乐] 获取歌词: songId=${songId}`)

    const response = await axios.get(lyricUrl, {
      params: {
        id: songId,
        lv: 1,
        kv: 1,
        tv: -1
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com',
        'Accept': 'application/json'
      }
    })

    // 获取原文歌词
    const originalLrc = response.data?.lrc?.lyric || null
    // 获取翻译歌词（如果有）
    const translationLrc = response.data?.tlyric?.lyric || null
    
    // 合并原文和翻译（双语显示）
    const mergedLrc = mergeLrcWithTranslation(originalLrc, translationLrc)
    
    if (mergedLrc) {
      console.log(`[网易云音乐] 歌词获取成功${translationLrc ? '（含翻译）' : ''}`)
    }

    return mergedLrc
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[网易云音乐] 获取歌词失败:', error.message)
    return null
  }
}

// QQ音乐
const QQ_MUSIC_API_BASE = 'https://c.y.qq.com/soso/fcgi-bin'

async function searchQQMusic(title, artist, { signal } = {}) {
  try {
    const searchUrl = `${QQ_MUSIC_API_BASE}/client_search_cp`
    
    // 第一次搜索：标题 + 艺术家
    let keyword = artist ? `${title} ${artist}` : title
    console.log(`[QQ音乐] 第一次搜索: ${keyword}`)

    let response = await axios.get(searchUrl, {
      params: {
        format: 'json',
        w: keyword,
        p: 1,
        n: 10,
        aggr: 1,
        lossless: 0,
        cr: 1,
        new_json: 1
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://y.qq.com',
        'Accept': 'application/json'
      }
    })

    let songs = response.data?.data?.song?.list || []
    
    // 如果第一次搜索没有结果，且艺术家不为空，尝试只用标题搜索
    if (songs.length === 0 && artist) {
      keyword = title
      console.log(`[QQ音乐] 第二次搜索（仅标题）: ${keyword}`)
      
      response = await axios.get(searchUrl, {
        params: {
          format: 'json',
          w: keyword,
          p: 1,
          n: 10,
          aggr: 1,
          lossless: 0,
          cr: 1,
          new_json: 1
        },
        httpsAgent,
        timeout: 10000,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://y.qq.com',
          'Accept': 'application/json'
        }
      })
      
      songs = response.data?.data?.song?.list || []
    }

    if (songs.length > 0) {
      // 计算每首歌曲的匹配度并排序
      const songsWithScore = songs.map(song => {
        const songName = song.name || ''
        const songArtists = song.singer ? song.singer.map(s => s.name).join('') : ''
        
        // 标题匹配度
        const titleScore = stringSimilarity(songName, title) * 0.7
        
        // 艺术家匹配度
        let artistScore = 0
        if (artist) {
          artistScore = stringSimilarity(songArtists, artist) * 0.3
          if (songArtists.toLowerCase().includes(artist.toLowerCase())) {
            artistScore = 0.3
          }
        } else {
          artistScore = 0.15
        }
        
        return {
          song,
          score: titleScore + artistScore
        }
      })
      
      // 按匹配度排序
      songsWithScore.sort((a, b) => b.score - a.score)
      
      const bestMatch = songsWithScore[0]
      console.log(`[QQ音乐] 最佳匹配: "${bestMatch.song.name}" - "${bestMatch.song.singer?.map(s => s.name).join('/')}" (匹配度: ${(bestMatch.score * 100).toFixed(1)}%)`)
      
      return {
        id: bestMatch.song.mid,
        name: bestMatch.song.name,
        artists: bestMatch.song.singer ? bestMatch.song.singer.map(s => s.name).join('/') : '',
        album: bestMatch.song.album ? bestMatch.song.album.name : '',
        matchScore: bestMatch.score
      }
    }

    console.log('[QQ音乐] 未找到匹配的歌曲')
    return null
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[QQ音乐] 搜索失败:', error.message)
    return null
  }
}

async function getQQMusicLyric(songMid, { signal } = {}) {
  try {
    const lyricUrl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'

    console.log(`[QQ音乐] 获取歌词: songMid=${songMid}`)

    const response = await axios.get(lyricUrl, {
      params: {
        songmid: songMid,
        format: 'json',
        nobase64: 1
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://y.qq.com',
        'Accept': 'application/json'
      }
    })

    if (response.data && response.data.lyric) {
      return response.data.lyric
    }

    return null
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[QQ音乐] 获取歌词失败:', error.message)
    return null
  }
}

// 酷狗音乐
const KUGOU_API_BASE = 'https://songsearch.kugou.com'

async function searchKugouMusic(title, artist, { signal } = {}) {
  try {
    const searchUrl = `${KUGOU_API_BASE}/song_search_v2`
    
    // 第一次搜索：标题 + 艺术家
    let keyword = artist ? `${title} ${artist}` : title
    console.log(`[酷狗音乐] 第一次搜索: ${keyword}`)

    let response = await axios.get(searchUrl, {
      params: {
        keyword: keyword,
        platform: 'WebFilter',
        format: 'json',
        page: 1,
        pagesize: 10
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.kugou.com',
        'Accept': 'application/json'
      }
    })

    let songs = response.data?.data?.lists || []
    
    // 如果第一次搜索没有结果，且艺术家不为空，尝试只用标题搜索
    if (songs.length === 0 && artist) {
      keyword = title
      console.log(`[酷狗音乐] 第二次搜索（仅标题）: ${keyword}`)
      
      response = await axios.get(searchUrl, {
        params: {
          keyword: keyword,
          platform: 'WebFilter',
          format: 'json',
          page: 1,
          pagesize: 10
        },
        httpsAgent,
        timeout: 10000,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.kugou.com',
          'Accept': 'application/json'
        }
      })
      
      songs = response.data?.data?.lists || []
    }

    if (songs.length > 0) {
      // 计算每首歌曲的匹配度并排序
      const songsWithScore = songs.map(song => {
        const songName = song.SongName || ''
        const songArtists = song.SingerName || ''
        
        // 标题匹配度
        const titleScore = stringSimilarity(songName, title) * 0.7
        
        // 艺术家匹配度
        let artistScore = 0
        if (artist) {
          artistScore = stringSimilarity(songArtists, artist) * 0.3
          if (songArtists.toLowerCase().includes(artist.toLowerCase())) {
            artistScore = 0.3
          }
        } else {
          artistScore = 0.15
        }
        
        return {
          song,
          score: titleScore + artistScore
        }
      })
      
      // 按匹配度排序
      songsWithScore.sort((a, b) => b.score - a.score)
      
      const bestMatch = songsWithScore[0]
      console.log(`[酷狗音乐] 最佳匹配: "${bestMatch.song.SongName}" - "${bestMatch.song.SingerName}" (匹配度: ${(bestMatch.score * 100).toFixed(1)}%)`)
      
      return {
        id: bestMatch.song.ID,
        hash: bestMatch.song.FileHash,
        name: bestMatch.song.SongName,
        artists: bestMatch.song.SingerName,
        album: bestMatch.song.AlbumName,
        matchScore: bestMatch.score
      }
    }

    console.log('[酷狗音乐] 未找到匹配的歌曲')
    return null
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[酷狗音乐] 搜索失败:', error.message)
    return null
  }
}

async function getKugouLyric(hash, { signal } = {}) {
  try {
    const lyricUrl = 'https://www.kugou.com/yy/index.php'

    console.log(`[酷狗音乐] 获取歌词: hash=${hash}`)

    const response = await axios.get(lyricUrl, {
      params: {
        r: 'play/getdata',
        hash: hash
      },
      httpsAgent,
      timeout: 10000,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.kugou.com',
        'Accept': 'application/json'
      }
    })

    if (response.data && response.data.data && response.data.data.lyrics) {
      return response.data.data.lyrics
    }

    return null
  } catch (error) {
    if (isLyricAbortError(error, signal)) throw error
    console.error('[酷狗音乐] 获取歌词失败:', error.message)
    return null
  }
}

// 搜索歌词（按优先级尝试多个歌词源）
async function searchLyricsFromSources(title, artist, { signal } = {}) {
  console.log(`[歌词搜索] 开始搜索: ${title} - ${artist || '未知'}`)

  // 按优先级顺序尝试每个歌词源
  for (const source of LYRIC_SOURCES) {
    try {
      throwIfLyricAborted(signal)
      console.log(`[歌词搜索] 尝试 ${source.name}...`)

      const songInfo = await source.search(title, artist, { signal })

      if (songInfo) {
        console.log(`[${source.name}] 找到歌曲: ${songInfo.name} - ${songInfo.artists}`)

        const lyric = await source.getLyric(songInfo.id || songInfo.hash, { signal })

        throwIfLyricAborted(signal)

        if (lyric) {
          console.log(`[${source.name}] 成功获取歌词`)
          return {
            source: source.name,
            lrc: lyric,
            songInfo
          }
        }
      }
    } catch (error) {
      if (isLyricAbortError(error, signal)) throw error
      console.error(`[${source.name}] 失败:`, error.message)
      continue // 继续尝试下一个源
    }
  }

  // 所有源都失败，返回 null
  console.log('[歌词搜索] 所有歌词源均失败，未找到歌词')
  return null
}

// 搜索歌词
router.get('/lyrics/search', authenticateToken, async (req, res) => {
  try {
    const { title, artist } = req.query

    if (!title) {
      return res.status(400).json({ message: '缺少歌曲标题' })
    }

    const result = await searchLyricsFromSources(title, artist || '')

    if (!result) {
      return res.json({
        success: false,
        source: null,
        lyrics: null,
        message: '未找到歌词'
      })
    }

    return res.json({
      success: true,
      source: result.source,
      lyrics: result.lrc
    })
  } catch (error) {
    console.error('搜索歌词失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

function normalizeLyricsTaskVersionId(value) {
  if (value === undefined || value === null) return randomUUID()
  if (typeof value !== 'string') {
    const error = new Error('Idempotency-Key 无效')
    error.code = 'TASK_IDEMPOTENCY_KEY_INVALID'
    throw error
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    const error = new Error('Idempotency-Key 无效')
    error.code = 'TASK_IDEMPOTENCY_KEY_INVALID'
    throw error
  }
  return normalized
}

function lyricsTaskVersionId(req) {
  return normalizeLyricsTaskVersionId(req.get('Idempotency-Key'))
}

function enqueueMusicLyricsTask(database, input, subjectVersionId) {
  return enqueueExclusiveRun(database, {
    taskType: 'music.lyrics.batch',
    processorVersion: MUSIC_LYRICS_PROCESSOR_VERSION,
    subjectType: MUSIC_LYRICS_SUBJECT_TYPE,
    subjectId: MUSIC_LYRICS_SUBJECT_ID,
    subjectVersionId,
    input,
    executionClass: MUSIC_LYRICS_EXECUTION_CLASS
  }, { taskTypes: MUSIC_LYRICS_TASK_TYPES })
}

function taskTimestamp(value) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function publicLyricsTaskResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const rawResults = Array.isArray(result.results) ? result.results : []
  const results = rawResults.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    if (!Number.isSafeInteger(item.musicId) || item.musicId <= 0) return []
    const output = {
      musicId: item.musicId,
      success: item.success === true
    }
    if (typeof item.source === 'string' && item.source) output.source = item.source
    if (typeof item.error === 'string' && item.error) output.error = item.error
    if (item.skipped === true) {
      output.skipped = true
      output.reason = '已有歌词'
    }
    return [output]
  })
  return {
    total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : 0,
    success: Number.isSafeInteger(result.success) && result.success >= 0 ? result.success : 0,
    failed: Number.isSafeInteger(result.failed) && result.failed >= 0 ? result.failed : 0,
    skipped: Number.isSafeInteger(result.skipped) && result.skipped >= 0 ? result.skipped : 0,
    results
  }
}

function publicLyricsTaskStatus(task) {
  const result = publicLyricsTaskResult(task.result)
  const input = task.input && typeof task.input === 'object' && !Array.isArray(task.input)
    ? task.input
    : null
  const total = result?.total ?? (Array.isArray(input?.musicIds) ? input.musicIds.length : 0)
  const status = {
    pending: 'pending',
    leased: 'running',
    running: 'running',
    succeeded: 'completed',
    failed: 'failed',
    cancelled: 'cancelled'
  }[task.status] || 'failed'
  const percentage = Number.isFinite(task.progress)
    ? Math.max(0, Math.min(100, task.progress))
    : 0
  const progress = total > 0 ? Math.min(total, Math.round((percentage / 100) * total)) : 0
  const publicTask = {
    id: task.id,
    taskId: task.id,
    status,
    progress,
    total,
    success: result?.success ?? 0,
    failed: result?.failed ?? 0,
    skipped: result?.skipped ?? 0,
    results: result?.results ?? [],
    startTime: taskTimestamp(task.startedAt || task.createdAt),
    endTime: taskTimestamp(task.finishedAt)
  }
  if (typeof task.errorSummary === 'string' && task.errorSummary) {
    publicTask.error = task.errorSummary
  }
  return publicTask
}

function sendEnqueuedMusicLyricsTask(res, outcome, total) {
  if (outcome.activeConflict) {
    return res.status(409).json({
      success: true,
      taskId: outcome.task.id,
      message: '歌词任务正在运行'
    })
  }
  return res.json({
    success: true,
    taskId: outcome.task.id,
    message: outcome.task.status === 'succeeded'
      ? '歌词下载已完成'
      : `开始下载 ${total} 首歌曲的歌词`
  })
}

// 批量下载歌词（持久任务）
router.post('/lyrics/batch-download', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const normalizedInput = normalizeMusicLyricsTaskInput({ input: req.body })
    const subjectVersionId = lyricsTaskVersionId(req)
    const outcome = enqueueMusicLyricsTask(
      getDatabase(),
      normalizedInput,
      subjectVersionId
    )
    return sendEnqueuedMusicLyricsTask(res, outcome, normalizedInput.musicIds.length)
  } catch (error) {
    if (error?.code === 'TASK_IDEMPOTENCY_KEY_INVALID' ||
      error?.code === 'TASK_INPUT_INVALID' ||
      error?.code === 'TASK_IDEMPOTENCY_CONFLICT') {
      return res.status(error.code === 'TASK_IDEMPOTENCY_CONFLICT' ? 409 : 400).json({
        message: error.summary || error.message,
        code: error.code
      })
    }
    console.error('批量下载歌词入队失败:', error)
    return res.status(500).json({ message: '服务器错误' })
  }
})

// 查询歌词下载任务进度
router.get('/lyrics/task/:taskId', authenticateToken, async (req, res) => {
  try {
    const task = getTaskById(getDatabase(), req.params.taskId)
    if (!task || task.taskType !== 'music.lyrics.batch' ||
      task.subjectType !== MUSIC_LYRICS_SUBJECT_TYPE ||
      task.subjectId !== MUSIC_LYRICS_SUBJECT_ID) {
      return res.status(404).json({ message: '任务不存在' })
    }
    return res.json({
      success: true,
      task: publicLyricsTaskStatus(task)
    })
  } catch (error) {
    if (error?.code === 'TASK_NOT_FOUND' || error?.code === 'TASK_ID_INVALID') {
      return res.status(404).json({ message: '任务不存在' })
    }
    console.error('查询歌词任务失败:', error)
    return res.status(500).json({ message: '服务器错误' })
  }
})

// 获取单个音乐的歌词
router.get('/:id/lyrics', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 检查字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    if (!columnNames.includes('lyrics')) {
      return res.json({ lyrics: null, message: '数据库未升级' })
    }
    
    const music = db.prepare('SELECT lyrics, lyrics_source, has_lyrics FROM music WHERE id = ?').get(req.params.id)
    
    if (!music) {
      return res.status(404).json({ message: '音乐不存在' })
    }
    
    res.json({ 
      lyrics: music.lyrics,
      source: music.lyrics_source || null,
      hasLyrics: music.has_lyrics === 1
    })
    
  } catch (error) {
    console.error('获取歌词失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新歌词（手动上传或纠正）
router.put('/:id/lyrics', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { lyrics, source } = req.body
    const db = getDatabase()
    
    // 检查字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    if (!columnNames.includes('lyrics')) {
      return res.status(500).json({ message: '数据库未升级' })
    }
    
    const updateFields = ['lyrics = ?', 'lyrics_updated_at = CURRENT_TIMESTAMP']
    const params = [lyrics || '']
    
    if (columnNames.includes('lyrics_source')) {
      updateFields.push('lyrics_source = ?')
      params.push(source || '手动上传')
    }
    
    if (columnNames.includes('has_lyrics')) {
      updateFields.push('has_lyrics = ?')
      params.push(lyrics ? 1 : 0)
    }
    
    params.push(req.params.id)
    
    db.prepare(`
      UPDATE music 
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `).run(...params)
    
    res.json({ message: '歌词更新成功' })
    
  } catch (error) {
    console.error('更新歌词失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 检测并清理示例歌词
router.post('/clean-sample-lyrics', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    
    // 检查字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    
    if (!columnNames.includes('lyrics') || !columnNames.includes('lyrics_source')) {
      return res.status(500).json({ message: '数据库未升级' })
    }
    
    // 查找所有标记为"示例数据"的歌词
    const sampleLyrics = db.prepare(`
      SELECT id, title, artist, lyrics 
      FROM music 
      WHERE lyrics_source = '示例数据' 
         OR lyrics LIKE '%暂无歌词%'
         OR lyrics LIKE '%请在音乐平台搜索并上传歌词%'
    `).all()
    
    if (sampleLyrics.length === 0) {
      return res.json({
        message: '未发现示例歌词',
        cleanedCount: 0,
        totalCount: 0
      })
    }
    
    // 清理示例歌词（设置为 NULL）
    const ids = sampleLyrics.map(m => m.id)
    const placeholders = ids.map(() => '?').join(',')
    
    db.prepare(`
      UPDATE music 
      SET lyrics = NULL, 
          lyrics_source = NULL, 
          has_lyrics = 0,
          lyrics_updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(...ids)
    
    res.json({
      message: `成功清理 ${sampleLyrics.length} 首歌曲的示例歌词`,
      cleanedCount: sampleLyrics.length,
      totalCount: sampleLyrics.length,
      cleanedSongs: sampleLyrics.map(s => ({
        id: s.id,
        title: s.title,
        artist: s.artist
      }))
    })
    
  } catch (error) {
    console.error('清理示例歌词失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取单个音乐的封面图片（必须放在最后，避免路由冲突）
// 返回 JSON 格式 { cover: base64 }，方便前端缓存到 IndexedDB
router.get('/:id/cover', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const music = db.prepare('SELECT cover_image FROM music WHERE id = ?').get(req.params.id)
    
    if (!music || !music.cover_image) {
      return res.status(404).json({ message: '封面不存在' })
    }
    
    // 返回封面数据（base64 格式）
    res.json({ cover: music.cover_image })
  } catch (error) {
    console.error('获取封面失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

async function verifiedMusicPath(music) {
  return (await getResourceStorageRuntime().contentServiceFor('music').resolveVerifiedFilePath(music)).filePath
}

const musicMetadataTaskProcessor = createMusicMetadataTaskProcessor({
  databaseProvider: getDatabase,
  resolveMusicPath: verifiedMusicPath,
  parseMetadata: parseMusicMetadata
})
registerTaskProcessor(
  MUSIC_METADATA_TASK_TYPE,
  MUSIC_METADATA_PROCESSOR_VERSION,
  MUSIC_METADATA_EXECUTION_CLASS,
  musicMetadataTaskProcessor
)

const musicLyricsTaskProcessor = createMusicLyricsTaskProcessor({
  searchLyricsFromSources
})
registerTaskProcessor(
  'music.lyrics.batch',
  MUSIC_LYRICS_PROCESSOR_VERSION,
  MUSIC_LYRICS_EXECUTION_CLASS,
  musicLyricsTaskProcessor
)

export default router
