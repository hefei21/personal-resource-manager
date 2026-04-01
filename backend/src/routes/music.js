import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { getDatabase } from '../config/database.js'
import { getStoragePath } from '../config/storage.js'
import { authenticateToken } from '../middlewares/auth.js'

const execAsync = promisify(exec)

// 创建代理 agent
const httpsAgent = process.env.HTTP_PROXY
  ? new HttpsProxyAgent(process.env.HTTP_PROXY)
  : undefined

// 歌词批量下载任务存储
const lyricTasks = new Map()

// ========== 上传取消管理 ==========
// 使用 Set 存储已取消的 fileId，实现实时取消功能
const cancelledUploads = new Set()

// 存储正在上传的文件进度（用于跨标签页同步和断点续传）
// uploadProgress: Map<fileId, { fileName, fileSize, totalChunks, receivedChunks: Set<number>, status, timestamp, fileData? }>
const uploadProgress = new Map()

// 定期清理过期的取消标记（避免内存泄漏）
setInterval(() => {
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
        const chunkPath = path.join(tempDir, `${fileId}_${i}`)
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

// ========== 中文拼音排序辅助函数（使用 Intl.Collator，无需额外依赖）==========
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

// ========== 轻量级元数据解析（降级方案）==========

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
    while (offset < buffer.length) {
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
    console.log('[轻量解析] FLAC Vorbis 解析失败:', error.message)
    return null
  }
}

// 简单解析 MP3 ID3v2 标签（纯 JS）
function parseMp3Id3Tags(buffer) {
  try {
    // 检查 ID3v2 标签
    if (buffer.length < 10 || buffer.slice(0, 3).toString('ascii') !== 'ID3') {
      return null
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
    console.log('[轻量解析] MP3 ID3 解析失败:', error.message)
    return null
  }
}

// 轻量级元数据解析（降级方案）
function parseMetadataLightweight(filePath, originalName) {
  try {
    const ext = path.extname(originalName).toLowerCase()
    const buffer = fs.readFileSync(filePath, { start: 0, end: 65535 }) // 只读取前 64KB
    
    console.log('[轻量解析] 尝试解析:', originalName)
    
    if (ext === '.flac') {
      return parseFlacVorbisComments(buffer)
    } else if (ext === '.mp3') {
      return parseMp3Id3Tags(buffer)
    }
    
    return null
  } catch (error) {
    console.log('[轻量解析] 解析失败:', error.message)
    return null
  }
}

// ========== 主解析函数 ==========

const router = express.Router()

// 最终存储目录
const musicDir = getStoragePath('music')

// 临时上传目录
const tempDir = path.join(musicDir, 'temp')
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

// 配置分片上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir)
  },
  filename: (req, file, cb) => {
    const { fileId, chunkIndex } = req.body
    cb(null, `${fileId}_${chunkIndex}`)
  }
})

const upload = multer({ storage })

