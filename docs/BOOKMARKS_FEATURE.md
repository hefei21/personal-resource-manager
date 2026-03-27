# 书签管理功能文档

## 功能概述

书签管理模块用于管理和组织常用的网站链接，提供类似浏览器书签的功能，支持自动获取网站标题和图标、标签分类、批量操作等功能。

## 功能列表

### 1. 基础功能
- **添加书签**：输入URL后自动获取网站标题和favicon图标
- **编辑书签**：修改标题、URL、标签、描述等信息
- **删除书签**：单个删除或批量删除
- **查看书签**：列表展示，标题可点击直接跳转

### 2. 搜索与筛选
- **关键词搜索**：支持按标题、URL、描述搜索
- **标签筛选**：多选下拉框，支持同时选择多个标签（OR逻辑）
- **排序方式**：按添加时间（默认）、按标题名排序

### 3. 分页显示
- 默认每页15条
- 支持15/30/50条切换
- 筛选条件变化时自动重置到第一页

### 4. 视觉优化
- **网站图标**：标题前显示favicon，加载失败时自动使用Google favicon服务
- **标题截断**：过长标题自动截断，鼠标悬停显示完整内容
- **可点击链接**：标题直接点击跳转到目标网站

## 数据库设计

### 表结构：bookmarks

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| title | TEXT | 书签标题 |
| url | TEXT | 书签URL |
| icon | TEXT | 网站图标URL |
| category | TEXT | 分类（已废弃，保留兼容） |
| tags | TEXT | 标签，逗号分隔 |
| description | TEXT | 描述 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

## API 接口

### 1. 获取书签列表
```
GET /api/bookmarks
```

**Query 参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyword | string | 否 | 搜索关键词 |
| tags | string | 否 | 标签列表，逗号分隔 |
| sortBy | string | 否 | 排序字段：updated_at（默认）、title |
| page | number | 否 | 页码，默认1 |
| pageSize | number | 否 | 每页条数，默认15 |

**响应示例：**
```json
{
  "data": [
    {
      "id": 1,
      "title": "GitHub",
      "url": "https://github.com",
      "icon": "https://github.com/favicon.ico",
      "tags": "开发,工具",
      "description": "代码托管平台",
      "created_at": "2026-03-20 10:00:00",
      "updated_at": "2026-03-20 10:00:00"
    }
  ],
  "total": 100
}
```

### 2. 获取所有标签
```
GET /api/bookmarks/tags
```

**响应示例：**
```json
{
  "data": ["开发", "工具", "学习", "娱乐"]
}
```

### 3. 获取网页标题和图标
```
GET /api/bookmarks/fetch-title?url=https://example.com
```

**响应示例：**
```json
{
  "title": "Example Domain",
  "icon": "https://example.com/favicon.ico"
}
```

### 4. 创建书签
```
POST /api/bookmarks
```

**请求体：**
```json
{
  "title": "网站标题",
  "url": "https://example.com",
  "icon": "https://example.com/favicon.ico",
  "tags": "标签1,标签2",
  "description": "网站描述"
}
```

### 5. 更新书签
```
PUT /api/bookmarks/:id
```

### 6. 删除书签
```
DELETE /api/bookmarks/:id
```

### 7. 批量删除书签
```
POST /api/bookmarks/batch-delete
```

**请求体：**
```json
{
  "ids": [1, 2, 3]
}
```

## 技术实现细节

### 1. 自动获取标题和图标

**实现流程：**
1. 用户输入URL后失焦触发 `fetchTitle()` 函数
2. 显示loading动画
3. 后端通过fetch请求目标网站
4. 解析HTML提取 `<title>` 内容
5. 解析HTML提取 `<link rel="icon">` 的href属性
6. 处理相对路径，转换为完整URL
7. 若未找到图标，使用 `/favicon.ico` 作为默认值

**图标获取优先级：**
1. 从网页HTML中解析 `<link rel="icon">`
2. 使用网站根目录的 `/favicon.ico`
3. 前端加载失败时，使用Google favicon服务：`https://www.google.com/s2/favicons?domain=xxx`

### 2. 标签系统

**存储方式：**
- 标签以逗号分隔存储在单个TEXT字段中
- 例如：`"开发,工具,学习"`

**标签搜索：**
- 使用SQL LIKE语句进行模糊匹配
- 多标签筛选使用OR逻辑

```sql
SELECT * FROM bookmarks 
WHERE tags LIKE '%开发%' OR tags LIKE '%工具%'
```

### 3. 分页实现

**后端SQL：**
```sql
-- 先获取总数
SELECT COUNT(*) as total FROM (原始查询)

-- 再分页查询
SELECT * FROM bookmarks 
WHERE ... 
ORDER BY ... 
LIMIT ? OFFSET ?
```

**前端状态：**
```javascript
const pagination = ref({
  current: 1,    // 当前页码
  pageSize: 15,  // 每页条数
  total: 0       // 总条数
})
```

### 4. 排序实现

```javascript
// 后端排序逻辑
if (sortBy === 'title') {
  sql += ' ORDER BY title COLLATE NOCASE ASC'  // 忽略大小写
} else {
  sql += ' ORDER BY updated_at DESC'  // 默认按时间降序
}
```

### 5. 前端组件技术栈

- **UI框架**：TDesign Vue Next
- **主要组件**：
  - `t-table`：表格展示，支持多选
  - `t-pagination`：分页组件
  - `t-select`：标签多选、排序选择
  - `t-dialog`：添加/编辑弹窗
  - `t-tooltip`：标题悬停提示
  - `t-loading`：加载动画

### 6. SQLite注意事项

在SQLite中：
- **字符串使用单引号**：`tags != ''`（正确）
- **标识符使用双引号**：`"column_name"`
- 双引号内的空字符串 `""` 会被当作空标识符，导致 `no such column` 错误

## 文件结构

```
backend/src/
├── routes/
│   └── bookmarks.js      # 书签路由和业务逻辑
└── config/
    └── database.js       # 数据库初始化和字段迁移

frontend/src/
├── views/
│   └── Bookmarks.vue     # 书签管理页面
└── api/
    └── index.js          # API接口定义
```

## 使用说明

### 添加书签
1. 点击"添加书签"按钮
2. 在弹窗中输入URL
3. 点击其他输入框或按Tab键，自动获取标题和图标
4. 可手动修改标题，添加标签和描述
5. 点击确认保存

### 批量删除
1. 在列表中勾选要删除的书签
2. 点击"批量删除"按钮
3. 确认删除

### 搜索和筛选
1. 在搜索框输入关键词，按回车搜索
2. 点击标签下拉框选择标签进行筛选
3. 使用排序下拉框切换排序方式
4. 筛选条件会自动触发搜索

## 后续优化建议

1. **标签管理**：支持标签的增删改、重命名
2. **分类功能**：恢复并优化分类功能，支持文件夹式管理
3. **导入导出**：支持浏览器书签HTML文件导入导出
4. **快捷操作**：支持拖拽排序、快捷键操作
5. **统计功能**：访问次数统计、最近访问等
