# 我如何从零搭建一个全功能个人资源管理系统

## 前言

作为一个程序员，我一直在寻找一个能统一管理自己所有数字资源的方法。文档、音乐、电子书、代码仓库、书签、动漫收藏...这些资源分散在各个平台，管理起来非常混乱。市面上虽然有很多现成的方案，但都不完全符合我的需求。

于是，我决定自己动手，从零开始搭建一个**个人资源管理系统**。这篇文章记录了整个开发过程中的技术选型、功能实现、踩坑经历和解决方案。

---

## 一、项目概览

### 功能模块

这个系统包含 **8大核心模块**：

| 模块 | 功能 | 数据库表 |
|------|------|----------|
| 📄 文档管理 | 分类、标签、版本控制、PDF预览 | documents, categories, document_versions |
| 📝 博客管理 | Markdown编辑器、分类标签、草稿发布 | blog_posts, blog_categories, blog_tags |
| 🎵 音乐管理 | FFprobe元数据解析、播放列表、封面提取 | music, playlists, playlist_songs |
| 📚 书籍管理 | 电子书上传、在线阅读器、进度记忆 | books, book_categories, reading_progress |
| 💻 代码管理 | Git仓库链接管理 | code_repositories |
| 🔖 书签管理 | URL收藏、图标自动获取 | bookmarks |
| 🎬 动漫管理 | Bangumi爬虫、收藏标记、评分系统 | anime |
| 🎮 游戏管理 | Steam集成、成就追踪 | games, game_achievements |

### 技术栈

**前端**
- Vue 3.4 + Vite 5.0
- TDesign Vue Next 1.9（UI组件库）
- Pinia（状态管理）
- Vue Router 4
- Axios（HTTP请求）
- marked + highlight.js（Markdown渲染）
- md-editor-v3（Markdown编辑器）
- mammoth（Word文档解析）
- xlsx（Excel解析）
- PDF.js（PDF预览）

**后端**
- Node.js + Express 4.18
- better-sqlite3（SQLite同步API）
- JWT + bcryptjs（用户认证）
- Multer（文件上传）
- Cheerio（HTML解析）
- https-proxy-agent（代理请求）

**部署**
- Docker Compose
- NAS服务器
- Clash代理（解决爬虫被墙问题）

---

## 二、各模块功能详解

### 📄 文档管理模块

**核心功能**：
- **多级分类系统**：支持无限级分类（如：技术/前端/Vue），分类支持拖拽排序
- **标签管理**：每篇文档可添加多个标签，支持标签筛选
- **文件上传**：支持拖拽上传、批量上传
- **在线预览**：
  - 文本文件：Markdown、代码文件直接渲染
  - PDF：使用 PDF.js 实现缩放、翻页
  - Word/Excel：前端解析，无需后端转换
- **版本控制**：自动保存历史版本，支持版本回退
- **全文搜索**：按标题、内容、标签搜索
- **🔒 隐私空间**：独立加密存储区域，用于存放私密文档

**隐私空间设计**：

为了保护敏感文档，我设计了独立的隐私空间：