// 辅助函数：将 UTC 时间转换为 UTC+8
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  const date = new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hour = String(utc8Date.getHours()).padStart(2, '0')
  const minute = String(utc8Date.getMinutes()).padStart(2, '0')
  const second = String(utc8Date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

// 解析音乐元数据（三层降级策略）
async function parseMusicMetadata(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase()
  const baseName = path.basename(originalName, ext)

  // 默认值从文件名推断
  let title = baseName
  let artist = ''
  let album = ''
  let duration = 0
  let coverImage = null

  // 第一层：尝试使用 FFprobe（最可靠，需要 FFmpeg）
  try {
    console.log('[元数据解析] 第一层：尝试 FFprobe...')
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 10000 }
    )

    const probeData = JSON.parse(stdout)
    const format = probeData.format || {}
    const tags = format.tags || {}

    console.log('[FFprobe] 解析成功')
    console.log('[FFprobe] 格式:', format.format_long_name || format.format_name)
    console.log('[FFprobe] 标签:', JSON.stringify(tags))

    // 提取基本信息
    title = tags.title || tags.TITLE || title
    artist = tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST || tags.artists || artist
    album = tags.album || tags.ALBUM || album
    duration = format.duration ? Math.round(parseFloat(format.duration)) : duration

    // 提取封面图片
    const videoStream = probeData.streams?.find(s => 
      s.codec_type === 'video' && s.disposition?.attached_pic === 1
    )
    
    if (videoStream) {
      console.log('[FFprobe] 提取封面中...')
      try {
        const { stdout: coverData } = await execAsync(
          `ffmpeg -v quiet -i "${filePath}" -an -vcodec copy -f image2pipe -`,
          { 
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000
          }
        )
        
        const mimeType = videoStream.codec_name === 'png' ? 'image/png' : 'image/jpeg'
        coverImage = `data:${mimeType};base64,${coverData.toString('base64')}`
        console.log('[FFprobe] 封面提取成功，大小:', coverData.length, '字节')
      } catch (coverError) {
        console.log('[FFprobe] 封面提取失败:', coverError.message)
      }
    }

    console.log(`[FFprobe] 最终结果: ${title} - ${artist} (${duration}s)${coverImage ? ' [有封面]' : ''}`)
    
    // FFprobe 成功，直接返回
    const stats = fs.statSync(filePath)
    return {
      title,
      artist,
      album,
      duration,
      fileSize: stats.size,
      fileType: ext.replace('.', ''),
      coverImage
    }
  } catch (error) {
    console.log(`[FFprobe] 失败: ${error.message}`)
  }

  // 第二层：轻量级纯 JS 解析（无需外部依赖）
  console.log('[元数据解析] 第二层：尝试轻量级解析...')
  const lightweightMetadata = parseMetadataLightweight(filePath, originalName)
  
  if (lightweightMetadata) {
    console.log('[轻量解析] 成功:', lightweightMetadata)
    
    // 使用轻量级解析的结果
    title = lightweightMetadata.title || title
    artist = lightweightMetadata.artist || artist
    album = lightweightMetadata.album || album
    
    console.log(`[轻量解析] 最终结果: ${title} - ${artist}`)
  } else {
    console.log('[轻量解析] 失败，使用文件名作为默认值')
  }

  // 第三层：降级到文件名（已在初始化时设置）

  // 获取文件大小
  const stats = fs.statSync(filePath)
  const fileSize = stats.size

  console.log(`[元数据解析] 最终: ${title} - ${artist} (${duration}s)`)

  return {
    title,
    artist,
    album,
    duration,
    fileSize,
    fileType: ext.replace('.', ''),
    coverImage
  }
}

// ========== 分片上传 ==========

