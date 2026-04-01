# 书籍管理模块

## 一、功能概述

书籍管理模块提供完整的电子书管理功能，支持多格式电子书（TXT、EPUB、PDF）、分片上传、内置阅读器、阅读进度同步和资源搜索。

## 二、数据库结构

### 1. book_categories 表（书籍分类表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 分类名称，唯一 |
| sort_order | INTEGER | 排序顺序，默认 0 |
| created_at | DATETIME | 创建时间 |

### 2. books 表（书籍主表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 书名，必填 |
| author | TEXT | 作者 |
| year | TEXT | 出版年份 |
| publisher | TEXT | 出版社 |
| isbn | TEXT | ISBN 编号 |
| description | TEXT | 书籍简介 |
| cover_image | TEXT | 封面图片路径 |
| category_id | INTEGER | 分类 ID，外键 |
| file_path | TEXT | 文件存储路径，必填 |
| file_type | TEXT | 文件类型（txt/epub/pdf） |
| file_size | INTEGER | 文件大小（字节） |
| total_pages | INTEGER | 总页数 |
| content_cache | TEXT | EPUB 解析内容缓存（JSON） |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |
| last_read_at | DATETIME | 最后阅读时间 |

### 3. reading_progress 表（阅读进度表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| book_id | INTEGER | 书籍 ID，唯一，外键级联删除 |
| current_page | INTEGER | 当前章节索引 |
| current_chapter | TEXT | 滚动位置（0-1） |
| progress | REAL | 总体进度百分比 |
| font_size | INTEGER | 字体大小，默认 16 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 4. book_chapters 表（书籍目录表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| book_id | INTEGER | 书籍 ID，外键级联删除 |
| title | TEXT | 章节标题 |
| chapter_index | INTEGER | 章节索引 |
| start_position | INTEGER | 起始位置 |
| created_at | DATETIME | 创建时间 |

---

## 三、后端 API 接口

**路由文件**: `backend/src/routes/books.js`

### 分类管理 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/ebooks/categories` | 获取分类列表 | - | `{ data: [{ id, name, sortOrder, bookCount }] }` |
| POST | `/ebooks/categories` | 创建分类 | `{ name }` | `{ id, message }` |
| PUT | `/ebooks/categories/:id` | 重命名分类 | `{ name }` | `{ message }` |
| DELETE | `/ebooks/categories/:id` | 删除分类 | - | `{ message }` |
| PUT | `/ebooks/categories/reorder` | 更新分类排序 | `{ orders: [{ id, sortOrder }] }` | `{ message }` |

### 书籍管理 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/ebooks` | 获取书籍列表 | `keyword, category, sortBy, sortOrder` | `{ data: [书籍对象数组] }` |
| POST | `/ebooks/upload` | 上传书籍（单文件） | `file` + 表单字段 | `{ id, title, message }` |
| POST | `/ebooks/upload-with-path` | 使用文件路径创建书籍 | `filePath` + 元数据 | `{ id, title, message }` |
| PUT | `/ebooks/:id` | 更新书籍信息 | `title, author, year, publisher, isbn, description, categoryId` | `{ message }` |
| DELETE | `/ebooks/:id` | 删除书籍 | - | `{ message }` |
| POST | `/ebooks/batch-delete` | 批量删除书籍 | `{ ids: [id数组] }` | `{ message }` |

### 分片上传 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| POST | `/ebooks/upload-chunk` | 上传分片 | `chunk, index, totalChunks, fileId, fileName` | `{ message, index }` |
| POST | `/ebooks/merge-chunks` | 合并分片 | `fileId, fileName, totalChunks` | `{ data: { 元数据 } }` |
| DELETE | `/ebooks/cancel-upload` | 取消上传 | `{ fileId }` | `{ message }` |
| POST | `/ebooks/parse-metadata` | 解析书籍元数据 | `file` | `{ data: { 元数据 } }` |

