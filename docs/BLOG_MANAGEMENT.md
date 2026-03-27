# 博客管理模块

## 一、功能概述

博客管理模块提供完整的博客写作、发布、管理功能，支持 Markdown 编辑、分类管理、标签管理、文章预览和草稿/发布状态管理。

## 二、数据库结构

### 1. blog_posts 表（文章主表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 文章标题，必填 |
| content | TEXT | 文章内容（Markdown 格式） |
| category_id | INTEGER | 分类 ID，外键 |
| status | TEXT | 状态：'draft' / 'published'，默认 'draft' |
| is_top | INTEGER | 是否置顶，默认 0 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

### 2. blog_categories 表（分类表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 分类名称，唯一 |
| parent_id | INTEGER | 父分类 ID（支持多层级） |
| sort_order | INTEGER | 排序顺序，默认 0 |
| created_at | DATETIME | 创建时间 |

### 3. blog_tags 表（标签表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 标签名称，唯一 |
| color | TEXT | 标签颜色（十六进制） |
| created_at | DATETIME | 创建时间 |

### 4. blog_post_tags 表（文章标签关联表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| post_id | INTEGER | 文章 ID，外键级联删除 |
| tag_id | INTEGER | 标签 ID，外键级联删除 |

---

## 三、后端 API 接口

**路由文件**: `backend/src/routes/blog.js`

### 文章管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/posts` | 获取文章列表 | `status`, `category_id`, `keyword`, `page`, `pageSize` |
| GET | `/posts/:id` | 获取单篇文章 | - |
| POST | `/posts` | 创建文章 | `{ title, content, category_id, tags, status, is_top }` |
| PUT | `/posts/:id` | 更新文章 | `{ title, content, category_id, tags, status, is_top }` |
| DELETE | `/posts/:id` | 删除文章 | - |

### 分类管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/categories` | 获取分类树 | - |
| GET | `/categories/all` | 获取所有分类（平铺） | - |
| POST | `/categories` | 创建分类 | `{ name, parent_id, sort_order }` |
| PUT | `/categories/:id` | 更新分类 | `{ name, parent_id, sort_order }` |
| DELETE | `/categories/:id` | 删除分类 | - |

### 标签管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/tags` | 获取标签列表 | - |
| POST | `/tags` | 创建标签 | `{ name, color }` |
| PUT | `/tags/:id` | 更新标签 | `{ name, color }` |
| DELETE | `/tags/:id` | 删除标签 | - |

---

## 四、前端页面功能

### 1. 文章列表

- **状态筛选**：全部 / 已发布 / 草稿
- **搜索功能**：按标题搜索
- **分类筛选**：下拉选择分类
- **文章卡片**：
  - 置顶标识（黄色标签）
  - 草稿标识（灰色标签）
  - 分类、标签、更新时间显示
- **操作按钮**：
  - 预览（浏览图标）
  - 编辑（编辑图标）
  - 删除（带确认弹窗）

### 2. 文章编辑器

使用 `md-editor-v3` Markdown 编辑器：

- **编辑模式**：
  - 编辑器模式（左侧）
  - 预览模式（右侧）
  - 分屏模式（左右分栏）

- **编辑器功能**：
  - 工具栏：标题、加粗、斜体、引用、代码、链接、图片、表格等
  - 快捷键支持
  - 实时预览
  - 代码高亮（Atom 主题）
  - Mac 风格装饰（红黄绿三色圆点）

- **元数据编辑**：
  - 标题输入
  - 分类选择（支持多级分类）
  - 标签输入（支持多选）
  - 状态切换（草稿/发布）
  - 置顶开关

### 3. 文章预览

使用 `MdPreview` 组件：

- **预览特性**：
  - 黑底代码块 + Atom 主题高亮
  - Markdown 渲染
  - 图片懒加载
  - 目录导航

- **元信息显示**：
  - 分类名称
  - 标签列表
  - 更新时间

### 4. 分类管理对话框

- **树形结构**：支持多层级分类
- **分类 CRUD**：创建、重命名、删除
- **排序功能**：拖拽排序
- **文章统计**：显示每个分类的文章数

### 5. 标签管理对话框

- **标签列表**：显示标签名称、颜色、文章数
- **标签 CRUD**：创建、编辑、删除
- **颜色选择**：支持自定义标签颜色

---

## 五、技术实现细节

### 1. Markdown 编辑器配置

```javascript
import { MdEditor, MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import 'md-editor-v3/lib/preview.css'

// 编辑器配置
const editorTheme = ref('dark')
const previewTheme = ref('github-dark')
const codeTheme = ref('atom')

// 编辑器工具栏
const toolbars = [
  'bold', 'underline', 'italic', '-',
  'title', 'strikeThrough', 'sub', 'sup', 'quote', '-',
  'unorderedList', 'orderedList', 'task', '-',
  'codeRow', 'code', 'link', 'image', 'table', '-',
  'revoke', 'next', 'save', '='
]
```

### 2. 文章保存流程

```javascript
async function handleSave() {
  const postData = {
    title: editForm.value.title,
    content: editForm.value.content,
    category_id: editForm.value.category_id || null,
    tags: editForm.value.tags,
    status: editForm.value.status,
    is_top: editForm.value.is_top
  }

  if (editingPost.value) {
    await api.blog.updatePost(editingPost.value.id, postData)
  } else {
    await api.blog.createPost(postData)
  }
}
```

### 3. 标签自动创建

```javascript
// 创建文章时自动创建不存在的标签
for (const tagName of tags) {
  if (tagName && tagName.trim()) {
    // 插入或忽略已存在的标签
    tagStmt.run(tagName.trim())
    // 获取标签 ID
    const tagRow = tagIdStmt.get(tagName.trim())
    if (tagRow) {
      // 关联文章和标签
      postTagStmt.run(postId, tagRow.id)
    }
  }
}
```

### 4. 分类树构建

```javascript
// 递归构建分类树
const buildTree = (items, parentId = null) => {
  return items
    .filter(item => item.parent_id === parentId)
    .map(item => ({
      ...item,
      post_count: item.post_count || 0,
      children: buildTree(items, item.id)
    }))
}
```

---

## 六、配置说明

### 环境变量

无特殊环境变量配置。

### 存储结构

文章内容存储在数据库中，不生成静态文件。

---

## 七、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/blog.js` |
| 前端视图 | `frontend/src/views/Blog.vue` |
| API 定义 | `frontend/src/api/index.js` |

---

## 八、使用说明

### 1. 创建文章

1. 点击"新建文章"按钮
2. 输入文章标题
3. 编写 Markdown 内容
4. 选择分类和标签
5. 选择状态（草稿/发布）
6. 点击保存

### 2. 编辑文章

1. 点击文章列表中的编辑图标
2. 修改内容
3. 点击保存

### 3. 预览文章

1. 点击文章列表中的预览图标
2. 或点击文章卡片

### 4. 管理分类

1. 点击"分类管理"按钮
2. 创建、编辑或删除分类
3. 支持拖拽排序

### 5. 管理标签

1. 点击"标签管理"按钮
2. 创建、编辑或删除标签
3. 可自定义标签颜色

---

## 九、注意事项

1. **Markdown 支持**：支持标准 Markdown 语法和 GFM 扩展
2. **代码高亮**：使用 Atom 主题，支持多种语言
3. **图片上传**：需要单独配置图片存储
4. **草稿保存**：草稿不会出现在公开页面
5. **置顶文章**：置顶文章会排在列表最前面
6. **分类删除**：删除分类时，该分类下的文章会变为未分类
