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

### 文档管理
- 上传 PDF、Word、PPT 等文档
- 分类和标签管理
- 版本历史记录

### 书籍管理
- 支持 TXT、EPUB、PDF、MOBI 等格式
- 自动解析 EPUB 元数据（书名、作者、出版社等）
- 自动提取 EPUB 封面图片
- 分片上传支持大文件（>100MB 自动启用）
- 在线阅读器（章节导航、字体调整、进度保存）
- 电子书资源搜索（Anna's Archive、Nyaa）
- 分类管理和拖拽排序

### 音乐管理
- 添加音乐文件信息
- 分类和标签
- 支持本地文件路径

### 代码管理
- 管理 Git 仓库链接
- 版本跟踪
- 分类和标签

### 书签管理
- 保存网页链接
- 分类和标签
- 添加描述

### 动漫管理
- 从 Bangumi 搜索并导入动漫
- 标记想看/看过状态
- 收藏功能
- 查看评分和简介

### 全局搜索
- 跨所有资源类型搜索
- 分类筛选结果

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

## 技术支持

如有问题，请查看：
- `README.md` - 项目概述
- `NAS_DEPLOYMENT.md` - 详细部署指南