// 上传分片
router.post('/upload-chunk', authenticateToken, upload.single('chunk'), async (req, res) => {
  try {
    const { fileId, chunkIndex, totalChunks, fileName } = req.body
    const chunkIdx = parseInt(chunkIndex)
    const totalChs = parseInt(totalChunks)
    
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
    res.status(500).json({ message: '上传失败' })
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
router.post('/merge-chunks', authenticateToken, async (req, res) => {
  try {
    const { fileId, fileName, totalChunks, skipDuplicate } = req.body
    const db = getDatabase()
    
    // 检查是否已取消
    if (cancelledUploads.has(fileId)) {
      console.log(`[合并取消] 文件 ${fileId} 已取消，拒绝合并`)
      // 清理可能残留的临时文件
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(tempDir, `${fileId}_${i}`)
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath)
        }
      }
      return res.status(400).json({ message: '上传已取消', cancelled: true })
    }
    
    // 先计算文件大小（通过分片）
    let totalSize = 0
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `${fileId}_${i}`)
      if (fs.existsSync(chunkPath)) {
        totalSize += fs.statSync(chunkPath).size
      }
    }
    
    // 检查重复（除非明确跳过）
    if (!skipDuplicate) {
      const existing = db.prepare(`
        SELECT id, title, artist, album, file_size 
        FROM music 
        WHERE file_size = ?
        LIMIT 1
      `).get(totalSize)
      
      if (existing) {
        // 清理临时分片
        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = path.join(tempDir, `${fileId}_${i}`)
          if (fs.existsSync(chunkPath)) {
            fs.unlinkSync(chunkPath)
          }
        }
        
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
    
    // 生成最终文件名
    const ext = path.extname(fileName).toLowerCase()
    let finalExt = ext
    
    // 生成最终路径
    const finalPath = path.join(musicDir, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`)
    
    // 合并分片
    const writeStream = fs.createWriteStream(finalPath)
    
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `${fileId}_${i}`)
      if (fs.existsSync(chunkPath)) {
        const chunkData = fs.readFileSync(chunkPath)
        writeStream.write(chunkData)
        fs.unlinkSync(chunkPath) // 删除临时分片
      } else {
        console.error(`分片 ${i} 不存在，文件可能损坏`)
        writeStream.end()
        fs.unlinkSync(finalPath) // 删除不完整的文件
        return res.status(400).json({ 
          message: '文件上传不完整，请重试',
          error: 'missing_chunk'
        })
      }
    }
    
    writeStream.end()
    
    // 等待写入完成
    await new Promise(resolve => writeStream.on('finish', resolve))

    // 验证文件完整性（检查文件魔数/签名）
    const fileBuffer = fs.readFileSync(finalPath)
    const fileSize = fileBuffer.length
    const fileHeader = fileBuffer.slice(0, 16).toString('hex')
    
    console.log(`[文件验证] ${fileName}, 大小: ${fileSize} 字节`)
    console.log(`[文件验证] 文件头: ${fileHeader}`)
    
    // 检查常见音频格式签名
    const formatSignatures = {
      flac: '664c61430000000022', // FLAC: fLaC
      mp3_id3: '494433',          // MP3 with ID3 tag
      mp3_frame: 'fffb',          // MP3 frame sync
      wav: '52494646',            // WAV: RIFF
      ogg: '4f676753',            // OGG: OggS
      m4a: '000000',              // M4A/M4P (box structure)
      ape: '4d415043',            // APE: MAC
    }
    
    const extLower = ext.toLowerCase()
    let isFormatValid = true
    
    if (extLower === '.flac') {
      // FLAC 文件必须以 'fLaC' 开头
      isFormatValid = fileHeader.startsWith('664c6143')
      if (!isFormatValid) {
        console.error(`[文件验证] FLAC 文件签名无效`)
      }
    } else if (extLower === '.mp3') {
      // MP3 文件以 ID3 标签或帧同步开头
      isFormatValid = fileHeader.startsWith('494433') || fileHeader.startsWith('fffb') || fileHeader.startsWith('fff3') || fileHeader.startsWith('fff2')
      if (!isFormatValid) {
        console.error(`[文件验证] MP3 文件签名无效`)
      }
    }
    
    if (!isFormatValid) {
      fs.unlinkSync(finalPath)
      return res.status(400).json({
        message: `文件格式验证失败：${ext} 文件头签名无效，可能不是有效的音频文件或文件已损坏`,
        error: 'invalid_format'
      })
    }

    // 解析元数据
    const metadata = await parseMusicMetadata(finalPath, fileName)

    // 保存到数据库（包含封面图片）
    const stmt = db.prepare(`
      INSERT INTO music (title, artist, album, duration, file_path, file_size, file_type, cover_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      metadata.title,
      metadata.artist,
      metadata.album,
      metadata.duration,
      finalPath,
      metadata.fileSize,
      metadata.fileType,
      metadata.coverImage
    )

    console.log(`音乐上传成功: ${metadata.title} - ${metadata.artist}${metadata.coverImage ? ' [有封面]' : ''}`)
    
    // 清除上传进度记录
    uploadProgress.delete(fileId)
    
    res.json({ 
      id: result.lastInsertRowid,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      message: '上传成功'
    })
  } catch (error) {
    console.error('合并分片失败:', error)
    res.status(500).json({ message: '合并失败', error: error.message })
  }
})

