# 文档管理模块

## 一、功能概述

文档管理模块提供文档的上传、分类、预览、编辑和版本管理功能，支持多层级分类结构和标签系统。

---

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

---

## 三、后端 API 接口

### 分类管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/documents/categories` | 获取分类列表 | - |
| GET | `/documents/categories/tree` | 获取分类树 | - |
| POST | `/documents/categories` | 创建分类 | `{ name, parentId }` |
| PUT | `/documents/categories/:id` | 重命名分类 | `{ name }` |
| DELETE | `/documents/categories/:id` | 删除分类 | `deleteFiles` (query) |
| PUT | `/documents/categories/reorder` | 更新分类排序 | `{ orders: [{ id, sortOrder }] }` |

### 文档管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/documents` | 获取文档列表 | `keyword, category, subcategory, tag` |
| GET | `/documents/:id` | 获取单个文档 | - |
| POST | `/documents` | 创建文档记录 | `{ title, category, subcategory, tags, filePath }` |
| POST | `/documents/upload` | 上传文档文件 | `file` + 表单字段 |
| PUT | `/documents/:id` | 更新文档信息 | `{ title, category, subcategory, tags }` |
| PUT | `/documents/batch/update` | 批量更新文档 | `{ ids, category, subcategory, tags }` |
| DELETE | `/documents/:id` | 删除文档 | - |
| GET | `/documents/:id/content` | 获取文档内容 | `token` (query) |
| PUT | `/documents/:id/content` | 更新文档内容 | `{ content }` |
| GET | `/documents/:id/versions` | 获取版本历史 | - |
| GET | `/documents/tags` | 获取标签列表 | - |
| GET | `/documents/check-duplicate` | 检查重名 | `title, category, subcategory, excludeId` |

### 私密空间 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| POST | `/documents/private/verify-password` | 验证密码 | `{ password }` |
| POST | `/documents/private/change-password` | 修改密码 | `{ oldPassword, newPassword }` |
| GET | `/documents/private/list` | 获取私密文件列表 | - |
| POST | `/documents/private/upload` | 上传私密文件 | `file` |
| DELETE | `/documents/private/:id` | 删除私密文件 | - |
| GET | `/documents/private/:id/content` | 获取私密文件内容 | `token` |

---

## 四、前端页面功能

### 1. 分类管理

- **多层级分类树**：支持无限层级嵌套
- **拖拽排序**：支持分类卡片拖拽调整顺序
- **分类 CRUD**：创建、重命名、删除分类
- **删除选项**：删除分类时可选择是否同时删除文件

### 2. 文档列表

- **视图模式**：表格视图 / 卡片视图切换
- **搜索过滤**：按标题、分类、标签搜索
- **批量操作**：多选、批量移动、批量删除
- **排序方式**：按名称、更新时间、分类排序

### 3. 文档上传

- **文件限制**：最大 50MB
- **重复检测**：上传前检测同名文件
- **自动命名**：重复文件自动添加后缀
- **分类选择**：支持选择分类和子分类

### 4. 文档预览

- **支持的格式**：
  - PDF：使用 PDF.js 渲染
  - 图片：直接显示
  - Office 文档：返回 base64 数据
  - 文本文件：直接显示内容
- **Office 文档**：通过 base64 编码传输

### 5. 私密空间

- **密码保护**：需要密码才能访问
- **独立存储**：私密文件单独存储
- **密码管理**：支持修改密码

---

## 五、技术实现细节

### 1. 多层级分类结构

```javascript
// 分类路径格式
// 根分类: "工作"
// 一级子分类: "工作/项目"
// 二级子分类: "工作/项目/文档"

// 数据库查询示例
// 获取分类及其所有子分类
SELECT * FROM categories WHERE path LIKE '工作/%' OR path = '工作'
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
limits: { fileSize: 50 * 1024 * 1024 } // 50MB
```

### 3. 文档预览

```javascript
// 二进制文件处理
const binaryFormats = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 
  'ppt', 'pptx', 'zip', 'rar', '7z'
]

// 返回 base64 编码数据
const fileBuffer = fs.readFileSync(filePath)
const base64Data = fileBuffer.toString('base64')
res.json({
  content: base64Data,
  isBase64: true,
  fileType: path.extname(filePath).slice(1)
})
```

### 4. 版本管理

- 每次更新文档内容时创建新版本
- 保留历史版本的文件路径
- 支持查看和恢复历史版本

### 5. 时间转换

```javascript
// UTC 转 UTC+8
function convertToUTC8(utcTime) {
  const date = new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}
```

### 6. 拖拽排序

```javascript
// 前端拖拽实现
// 使用 HTML5 原生拖拽 API
@dragstart="handleDragStart"
@dragover.prevent
@drop="handleDrop"

// 后端批量更新排序
const updateStmt = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
const transaction = db.transaction((items) => {
  items.forEach(item => {
    updateStmt.run(item.sortOrder, item.id)
  })
})
```

---

## 六、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/documents.js` |
| 数据库配置 | `backend/src/config/database.js` |
| 存储配置 | `backend/src/config/storage.js` |
| 前端视图 | `frontend/src/views/Documents.vue` |
| API 定义 | `frontend/src/api/index.js` |

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

## 八、注意事项

1. **文件大小限制**：单文件最大 50MB
2. **分类层级**：建议不超过 3 层，避免路径过长
3. **重名处理**：同分类下同名文件会自动添加后缀
4. **删除保护**：删除分类时需确认是否删除文件
5. **私密空间**：密码使用 bcrypt 加密存储