### 阅读器 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/ebooks/:id/content` | 获取书籍内容 | `token` (query/header) | TXT: `{ content, totalPages, fileType, title }` / EPUB: `{ chapters, toc, fileType, title }` / PDF: `{ filePath, totalPages, fileType, title }` |
| GET | `/ebooks/:id/progress` | 获取阅读进度 | - | `{ currentPage, scrollPosition, progress, fontSize }` |
| POST | `/ebooks/:id/progress` | 保存阅读进度 | `{ currentPage, scrollPosition, progress, fontSize }` | `{ message }` |
| DELETE | `/ebooks/:id/cache` | 清除书籍缓存 | - | `{ message }` |
| GET | `/ebooks/:id/resource` | 获取 EPUB 资源 | `path, token` | 资源文件（图片/CSS/字体） |
| GET | `/ebooks/:id/cover` | 获取封面图片 | - | 图片文件 |
| GET | `/ebooks/download/:id` | 下载书籍 | - | 文件流 |

### 书籍搜索 API

**路由文件**: `backend/src/routes/bookSearch.js`

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/book-search/config` | 获取搜索配置 | - | `{ success, data: { annaArchiveDomain, nyaaDomain } }` |
| PUT | `/book-search/config` | 更新搜索配置 | `{ annaArchiveDomain, nyaaDomain }` | `{ success, message, data }` |
| GET | `/book-search/test-domain` | 测试域名连通性 | `domain` | `{ success, domain, available, message }` |
| GET | `/book-search/search` | 统一搜索 | `keyword, source` | `{ success, keyword, total, data: { annaArchive: [], nyaa: [], errors: [] } }` |

---

## 四、前端页面功能

### 1. 搜索与排序

- **搜索功能**：支持按书名、作者关键词搜索
- **排序方式**：最近阅读、书名、作者、年份、上传时间
- **排序顺序**：升序/降序切换
- **视图模式**：封面视图 / 列表视图切换

### 2. 分类管理

- **分类展示**：网格布局展示分类卡片
- **创建分类**：弹窗创建新分类
- **重命名分类**：编辑分类名称
- **删除分类**：删除分类（书籍的 category_id 设为 null）
- **拖拽排序**：支持拖拽调整分类顺序

### 3. 书籍列表

- **列表视图**：表格展示书籍信息，支持多选、批量删除
- **封面视图**：网格卡片展示，显示封面、书名、作者、阅读进度

### 4. 上传功能

- **普通上传**：支持小文件直接上传
- **分片上传**：大于 100MB 的文件自动分片上传（5MB/片）
- **元数据解析**：EPUB 文件自动解析元数据（书名、作者、出版社等）
- **封面提取**：EPUB 文件自动提取封面图片
- **进度显示**：实时显示上传进度

### 5. 阅读器功能

#### 多格式支持

| 格式 | 处理方式 |
|------|---------|
| TXT | 按字符数分页显示（约 2000 字符/页） |
| EPUB | 章节解析、目录导航、图片支持 |
| PDF | 返回文件路径，前端 PDF.js 处理 |

#### 阅读设置

- **字体大小**：12px - 32px 调节
- **字体选择**：宋体 / 黑体 / 楷体
- **仿真纸张**：背景样式

#### 目录导航

- 可折叠侧边栏
- 点击目录跳转章节
- 章节上下翻页

#### 进度保存

- 当前章节索引
- 章节内滚动位置（0-1）
- 总体阅读进度
- 字体设置

#### 自动保存策略

- 滚动防抖保存（500ms）
- 关闭阅读器保存
- 页面卸载保存
- 标签页切换保存

### 6. 资源搜索

- **多源搜索**：安娜档案 + Nyaa（轻小说/漫画）
- **域名配置**：可自定义搜索源域名
- **连通性测试**：测试域名是否可访问
- **结果展示**：显示标题、格式、大小、做种数等

---

## 五、技术实现细节

### 1. 电子书格式支持

#### TXT 文件处理

```javascript
// 按字符数分页（约 2000 字符/页）
const CHARS_PER_PAGE = 2000
const totalPages = Math.ceil(content.length / CHARS_PER_PAGE)

