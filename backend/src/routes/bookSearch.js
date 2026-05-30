import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import { scraperLimiter } from '../middlewares/security.js'
import { cache, CacheTTL } from '../utils/cache.js'

const router = express.Router()

// 配置文件路径
const CONFIG_PATH = process.env.DATA_PATH 
  ? path.join(process.env.DATA_PATH, 'booksearch-config.json')
  : path.join(process.cwd(), 'data', 'booksearch-config.json')

// 默认配置
const DEFAULT_CONFIG = {
  annaArchiveDomain: 'annas-archive.gl',
  nyaaDomain: 'nyaa.si',
  lastUpdated: new Date().toISOString()
}

// 读取配置
function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8')
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
    }
  } catch (error) {
    console.error('读取电子书搜索配置失败:', error.message)
  }
  return DEFAULT_CONFIG
}

// 保存配置
function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...config,
      lastUpdated: new Date().toISOString()
    }, null, 2))
    return true
  } catch (error) {
    console.error('保存电子书搜索配置失败:', error.message)
    return false
  }
}

// 创建代理 agent
function createProxyAgent() {
  const proxyUrl = process.env.HTTP_PROXY
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
}

// 测试域名可用性
async function testDomain(domain) {
  try {
    const httpsAgent = createProxyAgent()
    const response = await axios.get(`https://${domain}`, {
      httpsAgent,
      timeout: 10000,
      validateStatus: () => true
    })
    return response.status === 200
  } catch (error) {
    return false
  }
}

// 获取配置
router.get('/config', (req, res) => {
  const config = getConfig()
  res.json({
    success: true,
    data: config
  })
})

// 更新配置
router.put('/config', (req, res) => {
  const { annaArchiveDomain, nyaaDomain } = req.body
  const config = getConfig()
  
  if (annaArchiveDomain) config.annaArchiveDomain = annaArchiveDomain
  if (nyaaDomain) config.nyaaDomain = nyaaDomain
  
  if (saveConfig(config)) {
    res.json({
      success: true,
      message: '配置保存成功',
      data: config
    })
  } else {
    res.status(500).json({
      success: false,
      message: '配置保存失败'
    })
  }
})

// 测试域名连通性
router.get('/test-domain', async (req, res) => {
  const { domain } = req.query
  
  if (!domain) {
    return res.status(400).json({
      success: false,
      message: '请提供域名'
    })
  }
  
  const available = await testDomain(domain)
  res.json({
    success: true,
    domain,
    available,
    message: available ? '域名可访问' : '域名无法访问，请更换'
  })
})

// 从标题中提取文件格式
function extractFormatFromTitle(title) {
  // 常见的电子书格式
  const formats = ['epub', 'mobi', 'pdf', 'azw3', 'azw', 'txt', 'rtf', 'djvu', 'fb2', 'cbz', 'cbr', 'cb7']
  // 常见的漫画/图像格式
  const imageFormats = ['cbz', 'cbr', 'cb7', 'zip', 'rar', '7z']
  
  const lowerTitle = title.toLowerCase()
  
  // 方括号中提取 [EPUB] [PDF]
  const bracketMatch = title.match(/\[(epub|mobi|pdf|azw3?|txt|rtf|djvu|fb2|cbz|cbr|cb7|zip|rar|7z)\]/i)
  if (bracketMatch) {
    return bracketMatch[1].toUpperCase()
  }
  
  // 圆括号中提取 (EPUB) (PDF)
  const parenMatch = title.match(/\((epub|mobi|pdf|azw3?|txt|rtf|djvu|fb2|cbz|cbr|cb7|zip|rar|7z)\)/i)
  if (parenMatch) {
    return parenMatch[1].toUpperCase()
  }
  
  // 从标题末尾提取 .epub .pdf
  const extMatch = title.match(/\.(epub|mobi|pdf|azw3?|txt|rtf|djvu|fb2|cbz|cbr|cb7)$/i)
  if (extMatch) {
    return extMatch[1].toUpperCase()
  }
  
  // 检查标题中是否包含格式关键字
  for (const fmt of formats) {
    if (lowerTitle.includes(fmt)) {
      // 检查是否是独立的格式词（不是单词的一部分）
      const regex = new RegExp(`\\b${fmt}\\b`, 'i')
      if (regex.test(title)) {
        return fmt.toUpperCase()
      }
    }
  }
  
  return null
}

