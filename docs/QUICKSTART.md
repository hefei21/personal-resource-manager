# 快速开始指南

## 前提条件

- Node.js 18+ 和 npm
- 或者 Docker 和 Docker Compose

## 开发环境启动

### 方法一：使用 npm（推荐用于开发）

```bash
# 1. 安装依赖
npm install

# 2. 启动前端和后端
npm run dev

# 前端: http://localhost:5173
# 后端: http://localhost:3000
```

### 方法二：使用 Docker（推荐用于生产）

```bash
# 1. 普通部署
docker-compose up -d --build

# 2. 极空间 NAS 部署（推荐）
docker-compose -f docker-compose.nas.yml up -d --build

# 3. 查看日志
docker-compose -f docker-compose.nas.yml logs -f

# 4. 停止服务
docker-compose -f docker-compose.nas.yml down
```

## 默认登录

- 用户名: `admin`
- 密码: `admin123`

⚠️ **重要**: 首次登录后请立即修改密码！

## 极空间 NAS 部署步骤

### 重要说明

**极空间 NAS 的 SMB/NFS 共享默认是只读的**，无法直接挂载到 Docker 容器进行写入操作。

**解决方案**：本项目使用 Docker Volumes 存储数据，数据会存储在 NAS 的 Docker 管理目录中（`/var/lib/docker/volumes/`），容器内部有完整读写权限。

### 1. 在极空间 NAS 上准备环境

1. 在极空间应用商店安装并启动 Docker
2. （可选）开启 SSH 服务用于调试
3. 记录 NAS 的 IP 地址

### 2. 配置环境变量

创建 `.env` 文件：

```env
JWT_SECRET=your-random-secret-key-at-least-32-characters-long
DEFAULT_USERNAME=admin
DEFAULT_PASSWORD=admin123
```

### 3. 启动服务

```bash
# 使用针对 NAS 优化的配置文件
docker-compose -f docker-compose.nas.yml up -d --build

# 查看日志
docker-compose -f docker-compose.nas.yml logs -f
```

### 4. 访问应用

- 前端: `http://your-nas-ip:5173`
- 后端 API: `http://your-nas-ip:3000/api`

### 5. 数据管理

数据存储在 Docker Volumes 中：

```bash
# 查看 Volumes
docker volume ls

# 备份数据（需要 root 权限）
docker run --rm -v pr-db:/data -v $(pwd):/backup alpine tar czf /backup/db-backup.tar.gz /data
```

## 功能说明

### 📄 文档管理
- 上传 PDF、Word、PPT、Excel 等文档
- 分类和标签管理（支持拖拽排序）
- 版本历史记录
- PDF 在线预览
- 隐私空间（密码保护）

### 📝 博客管理
- Markdown 编辑器（分屏预览）
- 分类和标签管理
- 草稿/发布状态
- 文章置顶功能

### 📚 书籍管理
- 支持 TXT、EPUB、PDF 等格式
- 自动解析 EPUB 元数据（书名、作者、出版社等）
- 自动提取 EPUB 封面图片
- 分片上传支持大文件（>100MB 自动启用）
- 在线阅读器（章节导航、字体调整、进度保存）
- **多用户进度隔离**（管理员和游客进度独立）
- 电子书资源搜索（Anna's Archive、Nyaa）
- 分类管理和拖拽排序

### 🎵 音乐管理
- 自动解析音乐元数据（标题、艺术家、专辑等）
- 封面图片自动提取
- 播放列表管理
- **歌词功能**：
  - 多源歌词搜索（网易云、QQ音乐、酷狗）
  - 双语歌词支持（原文+翻译）
  - 全屏歌词窗口（网易云风格）
  - 歌词同步高亮
  - 批量下载歌词
- **10段均衡器**：
  - 6种预设方案（默认、低音增强、人声增强、高音增强、摇滚、古典）
  - 实时音频处理
- 分类拖拽排序

### 💻 代码管理
- 管理 Git 仓库链接（GitHub、GitLab 等）
- 一键克隆仓库
- 在线文件浏览器
- README 渲染预览
- 代码语法高亮

### 🔖 书签管理
- 保存网页链接
- 自动获取网站图标
- 分类和标签

