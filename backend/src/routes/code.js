import express from 'express'
import { getDatabase } from '../config/database.js'
import { authenticateToken, requireWritePermission } from '../middlewares/auth.js'
import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import axios from 'axios'
import { cache, CacheTTL } from '../utils/cache.js'
import {
  normalizeCommitLimit,
  RepositorySecurityError,
  resolveManagedRepositoryPath,
  resolveRepositoryEntry,
  validateCommitHash,
  validateGitRemoteUrl
} from '../services/repositorySecurity.js'

const router = express.Router()
const execFileAsync = promisify(execFile)

// 代码存储目录
const CODE_BASE_PATH = process.env.CODE_PATH || path.join(process.env.DATA_PATH || '/data', 'code')

// 确保代码目录存在
if (!fs.existsSync(CODE_BASE_PATH)) {
  fs.mkdirSync(CODE_BASE_PATH, { recursive: true })
}

const SAFE_GIT_CONFIG = [
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never'
]

function runGit(args, options = {}) {
  return execFileAsync(
    'git',
    [...SAFE_GIT_CONFIG, ...args],
    {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    }
  )
}

function sendRepositorySecurityError(res, error) {
  if (!(error instanceof RepositorySecurityError)) return false
  res.status(400).json({ message: error.message, code: error.code })
  return true
}

// 获取文件原始内容（用于图片等）
router.get('/:id/raw/:path(*)', async (req, res) => {
  try {
    const db = getDatabase()
    let relativePath = req.params.path || ''
    relativePath = relativePath.split('?')[0]
    relativePath = decodeURIComponent(relativePath)
    
    const repo = db.prepare('SELECT local_path FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    const fullPath = resolveRepositoryEntry(
      CODE_BASE_PATH,
      repo.local_path,
      relativePath
    )

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
      '.svg': 'application/octet-stream',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'text/plain',
      '.js': 'text/plain',
      '.css': 'text/plain',
      '.html': 'text/plain'
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
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '文件不存在' })
    }
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
      try {
        const repositoryPath = resolveManagedRepositoryPath(
          CODE_BASE_PATH,
          repo.local_path,
          { mustExist: true }
        )
        size = getDirectorySize(repositoryPath)
      } catch {
        size = 0
      }
      // 解析languages字段
      let languages = []
      if (repo.languages) {
        try {
          languages = JSON.parse(repo.languages)
        } catch (e) {}
      }
      const { local_path: _localPath, ...publicRepo } = repo
      return { ...publicRepo, size, languages }
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
        const stats = fs.lstatSync(filePath)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) {
          // 跳过 .git 目录（通常很大）
          if (file !== '.git') {
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
    if (type !== 'git') {
      return res.status(400).json({
        message: '仅支持 Git 仓库',
        code: 'REPOSITORY_TYPE_UNSUPPORTED'
      })
    }
    const safeRemoteUrl = validateGitRemoteUrl(url)

    // 检查是否已存在
    const existing = db.prepare(
      'SELECT id FROM code_repositories WHERE url = ?'
    ).get(safeRemoteUrl)
    if (existing) {
      return res.status(400).json({ message: '该仓库URL已存在' })
    }

    // 生成本地路径
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const localPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      path.join(CODE_BASE_PATH, `${safeName}_${Date.now()}`)
    )

    // 先保存到数据库
    const stmt = db.prepare(
      `INSERT INTO code_repositories (name, url, description, local_path, type) VALUES (?, ?, ?, ?, ?)`
    )
    const result = stmt.run(
      name,
      safeRemoteUrl,
      description,
      localPath,
      'git'
    )

    // 异步克隆仓库
    cloneRepository(
      result.lastInsertRowid,
      safeRemoteUrl,
      localPath,
      name
    )

    res.json({ 
      id: result.lastInsertRowid, 
      message: '仓库添加成功，正在后台克隆...'
    })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
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
async function cloneRepository(id, url, localPath, name) {
  const db = getDatabase()
  const managedPath = resolveManagedRepositoryPath(CODE_BASE_PATH, localPath)
  
  const task = {
    id: String(id),
    status: 'cloning',
    progress: 0,
    message: '准备克隆...',
    startTime: Date.now()
  }
  cloneTasks.set(String(id), task)
  
  try {
    console.log(`[仓库 ${name}] 开始克隆`)
    await cloneGitWithProgress(url, managedPath, task)
    
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
      fs.rmSync(managedPath, { recursive: true, force: true })
    } catch (e) {}
    // 标记为失败状态
    try {
      db.prepare("UPDATE code_repositories SET description = description || ' [克隆失败]' WHERE id = ?").run(id)
    } catch (dbError) {
      console.error('更新失败状态失败:', dbError.message)
    }
  }
  
  // 10分钟后清理任务记录
  const cleanupTimer = setTimeout(() => {
    cloneTasks.delete(String(id))
  }, 600000)
  cleanupTimer.unref?.()
}

