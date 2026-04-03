# 个人资源管理系统

一个全功能的个人资源管理系统，支持文档、音乐、书籍、博客、动漫等资源管理。

![License](https://img.shields.io/badge/license-MIT-blue)
![Vue](https://img.shields.io/badge/Vue-3.4-brightgreen)
![Node](https://img.shields.io/badge/Node.js-18+-green)

## ✨ 功能特性

### 📄 文档管理
- 多级分类、标签管理
- 文件上传、在线预览（PDF、Word、Excel）
- 版本控制、隐私空间

### 🎵 音乐管理
- FFprobe 元数据解析（支持 MP3/FLAC/M4A）
- 大文件分片上传、断点续传
- 播放列表、全局播放器

### 📚 书籍管理
- 在线阅读器（EPUB/PDF/TXT）
- 阅读进度保存
- Anna's Archive / Nyaa 资源搜索

### 📝 博客管理
- Markdown 编辑器（实时预览）
- 分类标签、草稿/发布管理
- 代码高亮（Atom 主题）

### 🎬 动漫管理
- Bangumi API 集成（支持认证）
- 收藏、评分、想看/看过标记
- Nyaa 资源搜索
- 封面懒加载（IndexedDB 缓存）
- 详情页优化（数据库优先）

### 其他功能
- 💻 代码仓库管理
- 🔖 书签管理
- 🎮 游戏管理（Steam 集成）
- 🔍 全局搜索
- 👥 权限管理（管理员/游客）

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| **前端** | Vue 3.4 + Vite 5.0 + TDesign |
| **后端** | Node.js 18 + Express 4.18 |
| **数据库** | SQLite（better-sqlite3） |
| **解析** | FFprobe（音频）、PDF.js（文档） |
| **部署** | Docker Compose |

## 🚀 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/你的用户名/personal-resource-manager.git
cd personal-resource-manager

# 2. 复制配置文件
cp backend/.env.example backend/.env

# 3. 修改配置（重要！）
# 编辑 docker-compose.yml，修改数据目录路径
# 编辑 backend/.env，设置 JWT_SECRET

# 4. 启动服务
docker-compose up -d

# 5. 访问
# 前端：http://localhost:5173
# 后端：http://localhost:3000
```

### 方式二：本地开发

```bash
# 安装依赖
cd backend && npm install
cd frontend && npm install

# 配置环境变量
cd backend && cp .env.example .env

# 启动后端
cd backend && npm run dev

# 启动前端（新终端）
cd frontend && npm run dev
```

### 默认登录

- **用户名**：`admin`
- **密码**：`admin123`

⚠️ **生产环境请立即修改默认密码！**

## ⚙️ 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 密钥（必须修改） | - |
| `DATA_PATH` | 数据存储路径 | `/app/data` |
| `HTTP_PROXY` | 代理地址（用于爬虫） | - |

详见：[backend/.env.example](backend/.env.example)

### Docker 挂载路径

编辑 `docker-compose.yml`，修改以下路径：

```yaml
volumes:
  - ./data/db:/app/data/database      # 数据库
  - ./data/docs:/app/data/documents   # 文档
  - ./data/music:/app/data/music      # 音乐
  - ./data/books:/app/data/books      # 书籍
```

## 📖 文档

- [快速开始](docs/QUICKSTART.md)
- [数据库结构](docs/DATABASE_SCHEMA.md)
- [Docker 部署](docs/NAS_DEPLOYMENT.md)
- [FFmpeg 配置](docs/FFMPEG_SETUP.md)
- [Clash 代理](docs/CLASH_DEPLOYMENT.md)

## 🔒 安全提示

1. **修改默认密码**：首次启动后立即修改 admin 密码
2. **设置 JWT_SECRET**：使用强随机密钥
3. **HTTPS**：生产环境建议配置 HTTPS
4. **防火墙**：限制端口访问
5. **备份**：定期备份数据库和上传文件

## 👥 权限管理

系统支持两种角色：

### 管理员
- 完整的读写权限
- 可以执行所有操作
- Token 有效期：7天
- 支持修改密码

### 游客
- 只读权限，可浏览所有资源
- 可以播放音乐、阅读书籍、预览文档
- 无法执行任何写操作（上传、删除、修改等）
- Token 有效期：24小时
- 使用 sessionStorage（关闭浏览器自动清除）

详细说明请查看：[权限管理系统](docs/PERMISSION_SYSTEM.md)

## 📝 开发计划

- [ ] 全文搜索（SQLite FTS5）
- [ ] 移动端适配
- [ ] 多用户支持
- [ ] API 开放
- [ ] 数据导出

## 🐛 已知问题修复

### UI 优化（2026-04-03）
- **悬停提示问题**：移除 TDesign t-tooltip 组件，改用浏览器原生 title 属性，解决重复悬停框和样式冲突问题（影响模块：音乐、动漫、书籍、书签）
- **加载状态优化**：所有列表页实现骨架屏效果，页面框架立即显示，内容区域显示加载动画
- **表格布局优化**：修复音乐和动漫管理页面的表格列对齐问题，确保表头与内容左对齐
- **游客权限优化**：所有写操作按钮对游客显示为禁用状态，提供明确的权限提示

### 功能增强（2026-04-02）
- **权限管理系统**：实现完整的游客模式，支持只读访问所有资源
- **Cloudflare Tunnel**：添加 Cloudflare Tunnel 部署方案，支持无需公网IP的安全访问

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT License

---

**如有问题，请查看 [文档](docs/) 或提交 Issue。**
