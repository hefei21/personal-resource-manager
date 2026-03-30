# 音乐管理模块

## 一、功能概述

音乐管理模块提供音乐文件的上传、管理、播放功能，支持大文件分片上传、断点续传、元数据解析、封面提取、歌单管理等高级功能。

## 二、数据库结构

### 1. music 表（音乐主表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 歌曲标题，必填 |
| artist | TEXT | 艺术家 |
| album | TEXT | 专辑名称 |
| duration | INTEGER | 时长（秒） |
| file_path | TEXT | 文件存储路径，必填 |
| file_size | INTEGER | 文件大小（字节） |
| file_type | TEXT | 文件类型（mp3, flac 等） |
| cover_image | TEXT | 封面图片（base64） |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 2. playlists 表（歌单表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 歌单名称，唯一 |
| description | TEXT | 歌单描述 |
| cover_image | TEXT | 歌单封面（base64） |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 3. playlist_songs 表（歌单歌曲关联表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| playlist_id | INTEGER | 歌单 ID，外键级联删除 |
| music_id | INTEGER | 音乐 ID，外键级联删除 |
| sort_order | INTEGER | 排序顺序 |
| added_at | DATETIME | 添加时间 |

---

## 三、后端 API 接口

**路由文件**: `backend/src/routes/music.js`

### 分片上传 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| POST | `/start-upload` | 开始上传会话 | `{ fileId, fileName, fileSize, totalChunks }` |
| POST | `/upload-chunk` | 上传分片 | `fileId`, `chunkIndex`, `totalChunks`, `fileName`, `chunk` |
| POST | `/merge-chunks` | 合并分片 | `{ fileId, fileName, totalChunks, skipDuplicate }` |
| DELETE | `/cancel-upload` | 取消上传 | `{ fileId }` |
| DELETE | `/cancel-all-uploads` | 取消所有上传 | - |
| GET | `/upload-progress` | 获取上传进度 | - |
| GET | `/upload-status/:fileId` | 获取单个文件状态 | - |
| POST | `/check-duplicate` | 检查文件重复 | `{ fileName, fileSize, fileHash }` |

### 音乐管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/` | 获取音乐列表 | `keyword`, `artist`, `album`, `sortBy`, `sortOrder`, `page`, `pageSize` |
| GET | `/all-ids` | 获取所有音乐 ID | `keyword`, `artist`, `album` |
| GET | `/artists` | 获取艺术家列表 | - |
| GET | `/albums` | 获取专辑列表 | - |
| GET | `/:id/cover` | 获取音乐封面 | - |
| PUT | `/:id` | 更新音乐信息 | `{ title, artist, album, coverImage }` |
| DELETE | `/:id` | 删除音乐 | - |
| POST | `/batch-delete` | 批量删除 | `{ ids }` |
| POST | `/:id/reparse` | 重新解析元数据 | - |
| GET | `/duplicates` | 查找重复音乐 | - |
| POST | `/remove-duplicates` | 删除重复音乐 | - |
| GET | `/play/:id` | 播放音乐 | `token`（query/header） |

### 歌单管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/playlists` | 获取歌单列表 | - |
| POST | `/playlists` | 创建歌单 | `{ name, description }` |
| PUT | `/playlists/:id` | 更新歌单 | `{ name, description, coverImage }` |
| DELETE | `/playlists/:id` | 删除歌单 | - |
| GET | `/playlists/:id/songs` | 获取歌单歌曲 | - |
| POST | `/playlists/:id/songs` | 添加歌曲到歌单 | `{ songIds }` |
| DELETE | `/playlists/:id/songs/:songId` | 从歌单移除歌曲 | - |
| POST | `/playlists/:id/songs/batch-remove` | 批量移除歌曲 | `{ songIds }` |
| PUT | `/playlists/:id/songs/reorder` | 歌单歌曲排序 | `{ songOrders }` |

---

## 四、前端页面功能

### 1. 音乐列表

- **搜索过滤**：
  - 关键词搜索（标题、艺术家、专辑）
  - 艺术家筛选
  - 专辑筛选