```sql
-- 隐私文档独立存储
CREATE TABLE private_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**隐私空间特点**：
- 🔐 **独立存储路径**：与普通文档物理隔离
- 🔐 **独立API路由**：`/api/documents/private/*` 
- 🔐 **独立管理界面**：需要额外确认才能访问
- 🔐 **上传去重**：自动处理同名文件（添加后缀）

```javascript
// 隐私文档上传时自动去重
let finalTitle = title
let suffix = 1
while (!unique) {
  const existing = db.prepare('SELECT * FROM private_documents WHERE title = ?').get(finalTitle)
  if (!existing) {
    unique = true
  } else {
    finalTitle = `${title} (${suffix})`
    suffix++
  }
}
```

**普通文档表结构**：
```sql
-- 文档表结构
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,          -- 主分类
  subcategory TEXT,       -- 子分类
  tags TEXT,              -- 标签（逗号分隔）
  file_path TEXT NOT NULL,
  version REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)

-- 分类表（支持拖拽排序）
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0
)

-- 文档版本表
CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  version REAL,
  file_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

---

### 📝 博客管理模块

**核心功能**：
- **Markdown编辑器**：使用 md-editor-v3，支持实时预览、工具栏、快捷键
- **文章管理**：草稿/发布状态、置顶、创建时间/更新时间
- **分类和标签**：独立的分类树和标签系统，支持颜色自定义
- **只读预览**：点击文章卡片进入预览视图，点击编辑按钮才进入编辑
- **代码高亮**：Atom 主题，黑底 + 语法高亮

**技术实现**：
```vue
<!-- 编辑器配置 -->
<MdEditor
  v-model="editForm.content"
  :theme="editorTheme"        <!-- 主题：light -->
  :previewTheme="previewTheme" <!-- 预览主题：default -->
  :codeTheme="codeTheme"      <!-- 代码主题：atom（黑底高亮） -->
  :toolbars="editorToolbars"
  @onSave="handleAutoSave"
/>

<!-- 预览组件（只读） -->
<MdPreview
  :modelValue="previewContent"
  :theme="editorTheme"
  :previewTheme="previewTheme"
  :codeTheme="codeTheme"
/>
```

**数据库设计**：
```sql
CREATE TABLE blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,               -- Markdown内容
  category_id INTEGER,
  status TEXT DEFAULT 'draft', -- draft/published
  is_top INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)

CREATE TABLE blog_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0
)

CREATE TABLE blog_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT  -- 标签颜色
)
```

---

### 🎵 音乐管理模块

**核心功能**：
- **元数据解析**：使用 FFprobe（FFmpeg）解析音频文件的标题、艺术家、专辑、时长
- **封面提取**：自动提取嵌入的封面图片，支持 MP3/FLAC/M4A 等格式
- **播放列表**：创建、编辑、删除歌单，拖拽排序歌曲
- **在线播放**：全局播放器，支持单曲循环、随机播放、顺序播放
- **搜索筛选**：按艺术家、专辑、歌单筛选
- **📤 大文件上传**：支持超大音乐文件（支持 100MB+）
- **📤 断点续传**：网络中断后可继续上传
- **📤 上传进度恢复**：页面刷新后恢复上传进度

**大文件上传实现**：

采用**分片上传**策略，将大文件切分成多个小块上传：

```javascript
// 分片上传实现
const CHUNK_SIZE = 10 * 1024 * 1024  // 每片 10MB

async function uploadFile(file) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  
  // 1. 开始上传会话
  await api.music.startUpload({
    fileId: file.id,
    fileName: file.name,
    fileSize: file.size,
    totalChunks
  })
  
  // 2. 分片上传
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunk = file.file.slice(start, end)  // 切片
    
    const formData = new FormData()
    formData.append('fileId', file.id)
    formData.append('chunkIndex', i)
    formData.append('chunk', chunk)
    
    await api.music.uploadChunk(formData)
    
    // 更新进度
    file.progress = Math.round(((i + 1) / totalChunks) * 100)
  }
  
  // 3. 合并分片
  await api.music.mergeChunks({
    fileId: file.id,
    fileName: file.name,
    totalChunks
  })
}
```

**断点续传实现**：

使用 **IndexedDB** 在浏览器端保存上传状态，页面刷新后恢复：

```javascript
// 保存上传状态到 IndexedDB
async function saveUploadState(fileId, file, totalChunks) {
  const db = await openIndexedDB()
  await db.put('uploads', {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    file: file,  // 保存 File 对象引用
    totalChunks,
    timestamp: Date.now()
  })
}

// 页面加载时恢复上传进度
async function restoreUploadProgress() {
  const pendingUploads = await getAllPendingUploads()
  
  for (const upload of pendingUploads) {
    // 从后端获取已上传的分片
    const status = await api.music.getUploadStatus(upload.fileId)
    
    if (status.status === 'uploading') {
      const receivedChunks = status.receivedChunks || []
      
      // 检查 File 对象是否还有效
      if (upload.file && upload.file instanceof File) {
        // ✅ 文件对象有效，显示为"后台上传中"
        resumedUploads.push({
          ...upload,
          status: 'uploading',
          isRecovered: true
        })
      } else {
        // ❌ 文件对象丢失，需要用户重新选择
        resumedUploads.push({
          ...upload,
          status: 'waiting_file',
          needReselect: true
        })
      }
    }
  }
}
```

**后端分片处理**：

```javascript
// 上传分片
router.post('/upload-chunk', (req, res) => {
  const { fileId, chunkIndex } = req.body
  const chunkFile = req.files.chunk
  
  // 保存到临时目录
  const chunkPath = path.join(tempDir, `${fileId}_${chunkIndex}`)
  fs.writeFileSync(chunkPath, chunkFile.data)
  
  // 记录已接收的分片
  uploadSessions[fileId].receivedChunks.push(chunkIndex)
  
  res.json({ success: true, chunkIndex })
})

// 合并分片
router.post('/merge-chunks', (req, res) => {
  const { fileId, fileName, totalChunks } = req.body
  
  const finalPath = path.join(musicDir, fileName)
  const writeStream = fs.createWriteStream(finalPath)
  
  // 按顺序合并分片
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(tempDir, `${fileId}_${i}`)
    const chunkData = fs.readFileSync(chunkPath)
    writeStream.write(chunkData)
    fs.unlinkSync(chunkPath)  // 删除临时分片
  }
  
  writeStream.end()
  
  // 解析元数据
  const metadata = await parseMusicMetadata(finalPath)
  // 保存到数据库...
})
```

**上传场景处理**：

| 场景 | 状态 | 处理方式 |
|------|------|----------|
| 正常上传 | `uploading` | 显示进度条 |
| 网络中断 | `pending` | 显示"继续上传"按钮 |
| 页面刷新（文件有效） | `uploading` | 后台继续上传，显示进度 |
| 页面刷新（文件丢失） | `waiting_file` | 提示重新选择文件 |
| 上传失败 | `error` | 显示错误信息，可重试 |

**技术实现（三层降级策略）**：

```javascript
// 第一层：FFprobe（推荐，最可靠）
async function parseWithFFprobe(filePath) {
  const { exec } = require('child_process')
  const command = `ffprobe -v quiet -print_format json -show_format "${filePath}"`
  
  const result = await execPromise(command)
  const data = JSON.parse(result)
  
  return {
    title: data.format.tags?.title,
    artist: data.format.tags?.artist || data.format.tags?.ARTIST,
    album: data.format.tags?.album,
    duration: data.format.duration
  }
}

// 第二层：轻量级纯 JS 解析（降级）
function parseWithPureJS(filePath) {
  // FLAC: 解析 Vorbis Comments
  // MP3: 解析 ID3v2 标签
  // 无需外部依赖
}

// 第三层：文件名推断（兜底）
function parseFromFilename(filename) {
  // 尝试从文件名提取信息
}
```

**为什么选择 FFprobe 而不是 music-metadata？**

| 对比项 | FFprobe | music-metadata |
|--------|---------|----------------|
| FLAC 兼容性 | ✅ 完美支持 | ❌ 部分文件报错 |
| NCM 转换文件 | ✅ 正常解析 | ❌ 经常失败 |
| 封面提取 | ✅ 稳定可靠 | ⚠️ 不稳定 |
| 行业地位 | ✅ Netflix/Spotify 使用 | ❌ 社区库 |

---

### 📚 书籍管理模块

**核心功能**：
- **电子书上传**：支持 EPUB、PDF、TXT 等格式
- **在线阅读器**：
  - EPUB：章节目录、翻页、字体调整
  - PDF：缩放、翻页
  - TXT：自动分章、编码检测
- **阅读进度**：自动保存当前位置，下次打开恢复
- **书籍分类**：分类树管理，支持子分类
- **🔍 在线资源搜索**：爬取 Anna's Archive 和 Nyaa 搜索电子书

**在线资源搜索爬虫**：

为了方便找书，我集成了多个电子书资源站点的爬虫：

**支持的搜索源**：
- **Anna's Archive**：全球最大的电子书搜索引擎镜像
- **Nyaa**：动漫资源站点，包含轻小说分类

```javascript
// Anna's Archive 爬虫
async function searchAnnaArchive(keyword) {
  const searchUrl = `https://annas-archive.gl/search?q=${encodeURIComponent(keyword)}`
  
  const response = await axios.get(searchUrl, {
    httpsAgent: proxyAgent,  // 使用 Clash 代理
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 ...',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  })
  
  const $ = cheerio.load(response.data)
  const results = []
  
  // 解析搜索结果
  $('div[data-id]').each((i, elem) => {
    const $elem = $(elem)
    results.push({
      title: $elem.find('h3').text(),
      author: $elem.find('.author').text(),
      format: $elem.find('.format').text(),  // PDF/EPUB/MOBI
      size: $elem.find('.size').text(),
      link: $elem.find('a').attr('href')
    })
  })
  
  return results
}

// Nyaa 爬虫（轻小说分类）
async function searchNyaa(keyword) {
  const searchUrl = `https://nyaa.si/?f=0&c=3_0&q=${encodeURIComponent(keyword)}`
  
  const response = await axios.get(searchUrl, {
    httpsAgent: proxyAgent,
    timeout: 15000
  })
  
  const $ = cheerio.load(response.data)
  const results = []
  
  $('tr.success, tr.default').each((i, elem) => {
    results.push({
      title: $(elem).find('a[title]').attr('title'),
      size: $(elem).find('td:nth-child(4)').text(),
      seeders: $(elem).find('td:nth-child(6)').text(),
      leechers: $(elem).find('td:nth-child(7)').text(),
      torrent: $(elem).find('a[href*="download"]').attr('href')
    })
  })
  
  return results
}

// 并行搜索多个源
router.get('/search', async (req, res) => {
  const { keyword } = req.query
  
  const results = await Promise.allSettled([
    searchAnnaArchive(keyword),
    searchNyaa(keyword)
  ])
  
  res.json({
    annaArchive: results[0].status === 'fulfilled' ? results[0].value : [],
    nyaa: results[1].status === 'fulfilled' ? results[1].value : []
  })
})
```

**爬虫配置**：
```javascript
// 可配置的域名（应对域名变化）
const config = {
  annaArchiveDomain: 'annas-archive.gl',
  nyaaDomain: 'nyaa.si',
  lastUpdated: new Date().toISOString()
}

// 配置存储在文件中，可动态修改
fs.writeFileSync('booksearch-config.json', JSON.stringify(config))
```

**技术实现（进度保存防抖）**：

```javascript
// 防止初始值覆盖正确进度
let isProgressLoaded = false

async function handleRead(row) {
  // 先加载进度
  const progress = await api.books.getProgress(row.id)
  
  // 恢复滚动位置
  if (progress) {
    scrollToPosition(progress.current_chapter)
  }
  
  // 进度加载完成后才设置 currentBook
  currentBook.value = row
  isProgressLoaded = true
}

// 保存前检查标志位
function saveProgress() {
  if (!currentBook.value || !isProgressLoaded) return
  // 保存逻辑...
}
```

---

### 💻 代码管理模块

**核心功能**：
- **仓库管理**：添加 Git 仓库链接（GitHub、GitLab 等）
- **一键克隆**：自动克隆仓库到服务器
- **文件浏览**：在线浏览仓库文件结构
- **提交历史**：查看最近的提交记录

**技术实现**：

```javascript
// 后端克隆仓库
router.post('/clone', async (req, res) => {
  const { url, name } = req.body
  const targetPath = path.join(codeDir, name)
  
  // 使用 simple-git 克隆
  const git = simpleGit()
  await git.clone(url, targetPath)
  
  res.json({ success: true, path: targetPath })
})
```

---

### 🔖 书签管理模块

**核心功能**：
- **URL 收藏**：快速保存网页链接
- **图标获取**：自动获取网站 favicon
- **分类管理**：按类别整理书签
- **搜索**：按标题、URL、标签搜索

---

### 🎬 动漫管理模块

**核心功能**：
- **Bangumi 爬虫**：搜索动漫信息，自动获取封面、评分、简介
- **收藏标记**：想看、看过、正在看
- **评分系统**：显示 Bangumi 评分
- **状态管理**：收藏、取消收藏
- **懒加载优化**：使用缓存机制，避免重复请求
- **🔍 在线资源搜索**：爬取 Nyaa 搜索动漫资源

**Bangumi API 爬虫**：

使用 Bangumi 官方 API 获取动漫信息：

```javascript
const BANGUMI_API_V0 = 'https://api.bgm.tv/v0'

// Bangumi API 要求自定义 User-Agent
const BANGUMI_HEADERS = {
  'User-Agent': 'PersonalResourceManager/1.0 (https://github.com/user/pr-manager)'
}

// 搜索动漫
router.get('/search', async (req, res) => {
  const { keyword } = req.query
  
  // 使用 v0 API POST 请求
  const response = await axios.post(`${BANGUMI_API_V0}/search/subjects`, {
    keyword,
    type: [2],  // 动画类型（数组格式）
    limit: 25
  }, {
    httpsAgent: proxyAgent,  // 使用 Clash 代理
    timeout: 15000,
    headers: BANGUMI_HEADERS
  })
  
  // 过滤只保留动画（type=2）
  const results = response.data.data.filter(item => item.type === 2)
  
  // 模糊匹配排序
  const keywordLower = keyword.toLowerCase()
  const scoredResults = results.map(item => {
    let score = 0
    const nameCn = (item.name_cn || '').toLowerCase()
    
    if (nameCn === keywordLower) score += 100
    else if (nameCn.includes(keywordLower)) score += 50
    if (item.name.toLowerCase().includes(keywordLower)) score += 30
    
    return { ...item, score }
  }).sort((a, b) => b.score - a.score)
  
  res.json({ data: scoredResults })
})

// 获取动漫详情（并行请求）
async function getAnimeDetail(bangumiId) {
  const [subjectRes, charactersRes, personsRes] = await Promise.all([
    axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}`),
    axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/characters`),
    axios.get(`${BANGUMI_API_V0}/subjects/${bangumiId}/persons`)
  ])
  
  return {
    subject: subjectRes.data,      // 基本信息
    characters: charactersRes.data, // 角色信息
    persons: personsRes.data        // 制作人员
  }
}
```

**导入动漫流程**：

```javascript
// 导入动漫（支持前端传递数据）
router.post('/import', async (req, res) => {
  const { bangumiId, animeData } = req.body
  
  let animeInfo
  if (animeData) {
    // 前端传递了完整数据，直接使用
    animeInfo = animeData
  } else {
    // 从 Bangumi API 获取
    const detail = await getAnimeDetail(bangumiId)
    animeInfo = detail.subject
  }
  
  // 下载封面图片并转 base64
  let coverImageData = null
  if (animeInfo.images?.common) {
    const imageResponse = await axios.get(animeInfo.images.common, {
      responseType: 'arraybuffer'
    })
    coverImageData = `data:image/jpeg;base64,${Buffer.from(imageResponse.data).toString('base64')}`
  }
  
  // 从 infobox 提取详细信息
  const infobox = animeInfo.infobox || []
  const author = extractFromInfobox(infobox, '作者') || extractFromInfobox(infobox, '原作')
  const director = extractFromInfobox(infobox, '导演')
  const studio = extractFromInfobox(infobox, '动画制作')
  
  // 保存到数据库
  db.prepare(`INSERT INTO anime (...) VALUES (?, ?, ?, ...)`).run(...)
})
```

**在线资源搜索爬虫（Nyaa）**：

```javascript
// 搜索动漫资源（Nyaa）
router.get('/resources/search', async (req, res) => {
  const { keyword } = req.query
  
  // Nyaa 搜索（动漫分类 1_0）
  const searchUrl = `https://nyaa.si/?f=0&c=1_0&q=${encodeURIComponent(keyword)}`
  
  const response = await axios.get(searchUrl, {
    httpsAgent: proxyAgent,
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 ...',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }
  })
  
  const $ = cheerio.load(response.data)
  const results = []
  
  // 解析搜索结果
  $('tr.success, tr.default').each((i, elem) => {
    results.push({
      title: $(elem).find('a[title]').attr('title'),
      torrent: $(elem).find('a[href*="download"]').attr('href'),
      size: $(elem).find('td:nth-child(4)').text(),
      seeders: $(elem).find('td:nth-child(6)').text(),
      leechers: $(elem).find('td:nth-child(7)').text()
    })
  })
  
  res.json({ data: results })
})
```

**获取关联作品**：

```javascript
// 获取前传、续集等关联作品
router.get('/relations/:bangumiId', async (req, res) => {
  const response = await axios.get(
    `${BANGUMI_API_V0}/subjects/${req.params.bangumiId}/subjects`
  )
  
  // 只保留前传和续集
  const relations = response.data.filter(item => {
    const relation = item.relation || ''
    return relation.includes('前传') || 
           relation.includes('续集') ||
           relation.includes('Prequel') ||
           relation.includes('Sequel')
  })
  
  res.json({ data: relations })
})
```

**技术实现**：

```javascript
// 前端缓存优化
const cacheLoaded = ref(false)
const lastFilterStatus = ref('')

async function loadAnime(forceReload = false) {
  // 如果筛选条件没变化且已缓存，则不重新加载
  if (!forceReload && cacheLoaded.value && 
      filterStatus.value === lastFilterStatus.value) {
    return
  }
  
  // 加载数据...
  cacheLoaded.value = true
}

// 组件激活时检查缓存
onActivated(() => {
  if (!cacheLoaded.value) {
    loadAnime()
  }
})
```

---

### 🎮 游戏管理模块

**核心功能**：
- **Steam 集成**：导入 Steam 库中的游戏
- **成就追踪**：查看游戏成就完成度
- **游戏状态**：想玩、在玩、通关
- **游戏信息**：封面、简介、游戏时长

---

## 三、开发过程中遇到的难点

### 难点1：SQLite从异步API迁移到同步API

**问题背景**：

最初使用 `sqlite3` 库（异步API），但在 Alpine Linux Docker 容器中编译原生模块失败：

```
Error: Cannot find module '../build/Release/node_sqlite3.node'
```

**解决方案**：

迁移到 `better-sqlite3`（同步API），步骤：

```javascript
// ❌ 旧代码（异步）
db.all("SELECT * FROM users", [], (err, rows) => {
  if (err) throw err
  console.log(rows)
})

// ✅ 新代码（同步）
const rows = db.prepare("SELECT * FROM users").all()
console.log(rows)
```

**经验教训**：
- 优先选择纯 JavaScript 实现的库，避免原生模块编译问题
- Docker 部署时，`alpine` 镜像缺少编译工具，改用 `slim` 镜像

---

### 难点2：PDF预览功能的实现

**问题背景**：

我希望在线预览 PDF 文件，但遇到以下问题：
1. PDF.js 版本不兼容（4.0.379 使用私有字段）
2. 二进制文件传输编码问题
3. Worker 加载失败

**解决方案**：

**后端处理**：
```javascript
router.get('/:id/content', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id)
  
  const binaryFormats = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'zip', 'rar']
  const ext = doc.file_path.split('.').pop().toLowerCase()
  
  if (binaryFormats.includes(ext)) {
    // 返回 base64 编码
    const fileBuffer = fs.readFileSync(doc.file_path)
    const base64 = fileBuffer.toString('base64')
    res.json({ content: base64, isBase64: true })
  } else {
    // 文本文件直接返回内容
    const content = fs.readFileSync(doc.file_path, 'utf-8')
    res.json({ content })
  }
})
```

**前端处理**：
```javascript
async function loadPDF(doc) {
  const response = await api.documents.getContent(doc.id)
  const base64 = response.data.content
  
  // Base64 转 Uint8Array
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  
  // 使用 PDF.js 加载
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
}
```

**版本降级**：
```json
{
  "dependencies": {
    "pdfjs-dist": "3.11.174"  // 从 4.0.379 降级
  }
}
```

---

### 难点3：音乐文件元数据解析

**问题背景**：

需要从音乐文件中提取：
- 歌曲名称、艺术家、专辑
- 封面图片
- 时长

最初尝试使用 `music-metadata` 库，但发现：
- 部分 FLAC 文件报错 `Invalid FLAC preamble`
- NCM 转换的文件经常无法解析
- 封面提取不稳定

**解决方案**：

改用 **FFprobe**（FFmpeg 的一部分）：

```javascript
// 使用 FFprobe 解析元数据
const { exec } = require('child_process')

async function parseMusicMetadata(filePath) {
  // 获取基本信息
  const infoCommand = `ffprobe -v quiet -print_format json -show_format "${filePath}"`
  const infoResult = await execPromise(infoCommand)
  const data = JSON.parse(infoResult)
  
  // 提取封面图片
  const coverCommand = `ffmpeg -i "${filePath}" -an -vcodec copy -f image2pipe - | base64`
  const coverResult = await execPromise(coverCommand)
  
  return {
    title: data.format.tags?.title,
    artist: data.format.tags?.artist,
    album: data.format.tags?.album,
    duration: data.format.duration,
    cover: `data:image/jpeg;base64,${coverResult}`
  }
}
```

**三层降级策略**：

```
第一层：FFprobe（推荐，需要安装 FFmpeg）
   ↓ 失败
第二层：轻量级纯 JS 解析（无需外部依赖）
   ↓ 失败
第三层：文件名推断（兜底）
```

这样即使 FFprobe 失败，至少也能获取艺术家名字。

---

### 难点4：Bangumi 爬虫与代理配置

**问题背景**：

动漫管理模块需要调用 Bangumi API，但：
1. Bangumi 网站在国外，直连不稳定
2. Docker 容器内无法直接使用系统代理

**解决方案**：

部署 Clash 代理：

```yaml
# docker-compose.clash.yml
services:
  clash:
    image: centralx/clash:latest
    ports:
      - "7890:7890"   # HTTP代理
      - "7891:7891"   # SOCKS5代理
    networks:
      - pr-network

networks:
  pr-network:
    external: true
```

**后端使用代理**：

```javascript
const { HttpsProxyAgent } = require('https-proxy-agent')
const axios = require('axios')

const agent = new HttpsProxyAgent(process.env.HTTP_PROXY || 'http://clash:7890')

const response = await axios.get('https://api.bgm.tv/search/xxx', {
  httpsAgent: agent,
  timeout: 15000
})
```

---

### 难点5：阅读进度保存问题

**问题背景**：

电子书阅读器在打开时会丢失进度：
1. 对话框打开时立即触发 `visibilitychange` 事件
2. 此时滚动位置还是初始值 0
3. 错误的初始值覆盖了正确进度

**解决方案**：

添加加载标志位：

```javascript
let isProgressLoaded = false

async function handleRead(row) {
  // 先加载进度
  const progress = await api.books.getProgress(row.id)
  
  // 恢复滚动位置
  if (progress) {
    scrollToPosition(progress.current_chapter)
  }
  
  // 进度加载完成后才设置 currentBook
  currentBook.value = row
  isProgressLoaded = true
}

function saveProgress() {
  if (!currentBook.value || !isProgressLoaded) return
  // 保存逻辑...
}
```

---

### 难点6：SQL查询的多个坑

**问题1：字符串引号错误**

```javascript
// ❌ 错误（SQLite把双引号当作标识符）
const sql = `SELECT * FROM music WHERE cover_image != ""`

// ✅ 正确（字符串用单引号）
const sql = `SELECT * FROM music WHERE cover_image != ''`
```

**问题2：路由顺序冲突**

```javascript
// ❌ 错误顺序（/:id 会匹配 /artists）
router.get('/:id/cover', ...)
router.get('/artists', ...)

// ✅ 正确顺序（具体路径在前）
router.get('/artists', ...)
router.get('/:id/cover', ...)
```

---

## 四、部署架构

### NAS 部署

选择在 NAS 上部署的原因：
- ✅ 24小时开机，随时访问
- ✅ 本地存储，数据安全
- ✅ 内网穿透，远程访问

**目录结构**：

```
/data/PersonalResourceManager/
├── db/                    # 数据库文件
├── docs/                  # 文档存储
├── music/                 # 音乐文件
├── books/                 # 电子书
├── uploads/               # 上传文件
├── backend/               # 后端代码
├── frontend/              # 前端代码
└── docker-compose.yml
```

**Docker Compose 配置**：

```yaml
version: '3.8'

services:
  backend:
    build: ./backend
    container_name: pr-manager-backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./db:/app/data/database
      - ./docs:/app/data/documents
      - ./music:/app/data/music
      - ./books:/app/data/books
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET}
      - HTTP_PROXY=http://clash:7890
    networks:
      - pr-network

  frontend:
    build: ./frontend
    container_name: pr-manager-frontend
    restart: unless-stopped
    ports:
      - "5173:80"
    depends_on:
      - backend
    networks:
      - pr-network

networks:
  pr-network:
    external: true
```

### 性能优化

1. **数据库索引**：
```sql
CREATE INDEX idx_documents_category ON documents(category);
CREATE INDEX idx_music_artist ON music(artist);
CREATE INDEX idx_blog_posts_status ON blog_posts(status);
```

2. **前端懒加载**：
```javascript
const cacheLoaded = ref(false)

async function loadData(forceReload = false) {
  if (!forceReload && cacheLoaded.value) return
  // 加载数据...
  cacheLoaded.value = true
}

onActivated(() => {
  if (!cacheLoaded.value) loadData()
})
```

3. **后端统计优化**：
```javascript
// 使用 COUNT 查询，性能远高于加载全部数据
app.get('/api/stats', (req, res) => {
  const stats = {
    documents: db.prepare('SELECT COUNT(*) as count FROM documents').get()?.count || 0,
    music: db.prepare('SELECT COUNT(*) as count FROM music').get()?.count || 0,
    blog: {
      total: db.prepare('SELECT COUNT(*) as count FROM blog_posts').get()?.count || 0,
      published: db.prepare("SELECT COUNT(*) as count FROM blog_posts WHERE status = 'published'").get()?.count || 0
    }
  }
  res.json({ data: stats })
})
```

---

## 五、未来规划

### 待实现功能

1. **全文搜索**：集成 SQLite FTS5 全文搜索引擎
2. **移动端适配**：响应式设计，支持手机访问
3. **多用户支持**：用户隔离，权限管理
4. **数据导出**：支持导出为 Markdown/JSON
5. **API 开放**：提供公开 API，支持第三方集成

### 技术改进

1. **后端重构**：考虑使用 Fastify 提升性能
2. **数据库迁移**：考虑 PostgreSQL（如果数据量增长）
3. **缓存层**：引入 Redis 缓存热点数据
4. **监控告警**：集成 Prometheus + Grafana

---

## 六、总结

### 项目成果

通过这个项目，我收获了很多：

1. ✅ **全栈开发能力**：从前端到后端到部署，完整闭环
2. ✅ **数据库设计经验**：从表结构到索引优化
3. ✅ **Docker 实践**：容器化部署、网络配置
4. ✅ **问题解决能力**：遇到问题独立分析和解决

### 技术心得

1. **技术选型很重要**：选择成熟稳定的技术栈，避免踩坑
2. **架构设计要留余地**：考虑未来扩展性
3. **代码质量要重视**：注释、文档、测试缺一不可
4. **用户体验要关注**：性能优化、交互细节

### 开源分享

如果你也想搭建类似的系统，希望这篇文章能给你一些启发！

---

**最后更新时间**：2026-03-27
**项目状态**：✅ 持续开发中

---

## 附录：关键文件索引

### 前端核心文件
- `frontend/src/views/Blog.vue` - 博客管理组件
- `frontend/src/views/Documents.vue` - 文档管理组件
- `frontend/src/views/Music.vue` - 音乐管理组件
- `frontend/src/views/Books.vue` - 书籍阅读器
- `frontend/src/components/MediaPlayer.vue` - 全局音乐播放器

### 后端核心文件
- `backend/src/routes/blog.js` - 博客API
- `backend/src/routes/documents.js` - 文档API
- `backend/src/routes/music.js` - 音乐API（含 FFprobe 解析）
- `backend/src/routes/anime.js` - 动漫爬虫
- `backend/src/config/database.js` - 数据库初始化

### 配置文件
- `docker-compose.yml` - 主部署配置
- `docker-compose.clash.yml` - 代理配置
- `.env` - 环境变量

### 文档文件
- `docs/DATABASE_SCHEMA.md` - 数据库表结构
- `docs/CLASH_DEPLOYMENT.md` - 代理部署指南
- `docs/FFMPEG_SETUP.md` - FFmpeg 安装说明
- `docs/ALL_FIXES_SUMMARY.md` - 问题修复总结
