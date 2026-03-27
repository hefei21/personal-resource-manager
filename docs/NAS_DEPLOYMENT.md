# 极空间 NAS 部署指南

## 准备工作

### 1. 极空间 NAS 设置

#### 1.1 关于极空间 NAS 的重要说明

**重要**：极空间 NAS 的 SMB/NFS 共享在默认配置下是只读访问的，无法直接挂载到 Docker 容器进行写入操作。

**解决方案**：使用 Docker Volumes 存储数据。Docker Volume 将数据存储在 NAS 的 Docker 管理目录中（通常在 `/var/lib/docker/volumes/`），容器内部有完整的读写权限，不依赖 SMB/NFS 挂载。

#### 1.2 数据存储方案

本项目采用 **Docker Volume** 方案存储数据：

```
数据存储位置：Docker 内部 Volume
- pr-data:        应用数据目录
- pr-db:          数据库文件
- pr-docs:        文档文件
- pr-music:       音乐文件
- pr-uploads:     临时上传文件
- pr-logs:        日志文件
```

**优点**：
- ✅ 完全绕过极空间的只读限制
- ✅ 容器内部有完整读写权限
- ✅ 数据持久化存储在 NAS
- ✅ 无需复杂的 NAS 权限配置

#### 1.3 启用必要服务
1. **Docker 服务** - 在应用商店中安装并启动 Docker（必需）
2. **SSH 服务** - 开启 SSH 访问（可选，用于调试）

### 2. 网络配置
- 记录 NAS 的 IP 地址（例如：192.168.1.100）
- 确保开发机可以访问 NAS

## 部署方案

### 方案 A：Docker Compose 部署（推荐）

#### 2.1 Docker Compose 配置

项目已包含针对极空间 NAS 优化的 `docker-compose.nas.yml`：

```yaml
version: '3.8'

services:
  backend:
    build: ./backend
    container_name: pr-manager-backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      # 使用 Docker 卷存储数据（适合极空间 NAS）
      - pr-data:/app/data
      - pr-db:/app/data/database
      - pr-docs:/app/data/documents
      - pr-music:/app/data/music
      - pr-uploads:/app/data/uploads
      - pr-logs:/app/data/logs
    environment:
      - NODE_ENV=production
      - PORT=3000
      - JWT_SECRET=${JWT_SECRET}
      - JWT_EXPIRE=7d
      - DATA_PATH=/app/data
      - DB_PATH=/app/data/database/app.db
      - DOCUMENTS_PATH=/app/data/documents
      - MUSIC_PATH=/app/data/music
      - UPLOADS_PATH=/app/data/uploads
      - LOGS_PATH=/app/data/logs
      - CORS_ORIGIN=*
      - DEFAULT_USERNAME=${DEFAULT_USERNAME:-admin}
      - DEFAULT_PASSWORD=${DEFAULT_PASSWORD:-admin123}
    networks:
      - pr-network

  frontend:
    build: ./frontend
    container_name: pr-manager-frontend
    restart: unless-stopped
    ports:
      - "5173:80"
    depends_on:
      - backend
    environment:
      - VITE_API_URL=http://backend:3000/api
    networks:
      - pr-network

# 使用 Docker 卷而不是挂载 NAS 路径
# 数据会存储在 NAS 的 Docker 卷管理中
volumes:
  pr-data:
    driver: local
  pr-db:
    driver: local
  pr-docs:
    driver: local
  pr-music:
    driver: local
  pr-uploads:
    driver: local
  pr-logs:
    driver: local

networks:
  pr-network:
    driver: bridge
```

#### 2.2 后端 Dockerfile

后端已包含 Dockerfile，使用 `better-sqlite3` 和 Alpine Linux：

```dockerfile
FROM node:18-alpine

WORKDIR /app

# 安装构建工具（better-sqlite3 需要）
RUN apk add --no-cache python3 make g++ sqlite

COPY package*.json ./
RUN npm install --production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

#### 2.3 创建前端 Dockerfile

在 `frontend/` 目录创建 `Dockerfile`:

```dockerfile
FROM node:18-alpine as build-stage

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine as production-stage
COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

#### 2.4 创建 Nginx 配置

在 `frontend/` 目录创建 `nginx.conf`:

```nginx
server {
    listen 80;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

#### 2.5 部署步骤

1. **构建并启动容器**

```bash
# 在项目根目录执行
docker-compose up -d --build
```

2. **配置环境变量**

创建 `.env` 文件：

```env
JWT_SECRET=your-very-secret-random-string
```

3. **访问应用**
- 前端：`http://your-nas-ip:5173`
- 后端 API：`http://your-nas-ip:3000/api`

### 方案 B：直接部署到 NAS

#### 2.1 通过 SSH 连接到 NAS

```bash
ssh your-nas-user@192.168.1.100
```

#### 2.2 安装 Node.js

极空间 NAS 可能需要手动安装 Node.js：

```bash
# 使用 Docker 方式更简单
docker run -it --rm -v $(pwd):/app -w /app -p 3000:3000 node:18-alpine sh
```

#### 2.3 部署应用

```bash
# 上传项目文件到 NAS
scp -r ./project your-nas-user@192.168.1.100:/docker/personal-resource-manager

# 在 NAS 上启动
cd /docker/personal-resource-manager
npm install
npm run start
```

## 数据存储配置

### 后端配置文件

修改 `backend/src/config/database.js`:

```javascript
const path = require('path')

module.exports = {
  database: {
    // 数据库文件路径，指向 NAS 目录
    path: process.env.DB_PATH || path.join(process.env.DATA_PATH, 'database', 'app.db'),
    storage: path.join(process.env.DATA_PATH, 'database', 'app.db')
  }
}
```

### 文件存储配置

修改 `backend/src/config/storage.js`:

```javascript
const path = require('path')

module.exports = {
  documents: path.join(process.env.DATA_PATH, 'documents'),
  music: path.join(process.env.DATA_PATH, 'music'),
  uploads: path.join(process.env.DATA_PATH, 'uploads')
}
```

## 维护和备份

### 数据备份

定期备份 NAS 数据目录：

```bash
# 备份整个数据目录
tar -czf backup-$(date +%Y%m%d).tar.gz /path/to/NAS/PersonalResourceManager
```

### 日志管理

日志文件存储在 NAS 的 `logs/` 目录，定期清理旧日志。

### 更新应用

```bash
# 拉取最新代码
git pull

# 重新构建和启动
docker-compose down
docker-compose up -d --build
```

## 故障排查

### 常见问题

1. **容器无法启动**
   - 检查 Docker 日志：`docker-compose logs`
   - 确认 NAS 路径挂载正确

2. **无法访问 NAS 存储**
   - 确认 SMB/NFS 服务已启动
   - 检查网络连接

3. **数据库连接失败**
   - 检查数据库文件权限
   - 确认目录路径正确

## 性能优化

### 1. 使用 Nginx 反向代理

```nginx
upstream backend {
    server backend:3000;
}

server {
    listen 80;
    server_name your-nas-ip;

    # 静态资源缓存
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API 代理
    location /api {
        proxy_pass http://backend;
    }

    # 前端路由
    location / {
        proxy_pass http://frontend;
    }
}
```

### 2. 定期清理临时文件

添加 cron 任务清理 `uploads/` 目录中的临时文件。

## 安全建议

1. 使用强密码和 JWT Secret
2. 定期更新系统依赖
3. 限制 API 访问频率
4. 启用 HTTPS（使用 Let's Encrypt）
5. 定期备份数据

## 联系支持

如有问题，请查看 GitHub Issues 或联系技术支持。