- **排序方式**：
  - 添加时间（降序）
  - 歌名（升序）
  - 艺术家（升序）
  - 专辑（升序）
  - 时长（降序）
  - **智能排序方向**：不同字段有不同的默认排序方向

- **批量操作**：多选、批量删除、批量添加到歌单

- **搜索筛选**：
  - 关键词搜索
  - 艺术家筛选
  - 专辑筛选

- **排序方式**：
  - 标题排序（支持中文拼音）
  - 艺术家排序
  - 专辑排序
  - 创建时间排序
  - 时长排序

- **列表视图**：
  - 封面缩略图
  - 歌曲信息（标题、艺术家、专辑、时长）
  - 文件信息（格式、大小）
  - 操作按钮

### 2. 文件上传

**分片上传特性**：

- **大文件支持**：支持 100MB+ 文件上传
- **断点续传**：网络中断后可继续上传
- **进度恢复**：页面刷新后恢复上传进度
- **取消上传**：实时取消正在进行的上传

**上传流程**：

1. 选择文件
2. 检查重复
3. 创建上传会话
4. 分片上传（10MB/片）
5. 合并分片
6. 解析元数据

### 3. 音乐播放器

全局播放器组件：

- **播放控制**：
  - 播放/暂停
  - 上一曲/下一曲
  - 进度条拖动
  - 音量调节

- **播放模式**：
  - 单曲循环
  - 列表循环
  - 随机播放

- **播放列表**：
  - 当前播放列表显示
  - 点击切换歌曲
  - 从列表移除

### 4. 歌单管理

- **歌单 CRUD**：创建、编辑、删除歌单
- **歌曲管理**：添加、移除、排序
- **拖拽排序**：支持拖拽调整歌曲顺序

---

## 五、技术实现细节

### 1. 智能排序实现

```javascript
// 排序方向映射（常量）
const sortOrderMap = {
  'created_at': 'DESC',  // 添加时间降序（最新在前）
  'title': 'ASC',        // 歌名升序（A-Z）
  'artist': 'ASC',       // 艺术家升序（A-Z）
  'album': 'ASC',        // 专辑升序（A-Z）
  'duration': 'DESC'     // 时长降序（最长在前）
}

// 加载音乐列表
async function loadMusic() {
  const sortOrder = sortOrderMap[sortBy.value] || 'DESC'

  const response = await api.music.list({
    keyword: searchKeyword.value,
    artist: filterArtist.value,
    album: filterAlbum.value,
    sortBy: sortBy.value,
    sortOrder: sortOrder,
    page: pagination.value.current,
    pageSize: pagination.value.pageSize
  })
}
```

**特点**：
- 无需用户手动选择升序/降序
- 不同字段有合理的默认排序方向
- 简化用户操作

---

### 2. 分片上传实现

```javascript
// 分片大小：10MB
const CHUNK_SIZE = 10 * 1024 * 1024

// 上传流程
async function uploadFile(file) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  
  // 1. 开始上传会话
  await api.music.startUpload({ fileId, fileName: file.name, fileSize: file.size, totalChunks })
  
  // 2. 分片上传
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const chunk = file.slice(start, end)
    
    const formData = new FormData()
    formData.append('fileId', fileId)
    formData.append('chunkIndex', i)
    formData.append('totalChunks', totalChunks)
    formData.append('fileName', file.name)
    formData.append('chunk', chunk)
    
    await api.music.uploadChunk(formData)
  }
  
  // 3. 合并分片
  await api.music.mergeChunks({ fileId, fileName: file.name, totalChunks })
}
```

### 2. 元数据解析（三层降级策略）

