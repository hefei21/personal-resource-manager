# 文档管理模块

## 一、功能概述

文档管理模块提供完整的文档管理功能，支持多层级分类、文件上传、在线预览、版本管理和私密空间。

## 二、数据库结构

### 1. documents 表（文档主表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 文档标题，必填 |
| category | TEXT | 根分类名称 |
| subcategory | TEXT | 子分类路径（支持多层级） |
| tags | TEXT | 标签，逗号分隔 |
| file_path | TEXT | 文件存储路径，必填 |
| version | REAL | 版本号，默认 1.0 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 2. categories 表（分类表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 分类名称 |
| parent_id | INTEGER | 父分类 ID（支持多层级） |
| path | TEXT | 分类完整路径（如：工作/项目/文档） |
| level | INTEGER | 层级深度，默认 0 |
| sort_order | INTEGER | 排序顺序，默认 0 |
| created_at | DATETIME | 创建时间 |

### 3. document_versions 表（文档版本表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| document_id | INTEGER | 文档 ID，外键级联删除 |
| version | INTEGER | 版本号 |
| file_path | TEXT | 版本文件路径 |
| note | TEXT | 版本说明 |
| created_at | DATETIME | 创建时间 |

### 4. private_documents 表（私密文件表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 文件标题 |
| file_path | TEXT | 文件路径 |
| size | INTEGER | 文件大小 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 5. private_settings 表（私密空间密码表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，固定为 1 |
| password | TEXT | 密码哈希值 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

---

## 三、后端 API 接口

**路由文件**: `backend/src/routes/documents.js`

### 分类管理 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/documents/categories` | 获取分类列表 | - | `{ data: [{ id, name, path, sortOrder, subcategories }] }` |
| GET | `/documents/categories/tree` | 获取分类树 | - | `{ data: [树形结构] }` |
| POST | `/documents/categories` | 创建分类 | `{ name, parentId }` | `{ id, message }` |
| PUT | `/documents/categories/:id` | 重命名分类 | `{ name }` | `{ message, newPath }` |
| DELETE | `/documents/categories/:id` | 删除分类 | `deleteFiles` (query) | `{ message, deletedCategories }` |
| PUT | `/documents/categories/reorder` | 更新分类排序 | `{ orders: [{ id, sortOrder }] }` | `{ message }` |

### 文档管理 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| GET | `/documents` | 获取文档列表 | `keyword, category, subcategory, tag` | `{ data: [文档数组] }` |
| GET | `/documents/:id` | 获取单个文档 | - | `{ data: 文档对象 }` |
| POST | `/documents` | 创建文档记录 | `{ title, category, subcategory, tags, filePath }` | `{ id, message }` |
| POST | `/documents/upload` | 上传文档文件 | `file` + 表单字段 | `{ id, title, message }` |
| PUT | `/documents/:id` | 更新文档信息 | `{ title, category, subcategory, tags }` | `{ message }` |
| PUT | `/documents/batch/update` | 批量更新文档 | `{ ids, category, subcategory, tags }` | `{ message }` |
| DELETE | `/documents/:id` | 删除文档 | - | `{ message }` |
| GET | `/documents/:id/content` | 获取文档内容 | `token` (query/header) | `{ content/filePath, fileType, isBase64 }` |
| PUT | `/documents/:id/content` | 更新文档内容 | `{ content }` | `{ message }` |
| GET | `/documents/:id/versions` | 获取版本历史 | - | `{ data: [版本数组] }` |
| GET | `/documents/tags` | 获取标签列表 | - | `{ data: [标签数组] }` |
| GET | `/documents/check-duplicate` | 检查重名 | `title, category, subcategory, excludeId` | `{ duplicate, suggestedTitle }` |

### 私密空间 API

| 方法 | 路由 | 功能 | 参数 | 返回值 |
|------|------|------|------|--------|
| POST | `/documents/private/verify-password` | 验证密码 | `{ password }` | `{ valid }` |
| POST | `/documents/private/change-password` | 修改密码 | `{ oldPassword, newPassword }` | `{ message }` |
| GET | `/documents/private/list` | 获取私密文件列表 | - | `{ data: [文件数组] }` |
| POST | `/documents/private/upload` | 上传私密文件 | `file` + 表单 | `{ id, title, message }` |
| DELETE | `/documents/private/:id` | 删除私密文件 | - | `{ message }` |
| GET | `/documents/private/:id/content` | 获取私密文件内容 | `token` | 文件内容 |

---

## 四、前端页面功能

### 1. 分类管理