### 🎬 动漫管理
- Bangumi 数据搜索和导入
- 标记想看/看过/正在看状态
- 收藏功能
- 评分系统（Bangumi评分+个人评分）
- **多源资源搜索**（Nyaa、DMHY、ACG.RIP、蜜柑计划）
- 角色声优信息展示

### 🎮 游戏管理
- Steam 库集成
- 游戏成就追踪
- 游戏状态标记（想玩、在玩、通关）
- 用户评分（1-5星，支持半星）

### 🔍 全局搜索
- 跨所有资源类型搜索
- 分类筛选结果

### 📱 移动端适配
- 完整的移动端响应式适配
- PC/移动端组件分离
- 触摸手势支持
- 底部浮动播放器

## 常见问题

### 1. 数据库初始化失败

检查是否有写入权限，确保数据目录存在：

```bash
mkdir -p data/{database,documents,music,uploads,logs}
chmod -R 777 data
```

### 2. 无法连接后端 API

检查：
- 后端服务是否启动
- 端口 3000 是否被占用
- CORS 配置是否正确

### 3. 上传文件失败

检查：
- uploads 目录权限
- 文件大小限制（默认 50MB）
- 磁盘空间是否充足

### 4. Bangumi 搜索失败

可能是网络问题或 API 变更，检查：
- 网络连接
- https://api.bgm.tv 是否可访问
- 如在中国大陆，建议配置 Clash 代理（见 `CLASH_DEPLOYMENT.md`）

### 5. 歌词下载失败

检查：
- 是否配置了代理（访问网易云等 API 需要）
- 网络连接状态
- 歌曲元数据是否完整（标题、艺术家）

### 6. 音乐元数据解析失败

检查：
- 后端是否正确安装 FFmpeg
- 音乐文件是否损坏
- 文件权限是否正确

## 开发相关

### 前端开发

```bash
cd frontend
npm install
npm run dev
```

### 后端开发

```bash
cd backend
npm install
npm run dev
```

### 构建生产版本

```bash
# 构建前端
cd frontend
npm run build

# 后端无需构建，直接运行
cd ../backend
npm start
```

## 数据备份

### Docker Volume 备份（NAS 部署）

```bash
# 备份所有 Volumes
docker run --rm -v pr-data:/data -v $(pwd):/backup alpine tar czf /backup/data-backup.tar.gz /data
```

### 本地目录备份（普通部署）

```bash
# 备份整个数据目录
tar -czf backup-$(date +%Y%m%d).tar.gz /path/to/PersonalResourceManager
```

## 系统架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   前端 (Vue 3)   │────▶│  后端 (Express)  │────▶│ SQLite 数据库   │
│   端口: 5173    │     │   端口: 3000    │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  PC/Mobile 响应式 │     │  Redis 缓存     │
│  组件分离        │     │  代理支持       │
└─────────────────┘     └─────────────────┘
```

### 技术栈

- **前端**: Vue 3.4 + Vite 5.0 + TDesign Vue Next 1.9 + Pinia
- **后端**: Node.js + Express 4.18 + better-sqlite3
- **部署**: Docker Compose

## 模块文档

| 模块 | 文档 |
|------|------|
| 文档管理 | `docs/DOCUMENTS_MANAGEMENT.md` |
| 博客管理 | `docs/BLOG_MANAGEMENT.md` |
| 书籍管理 | `docs/BOOKS_MANAGEMENT.md` |
| 音乐管理 | `docs/MUSIC_MANAGEMENT.md` |
| 歌词功能 | `docs/LYRICS_FEATURE.md` |
| 代码管理 | `docs/CODE_MANAGEMENT.md` |
| 书签管理 | `docs/BOOKMARKS_FEATURE.md` |
| 动漫管理 | `docs/ANIME_MANAGEMENT.md` |
| 游戏管理 | `docs/GAMES_MANAGEMENT.md` |
| 数据库结构 | `docs/DATABASE_SCHEMA.md` |

## 技术支持

如有问题，请查看：
- `README.md` - 项目概述
- `NAS_DEPLOYMENT.md` - 详细部署指南
- `BLOG_ARTICLE_MY_RESOURCE_MANAGER.md` - 从零搭建教程
