import sharp from 'sharp'

/**
 * 压缩图片（保持清晰度）
 * @param {Buffer} imageBuffer - 原始图片 Buffer
 * @param {Object} options - 压缩选项
 * @param {number} options.maxWidth - 最大宽度（默认 500）
 * @param {number} options.maxHeight - 最大高度（默认 500）
 * @param {number} options.quality - 质量 1-100（默认 85）
 * @returns {Promise<Buffer>} 压缩后的图片 Buffer
 */
export async function compressImage(imageBuffer, options = {}) {
  const { maxWidth = 500, maxHeight = 500, quality = 85 } = options
  
  try {
    const image = sharp(imageBuffer)
    const metadata = await image.metadata()
    
    // 如果图片已经很小，不压缩
    if (metadata.width <= maxWidth && metadata.height <= maxHeight) {
      // 但仍然应用质量压缩
      if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
        return await image.jpeg({ quality, mozjpeg: true }).toBuffer()
      } else if (metadata.format === 'png') {
        return await image.png({ quality, compressionLevel: 8 }).toBuffer()
      } else if (metadata.format === 'webp') {
        return await image.webp({ quality }).toBuffer()
      }
      return imageBuffer
    }
    
    // 调整大小并压缩
    let compressedImage = image.resize(maxWidth, maxHeight, {
      fit: 'inside', // 保持宽高比，不超过指定尺寸
      withoutEnlargement: true // 不放大小图
    })
    
    // 根据格式应用压缩
    if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
      compressedImage = compressedImage.jpeg({ quality, mozjpeg: true })
    } else if (metadata.format === 'png') {
      compressedImage = compressedImage.png({ quality, compressionLevel: 8 })
    } else if (metadata.format === 'webp') {
      compressedImage = compressedImage.webp({ quality })
    } else {
      // 其他格式转为 JPEG
      compressedImage = compressedImage.jpeg({ quality, mozjpeg: true })
    }
    
    const result = await compressedImage.toBuffer()
    
    console.log(`[图片压缩] ${metadata.width}x${metadata.height} -> 压缩后 ${result.length} 字节 (原 ${imageBuffer.length} 字节)`)
    
    return result
  } catch (error) {
    console.error('[图片压缩] 压缩失败:', error.message)
    return imageBuffer // 压缩失败返回原图
  }
}

/**
 * 压缩 Base64 图片
 * @param {string} base64Data - Base64 编码的图片（可能包含 data:image/xxx;base64, 前缀）
 * @param {Object} options - 压缩选项
 * @returns {Promise<string>} 压缩后的 Base64 图片
 */
export async function compressBase64Image(base64Data, options = {}) {
  try {
    // 提取 MIME 类型
    const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!matches) {
      console.warn('[图片压缩] 无效的 Base64 格式')
      return base64Data
    }
    
    const mimeType = matches[1]
    const base64String = matches[2]
    
    // 转换为 Buffer
    const imageBuffer = Buffer.from(base64String, 'base64')
    
    // 压缩
    const compressedBuffer = await compressImage(imageBuffer, options)
    
    // 转回 Base64
    const compressedBase64 = compressedBuffer.toString('base64')
    
    // 返回带前缀的完整字符串
    // 根据压缩后的格式确定 MIME 类型
    const outputMimeType = detectMimeType(compressedBuffer) || `image/${mimeType}`
    
    return `data:${outputMimeType};base64,${compressedBase64}`
  } catch (error) {
    console.error('[图片压缩] Base64 压缩失败:', error.message)
    return base64Data
  }
}

/**
 * 检测图片 MIME 类型
 */
function detectMimeType(buffer) {
  if (buffer.length < 4) return null
  
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png'
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg'
  }
  // WebP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return 'image/webp'
  }
  
  return null
}
