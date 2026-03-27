# Clash + Yacd Dashboard 部署指南

## 一、部署步骤

### 1. 上传配置文件

确保 `config.yml` 文件在项目根目录下（与 docker-compose.clash.yml 同级）

### 2. 启动 Clash 服务

在极空间 Docker 管理界面中：

1. 打开 Docker → 项目/Compose
2. 选择 `docker-compose.clash.yml` 文件
3. 点击部署/启动

或通过命令行（如果支持）：
```bash
docker-compose -f docker-compose.clash.yml up -d
```

### 3. 访问管理界面

部署成功后，通过浏览器访问：

| 服务 | 地址 | 说明 |
|------|------|------|
| Yacd Dashboard | `http://NAS_IP:1234` | Web管理界面 |
| Clash API | `http://NAS_IP:9090` | RESTful API |

**首次访问 Yacd 需要设置后端地址：**
1. 打开 `http://NAS_IP:1234`
2. 点击设置图标
3. 后端地址填写：`http://NAS_IP:9090`
4. 保存

## 二、让后端服务使用代理

### 方式A：修改现有 docker-compose.yml（推荐）

在 backend 服务中添加代理环境变量：

```yaml
services:
  backend:
    # ... 现有配置 ...
    environment:
      # ... 现有环境变量 ...
      - HTTP_PROXY=http://clash:7890
      - HTTPS_PROXY=http://clash:7890
      - ALL_PROXY=socks5://clash:7891
      - NO_PROXY=localhost,127.0.0.1,*.local
    depends_on:
      - clash
    networks:
      - pr-network
      - proxy-network  # 添加代理网络
```

### 方式B：创建合并配置文件

创建 `docker-compose.with-proxy.yml`：

```yaml
version: '3.8'

services:
  clash:
    image: centralx/clash:latest
    container_name: clash
    restart: unless-stopped
    volumes:
      - ./config.yml:/root/.config/clash/config.yaml:ro
    ports:
      - "7890:7890"
      - "7891:7891"
      - "9090:9090"
    networks:
      - pr-network

  yacd:
    image: haishanh/yacd:latest
    container_name: yacd-dashboard
    restart: unless-stopped
    ports:
      - "1234:80"
    networks:
      - pr-network

  backend:
    build: ./backend
    container_name: pr-manager-backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./db:/app/data/database
      - ./docs:/app/data/documents
      - ./music:/app/data/music
      - ./books:/app/data/books
      - ./uploads:/app/data/uploads
      - ./logs:/app/data/logs
    environment:
      - NODE_ENV=production
      - PORT=3000
      - JWT_SECRET=${JWT_SECRET}
      - JWT_EXPIRE=7d
      - DATA_PATH=/app/data
      - HTTP_PROXY=http://clash:7890
      - HTTPS_PROXY=http://clash:7891
      - ALL_PROXY=socks5://clash:7891
      - NO_PROXY=localhost,127.0.0.1
    depends_on:
      - clash
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
    networks:
      - pr-network

networks:
  pr-network:
    driver: bridge
```

## 三、验证代理是否正常工作

### 1. 检查 Clash 状态

访问 `http://NAS_IP:1234`，确认：
- 节点列表正常显示
- 可以切换节点
- 延迟测试正常

### 2. 测试后端代理

在后端容器中测试：

```bash
# 进入容器
docker exec -it pr-manager-backend sh

# 测试代理
curl -x http://clash:7890 https://www.google.com -I

# 或测试 Nyaa
curl -x http://clash:7890 https://nyaa.si -I
```

### 3. 代码中使用代理

Node.js 后端中使用代理：

```javascript
// 方式1：全局代理（已通过环境变量自动生效）
const fetch = require('node-fetch')

// 方式2：手动指定代理
const { HttpsProxyAgent } = require('https-proxy-agent')

const agent = new HttpsProxyAgent('http://clash:7890')

fetch('https://nyaa.si', { agent })
  .then(res => res.text())
  .then(html => console.log(html))
```

## 四、常见问题

### Q1: Yacd 无法连接 Clash API

**原因**：Clash 配置中的 `external-controller` 绑定地址问题

**解决**：确保 config.yml 中有：
```yaml
external-controller: 0.0.0.0:9090
```

### Q2: 后端无法访问代理

**原因**：容器不在同一网络

**解决**：确保 backend 和 clash 在同一个 Docker network 中

### Q3: 代理连接失败

**原因**：Glados 节点不可用

**解决**：
1. 访问 Yacd Dashboard 检查节点状态
2. 在 Yacd 中切换到可用节点
3. 检查 config.yml 中的代理配置是否正确

### Q4: 如何更新 Glados 配置

1. 登录 Glados 官网获取新配置
2. 替换 `config.yml` 文件
3. 重启 Clash 容器：
   ```bash
   docker restart clash
   ```

## 五、端口说明

| 端口 | 服务 | 说明 |
|------|------|------|
| 7890 | Clash HTTP | HTTP代理端口，供应用程序使用 |
| 7891 | Clash SOCKS5 | SOCKS5代理端口 |
| 9090 | Clash API | RESTful API端口，Yacd通过此端口管理Clash |
| 1234 | Yacd | Web管理界面端口 |

## 六、安全建议

1. **不要将代理端口暴露到公网**
2. 建议在 config.yml 中设置 API 密钥：
   ```yaml
   secret: "your-secret-key"
   ```
3. 在 Yacd 连接时输入密钥

---

**部署完成后，你的 NAS 后端服务就可以通过代理访问被墙网站了！**