- **多层级分类树**：支持无限层级嵌套
- **拖拽排序**：支持分类卡片拖拽调整顺序
- **分类 CRUD**：创建、重命名、删除分类
- **删除选项**：删除分类时可选择是否同时删除文件
- **子分类导航**：点击分类可进入子分类层级

### 2. 文档列表

- **视图模式**：表格视图 / 卡片视图切换
- **搜索过滤**：按标题、分类、标签搜索
- **批量操作**：多选、批量移动、批量删除
- **排序方式**：
  - 下拉栏排序：标题、文件类型、更新时间
  - 表头排序：支持点击表头排序（与下拉栏双向同步）
  - 取消排序：点击表头取消排序，恢复默认排序
- **分页显示**：支持分页浏览

### 3. 文档上传

- **文件限制**：最大 50MB
- **重复检测**：上传前检测同名文件，自动建议新名称
- **分类选择**：支持选择分类和子分类
- **标签添加**：支持添加多个标签

### 4. 文档预览

**支持的格式**：

| 格式 | 预览方式 |
|------|---------|
| PDF | PDF.js 渲染，支持缩放、翻页 |
| 图片 | 直接显示（jpg, png, gif, webp） |
| Office 文档 | 返回 base64 编码（doc, docx, xls, xlsx, ppt, pptx） |
| 文本文件 | 直接显示内容（txt, md） |
| 压缩文件 | 返回 base64 编码（zip, rar, 7z） |

### 5. 文档编辑

- **元数据编辑**：修改标题、分类、标签
- **内容编辑**：文本文件支持在线编辑
- **版本管理**：每次保存创建新版本，支持查看历史版本

### 6. 私密空间

- **密码保护**：需要密码才能访问
- **独立存储**：私密文件单独存储
- **密码管理**：支持修改密码
- **文件管理**：上传、删除、预览私密文件

---

## 五、前端架构

### PC/移动端分离架构

采用条件渲染方式实现响应式适配：

**主入口文件** (`frontend/src/views/Documents.vue`):
```vue
<template>
  <DocumentsMobile v-if="isMobile" />
  <div v-else class="documents">
    <!-- PC端内容 -->
  </div>
</template>
```

**PC端组件** (`frontend/src/pc/pages/DocumentsPC.vue`):
- 分类树形侧边栏
- 表格/卡片双视图
- 批量操作功能
- 拖拽排序支持

**移动端组件** (`frontend/src/mobile/pages/DocumentsMobile.vue`):
- 分类下拉选择
- 卡片列表布局
- 底部操作栏
- 滑动删除支持

---

## 六、技术实现细节

### 1. 多层级分类结构

```javascript
// 分类路径格式示例
// 根分类: "工作"
// 一级子分类: "工作/项目"
// 二级子分类: "工作/项目/文档"

// 数据库查询示例
// 获取分类及其所有子分类
SELECT * FROM categories 
WHERE path LIKE '工作/%' OR path = '工作'
ORDER BY level, sort_order, name
```

### 2. 文件上传处理

```javascript
// Multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getStoragePath('uploads'))
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + path.extname(file.originalname))
  }
})

// 文件大小限制
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
})
```

### 3. 文档预览实现

```javascript
// 二进制文件处理
const binaryFormats = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z']

// PDF 预览
if (ext === 'pdf') {
  // 返回文件路径，前端使用 PDF.js 渲染
  res.json({ filePath, fileType: 'pdf', totalPages })
}

// Office 文档
if (binaryFormats.includes(ext)) {
  // 返回 base64 编码数据
  const fileBuffer = fs.readFileSync(filePath)
  const base64Data = fileBuffer.toString('base64')
  res.json({
    content: base64Data,
    isBase64: true,
    fileType: ext
  })
}

// 文本文件
if (['txt', 'md'].includes(ext)) {
  const content = fs.readFileSync(filePath, 'utf-8')
  res.json({ content, fileType: ext })
}
```

### 4. 版本管理

```javascript
// 创建新版本
const currentVersion = doc.version
const newVersion = Math.floor(currentVersion) + 1

// 保存版本记录
db.prepare(`
  INSERT INTO document_versions (document_id, version, file_path, note)
  VALUES (?, ?, ?, ?)
`).run(docId, newVersion, oldFilePath, note)

// 更新文档版本
db.prepare(`
  UPDATE documents SET version = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`).run(newVersion, newFilePath, docId)
```

### 5. 表格排序功能

#### 双向同步实现