// Anna's Archive 搜索
async function searchAnnaArchive(keyword, domain) {
  const httpsAgent = createProxyAgent()
  const baseUrl = `https://${domain}`
  
  try {
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(keyword)}`
    console.log(`[Anna's Archive] 搜索: ${keyword}`)
    
    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    
    const $ = cheerio.load(response.data)
    const results = []
    
    // 调试：输出页面HTML片段（前2000字符）
    console.log('[Anna\'s Archive] 页面HTML长度:', response.data.length)
    
    // 查找所有MD5链接
    const md5Links = $('a[href*="/md5/"]')
    console.log(`[Anna's Archive] 找到 ${md5Links.length} 个MD5链接`)
    
    md5Links.each((index, element) => {
      const $link = $(element)
      const href = $link.attr('href')
      const title = $link.text().trim()
      
      if (!title || !href || title.length < 3) return
      
      let format = 'Unknown'
      let size = 'Unknown'
      let lang = 'Unknown'
      
      // 直接从链接向上查找包含元数据的div（class="text-gray-800..."）
      // HTML结构：链接的父容器中有 <div class="text-gray-800...">English [en] · AZW · 0.7MB · 2018 · ...</div>
      let $metadataDiv = null
      let $parent = $link.parent()
      
      // 向上查找，最多6层，找包含元数据的div
      for (let i = 0; i < 8 && $parent.length; i++) {
        // 查找该父元素下的所有 div.text-gray-800
        const $found = $parent.find('div.text-gray-800, div.dark\\:text-slate-400')
        if ($found.length) {
          $metadataDiv = $found.first()
          break
        }
        $parent = $parent.parent()
      }
      
      if ($metadataDiv) {
        const metadataText = $metadataDiv.text().trim()
        
        if (index < 3) {
          console.log(`\n[Anna's Archive] 结果 #${index + 1}:`)
          console.log('  标题:', title.substring(0, 50))
          console.log('  元数据文本:', metadataText.substring(0, 150))
        }
        
        // 元数据格式：Language [code] · FORMAT · SIZE · YEAR · EMOJI TYPE · ...
        // 使用正则匹配，\s 匹配包括 &nbsp; 转换的 \u00A0
        // 注意：可能有多个语言，如：Chinese [zh] · English [en] · PDF · 148.3MB · 2014
        const metadataPattern = /([\w\s]+)\s*\[([a-z]{2,3})\].*?·\s*(EPUB|MOBI|PDF|AZW3?|AZW|TXT|DJVU|FB2|CBZ|CBR)\s*·\s*(\d+\.?\d*)\s*(MB|GB|KB)/i
        const metadataMatch = metadataText.match(metadataPattern)
        
        if (metadataMatch) {
          const langName = metadataMatch[1].trim()
          const langCode = metadataMatch[2].toLowerCase()
          format = metadataMatch[3].toUpperCase()
          size = `${metadataMatch[4]} ${metadataMatch[5].toUpperCase()}`
          
          // 语言映射
          const langMap = {
            'chinese': '中文', 'zh': '中文',
            'english': '英文', 'en': '英文',
            'japanese': '日文', 'ja': '日文',
            'spanish': '西班牙文', 'es': '西班牙文',
            'french': '法文', 'fr': '法文',
            'german': '德文', 'de': '德文',
            'russian': '俄文', 'ru': '俄文'
          }
          lang = langMap[langName.toLowerCase()] || langMap[langCode] || langName
          
          if (index < 3) {
            console.log('  [匹配成功]', { format, size, lang })
          }
        }
        
        // 提取所有语言（可能有多个）
        if (lang === 'Unknown') {
          const langMatches = metadataText.matchAll(/([\w\s]+)\s*\[([a-z]{2,3})\]/gi)
          const langs = []
          for (const match of langMatches) {
            const langName = match[1].trim()
            const langCode = match[2].toLowerCase()
            
            const langMap = {
              'chinese': '中文', 'zh': '中文',
              'english': '英文', 'en': '英文',
              'japanese': '日文', 'ja': '日文',
              'spanish': '西班牙文', 'es': '西班牙文',
              'french': '法文', 'fr': '法文',
              'german': '德文', 'de': '德文',
              'russian': '俄文', 'ru': '俄文'
            }
            
            const mappedLang = langMap[langName.toLowerCase()] || langMap[langCode]
            if (mappedLang && !langs.includes(mappedLang)) {
              langs.push(mappedLang)
            }
          }
          if (langs.length > 0) {
            lang = langs.join(' / ')
          }
        }
      } else if (index < 3) {
        console.log(`\n[Anna's Archive] 结果 #${index + 1}:`)
        console.log('  标题:', title.substring(0, 50))
        console.log('  未找到元数据div')
      }
      
      // 备用方法：从标题推断格式
      if (format === 'Unknown') {
        format = extractFormatFromTitle(title) || 'Unknown'
      }
      
      // 处理链接
      const fullHref = href.startsWith('/') ? `${baseUrl}${href}` : href
      
      // 避免重复
      const isDuplicate = results.some(r => r.title === title)
      if (!isDuplicate) {
        results.push({
          title: title.substring(0, 200),
          link: fullHref,
          format,
          size,
          language: lang,
          source: 'anna-archive'
        })
      }
    })
    
    console.log(`\n[Anna's Archive] 找到 ${results.length} 条结果`)
    
    // 输出前5条结果
    if (results.length > 0) {
      console.log('[Anna\'s Archive] 示例结果:', results.slice(0, 5).map(r => ({
        title: r.title.substring(0, 30),
        format: r.format,
        size: r.size,
        lang: r.language
      })))
    }
    
    return results.slice(0, 50)
  } catch (error) {
    console.error('[Anna\'s Archive] 搜索失败:', error.message)
    throw new Error(`Anna's Archive 搜索失败: ${error.message}`)
  }
}