// 返回完整内容
res.json({
  content,      // 完整文本
  totalPages,   // 总页数
  fileType: 'txt',
  title: book.title
})
```

#### EPUB 文件处理

```javascript
// 使用 adm-zip 解压 EPUB（ZIP 格式）
const zip = new AdmZip(filePath)

// 解析 META-INF/container.xml 定位 OPF 文件
const containerXml = zip.readAsText('META-INF/container.xml')
const rootfile = parseContainerXml(containerXml)

// 从 OPF 文件提取元数据
const opfContent = zip.readAsText(rootfile)
const metadata = parseOpfMetadata(opfContent)

// 解析 spine 和 manifest 构建章节顺序
const chapters = parseSpineAndManifest(opfContent, zip)

// 支持 NCX（EPUB2）和 NAV（EPUB3）目录格式
const toc = parseToc(zip, metadata)

// 处理章节内图片路径转换为 API 调用
const processChapterContent = (content, bookId) => {
  return content.replace(/src="([^"]+)"/g, (match, src) => {
    const absolutePath = resolvePath(src)
    return `src="/api/ebooks/${bookId}/resource?path=${absolutePath}&token=${token}"`
  })
}

// 内容缓存到数据库避免重复解析
db.prepare('UPDATE books SET content_cache = ? WHERE id = ?')
  .run(JSON.stringify({ chapters, toc }), bookId)
```

#### 封面提取逻辑

```javascript
// 封面查找顺序:
// 1. OPF 文件中 meta 元素的 cover 属性 -> manifest 查找对应 href
const coverMeta = opfDom('meta[name="cover"]')
if (coverMeta) {
  const coverId = coverMeta.attr('content')
  const coverItem = manifest.find(item => item.id === coverId)
  if (coverItem) return coverItem.href
}

// 2. 直接匹配常见封面文件名
const commonCoverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'Cover.jpg']
for (const name of commonCoverNames) {
  if (fileExists(name)) return name
}

// 3. 查找包含 'cover' 关键词的图片
const coverFile = files.find(f => /cover/i.test(f) && /\.(jpg|jpeg|png)$/i.test(f))
if (coverFile) return coverFile

// 4. 使用 ZIP 中第一个图片作为封面
const firstImage = files.find(f => /\.(jpg|jpeg|png)$/i.test(f))
return firstImage
```

#### PDF 文件处理

```javascript
// 返回文件路径，前端使用 PDF.js 渲染
res.json({
  filePath: `/api/ebooks/${bookId}/download`,
  totalPages: pdfPageCount,
  fileType: 'pdf',
  title: book.title
})
```

### 2. 分片上传实现

```javascript
// 前端实现要点
const CHUNK_SIZE = 5 * 1024 * 1024  // 5MB

// 分片命名
const chunkFileName = `chunk_${index}`

// 上传分片
for (let i = 0; i < totalChunks; i++) {
  const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
  await uploadChunk(chunk, i, totalChunks, fileId, fileName)
}

// 合并验证
const mergeResponse = await mergeChunks(fileId, fileName, totalChunks)

// 后端实现要点
// 临时目录
const chunksDir = path.join(getStoragePath('books'), 'chunks', fileId)

// 保存分片
const chunkPath = path.join(chunksDir, `chunk_${index}`)
fs.writeFileSync(chunkPath, chunk)

// 合并策略
const chunks = []
for (let i = 0; i < totalChunks; i++) {
  const chunkPath = path.join(chunksDir, `chunk_${i}`)
  chunks.push(fs.readFileSync(chunkPath))
}
const finalBuffer = Buffer.concat(chunks)

// 元数据解析（EPUB）
const metadata = await parseEpubMetadata(finalBuffer)
```

### 3. 阅读进度追踪

```javascript
// 进度计算公式
const progress = (currentChapterIndex / totalChapters + scrollPosition / totalChapters) * 100