// Git 克隆带进度
function cloneGitWithProgress(url, localPath, task) {
  return new Promise((resolve, reject) => {
    const args = [
      ...SAFE_GIT_CONFIG,
      'clone',
      '--progress',
      '--depth',
      '50',
      url,
      localPath
    ]
    const proc = spawn('git', args, {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    })
    let settled = false

    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    
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
        finish(resolve)
      } else {
        finish(() => reject(new Error(`Git clone 失败，退出码: ${code}`)))
      }
    })
    
    proc.on('error', (err) => {
      finish(() => reject(err))
    })
    
    // 5分钟超时
    const timeout = setTimeout(() => {
      proc.kill()
      finish(() => reject(new Error('克隆超时')))
    }, 300000)
    timeout.unref?.()
  })
}

// 删除代码仓库
router.delete('/:id', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const repo = db.prepare('SELECT local_path FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }

    const managedPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      repo.local_path
    )

    // 只允许删除代码存储根目录内的受管仓库目录
    if (fs.existsSync(managedPath)) {
      fs.rmSync(managedPath, { recursive: true, force: true })
    }

    // 删除数据库记录
    db.prepare('DELETE FROM code_repositories WHERE id = ?').run(req.params.id)
    res.json({ message: '删除成功' })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
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

    const fullPath = resolveRepositoryEntry(
      CODE_BASE_PATH,
      repo.local_path,
      relativePath,
      { allowRepositoryRoot: true }
    )

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
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '路径不存在' })
    }
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
    
    const fullPath = resolveRepositoryEntry(
      CODE_BASE_PATH,
      repo.local_path,
      relativePath
    )

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
      const repositoryPath = resolveManagedRepositoryPath(
        CODE_BASE_PATH,
        repo.local_path,
        { mustExist: true }
      )
      content = convertImagePathsToBase64(
        content,
        repositoryPath,
        fullPath
      )
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
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '文件不存在' })
    }
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

    const repositoryPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      repo.local_path,
      { mustExist: true }
    )

    // 查找 README 文件
    const readmeNames = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README.txt', 'readme.txt']
    let readmePath = null
    
    for (const name of readmeNames) {
      const candidatePath = resolveRepositoryEntry(
        CODE_BASE_PATH,
        repositoryPath,
        name,
        { mustExist: false }
      )
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        readmePath = resolveRepositoryEntry(
          CODE_BASE_PATH,
          repositoryPath,
          name
        )
        break
      }
    }

    if (!readmePath) {
      return res.json({ data: null })
    }

    let content = fs.readFileSync(readmePath, 'utf-8')
    
    // 转换相对图片路径为 base64 data URL
    content = convertImagePathsToBase64(
      content,
      repositoryPath,
      readmePath
    )
    
    console.log('README 图片路径转换完成')
    
    const result = {
      name: path.basename(readmePath),
      content
    }
    
    // 缓存结果（10分钟）
    await cache.set(cacheKey, result, CacheTTL.MEDIUM)
    
    res.json({ data: result })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.json({ data: null })
    }
    console.error('获取README失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 将图片转换为 base64 data URL
function imageToBase64(imagePath, repoPath, mdFilePath) {
  try {
    // 解码 URL 编码的路径
    const decodedPath = decodeURIComponent(imagePath)
    if (path.isAbsolute(decodedPath) && !decodedPath.startsWith('/')) {
      return null
    }

    const basePath = decodedPath.startsWith('/')
      ? repoPath
      : (mdFilePath ? path.dirname(mdFilePath) : repoPath)
    const candidatePath = path.resolve(
      basePath,
      decodedPath.replace(/^[/\\]+/, '')
    )
    const relativePath = path.relative(repoPath, candidatePath)
    const fullPath = resolveRepositoryEntry(
      CODE_BASE_PATH,
      repoPath,
      relativePath
    )
    
    // 读取文件并转为 base64
    const ext = path.extname(fullPath).toLowerCase()
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon'
    }
    const mimeType = mimeTypes[ext]
    if (!mimeType) return null

    const stats = fs.statSync(fullPath)
    if (stats.size > 5 * 1024 * 1024) return null
    const fileBuffer = fs.readFileSync(fullPath)
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
    const limit = normalizeCommitLimit(req.query.limit)
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

    if (repo.type !== 'git') {
      return res.status(410).json({
        message: 'SVN 支持已移除，请迁移为 Git 仓库',
        code: 'SVN_RETIRED'
      })
    }

    const repositoryPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      repo.local_path,
      { mustExist: true }
    )
    let commits = []
    try {
      const { stdout } = await runGit([
        '-C',
        repositoryPath,
        'log',
        '--pretty=format:%H|%an|%ad|%s',
        '--date=format:%Y-%m-%d %H:%M:%S',
        '-n',
        String(limit)
      ])
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
    } catch {
      commits = []
    }

    // 缓存结果（5分钟）
    await cache.set(cacheKey, commits, CacheTTL.MEDIUM)
    
    res.json({ data: commits })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '仓库尚未克隆完成' })
    }
    console.error('获取提交历史失败:', error)
    res.status(500).json({ message: '服务器错误' })
  }
})