// 取消上传（清理临时文件 + 设置取消标志）
router.delete('/cancel-upload', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.body
    
    console.log(`[上传取消] 收到取消请求: ${fileId}`)
    
    // 1. 设置取消标志（阻止后续分片上传）
    cancelledUploads.add(fileId)
    
    // 2. 删除所有相关分片
    const files = fs.readdirSync(tempDir)
    let deletedCount = 0
    files.forEach(file => {
      if (file.startsWith(fileId)) {
        fs.unlinkSync(path.join(tempDir, file))
        deletedCount++
      }
    })
    
    // 3. 清除进度记录
    uploadProgress.delete(fileId)
    
    console.log(`[上传取消] 已删除 ${deletedCount} 个临时分片`)
    
    // 4. 5 分钟后清理取消标记（给正在进行的请求足够时间检测）
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
router.post('/start-upload', authenticateToken, async (req, res) => {
  try {
    const { fileId, fileName, fileSize, totalChunks } = req.body
    
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
    res.status(500).json({ message: '创建失败' })
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
    
    // 1. 将所有正在上传的文件标记为取消
    for (const [fileId] of uploadProgress) {
      cancelledUploads.add(fileId)
    }
    
    // 2. 删除所有临时分片
    const files = fs.readdirSync(tempDir)
    let deletedCount = 0
    files.forEach(file => {
      try {
        fs.unlinkSync(path.join(tempDir, file))
        deletedCount++
      } catch (e) {
        // 忽略删除失败
      }
    })
    
    // 3. 清除所有进度记录
    const cancelledCount = uploadProgress.size
    uploadProgress.clear()
    
    console.log(`[上传取消] 已取消 ${cancelledCount} 个上传，删除 ${deletedCount} 个临时文件`)
    
    // 4. 5 分钟后清理取消标记
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

// ========== 音乐管理 ==========

// 获取所有音乐 ID（用于全选）
router.get('/all-ids', authenticateToken, async (req, res) => {
  try {
    const { keyword, artist, album } = req.query
    const db = getDatabase()

    let whereClause = 'WHERE 1=1'
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
      page = 1,
      pageSize = 30
    } = req.query
    const db = getDatabase()

    // 检查表结构，确定可用字段
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const columnNames = columns.map(c => c.name)
    console.log('music 表字段:', columnNames.join(', '))

    // 动态构建 SELECT 字段（不包含 cover_image，减少数据量）
    // 但添加 has_cover 标志位
    const selectFields = ['id', 'title']
    if (columnNames.includes('artist')) selectFields.push('artist')
    if (columnNames.includes('album')) selectFields.push('album')
    if (columnNames.includes('duration')) selectFields.push('duration')
    if (columnNames.includes('file_size')) selectFields.push('file_size')
    if (columnNames.includes('file_type')) selectFields.push('file_type')
    // 添加 has_cover 标志位（封面是否存在）
    if (columnNames.includes('cover_image')) {
      selectFields.push("CASE WHEN cover_image IS NOT NULL AND cover_image != '' THEN 1 ELSE 0 END as has_cover")
    }
    selectFields.push('created_at', 'updated_at')

    // 构建基础查询条件（不包含排序和分页）
    let whereClause = 'WHERE 1=1'
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
    console.log('[音乐列表] COUNT SQL:', countSql)
    console.log('[音乐列表] 参数:', params)
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

    // 文本字段排序需要拼音处理
    const textFieldPattern = ['title', 'artist', 'album']
    const needPinyinSort = textFieldPattern.includes(sortField)

    // 构建完整的查询 SQL
    let sql = `SELECT ${selectFields.join(', ')} FROM music ${whereClause}`

    if (needPinyinSort) {
      // 文本字段：先获取所有数据，在应用层排序（支持中文拼音）
      const stmt = db.prepare(sql)
      let rows = stmt.all(...params)
      
      // 转换时间
      let musicList = rows.map(row => ({
        ...row,
        created_at: convertToUTC8(row.created_at),
        updated_at: convertToUTC8(row.updated_at)
      }))
      
      // 按拼音排序（使用 Intl.Collator，支持中文拼音排序）
      musicList.sort((a, b) => {
        const comparison = compareByPinyin(a, b, sortField)
        return order === 'DESC' ? -comparison : comparison
      })
      
      // 分页
      const startIndex = (parseInt(page) - 1) * parseInt(pageSize)
      const paginatedList = musicList.slice(startIndex, startIndex + parseInt(pageSize))
      
      console.log('[音乐列表] 拼音排序 - 总数:', total, '当前页:', paginatedList.length)
      res.json({ data: paginatedList, total })
    } else {
      // 数值/时间字段：直接在数据库排序（性能更好）
      sql += ` ORDER BY CASE WHEN ${sortField} IS NULL THEN 1 ELSE 0 END, ${sortField} ${order}`
      sql += ' LIMIT ? OFFSET ?'
      const queryParams = [...params, parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)]
      
      console.log('[音乐列表] SQL:', sql)
      console.log('[音乐列表] 参数:', queryParams)
      
      const stmt = db.prepare(sql)
      const rows = stmt.all(...queryParams)
      
      // 转换时间
      const musicList = rows.map(row => ({
        ...row,
        created_at: convertToUTC8(row.created_at),
        updated_at: convertToUTC8(row.updated_at)
      }))
      
      res.json({ data: musicList, total })
    }
  } catch (error) {
    console.error('获取音乐失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取所有艺术家列表
router.get('/artists', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    // 检查 artist 字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const hasArtist = columns.some(col => col.name === 'artist')

    if (!hasArtist) {
      return res.json({ data: [] })
    }

    // 获取所有艺术家
    const rows = db.prepare(`SELECT DISTINCT TRIM(artist) as artist FROM music WHERE artist IS NOT NULL AND TRIM(artist) != ''`).all()
    
    // 按拼音排序（使用 Intl.Collator，支持中文拼音排序）
    const artists = rows.map(r => r.artist).sort((a, b) => zhCollator.compare(a, b))
    
    res.json({ data: artists })
  } catch (error) {
    console.error('获取艺术家列表失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 获取所有专辑列表
router.get('/albums', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    // 检查 album 字段是否存在
    const columns = db.prepare("PRAGMA table_info(music)").all()
    const hasAlbum = columns.some(col => col.name === 'album')

    if (!hasAlbum) {
      return res.json({ data: [] })
    }

    // 获取所有专辑
    const rows = db.prepare(`SELECT DISTINCT TRIM(album) as album FROM music WHERE album IS NOT NULL AND TRIM(album) != ''`).all()
    
    // 按拼音排序（使用 Intl.Collator，支持中文拼音排序）
    const albums = rows.map(r => r.album).sort((a, b) => zhCollator.compare(a, b))
    
    res.json({ data: albums })
  } catch (error) {
    console.error('获取专辑列表失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 重新解析音乐元数据
router.post('/:id/reparse', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const music = db.prepare('SELECT * FROM music WHERE id = ?').get(req.params.id)

    if (!music) {
      return res.status(404).json({ message: '音乐不存在' })
    }

    if (!music.file_path || !fs.existsSync(music.file_path)) {
      return res.status(404).json({ message: '音乐文件不存在' })
    }

    console.log(`[元数据] 重新解析文件: ${music.file_path}`)

    // 重新解析元数据
    const metadata = await parseMusicMetadata(music.file_path, music.file_path)

    // 更新数据库
    const stmt = db.prepare(`
      UPDATE music SET 
        title = ?, 
        artist = ?, 
        album = ?, 
        duration = ?,
        cover_image = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `)
    stmt.run(
      metadata.title,
      metadata.artist,
      metadata.album,
      metadata.duration,
      metadata.coverImage,
      req.params.id
    )

    console.log(`[元数据] 重新解析成功: ${metadata.title} - ${metadata.artist}`)

    res.json({
      message: '重新解析成功',
      metadata: {
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        duration: metadata.duration,
        hasCover: !!metadata.coverImage
      }
    })
  } catch (error) {
    console.error('重新解析失败:', error)
    res.status(500).json({ message: '重新解析失败', error: error.message })
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

    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 删除音乐
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM music WHERE id = ?')
    const music = stmt.get(req.params.id)

    if (music && music.file_path && fs.existsSync(music.file_path)) {
      fs.unlinkSync(music.file_path)
    }

    // 从所有歌单中移除
    db.prepare('DELETE FROM playlist_songs WHERE music_id = ?').run(req.params.id)
    
    // 删除音乐记录
    db.prepare('DELETE FROM music WHERE id = ?').run(req.params.id)

    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量删除音乐
router.post('/batch-delete', authenticateToken, async (req, res) => {
  try {
    const { ids } = req.body
    const db = getDatabase()
    
    const transaction = db.transaction(() => {
      for (const id of ids) {
        const music = db.prepare('SELECT * FROM music WHERE id = ?').get(id)
        if (music && music.file_path && fs.existsSync(music.file_path)) {
          fs.unlinkSync(music.file_path)
        }
        db.prepare('DELETE FROM playlist_songs WHERE music_id = ?').run(id)
        db.prepare('DELETE FROM music WHERE id = ?').run(id)
      }
    })
    
    transaction()
    
    res.json({ message: '删除成功', count: ids.length })
  } catch (error) {
    console.error('批量删除失败:', error)
    res.status(500).json({ message: '服务器错误' })
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
          m1.id, m1.title, m1.artist, m1.album, m1.duration, m1.file_size, m1.created_at,
          m1.file_path,
          (SELECT COUNT(*) FROM music m2 WHERE 
            LOWER(TRIM(m2.title)) = LOWER(TRIM(m1.title)) AND 
            (LOWER(TRIM(m2.artist)) = LOWER(TRIM(m1.artist)) OR (m2.artist IS NULL AND m1.artist IS NULL))
          ) as duplicate_count
        FROM music m1
        WHERE m1.id IN (
          SELECT MIN(m3.id) FROM music m3 
          WHERE EXISTS (
            SELECT 1 FROM music m4 WHERE m4.id != m3.id AND 
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
          SELECT id, title, artist, album, duration, file_size, created_at, file_path
          FROM music
          WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND 
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
    console.error('查找重复音乐失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 删除重复音乐（保留最早添加的）
router.post('/remove-duplicates', authenticateToken, async (req, res) => {
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
      GROUP BY title_key, artist_key
      HAVING COUNT(*) > 1
    `).all()
    
    let deletedCount = 0
    const deletedFiles = []
    
    const transaction = db.transaction(() => {
      for (const group of duplicateGroups) {
        // 获取要删除的歌曲（保留 ID 最小的）
        const toDelete = db.prepare(`
          SELECT id, file_path FROM music
          WHERE LOWER(TRIM(title)) = ? AND LOWER(TRIM(COALESCE(artist, ''))) = ?
          AND id != ?
        `).all(group.title_key, group.artist_key, group.keep_id)
        
        for (const song of toDelete) {
          // 从歌单中移除
          db.prepare('DELETE FROM playlist_songs WHERE music_id = ?').run(song.id)
          // 删除音乐记录
          db.prepare('DELETE FROM music WHERE id = ?').run(song.id)
          deletedCount++
          
          // 记录文件路径，稍后删除
          if (song.file_path && fs.existsSync(song.file_path)) {
            deletedFiles.push(song.file_path)
          }
        }
      }
    })
    
    transaction()
    
    // 删除文件
    for (const filePath of deletedFiles) {
      try {
        fs.unlinkSync(filePath)
        console.log(`[去重] 删除文件: ${filePath}`)
      } catch (e) {
        console.error(`[去重] 删除文件失败: ${filePath}`, e.message)
      }
    }
    
    res.json({ 
      message: '去重完成',
      deletedCount,
      filesDeleted: deletedFiles.length
    })
  } catch (error) {
    console.error('删除重复音乐失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 播放音乐（返回文件流）
router.get('/play/:id', async (req, res) => {
  try {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ message: '需要认证' })
    }

    const jwt = await import('jsonwebtoken')
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET || 'your-secret-key')

    const db = getDatabase()
    const music = db.prepare('SELECT * FROM music WHERE id = ?').get(req.params.id)

    if (!music) {
      return res.status(404).json({ message: '音乐不存在' })
    }

    const filePath = music.file_path
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const ext = path.extname(filePath).toLowerCase()
    const contentType = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ape': 'audio/ape'
    }[ext] || 'audio/mpeg'

    // 支持 Range 请求（用于拖动进度条）
    const stat = fs.statSync(filePath)
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      })

      const readStream = fs.createReadStream(filePath, { start, end })
      readStream.pipe(res)
    } else {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', fileSize)
      const readStream = fs.createReadStream(filePath)
      readStream.pipe(res)
    }
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: '认证失败' })
    }
    console.error('播放失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// ========== 歌单管理 ==========

// 获取歌单列表
router.get('/playlists', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = p.id) as song_count
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
router.post('/playlists', authenticateToken, async (req, res) => {
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
router.delete('/playlists/:id', authenticateToken, async (req, res) => {
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
    // 添加 has_cover 标志位
    if (columnNames.includes('cover_image')) {
      selectFields.push("CASE WHEN m.cover_image IS NOT NULL AND m.cover_image != '' THEN 1 ELSE 0 END as has_cover")
    }
    selectFields.push('m.created_at', 'm.updated_at', 'ps.sort_order', 'ps.added_at')
    
    const rows = db.prepare(`
      SELECT ${selectFields.join(', ')}
      FROM music m
      JOIN playlist_songs ps ON m.id = ps.music_id
      WHERE ps.playlist_id = ?
      ORDER BY ps.sort_order
    `).all(req.params.id)
    
    const songs = rows.map(row => ({
      ...row,
      created_at: convertToUTC8(row.created_at),
      updated_at: convertToUTC8(row.updated_at),
      added_at: convertToUTC8(row.added_at)
    }))
    
    res.json({ data: songs })
  } catch (error) {
    console.error('获取歌单歌曲失败:', error)
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
router.delete('/playlists/:id/songs/:songId', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND music_id = ?').run(
      parseInt(req.params.id),
      parseInt(req.params.songId)
    )
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

    res.json({ message: '移除成功', count: songIds.length })
  } catch (error) {
    console.error('批量移除失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 歌单歌曲排序
router.put('/playlists/:id/songs/reorder', authenticateToken, async (req, res) => {
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

// ========== 歌词管理 ==========

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

// ========== 网易云音乐 ==========
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

async function searchNeteaseMusic(title, artist) {
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

async function getNeteaseLyric(songId) {
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
    console.error('[网易云音乐] 获取歌词失败:', error.message)
    return null
  }
}

// ========== QQ音乐 ==========
const QQ_MUSIC_API_BASE = 'https://c.y.qq.com/soso/fcgi-bin'

async function searchQQMusic(title, artist) {
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
    console.error('[QQ音乐] 搜索失败:', error.message)
    return null
  }
}

async function getQQMusicLyric(songMid) {
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
    console.error('[QQ音乐] 获取歌词失败:', error.message)
    return null
  }
}

// ========== 酷狗音乐 ==========
const KUGOU_API_BASE = 'https://songsearch.kugou.com'

async function searchKugouMusic(title, artist) {
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
    console.error('[酷狗音乐] 搜索失败:', error.message)
    return null
  }
}

async function getKugouLyric(hash) {
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
    console.error('[酷狗音乐] 获取歌词失败:', error.message)
    return null
  }
}

// 搜索歌词（按优先级尝试多个歌词源）
async function searchLyricsFromSources(title, artist) {
  console.log(`[歌词搜索] 开始搜索: ${title} - ${artist || '未知'}`)

  // 按优先级顺序尝试每个歌词源
  for (const source of LYRIC_SOURCES) {
    try {
      console.log(`[歌词搜索] 尝试 ${source.name}...`)

      const songInfo = await source.search(title, artist)

      if (songInfo) {
        console.log(`[${source.name}] 找到歌曲: ${songInfo.name} - ${songInfo.artists}`)

        const lyric = await source.getLyric(songInfo.id || songInfo.hash)

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

    res.json({
      success: true,
      source: result.source,
      lyrics: result.lrc
    })
  } catch (error) {
    console.error('搜索歌词失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 批量下载歌词（异步任务）
router.post('/lyrics/batch-download', authenticateToken, async (req, res) => {
  try {
    const { musicIds, force = false } = req.body

    if (!musicIds || !Array.isArray(musicIds)) {
      return res.status(400).json({ message: '无效的音乐ID列表' })
    }

    // 生成任务ID
    const taskId = `lyric_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // 初始化任务状态
    const task = {
      id: taskId,
      status: 'pending',
      progress: 0,
      total: musicIds.length,
      success: 0,
      failed: 0,
      results: [],
      startTime: Date.now()
    }

    lyricTasks.set(taskId, task)

    // 立即返回任务ID
    res.json({
      success: true,
      taskId,
      message: `开始下载 ${musicIds.length} 首歌曲的歌词`
    })

    // 异步执行下载任务
    executeLyricDownloadTask(taskId, musicIds, force)

  } catch (error) {
    console.error('批量下载歌词失败:', error)
    res.status(500).json({ message: '服务器错误', error: error.message })
  }
})

// 异步执行歌词下载任务
async function executeLyricDownloadTask(taskId, musicIds, force = false) {
  const task = lyricTasks.get(taskId)
  if (!task) return

  const db = getDatabase()

  // 检查数据库字段
  const columns = db.prepare("PRAGMA table_info(music)").all()
  const columnNames = columns.map(c => c.name)

  const hasLyricsField = columnNames.includes('lyrics')
  const hasLyricsSourceField = columnNames.includes('lyrics_source')
  const hasHasLyricsField = columnNames.includes('has_lyrics')

  if (!hasLyricsField) {
    task.status = 'failed'
    task.error = '数据库未升级'
    return
  }

  task.status = 'running'

  for (let i = 0; i < musicIds.length; i++) {
    const musicId = musicIds[i]

    try {
      // 获取音乐信息（包含歌词状态）
      const music = db.prepare('SELECT id, title, artist, lyrics, has_lyrics FROM music WHERE id = ?').get(musicId)

      if (!music) {
        task.failed++
        task.results.push({ musicId, success: false, error: '音乐不存在' })
        task.progress = i + 1
        continue
      }

      // 跳过已有歌词的歌曲（除非强制下载）
      if (!force && (music.has_lyrics || music.lyrics)) {
        console.log(`[歌词下载] 跳过已有歌词: ${music.title} - ${music.artist}`)
        task.skipped = (task.skipped || 0) + 1
        task.results.push({ musicId, success: true, skipped: true, reason: '已有歌词' })
        task.progress = i + 1
        continue
      }

      // 搜索歌词
      const searchResult = await searchLyricsFromSources(music.title, music.artist || '')

      if (searchResult && searchResult.lrc) {
        // 更新数据库
        const updateFields = ['lyrics = ?', 'lyrics_updated_at = CURRENT_TIMESTAMP']
        const params = [searchResult.lrc]

        if (hasLyricsSourceField) {
          updateFields.push('lyrics_source = ?')
          params.push(searchResult.source)
        }

        if (hasHasLyricsField) {
          updateFields.push('has_lyrics = 1')
        }

        params.push(musicId)

        db.prepare(`
          UPDATE music
          SET ${updateFields.join(', ')}
          WHERE id = ?
        `).run(...params)

        task.success++
        task.results.push({
          musicId,
          success: true,
          title: music.title,
          artist: music.artist,
          source: searchResult.source
        })
        console.log(`[歌词下载] 成功: ${music.title}`)
      } else {
        task.failed++
        task.results.push({
          musicId,
          success: false,
          title: music.title,
          artist: music.artist,
          error: '未找到歌词'
        })
      }

      task.progress = i + 1

    } catch (err) {
      task.failed++
      task.results.push({ musicId, success: false, error: err.message })
      task.progress = i + 1
    }
  }

  // 任务完成
  task.status = 'completed'
  task.endTime = Date.now()
  console.log(`[任务完成] 成功: ${task.success}, 失败: ${task.failed}`)
}

// 查询歌词下载任务进度
router.get('/lyrics/task/:taskId', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params
    const task = lyricTasks.get(taskId)

    if (!task) {
      return res.status(404).json({ message: '任务不存在' })
    }

    res.json({
      success: true,
      task: {
        id: task.id,
        status: task.status,
        progress: task.progress,
        total: task.total,
        success: task.success,
        failed: task.failed,
        results: task.results,
        startTime: task.startTime,
        endTime: task.endTime
      }
    })

  } catch (error) {
    console.error('查询任务失败:', error)
    res.status(500).json({ message: '服务器错误' })
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
router.put('/:id/lyrics', authenticateToken, async (req, res) => {
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
router.post('/clean-sample-lyrics', authenticateToken, async (req, res) => {
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

export default router
