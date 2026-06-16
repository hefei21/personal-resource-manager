import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { exec, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import axios from 'axios'
import { cache, CacheTTL } from '../utils/cache.js'

const router = express.Router()
const execAsync = promisify(exec)

// 代码存储目录
const CODE_BASE_PATH = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')

// 确保代码目录存在
if (!fs.existsSync(CODE_BASE_PATH)) {
  fs.mkdirSync(CODE_BASE_PATH, { recursive: true })
}

// 获取文件原始内容（用于图片等）- 不需要认证，因为只是返回静态资源
// 安全性由路径检查保证（必须在仓库目录内）
router.get('/:id/raw/:path(*)', async (req, res) => {
  console.log('==== RAW 接口被调用 ====')
  console.log('originalUrl:', req.originalUrl)
  console.log('url:', req.url)
  console.log('params:', req.params)
  console.log('path参数:', req.params.path)
  try {
    const db = getDatabase()
    // 使用命名参数 :path(*) 捕获路径
    let relativePath = req.params.path || ''
    // 去掉查询参数
    relativePath = relativePath.split('?')[0]
    relativePath = decodeURIComponent(relativePath)
    console.log('提取的文件路径:', relativePath)
    
    const repo = db.prepare('SELECT local_path FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 禁止路径中的 .. 和空字节（防止路径遍历）
    if (relativePath.includes('..') || relativePath.includes('\0')) {
      console.log('安全检查失败: 路径包含非法字符')
      return res.status(403).json({ message: '非法路径' })
    }

    // 将 URL 中的 / 转换为系统路径分隔符
    relativePath = relativePath.replace(/\//g, path.sep)
    
    console.log('请求图片路径:', relativePath, '仓库路径:', repo.local_path)
    
    // 使用 path.resolve 规范化路径，防止路径遍历
    const resolvedRepoPath = path.resolve(repo.local_path)
    const fullPath = path.resolve(path.join(resolvedRepoPath, relativePath))
    console.log('完整路径:', fullPath)
    
    // 安全检查：确保解析后的路径在仓库目录内
    const pathSeparator = path.sep
    if (!fullPath.startsWith(resolvedRepoPath + pathSeparator) && fullPath !== resolvedRepoPath) {
      console.log('安全检查失败: 路径不在仓库目录内')
      return res.status(403).json({ message: '非法路径' })
    }

    // 检查文件是否存在（同时检查符号链接）
    if (!fs.existsSync(fullPath)) {
      console.log('文件不存在:', fullPath)
      return res.status(404).json({ message: '文件不存在' })
    }

    // 检查是否是符号链接（防止通过软链接访问其他目录）
    try {
      const realPath = fs.realpathSync(fullPath)
      const resolvedRealPath = path.resolve(realPath)
      if (!resolvedRealPath.startsWith(resolvedRepoPath + pathSeparator) && 
          resolvedRealPath !== resolvedRepoPath) {
        console.log('安全检查失败: 符号链接指向仓库外部')
        return res.status(403).json({ message: '不能访问符号链接' })
      }
    } catch (e) {
      console.log('无法解析文件路径:', e.message)
      return res.status(403).json({ message: '无法访问该文件' })
    }

    const stats = fs.statSync(fullPath)
    if (stats.isDirectory()) {
      return res.status(400).json({ message: '不能读取目录内容' })
    }

    // 根据扩展名设置Content-Type
    const ext = path.extname(relativePath).toLowerCase()
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.html': 'text/html'
    }
    
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    // 禁用缓存，防止 404 被缓存
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    
    // 流式返回文件内容
    const stream = fs.createReadStream(fullPath)
    stream.pipe(res)
  } catch (error) {
    console.error('获取文件原始内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取仓库列表
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { keyword } = req.query
    const db = getDatabase()

    let sql = 'SELECT id, name, url, description, type, local_path, last_sync, languages, created_at FROM code_repositories WHERE 1=1'
    const params = []

    if (keyword) {
      sql += ' AND (name LIKE ? OR url LIKE ? OR description LIKE ?)'
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
    }

    sql += ' ORDER BY last_sync DESC, updated_at DESC'

    const stmt = db.prepare(sql)
    const rows = stmt.all(params)
    
    // 计算每个仓库的大小
    const reposWithSize = rows.map(repo => {
      let size = 0
      if (repo.local_path && fs.existsSync(repo.local_path)) {
        size = getDirectorySize(repo.local_path)
      }
      // 解析languages字段
      let languages = []
      if (repo.languages) {
        try {
          languages = JSON.parse(repo.languages)
        } catch (e) {}
      }
      return { ...repo, size, languages }
    })
    
    res.json({ data: reposWithSize, total: reposWithSize.length })
  } catch (error) {
    console.error('获取代码仓库列表失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 计算目录大小
function getDirectorySize(dirPath) {
  let size = 0
  try {
    const files = fs.readdirSync(dirPath)
    for (const file of files) {
      const filePath = path.join(dirPath, file)
      try {
        const stats = fs.statSync(filePath)
        if (stats.isDirectory()) {
          // 跳过 .git 目录（通常很大）
          if (file !== '.git' && file !== '.svn') {
            size += getDirectorySize(filePath)
          }
        } else {
          size += stats.size
        }
      } catch (e) {
        // 忽略无法访问的文件
      }
    }
  } catch (e) {
    // 忽略无法访问的目录
  }
  return size
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 创建代码仓库（克隆）
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, url, description, type = 'git' } = req.body
    const db = getDatabase()

    if (!name || !url) {
      return res.status(400).json({ message: '仓库名称和URL不能为空' })
    }

    // 检查是否已存在
    const existing = db.prepare('SELECT id FROM code_repositories WHERE url = ?').get(url)
    if (existing) {
      return res.status(400).json({ message: '该仓库URL已存在' })
    }

    // 生成本地路径
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const localPath = path.join(CODE_BASE_PATH, `${safeName}_${Date.now()}`)

    // 先保存到数据库
    const stmt = db.prepare(
      `INSERT INTO code_repositories (name, url, description, local_path, type) VALUES (?, ?, ?, ?, ?)`
    )
    const result = stmt.run(name, url, description, localPath, type)

    // 异步克隆仓库
    cloneRepository(result.lastInsertRowid, url, localPath, type, name)

    res.json({ 
      id: result.lastInsertRowid, 
      message: '仓库添加成功，正在后台克隆...',
      localPath 
    })
  } catch (error) {
    console.error('创建代码仓库失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 克隆任务管理器
const cloneTasks = new Map()
const syncTasks = new Map() // 同步任务进度跟踪

// 获取克隆任务状态
router.get('/:id/clone-status', authenticateToken, (req, res) => {
  const task = cloneTasks.get(req.params.id)
  if (!task) {
    return res.json({ status: 'unknown', message: '无克隆任务' })
  }
  res.json({ data: task })
})

// 从GitHub API获取仓库描述
router.get('/github-info', authenticateToken, async (req, res) => {
  try {
    const { url } = req.query
    if (!url) {
      return res.status(400).json({ message: 'URL不能为空' })
    }

    // 解析GitHub URL
    // 支持格式：https://github.com/user/repo 或 https://github.com/user/repo.git
    const githubMatch = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/)
    if (!githubMatch) {
      return res.status(400).json({ message: '不是有效的GitHub仓库URL' })
    }

    const [, owner, repo] = githubMatch

    // 尝试从缓存获取
    const cacheKey = `code:github:${owner}/${repo}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }

    // 调用GitHub API
    try {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}`
      const response = await axios.get(apiUrl, {
        timeout: 10000,
        headers: {
          'Accept': 'application/vnd.github.v3+json'
        }
      })

      const data = response.data
      
      // 获取语言统计
      let languages = {}
      try {
        const langResponse = await axios.get(`${apiUrl}/languages`, {
          timeout: 10000,
          headers: {
            'Accept': 'application/vnd.github.v3+json'
          }
        })
        const langData = langResponse.data
        
        // 计算百分比
        const total = Object.values(langData).reduce((sum, val) => sum + val, 0)
        if (total > 0) {
          languages = Object.entries(langData)
            .map(([lang, bytes]) => ({
              name: lang,
              percentage: Math.round((bytes / total) * 100)
            }))
            .sort((a, b) => b.percentage - a.percentage)
        }
      } catch (langError) {
        console.error('获取语言统计失败:', langError.message)
      }
      
      const result = {
        name: data.name,
        fullName: data.full_name,
        description: data.description || '',
        homepage: data.homepage || '',
        stars: data.stargazers_count,
        forks: data.forks_count,
        language: data.language,
        languages,
        topics: data.topics || [],
        defaultBranch: data.default_branch,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }

      // 缓存结果（30分钟）
      await cache.set(cacheKey, result, CacheTTL.VERY_LONG)

      res.json({ data: result })
    } catch (apiError) {
      console.error('GitHub API调用失败:', apiError.message)
      if (apiError.response?.status === 404) {
        return res.status(404).json({ message: 'GitHub仓库不存在或无法访问' })
      }
      if (apiError.response?.status === 403) {
        return res.status(403).json({ message: 'GitHub API限流，请稍后重试' })
      }
      throw apiError
    }
  } catch (error) {
    console.error('获取GitHub信息失败:', error)
    res.status(500).json({ message: '获取GitHub信息失败' })
  }
})

// 克隆仓库的异步函数（带进度）
async function cloneRepository(id, url, localPath, type, name) {
  const db = getDatabase()
  
  const task = {
    id: String(id),
    status: 'cloning',
    progress: 0,
    message: '准备克隆...',
    startTime: Date.now()
  }
  cloneTasks.set(String(id), task)
  
  try {
    console.log(`[仓库 ${name}] 开始克隆到 ${localPath}`)
    
    if (type === 'svn') {
      task.message = '正在 SVN checkout...'
      await execAsync(`svn checkout "${url}" "${localPath}"`, { timeout: 300000 })
      task.progress = 100
      task.message = 'SVN checkout 完成'
    } else {
      // git - 使用 spawn 获取实时进度
      await cloneGitWithProgress(url, localPath, task)
    }
    
    // 更新同步时间
    db.prepare('UPDATE code_repositories SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    
    // 获取并保存语言统计（如果是GitHub仓库）
    await fetchAndSaveLanguages(id, url)
    
    task.status = 'completed'
    task.message = '克隆完成'
    task.progress = 100
    console.log(`[仓库 ${name}] 克隆完成`)
  } catch (error) {
    console.error(`[仓库 ${name}] 克隆失败:`, error.message)
    task.status = 'failed'
    task.message = '克隆失败: ' + error.message
    // 克隆失败，清理目录
    try {
      fs.rmSync(localPath, { recursive: true, force: true })
    } catch (e) {}
    // 标记为失败状态
    try {
      db.prepare("UPDATE code_repositories SET description = description || ' [克隆失败]' WHERE id = ?").run(id)
    } catch (dbError) {
      console.error('更新失败状态失败:', dbError.message)
    }
  }
  
  // 10分钟后清理任务记录
  setTimeout(() => {
    cloneTasks.delete(String(id))
  }, 600000)
}

// Git 克隆带进度
function cloneGitWithProgress(url, localPath, task) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--progress', '--depth', '50', url, localPath]
    const proc = spawn('git', args)
    
    task.message = '正在连接服务器...'
    
    proc.stderr.on('data', (data) => {
      const output = data.toString()
      
      // 解析 git progress 输出
      if (output.includes('remote: Enumerating objects')) {
        task.message = '正在枚举对象...'
      } else if (output.includes('remote: Counting objects')) {
        const match = output.match(/Counting objects:\s*(\d+)%/)
        if (match) {
          task.progress = Math.round(parseInt(match[1]) * 0.3) // 30% 用于 counting
          task.message = `正在计数对象... ${match[1]}%`
        }
      } else if (output.includes('remote: Compressing objects')) {
        const match = output.match(/Compressing objects:\s*(\d+)%/)
        if (match) {
          task.progress = 30 + Math.round(parseInt(match[1]) * 0.2) // 20% 用于 compressing
          task.message = `正在压缩对象... ${match[1]}%`
        }
      } else if (output.includes('Receiving objects')) {
        const match = output.match(/Receiving objects:\s*(\d+)%/)
        if (match) {
          task.progress = 50 + Math.round(parseInt(match[1]) * 0.4) // 40% 用于 receiving
          task.message = `正在接收对象... ${match[1]}%`
        }
      } else if (output.includes('Resolving deltas')) {
        const match = output.match(/Resolving deltas:\s*(\d+)%/)
        if (match) {
          task.progress = 90 + Math.round(parseInt(match[1]) * 0.1) // 10% 用于 resolving
          task.message = `正在解析 deltas... ${match[1]}%`
        }
      }
    })
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Git clone 失败，退出码: ${code}`))
      }
    })
    
    proc.on('error', (err) => {
      reject(err)
    })
    
    // 5分钟超时
    setTimeout(() => {
      proc.kill()
      reject(new Error('克隆超时'))
    }, 300000)
  })
}

// 删除代码仓库
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 删除本地目录
    if (fs.existsSync(repo.local_path)) {
      fs.rmSync(repo.local_path, { recursive: true, force: true })
    }

    // 删除数据库记录
    db.prepare('DELETE FROM code_repositories WHERE id = ?').run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    console.error('删除代码仓库失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新代码仓库信息
router.put('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const { name, description } = req.body
    const db = getDatabase()
    
    if (!name) {
      return res.status(400).json({ message: '仓库名称不能为空' })
    }
    
    const repo = db.prepare('SELECT id FROM code_repositories WHERE id = ?').get(req.params.id)
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }
    
    db.prepare('UPDATE code_repositories SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(name, description, req.params.id)
    
    res.json({ message: '更新成功' })
  } catch (error) {
    console.error('更新代码仓库失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取文件树
router.get('/:id/tree', authenticateToken, async (req, res) => {
  try {
    let { path: relativePath = '' } = req.query
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path, type FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 将 URL 中的 / 转换为系统路径分隔符
    relativePath = relativePath.replace(/\//g, path.sep)

    const fullPath = path.join(repo.local_path, relativePath)
    
    // 安全检查：确保路径在仓库目录内
    if (!fullPath.startsWith(repo.local_path)) {
      return res.status(403).json({ message: '非法路径' })
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: '路径不存在' })
    }

    const stats = fs.statSync(fullPath)
    if (!stats.isDirectory()) {
      return res.status(400).json({ message: '不是目录' })
    }

    const items = fs.readdirSync(fullPath, { withFileTypes: true })
      .filter(item => !item.name.startsWith('.')) // 隐藏默认隐藏文件
      .map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        path: path.join(relativePath, item.name).replace(/\\/g, '/')
      }))
      .sort((a, b) => {
        // 目录在前，文件在后
        if (a.type === b.type) return a.name.localeCompare(b.name)
        return a.type === 'directory' ? -1 : 1
      })

    res.json({ data: items })
  } catch (error) {
    console.error('获取文件树失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取文件内容
router.get('/:id/file', authenticateToken, async (req, res) => {
  try {
    let { path: relativePath } = req.query
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    if (!relativePath) {
      return res.status(400).json({ message: '路径不能为空' })
    }
    
    // 将 URL 中的 / 转换为系统路径分隔符
    relativePath = relativePath.replace(/\//g, path.sep)

    const fullPath = path.join(repo.local_path, relativePath)
    
    // 安全检查
    if (!fullPath.startsWith(repo.local_path)) {
      return res.status(403).json({ message: '非法路径' })
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: '文件不存在' })
    }

    const stats = fs.statSync(fullPath)
    if (stats.isDirectory()) {
      return res.status(400).json({ message: '不能读取目录内容' })
    }

    // 限制文件大小（最大 1MB）
    if (stats.size > 1024 * 1024) {
      return res.status(400).json({ message: '文件过大，无法显示' })
    }

    // 检测文件类型
    const ext = path.extname(relativePath).toLowerCase()
    const isBinary = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.exe', '.dll', '.so', '.dylib', '.zip', '.tar', '.gz', '.rar', '.7z', '.pdf'].includes(ext)
    
    if (isBinary) {
      return res.json({ 
        data: {
          type: 'binary',
          name: path.basename(relativePath),
          size: stats.size
        }
      })
    }

    let content = fs.readFileSync(fullPath, 'utf-8')
    
    // 如果是 Markdown 文件，转换其中的图片路径为 base64
    if (ext === '.md' || ext === '.markdown') {
      console.log('处理 Markdown 文件图片路径:', relativePath)
      content = convertImagePathsToBase64(content, repo.local_path, fullPath)
    }
    
    res.json({ 
      data: {
        type: 'text',
        name: path.basename(relativePath),
        content,
        size: stats.size,
        extension: ext
      }
    })
  } catch (error) {
    console.error('获取文件内容失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取README内容（处理图片路径）
router.get('/:id/readme', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params
    
    // 尝试从缓存获取
    const cacheKey = `code:readme:${id}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[代码仓库] 命中README缓存: ${id}`)
      return res.json({ data: cached })
    }
    
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path, url FROM code_repositories WHERE id = ?').get(id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 查找 README 文件
    const readmeNames = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README.txt', 'readme.txt']
    let readmePath = null
    
    for (const name of readmeNames) {
      const fullPath = path.join(repo.local_path, name)
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        readmePath = fullPath
        break
      }
    }

    if (!readmePath) {
      return res.json({ data: null })
    }

    let content = fs.readFileSync(readmePath, 'utf-8')
    
    // 转换相对图片路径为 base64 data URL
    content = convertImagePathsToBase64(content, repo.local_path, readmePath)
    
    console.log('README 图片路径转换完成')
    
    const result = {
      name: path.basename(readmePath),
      content
    }
    
    // 缓存结果（10分钟）
    await cache.set(cacheKey, result, CacheTTL.MEDIUM)
    
    res.json({ data: result })
  } catch (error) {
    console.error('获取README失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 将图片转换为 base64 data URL
function imageToBase64(imagePath, repoPath, mdFilePath) {
  try {
    // 解码 URL 编码的路径
    let decodedPath = decodeURIComponent(imagePath)
    
    // 构建完整路径
    let fullPath = decodedPath
    if (!path.isAbsolute(decodedPath)) {
      // 如果有 md 文件路径，则相对于 md 文件所在目录
      // 否则相对于仓库根目录
      const basePath = mdFilePath ? path.dirname(mdFilePath) : repoPath
      
      // 处理相对路径：./path, ../path, /path, path
      fullPath = path.resolve(basePath, decodedPath)
    }
    
    // 规范化路径
    fullPath = path.normalize(fullPath)
    
    // 安全检查：确保路径在仓库目录内
    if (!fullPath.startsWith(repoPath)) {
      console.log('  -> 安全检查失败：路径不在仓库内', fullPath)
      return null
    }
    
    if (!fs.existsSync(fullPath)) {
      console.log('  -> 文件不存在:', fullPath)
      return null
    }
    
    // 读取文件并转为 base64
    const fileBuffer = fs.readFileSync(fullPath)
    const ext = path.extname(fullPath).toLowerCase()
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }
    const mimeType = mimeTypes[ext] || 'application/octet-stream'
    const base64 = fileBuffer.toString('base64')
    console.log('  -> 转换成功:', ext, mimeType, '大小:', fileBuffer.length)
    return `data:${mimeType};base64,${base64}`
  } catch (error) {
    console.log('  -> 转换失败:', error.message)
    return null
  }
}

// 转换 Markdown 中的相对图片路径为 base64 data URL
// mdFilePath: MD 文件的完整路径，用于解析相对路径
function convertImagePathsToBase64(content, repoPath, mdFilePath = null) {
  console.log('转换图片路径为base64, 仓库路径:', repoPath, 'MD文件:', mdFilePath, '内容长度:', content.length)
  
  let matchCount = 0
  
  // 处理 Markdown 图片 ![alt](path)
  content = content.replace(/!\[([^\]]*)\]\((.*?)\)/g, (match, alt, imagePath) => {
    imagePath = imagePath.trim()
    console.log('匹配到图片:', imagePath)
    
    // 如果已经是绝对 URL（http/https/data:），不做处理
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
      console.log('  -> 跳过：已是绝对URL')
      return match
    }
    
    // 转换为 base64 data URL
    const base64Url = imageToBase64(imagePath, repoPath, mdFilePath)
    if (base64Url) {
      matchCount++
      return `![${alt}](${base64Url})`
    } else {
      console.log('  -> 转换失败，保留原路径')
      return match
    }
  })
  
  // 处理 HTML 图片 <img src="path" />
  content = content.replace(/<img([^>]*)src=["']([^"']*)["']([^>]*)>/gi, (match, before, imagePath, after) => {
    imagePath = imagePath.trim()
    
    // 如果已经是绝对 URL，不做处理
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
      return match
    }
    
    const base64Url = imageToBase64(imagePath, repoPath, mdFilePath)
    if (base64Url) {
      matchCount++
      return `<img${before}src="${base64Url}"${after}>`
    }
    return match
  })
  
  console.log('共转换', matchCount, '个图片为base64')
  return content
}

// 获取提交历史
router.get('/:id/commits', authenticateToken, async (req, res) => {
  try {
    const { limit = 20 } = req.query
    const { id } = req.params
    
    // 尝试从缓存获取
    const cacheKey = `code:commits:${id}:${limit}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      console.log(`[代码仓库] 命中提交历史缓存: ${id}`)
      return res.json({ data: cached })
    }
    
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path, type FROM code_repositories WHERE id = ?').get(id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    if (!fs.existsSync(repo.local_path)) {
      return res.status(404).json({ message: '仓库尚未克隆完成' })
    }

    let commits = []

    if (repo.type === 'svn') {
      // SVN 日志
      try {
        const { stdout } = await execAsync(
          `svn log "${repo.local_path}" --limit ${limit}`,
          { timeout: 30000 }
        )
        commits = parseSvnLog(stdout)
      } catch (e) {
        commits = []
      }
    } else {
      // Git 日志
      try {
        const { stdout } = await execAsync(
          `git -C "${repo.local_path}" log --pretty=format:"%H|%an|%ad|%s" --date=format:'%Y-%m-%d %H:%M:%S' -n ${limit}`,
          { timeout: 30000 }
        )
        commits = stdout.split('\n').filter(line => line).map(line => {
          const [hash, author, date, ...messageParts] = line.split('|')
          return {
            hash: hash.substring(0, 7),
            fullHash: hash,
            author,
            date,
            message: messageParts.join('|')
          }
        })
      } catch (e) {
        commits = []
      }
    }

    // 缓存结果（5分钟）
    await cache.set(cacheKey, commits, CacheTTL.MEDIUM)
    
    res.json({ data: commits })
  } catch (error) {
    console.error('获取提交历史失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取单个提交的详情和代码变更
router.get('/:id/commit/:hash', authenticateToken, async (req, res) => {
  try {
    const { hash } = req.params
    
    // 尝试从缓存获取
    const cacheKey = `code:commit:${req.params.id}:${hash}`
    const cached = await cache.get(cacheKey)
    if (cached) {
      return res.json({ data: cached })
    }
    
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path, type FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    if (!fs.existsSync(repo.local_path)) {
      return res.status(404).json({ message: '仓库尚未克隆完成' })
    }

    let commitDetail = null

    if (repo.type === 'svn') {
      // SVN 提交详情
      try {
        const { stdout: logOut } = await execAsync(
          `svn log -v -r ${hash.replace('r', '')} "${repo.local_path}"`,
          { timeout: 30000 }
        )
        const { stdout: diffOut } = await execAsync(
          `svn diff -c ${hash.replace('r', '')} "${repo.local_path}"`,
          { timeout: 60000 }
        )
        commitDetail = {
          hash,
          diff: diffOut || '无变更内容',
          files: parseSvnChangedFiles(logOut)
        }
      } catch (e) {
        commitDetail = { hash, diff: '获取变更失败', files: [] }
      }
    } else {
      // Git 提交详情
      try {
        // 获取提交信息
        const { stdout: showOut } = await execAsync(
          `git -C "${repo.local_path}" show --stat --pretty=format:"%H|%an|%ad|%s" ${hash}`,
          { timeout: 30000 }
        )
        
        // 获取代码变更
        const { stdout: diffOut } = await execAsync(
          `git -C "${repo.local_path}" show --format="" ${hash}`,
          { timeout: 60000, maxBuffer: 1024 * 1024 * 5 }
        )
        
        // 解析变更文件列表
        const files = parseGitChangedFiles(showOut)
        
        commitDetail = {
          hash,
          diff: diffOut || '无变更内容',
          files
        }
      } catch (e) {
        console.error('获取Git提交详情失败:', e)
        commitDetail = { hash, diff: '获取变更失败', files: [] }
      }
    }

    // 缓存结果（10分钟）
    await cache.set(cacheKey, commitDetail, CacheTTL.MEDIUM)
    
    res.json({ data: commitDetail })
  } catch (error) {
    console.error('获取提交详情失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 解析 Git 变更文件列表
function parseGitChangedFiles(output) {
  const files = []
  const lines = output.split('\n')
  let inStats = false
  
  for (const line of lines) {
    if (line.includes('files changed') || line.includes('file changed')) {
      inStats = true
      continue
    }
    if (inStats) break
    
    // 匹配格式: " file1 | 10 ++--" 或 " file2 (new) | 50 ++++"
    const match = line.match(/^\s+(.+?)\s*\|\s*(\d+)/)
    if (match) {
      files.push({
        file: match[1].trim(),
        changes: parseInt(match[2])
      })
    }
  }
  
  return files
}

// 解析 SVN 变更文件列表
function parseSvnChangedFiles(logOutput) {
  const files = []
  const lines = logOutput.split('\n')
  let inChanges = false
  
  for (const line of lines) {
    if (line.includes('Changed paths:')) {
      inChanges = true
      continue
    }
    if (inChanges && line.trim() === '') {
      break
    }
    if (inChanges) {
      const match = line.trim().match(/^[AMD]\s+(.+)/)
      if (match) {
        files.push({ file: match[1] })
      }
    }
  }
  
  return files
}

// 解析 SVN 日志
function parseSvnLog(logOutput) {
  const commits = []
  const lines = logOutput.split('\n')
  let currentCommit = null
  
  for (const line of lines) {
    if (line.startsWith('r') && line.includes(' | ')) {
      const parts = line.split(' | ')
      if (parts.length >= 3) {
        currentCommit = {
          hash: parts[0].trim(),
          author: parts[1].trim(),
          date: parts[2].trim(),
          message: ''
        }
      }
    } else if (currentCommit && line.trim() && !line.startsWith('---')) {
      currentCommit.message += line.trim() + ' '
    } else if (line.startsWith('---') && currentCommit) {
      commits.push(currentCommit)
      currentCommit = null
    }
  }
  
  return commits.map(c => ({ ...c, message: c.message.trim() }))
}

// 手动同步仓库
router.post('/:id/sync', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const repo = db.prepare('SELECT * FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 初始化同步任务状态
    const taskId = String(repo.id)
    syncTasks.set(taskId, {
      id: taskId,
      status: 'syncing',
      message: '准备同步...',
      progress: 0,
      startTime: Date.now()
    })

    if (!fs.existsSync(repo.local_path)) {
      // 如果目录不存在，重新克隆
      syncTasks.get(taskId).message = '目录不存在，开始重新克隆...'
      cloneRepository(repo.id, repo.url, repo.local_path, repo.type, repo.name)
      return res.json({ message: '开始重新克隆仓库...', taskId })
    }

    // 异步更新仓库
    updateRepository(repo.id, repo.url, repo.local_path, repo.type, repo.name, taskId)

    res.json({ message: '开始同步仓库...', taskId })
  } catch (error) {
    console.error('同步仓库失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取同步状态
router.get('/:id/sync-status', authenticateToken, async (req, res) => {
  try {
    const taskId = String(req.params.id)
    const task = syncTasks.get(taskId)
    
    if (!task) {
      return res.json({ 
        data: { 
          status: 'idle', 
          message: '无同步任务' 
        } 
      })
    }
    
    res.json({ data: task })
  } catch (error) {
    console.error('获取同步状态失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 更新仓库的异步函数（带进度跟踪）
async function updateRepository(id, url, localPath, type, name, taskId) {
  const db = getDatabase()
  const task = syncTasks.get(taskId)
  
  try {
    console.log(`[仓库 ${name}] 开始同步`)
    
    if (task) {
      task.message = '正在同步...'
      task.progress = 30
    }
    
    if (type === 'svn') {
      await execAsync(`svn update "${localPath}"`, { timeout: 300000 })
    } else {
      await execAsync(`git -C "${localPath}" pull`, { timeout: 300000 })
    }
    
    if (task) {
      task.message = '同步完成，更新数据库...'
      task.progress = 80
    }
    
    db.prepare('UPDATE code_repositories SET last_sync = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    
    // 获取并保存语言统计（如果是GitHub仓库）
    await fetchAndSaveLanguages(id, url)
    
    console.log(`[仓库 ${name}] 同步完成`)
    
    if (task) {
      task.status = 'completed'
      task.message = '同步完成'
      task.progress = 100
    }
  } catch (error) {
    console.error(`[仓库 ${name}] 同步失败:`, error.message)
    if (task) {
      task.status = 'failed'
      task.message = '同步失败: ' + error.message
      task.progress = 0
    }
  }
  
  // 10分钟后清理任务记录
  if (task) {
    setTimeout(() => {
      syncTasks.delete(taskId)
    }, 600000)
  }
}

// 获取仓库详情 - 必须放在最后，避免拦截其他具体路由
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const db = getDatabase()
    const repo = db.prepare('SELECT * FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    // 检查本地目录是否存在
    const exists = fs.existsSync(repo.local_path)
    
    res.json({ 
      data: {
        ...repo,
        exists
      }
    })
  } catch (error) {
    console.error('获取代码仓库详情失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取并保存语言统计
async function fetchAndSaveLanguages(repoId, repoUrl) {
  try {
    // 检查是否是GitHub仓库
    const githubMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/)
    if (!githubMatch) return
    
    const [, owner, repo] = githubMatch
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/languages`
    
    console.log(`[仓库] 获取语言统计: ${owner}/${repo}`)
    
    const response = await axios.get(apiUrl, {
      timeout: 10000,
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    })
    
    const langData = response.data
    const total = Object.values(langData).reduce((sum, val) => sum + val, 0)
    
    if (total > 0) {
      const languages = Object.entries(langData)
        .map(([lang, bytes]) => ({
          name: lang,
          percentage: Math.round((bytes / total) * 100)
        }))
        .sort((a, b) => b.percentage - a.percentage)
        .slice(0, 5) // 只保留前5种语言
      
      const db = getDatabase()
      db.prepare('UPDATE code_repositories SET languages = ? WHERE id = ?')
        .run(JSON.stringify(languages), repoId)
      
      console.log(`[仓库] 语言统计已保存:`, languages.map(l => `${l.name} ${l.percentage}%`).join(', '))
    }
  } catch (error) {
    console.error('[仓库] 获取语言统计失败:', error.message)
  }
}

export default router