```javascript
// 字段映射：列 colKey -> 后端字段名
const sortFieldMap = {
  'title': 'title',
  'type': 'file_type',
  'updatedAt': 'updated_at'
}

// 反向映射：后端字段名 -> 列 colKey
const sortColKeyMap = {
  'title': 'title',
  'file_type': 'type',
  'updated_at': 'updatedAt'
}

// 计算表格排序状态（双向同步）
const tableSort = computed(() => {
  const colKey = sortColKeyMap[sortBy.value]
  if (!colKey) {
    // 下拉栏选择的是表头没有的字段，清空表头高亮
    return null
  }
  return {
    sortBy: colKey,
    descending: sortOrder.value === 'desc'
  }
})
```

#### 处理表头排序

```javascript
function handleSortChange(context) {
  const sort = context?.sort || context

  if (!sort || !sort.sortBy) {
    // 取消排序时，恢复默认排序（更新时间降序）
    sortBy.value = 'updated_at'
    sortOrder.value = 'desc'
    pagination.value.current = 1
    loadDocuments()
    return
  }

  // 正常排序处理
  const field = sortFieldMap[sort.sortBy] || sort.sortBy
  sortBy.value = field
  sortOrder.value = sort.descending ? 'desc' : 'asc'
  pagination.value.current = 1
  loadDocuments()
}
```

#### 效果
- ✅ 表头点击排序生效
- ✅ 再次点击取消排序，恢复默认
- ✅ 下拉栏选择同步表头高亮
- ✅ 下拉栏选择"更新时间"，表头无高亮

---

### 6. 拖拽排序实现

```javascript
// 前端拖拽实现
const handleDragStart = (e, category) => {
  draggedCategory.value = category
  e.dataTransfer.effectAllowed = 'move'
}

const handleDrop = (e, targetCategory) => {
  e.preventDefault()
  // 调用 API 更新排序
  await api.documents.reorderCategories(newOrders)
}

// 后端批量更新排序
const updateStmt = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
const transaction = db.transaction((items) => {
  items.forEach(item => {
    updateStmt.run(item.sortOrder, item.id)
  })
})
transaction(orders)
```

### 6. 时间转换

```javascript
// UTC 转 UTC+8（用于显示时间）
function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  const date = new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hours = String(utc8Date.getHours()).padStart(2, '0')
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}
```

### 7. 分类删除逻辑

```javascript
// 删除分类时的两种模式：

// 1. 删除文件模式
// - 删除所有子分类
// - 删除所有相关文档
// - 删除物理文件

// 2. 保留文件模式
// - 将文档的 category/subcategory 设为父分类或 null
// - 只删除分类记录，不删除文件
```

---

## 七、配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATA_PATH` | 数据存储根目录 | - |
| `DB_PATH` | 数据库文件路径 | `{DATA_PATH}/database/app.db` |
| `PRIVATE_PASSWORD` | 私密空间默认密码 | `123456` |

### 存储结构

```
{DATA_PATH}/
├── database/
│   └── app.db
├── uploads/
│   └── {timestamp}-{random}.{ext}
└── private/
    └── {timestamp}-{random}.{ext}
```

---

## 八、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/documents.js` |
| 数据库配置 | `backend/src/config/database.js` |
| 存储配置 | `backend/src/config/storage.js` |
| 前端入口 | `frontend/src/views/Documents.vue` |
| PC端视图 | `frontend/src/pc/pages/DocumentsPC.vue` |
| Mobile端视图 | `frontend/src/mobile/pages/DocumentsMobile.vue` |
| API 定义 | `frontend/src/api/index.js` |

---

## 九、使用说明

### 1. 创建分类

1. 点击"新建分类"按钮
2. 输入分类名称
3. （可选）选择父分类创建子分类
4. 点击确认创建

### 2. 上传文档

1. 点击"上传文档"按钮
2. 选择文件（最大 50MB）
3. 填写标题、选择分类、添加标签
4. 系统检测重名并建议新名称
5. 点击确认上传

### 3. 预览文档

- 表格视图：点击行可预览
- 卡片视图：点击卡片可预览
- PDF 文件使用 PDF.js 渲染
- Office 文档返回 base64 数据

### 4. 私密空间

1. 点击"私密空间"按钮
2. 输入密码（默认：123456）
3. 管理私密文件

### 5. 批量操作

1. 勾选多个文档
2. 点击"批量移动"或"批量删除"
3. 选择目标分类或确认删除

---

## 十、注意事项

1. **文件大小限制**：单文件最大 50MB，超过限制需拆分或压缩
2. **分类删除**：删除分类前确认是否需要同时删除文件
3. **版本管理**：编辑文档会创建新版本，注意磁盘空间
4. **私密空间**：牢记密码，密码丢失无法恢复
5. **数据库备份**：定期备份 `app.db` 文件