// Nyaa 搜索（轻小说/漫画）
async function searchNyaa(keyword, domain) {
  const httpsAgent = createProxyAgent()
  const baseUrl = `https://${domain}`
  
  try {
    // Nyaa 搜索 URL（Literature 分类）
    const searchUrl = `${baseUrl}/?f=0&c=3_0&q=${encodeURIComponent(keyword)}`
    
    const response = await axios.get(searchUrl, {
      httpsAgent,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })
    
    const $ = cheerio.load(response.data)
    const results = []
    
    // 解析 Nyaa 搜索结果
    $('tr.default, tr.success, tr.danger').each((index, element) => {
      const $el = $(element)
      const titleLink = $el.find('td:nth-child(2) a:last-child')
      const title = titleLink.attr('title') || titleLink.text().trim()
      const detailUrl = titleLink.attr('href')
      
      // 获取磁力链接
      const magnetLink = $el.find('a[href^="magnet:"]').attr('href')
      const torrentLink = $el.find('a[href$=".torrent"]').attr('href')
      
      // 获取大小、日期等信息
      const size = $el.find('td:nth-child(4)').text().trim()
      const date = $el.find('td:nth-child(5)').text().trim()
      const seeders = $el.find('td:nth-child(6)').text().trim()
      const leechers = $el.find('td:nth-child(7)').text().trim()
      const downloads = $el.find('td:nth-child(8)').text().trim()
      
      // 从标题提取文件格式
      const format = extractFormatFromTitle(title)
      
      if (title && (magnetLink || torrentLink)) {
        results.push({
          title,
          link: detailUrl ? `${baseUrl}${detailUrl}` : '',
          magnetLink: magnetLink || null,
          torrentLink: torrentLink ? `${baseUrl}${torrentLink}` : null,
          format: format || 'Torrent',
          size,
          date,
          seeders,
          leechers,
          downloads,
          source: 'nyaa'
        })
      }
    })
    
    return results
  } catch (error) {
    throw new Error(`Nyaa 搜索失败: ${error.message}`)
  }
}

// 统一搜索接口 - 应用爬虫速率限制
router.get('/search', scraperLimiter, async (req, res) => {
  const { keyword, source = 'all' } = req.query
  
  if (!keyword) {
    return res.status(400).json({
      success: false,
      message: '请提供搜索关键词'
    })
  }
  
  // 尝试从缓存获取
  const cacheKey = `bookSearch:${keyword}:${source}`
  const cached = await cache.get(cacheKey)
  if (cached) {
    return res.json(cached)
  }
  
  const config = getConfig()
  const results = {
    annaArchive: [],
    nyaa: [],
    errors: []
  }
  
  // 并行搜索
  const searchPromises = []
  
  if (source === 'all' || source === 'anna-archive') {
    searchPromises.push(
      searchAnnaArchive(keyword, config.annaArchiveDomain)
        .then(data => { results.annaArchive = data })
        .catch(error => { results.errors.push(error.message) })
    )
  }
  
  if (source === 'all' || source === 'nyaa') {
    searchPromises.push(
      searchNyaa(keyword, config.nyaaDomain)
        .then(data => { results.nyaa = data })
        .catch(error => { results.errors.push(error.message) })
    )
  }
  
  await Promise.all(searchPromises)
  
  const totalResults = results.annaArchive.length + results.nyaa.length
  
  const response = {
    success: true,
    keyword,
    total: totalResults,
    data: results
  }
  
  // 缓存结果（30分钟）
  await cache.set(cacheKey, response, CacheTTL.LONG)
  
  res.json(response)
})

export default router