// 获取单个提交的详情和代码变更
router.get('/:id/commit/:hash', authenticateToken, async (req, res) => {
  try {
    const hash = validateCommitHash(req.params.hash)
    
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

    if (repo.type !== 'git') {
      return res.status(410).json({
        message: 'SVN 支持已移除，请迁移为 Git 仓库',
        code: 'SVN_RETIRED'
      })
    }

    const repositoryPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      repo.local_path,
      { mustExist: true }
    )
    let commitDetail = null
    try {
      const { stdout: showOut } = await runGit([
        '-C',
        repositoryPath,
        'show',
        '--stat',
        '--pretty=format:%H|%an|%ad|%s',
        hash,
        '--'
      ])
      const { stdout: diffOut } = await runGit([
        '-C',
        repositoryPath,
        'show',
        '--format=',
        hash,
        '--'
      ], {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 5
      })
      commitDetail = {
        hash,
        diff: diffOut || '无变更内容',
        files: parseGitChangedFiles(showOut)
      }
    } catch (error) {
      console.error('获取Git提交详情失败:', error.message)
      commitDetail = { hash, diff: '获取变更失败', files: [] }
    }

    // 缓存结果（10分钟）
    await cache.set(cacheKey, commitDetail, CacheTTL.MEDIUM)
    
    res.json({ data: commitDetail })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
    if (error.code === 'ENOENT') {
      return res.status(404).json({ message: '仓库尚未克隆完成' })
    }
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

// 手动同步仓库
router.post('/:id/sync', authenticateToken, requireWritePermission, async (req, res) => {
  try {
    const db = getDatabase()
    const repo = db.prepare('SELECT * FROM code_repositories WHERE id = ?').get(req.params.id)
    
    if (!repo) {
      return res.status(404).json({ message: '仓库不存在' })
    }
    if (repo.type !== 'git') {
      return res.status(410).json({
        message: 'SVN 支持已移除，请迁移为 Git 仓库',
        code: 'SVN_RETIRED'
      })
    }

    const repositoryPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      repo.local_path
    )

    // 初始化同步任务状态
    const taskId = String(repo.id)
    syncTasks.set(taskId, {
      id: taskId,
      status: 'syncing',
      message: '准备同步...',
      progress: 0,
      startTime: Date.now()
    })

    if (!fs.existsSync(repositoryPath)) {
      // 如果目录不存在，重新克隆
      syncTasks.get(taskId).message = '目录不存在，开始重新克隆...'
      cloneRepository(repo.id, repo.url, repositoryPath, repo.name)
      return res.json({ message: '开始重新克隆仓库...', taskId })
    }

    // 异步更新仓库
    updateRepository(
      repo.id,
      repo.url,
      repositoryPath,
      repo.name,
      taskId
    )

    res.json({ message: '开始同步仓库...', taskId })
  } catch (error) {
    if (sendRepositorySecurityError(res, error)) return
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
async function updateRepository(id, url, localPath, name, taskId) {
  const db = getDatabase()
  const task = syncTasks.get(taskId)
  
  try {
    console.log(`[仓库 ${name}] 开始同步`)
    
    if (task) {
      task.message = '正在同步...'
      task.progress = 30
    }
    
    const repositoryPath = resolveManagedRepositoryPath(
      CODE_BASE_PATH,
      localPath,
      { mustExist: true }
    )
    await runGit(
      ['-C', repositoryPath, 'pull', '--ff-only'],
      { timeout: 300000 }
    )
    
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
    const cleanupTimer = setTimeout(() => {
      syncTasks.delete(taskId)
    }, 600000)
    cleanupTimer.unref?.()
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

    // 检查受管仓库目录是否存在，但不向前端暴露物理路径。
    let exists = false
    try {
      const repositoryPath = resolveManagedRepositoryPath(
        CODE_BASE_PATH,
        repo.local_path
      )
      exists = fs.existsSync(repositoryPath)
    } catch {
      exists = false
    }
    const { local_path: _localPath, ...publicRepo } = repo
    
    res.json({ 
      data: {
        ...publicRepo,
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
