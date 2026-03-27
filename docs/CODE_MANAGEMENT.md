# 代码管理模块

## 一、功能概述

代码管理模块提供 Git/SVN 仓库克隆、文件浏览、提交历史查看、代码预览等功能，支持 GitHub 仓库信息获取、README 渲染和图片路径转换。

## 二、数据库结构

### code_repositories 表（代码仓库表）

| 字段名 | 类型 | 说明 |
|--------|------|------|
| id | INTEGER | 主键，自增 |
| name | TEXT | 仓库名称，必填 |
| url | TEXT | 仓库 URL，唯一 |
| description | TEXT | 仓库描述 |
| type | TEXT | 仓库类型：'git' / 'svn' |
| local_path | TEXT | 本地克隆路径 |
| last_sync | DATETIME | 最后同步时间 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

---

## 三、后端 API 接口

**路由文件**: `backend/src/routes/code.js`

### 仓库管理 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/` | 获取仓库列表 | `keyword` |
| GET | `/:id` | 获取仓库详情 | - |
| POST | `/` | 创建仓库（克隆） | `{ name, url, description, type }` |
| PUT | `/:id` | 更新仓库信息 | `{ name, description }` |
| DELETE | `/:id` | 删除仓库 | - |
| POST | `/:id/sync` | 同步仓库 | - |
| GET | `/:id/clone-status` | 获取克隆状态 | - |
| GET | `/github-info` | 获取 GitHub 仓库信息 | `url`（query） |

### 文件浏览 API

| 方法 | 路由 | 功能 | 参数 |
|------|------|------|------|
| GET | `/:id/tree` | 获取文件树 | `path`（query） |
| GET | `/:id/file` | 获取文件内容 | `path`（query） |
| GET | `/:id/raw/:path(*)` | 获取原始文件（图片等） | - |
| GET | `/:id/readme` | 获取 README 内容 | - |
| GET | `/:id/commits` | 获取提交历史 | `limit`（query） |
| GET | `/:id/commit/:hash` | 获取提交详情 | - |

---

## 四、前端页面功能

### 1. 仓库列表

- **仓库卡片**：
  - 仓库名称和描述
  - 仓库类型（Git/SVN）
  - 克隆状态（克隆中/完成/失败）
  - 最后同步时间
  - 仓库大小
  - 操作按钮（浏览、同步、删除）

- **搜索功能**：按名称、URL、描述搜索

- **添加仓库**：
  - 输入仓库 URL
  - 自动获取 GitHub 仓库信息
  - 选择仓库类型

### 2. 文件浏览器

- **文件树**：
  - 目录和文件图标区分
  - 点击目录进入子目录
  - 面包屑导航

- **文件预览**：
  - 代码文件：语法高亮
  - Markdown：渲染预览（图片自动显示）
  - 图片文件：直接显示
  - 二进制文件：显示文件信息

- **README 渲染**：
  - 自动查找 README.md
  - 图片路径自动转换
  - Markdown 渲染

### 3. 提交历史

- **提交列表**：
  - 提交哈希（短）
  - 作者
  - 提交时间
  - 提交信息

- **提交详情**：
  - 变更文件列表
  - 代码差异（diff 格式）

### 4. 克隆进度

- **进度显示**：
  - 正在克隆...
  - 百分比进度条
  - 当前阶段（计数/压缩/接收/解析）

- **状态通知**：
  - 克隆完成
  - 克隆失败（显示错误信息）

---

## 五、技术实现细节

### 1. Git 克隆（带进度）

```javascript
function cloneGitWithProgress(url, localPath, task) {
  return new Promise((resolve, reject) => {
    // 使用 --depth=50 浅克隆
    const args = ['clone', '--progress', '--depth', '50', url, localPath]
    const proc = spawn('git', args)
    
    proc.stderr.on('data', (data) => {
      const output = data.toString()
      
      // 解析进度
      if (output.includes('Counting objects')) {
        const match = output.match(/Counting objects:\s*(\d+)%/)
        if (match) {
          task.progress = Math.round(parseInt(match[1]) * 0.3)
          task.message = `正在计数对象... ${match[1]}%`
        }
      } else if (output.includes('Receiving objects')) {
        const match = output.match(/Receiving objects:\s*(\d+)%/)
        if (match) {
          task.progress = 50 + Math.round(parseInt(match[1]) * 0.4)
          task.message = `正在接收对象... ${match[1]}%`
        }
      }
    })
    
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Git clone 失败，退出码: ${code}`))
    })
  })
}
```

### 2. GitHub API 获取仓库信息

```javascript
async function getGitHubInfo(url) {
  // 解析 GitHub URL
  const match = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/)
  if (!match) throw new Error('不是有效的 GitHub URL')
  
  const [, owner, repo] = match
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}`
  
  const response = await axios.get(apiUrl, {
    timeout: 10000,
    headers: { 'Accept': 'application/vnd.github.v3+json' }
  })
  
  return {
    name: response.data.name,
    description: response.data.description,
    stars: response.data.stargazers_count,
    forks: response.data.forks_count,
    language: response.data.language
  }
}
```

