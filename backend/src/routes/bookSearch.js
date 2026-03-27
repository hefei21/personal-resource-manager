import express from 'express'
import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'

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

// Anna's Archive 搜索
async function searchAnnaArchive(keyword, domain) {
  const httpsAgent = createProxyAgent()
  const baseUrl = `https://${domain}`
  
  try {
    // Anna's Archive 搜索 URL 格式
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(keyword)}`
    
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
    
    // 解析搜索结果（根据实际页面结构调整选择器）
    $('a[href*="/md5/"]').each((index, element) => {
      const $el = $(element)
      const href = $el.attr('href')
      const title = $el.text().trim() || $el.find('.truncate').text().trim()
      
      if (title && href) {
        results.push({
          title,
          link: `${baseUrl}${href}`,
          source: 'anna-archive'
        })
      }
    })
    
    // 如果上面没找到，尝试其他选择器
    if (results.length === 0) {
      $('.item, .result, tr[class*="item"]').each((index, element) => {
        const $el = $(element)
        const titleLink = $el.find('a[href*="/md5/"]')
        const title = titleLink.text().trim() || $el.find('.title, .name').text().trim()
        const href = titleLink.attr('href')
        
        // 获取格式信息
        const format = $el.find('.format, .extension').text().trim()
        const size = $el.find('.size').text().trim()
        const lang = $el.find('.lang, .language').text().trim()
        
        if (title && href) {
          results.push({
            title,
            link: `${baseUrl}${href}`,
            format: format || 'Unknown',
            size: size || 'Unknown',
            language: lang || 'Unknown',
            source: 'anna-archive'
          })
        }
      })
    }
    
    return results
  } catch (error) {
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
      
      if (title && (magnetLink || torrentLink)) {
        results.push({
          title,
          link: detailUrl ? `${baseUrl}${detailUrl}` : '',
          magnetLink: magnetLink || null,
          torrentLink: torrentLink ? `${baseUrl}${torrentLink}` : null,
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

// 统一搜索接口
router.get('/search', async (req, res) => {
  const { keyword, source = 'all' } = req.query
  
  if (!keyword) {
    return res.status(400).json({
      success: false,
      message: '请提供搜索关键词'
    })
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
  
  res.json({
    success: true,
    keyword,
    total: totalResults,
    data: results
  })
})

export default router