```javascript
// 第一层：FFprobe（最可靠）
async function parseWithFFprobe(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
    { timeout: 10000 }
  )
  const data = JSON.parse(stdout)
  return {
    title: data.format.tags?.title,
    artist: data.format.tags?.artist,
    album: data.format.tags?.album,
    duration: Math.round(data.format.duration),
    coverImage: await extractCover(filePath)
  }
}

// 第二层：轻量级纯 JS 解析
function parseMetadataLightweight(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase()
  if (ext === '.flac') {
    return parseFlacVorbisComments(buffer)
  } else if (ext === '.mp3') {
    return parseMp3Id3Tags(buffer)
  }
  return null
}

// 第三层：使用文件名
function parseFromFileName(originalName) {
  const baseName = path.basename(originalName, path.extname(originalName))
  return { title: baseName, artist: '', album: '' }
}
```

### 3. 中文拼音排序

```javascript
// 使用 Intl.Collator 实现中文拼音排序
const zhCollator = new Intl.Collator('zh-CN', { 
  sensitivity: 'base',
  numeric: true
})

// 排序
musicList.sort((a, b) => {
  return zhCollator.compare(a.title, b.title)
})
```

### 4. 断点续传实现

```javascript
// IndexedDB 存储上传状态
async function saveUploadState(fileId, file, totalChunks) {
  const db = await openIndexedDB()
  await db.put('uploads', {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    file: file,
    totalChunks,
    timestamp: Date.now()
  })
}

// 恢复上传进度
async function restoreUploadProgress() {
  const pendingUploads = await getAllPendingUploads()
  for (const upload of pendingUploads) {
    const status = await api.music.getUploadStatus(upload.fileId)
    if (status.status === 'uploading') {
      // 从已接收的分片继续上传
      const receivedChunks = status.receivedChunks
      for (let i = 0; i < upload.totalChunks; i++) {
        if (!receivedChunks.includes(i)) {
          await uploadChunk(upload.file, i)
        }
      }
    }
  }
}
```

---

## 六、配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATA_PATH` | 数据存储根目录 | `/app/data` |
| `FFMPEG_PATH` | FFmpeg 路径（如需指定） | 系统 PATH |

### 依赖要求

- **FFmpeg**：用于元数据解析和封面提取
- 参见 [FFMPEG_SETUP.md](./FFMPEG_SETUP.md)

### 存储结构

```
{DATA_PATH}/
├── music/
│   ├── {timestamp}-{random}.mp3
│   ├── {timestamp}-{random}.flac
│   └── temp/           # 临时分片目录
│       ├── {fileId}_0
│       ├── {fileId}_1
│       └── ...
└── database/
    └── app.db
```

---

## 七、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/music.js` |
| 前端视图 | `frontend/src/views/Music.vue` |
| 播放器组件 | `frontend/src/components/MediaPlayer.vue` |
| API 定义 | `frontend/src/api/index.js` |

---

## 八、使用说明

### 1. 上传音乐

1. 点击"上传音乐"按钮
2. 选择音乐文件（支持多选）
3. 系统自动检测重复
4. 显示上传进度
5. 上传完成自动解析元数据

### 2. 播放音乐

1. 点击歌曲列表中的播放按钮
2. 全局播放器开始播放
3. 可拖动进度条、调整音量
4. 切换播放模式

### 3. 创建歌单

1. 点击"新建歌单"按钮
2. 输入歌单名称和描述
3. 添加歌曲到歌单
4. 拖拽调整歌曲顺序

### 4. 管理音乐

- **编辑信息**：修改标题、艺术家、专辑
- **重新解析**：重新提取元数据
- **删除音乐**：同时删除文件和数据库记录
- **去重功能**：查找并删除重复音乐

---

## 九、注意事项

1. **文件大小**：建议单文件不超过 500MB
2. **格式支持**：MP3、FLAC、WAV、OGG、M4A、AAC、APE
3. **元数据解析**：
   - 优先使用 FFprobe（需安装 FFmpeg）
   - 降级使用纯 JS 解析
   - 最后使用文件名
4. **断点续传**：
   - 页面刷新后可能需要重新选择文件
   - 上传进度保存 60 分钟
5. **中文排序**：使用拼音排序，支持中文和英文混合
6. **封面提取**：自动提取嵌入的封面图片，存储为 base64