### 3. README 图片路径转换

```javascript
// 将相对路径转换为 base64 data URL
function convertImagePathsToBase64(content, repoPath, mdFilePath) {
  return content.replace(/!\[([^\]]*)\]\((.*?)\)/g, (match, alt, imagePath) => {
    // 跳过绝对 URL
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
      return match
    }
    
    // 解析相对路径
    const basePath = mdFilePath ? path.dirname(mdFilePath) : repoPath
    const fullPath = path.resolve(basePath, imagePath)
    
    // 安全检查
    if (!fullPath.startsWith(repoPath)) return match
    
    // 读取并转为 base64
    if (fs.existsSync(fullPath)) {
      const fileBuffer = fs.readFileSync(fullPath)
      const ext = path.extname(fullPath).toLowerCase()
      const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg' }[ext] || 'image/jpeg'
      const base64 = fileBuffer.toString('base64')
      return `![${alt}](data:${mimeType};base64,${base64})`
    }
    
    return match
  })
}
```

### 4. Git 提交历史解析

```javascript
// 获取提交历史
const { stdout } = await execAsync(
  `git -C "${localPath}" log --pretty=format:"%H|%an|%ad|%s" --date=iso -n ${limit}`
)

// 解析输出
const commits = stdout.split('\n').map(line => {
  const [hash, author, date, ...messageParts] = line.split('|')
  return {
    hash: hash.substring(0, 7),
    fullHash: hash,
    author,
    date,
    message: messageParts.join('|')
  }
})
```

---

## 六、配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATA_PATH` | 数据存储根目录 | `/app/data` |
| `CODE_PATH` | 代码存储目录 | `{DATA_PATH}/code` |

### 依赖要求

- **Git**：用于克隆 Git 仓库
- **SVN**（可选）：用于克隆 SVN 仓库

### 存储结构

```
{CODE_PATH}/
├── repo1_1234567890/     # 仓库名_时间戳
│   ├── .git/
│   ├── src/
│   ├── README.md
│   └── ...
├── repo2_1234567891/
│   ├── trunk/
│   └── ...
└── ...
```

---

## 七、关键文件路径

| 功能模块 | 文件路径 |
|----------|----------|
| 后端路由 | `backend/src/routes/code.js` |
| 前端视图 | `frontend/src/views/Code.vue` |
| API 定义 | `frontend/src/api/index.js` |

---

## 八、使用说明

### 1. 添加仓库

1. 点击"添加仓库"按钮
2. 输入仓库 URL（如 `https://github.com/user/repo.git`）
3. 系统自动获取仓库信息（仅 GitHub）
4. 选择仓库类型（默认 Git）
5. 点击确认，开始克隆

### 2. 浏览代码

1. 点击仓库卡片进入
2. 查看文件树和 README
3. 点击目录进入子目录
4. 点击文件预览内容

### 3. 查看提交历史

1. 点击"提交历史"按钮
2. 查看提交列表
3. 点击提交查看详情

### 4. 同步仓库

1. 点击"同步"按钮
2. 执行 `git pull` 或 `svn update`
3. 更新最后同步时间

### 5. 删除仓库

1. 点击"删除"按钮
2. 确认删除
3. 同时删除本地文件

---

## 九、注意事项

1. **克隆深度**：默认浅克隆（depth=50），减少下载量
2. **大仓库**：超大仓库克隆时间较长，请耐心等待
3. **私有仓库**：需要配置 SSH 密钥或 Git 凭据
4. **网络问题**：如果克隆失败，检查网络和代理设置
5. **磁盘空间**：克隆前确保有足够的磁盘空间
6. **文件预览**：文件大小限制 1MB，超过限制显示文件信息
7. **二进制文件**：不显示二进制文件内容，只显示文件信息
8. **安全性**：路径安全检查，防止访问仓库目录外的文件