// 保存策略
// 1. 滚动事件防抖（500ms）自动保存
let saveTimeout
reader.addEventListener('scroll', () => {
  clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => saveProgress(), 500)
})

// 2. 章节切换立即保存
function goToChapter(index) {
  saveProgress()
  currentChapter.value = index
}

// 3. 关闭阅读器保存
onBeforeUnmount(() => {
  saveProgress()
})

// 4. 页面卸载使用 fetch + keepalive 保存
window.addEventListener('beforeunload', () => {
  fetch('/api/ebooks/' + bookId + '/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(progressData),
    keepalive: true
  })
})

// 5. 标签页切换到后台保存
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isReaderOpen) {
    saveProgress()
  }
})
```

### 4. EPUB 资源处理

```javascript
// 图片路径转换
// 原始路径: ../images/cover.jpg
// 转换后: /api/ebooks/{bookId}/resource?path=OEBPS/images/cover.jpg&token={token}

// 资源获取 API
router.get('/:id/resource', authenticateToken, (req, res) => {
  const { path, token } = req.query
  const book = getBook(req.params.id)
  
  // 从 EPUB 文件中提取资源
  const zip = new AdmZip(book.file_path)
  const resourcePath = resolveResourcePath(path, book.contentRoot)
  const resource = zip.readFile(resourcePath)
  
  // 根据扩展名设置 Content-Type
  const ext = path.extname(resourcePath).toLowerCase()
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf'
  }
  
  res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream')
  res.send(resource)
})
```

### 5. 时间转换

```javascript
// UTC 转 UTC+8
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  const date = new Date(utcTime + 'Z')  // 添加 Z 表示 UTC
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)  // 加 8 小时
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hours = String(utc8Date.getHours()).padStart(2, '0')
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}
```

---

## 六、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/books.js` |
| 书籍搜索 | `backend/src/routes/bookSearch.js` |
| 数据库配置 | `backend/src/config/database.js` |
| 前端视图 | `frontend/src/views/Books.vue` |
| 搜索组件 | `frontend/src/components/BookSearchDialog.vue` |
| API 定义 | `frontend/src/api/index.js` |

---

## 七、配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATA_PATH` | 数据存储根目录 | - |
| `DB_PATH` | 数据库文件路径 | `{DATA_PATH}/database/app.db` |

### 存储结构

```
{DATA_PATH}/
├── database/
│   └── app.db
└── books/
    ├── {timestamp}-{random}.{ext}
    └── chunks/
        └── {fileId}/
            ├── chunk_0
            ├── chunk_1
            └── ...
```

---

## 八、使用说明

### 1. 上传书籍

1. 点击"上传书籍"按钮
2. 选择 EPUB/PDF/TXT 文件
3. 系统自动解析元数据（EPUB）
4. 可手动修改书名、作者等信息
5. 选择分类
6. 大文件自动分片上传

### 2. 阅读书籍

- 封面视图：点击卡片进入阅读器
- 列表视图：点击行进入阅读器
- 自动恢复上次阅读进度
- 支持目录导航、字体调节

### 3. 管理进度

- 自动保存阅读进度
- 支持跨设备同步
- 最近阅读排序

### 4. 搜索资源

1. 点击"搜索资源"按钮
2. 输入关键词搜索
3. 支持安娜档案和 Nyaa 两个源
4. 可自定义域名

---

## 九、注意事项

1. **大文件上传**：超过 100MB 自动分片上传，确保网络稳定
2. **EPUB 缓存**：首次打开较慢（解析），后续读取缓存
3. **进度保存**：关闭页面前确保进度已保存（自动保存有延迟）
4. **PDF 阅读器**：PDF 文件使用前端 PDF.js 渲染，可能存在兼容性问题
5. **数据库备份**：定期备份 `app.db` 文件
6. **存储空间**：EPUB 文件解压后可能增大，注意磁盘空间
7. **悬停提示**：表格书名列使用浏览器原生 title 属性，章节目录也使用原生提示，避免样式冲突
