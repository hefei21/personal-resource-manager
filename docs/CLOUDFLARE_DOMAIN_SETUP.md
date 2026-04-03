# Cloudflare 域名配置指南

## 📋 概述

本文档记录如何使用 Cloudflare Tunnel 实现内网穿透，使网站可通过自定义域名访问，无需公网 IP 和极空间账号登录。

---

## 🎯 配置目标

- ✅ 绑定自定义域名（如：`yourdomain.cn`）
- ✅ 通过 Cloudflare CDN 全球加速
- ✅ 自动 HTTPS 加密
- ✅ 无需极空间账号登录
- ✅ 无需公网 IP
- ✅ 无流量限制

---

## 📦 前置条件

### 1. 域名准备
- 已购买域名（推荐：阿里云、腾讯云、NameSilo）
- 域名实名认证已通过（国内域名必须）

### 2. 服务运行正常
- Docker 容器正常运行
- 前端服务：`frontend:80`
- 后端服务：`backend:3000`
- 网络名称：`personal-resource-manager_pr-network`

---

## 🚀 完整配置流程

### 步骤 1: 购买域名（阿里云示例）

#### 1.1 创建域名信息模板
```
阿里云控制台 → 域名 → 域名信息模板 → 创建新信息模板
├─ 模板类型：个人
├─ 域名持有者：真实姓名
├─ 证件类型：身份证
├─ 证件号码：身份证号
├─ 上传证件：身份证正反面照片
└─ 提交审核（1-3 工作日）
```

#### 1.2 购买域名
```
阿里云域名查询页面 → 搜索域名 → 选择后缀 → 购买
├─ 选择信息模板：使用已审核的模板
├─ 购买时长：建议 3-5 年
└─ 支付：支付宝/微信
```

#### 1.3 开启域名隐私保护（可选但推荐）
```
域名控制台 → 域名管理 → 域名安全
→ 开启 CNNIC 隐私保护服务（¥39/年）
```

**注意**：域名实名认证 1-3 天通过后才可继续配置。

---

### 步骤 2: Cloudflare 配置

#### 2.1 注册 Cloudflare 账号
```
访问：https://dash.cloudflare.com/sign-up
├─ 使用邮箱注册
├─ 验证邮箱
└─ 设置密码
```

#### 2.2 添加站点
```
Cloudflare 控制台 → 添加站点
├─ 输入域名：yourdomain.cn
├─ 选择计划：Free（免费）
└─ 继续
```

#### 2.3 获取 Cloudflare DNS 地址
```
添加站点后，页面显示两个 DNS 地址：
示例：
  - athena.ns.cloudflare.com
  - damien.ns.cloudflare.com
  
复制这两个地址
```

---

### 步骤 3: 修改域名 DNS

#### 3.1 在阿里云修改 DNS
```
阿里云域名控制台 → 域名列表 → 管理
→ DNS 修改 → 修改 DNS 服务器
→ 选择"自定义 DNS"
→ 填入 Cloudflare 提供的两个 DNS 地址：
   DNS 服务器 1: athena.ns.cloudflare.com
   DNS 服务器 2: damien.ns.cloudflare.com
→ 确定
```

#### 3.2 等待 DNS 生效
```
生效时间：2-24 小时（最长 48 小时）

验证方法：
1. Cloudflare 控制台 → 概述 → 状态变为"有效"
2. 使用 DNSChecker.org 检查 DNS 是否更新
```

---

### 步骤 4: 创建 Cloudflare Tunnel

#### 4.1 进入 Zero Trust 控制台
```
Cloudflare 控制台 → 左侧菜单 → Zero Trust
（首次使用需要创建团队名称，选择 Free 计划）
```

#### 4.2 创建 Tunnel
```
Zero Trust → Networks → Tunnels
→ Create a tunnel
├─ 选择：Cloudflared
├─ 隧道名称：nas-tunnel（或自定义）
└─ Save tunnel
```

#### 4.3 获取 Tunnel Token
```
选择操作系统：Docker
→ 页面显示安装命令，找到 Token
→ 复制 Token（一长串字符，如：eyJhIjoixxxxx...）

重要：保存此 Token，稍后需要用到
```

---

### 步骤 5: 部署 Tunnel 到 NAS

#### 5.1 准备配置文件

使用项目提供的模板文件：
```bash
# 复制模板文件
cp docker-compose.tunnel.yml.example docker-compose.tunnel.yml
```

#### 5.2 填写 Token
编辑 `docker-compose.tunnel.yml`，将 `YOUR_TUNNEL_TOKEN` 替换为步骤 4.3 获取的 Token：

```yaml
version: '3.8'

services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token YOUR_TUNNEL_TOKEN
    networks:
      - pr-network

networks:
  pr-network:
    external: true
    name: personal-resource-manager_pr-network
```

#### 5.3 启动容器

**方式 A: Docker Compose（推荐）**
```bash
docker-compose -f docker-compose.tunnel.yml up -d
```

**方式 B: Docker Run**
```bash
docker run -d \
  --name cloudflared-tunnel \
  --restart unless-stopped \
  --network personal-resource-manager_pr-network \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token YOUR_TUNNEL_TOKEN
```

**方式 C: 图形界面（极空间）**
```
极空间 Docker → 项目 → 新增项目
├─ 项目名称：cloudflared-tunnel
├─ 粘贴 YAML 配置
└─ 创建
```

#### 5.4 验证容器运行
```
查看容器状态：
docker ps | grep cloudflared

查看日志：
docker logs cloudflared-tunnel

期望输出：
Connection registered
```

---

### 步骤 6: 配置域名路由

#### 6.1 添加 Public Hostname
```
Cloudflare Zero Trust → Tunnels
→ 点击你的 Tunnel → Configure
→ Public Hostname → Add a public hostname
```

#### 6.2 填写路由配置
```
子域（Subdomain）：留空（使用根域名）
域（Domain）：yourdomain.cn
路径（Path）：留空

服务（Service）：
  类型：HTTP
  URL：frontend:80

点击"保存"
```

#### 6.3 验证访问
```
浏览器访问：https://yourdomain.cn
├─ 应该能看到网站首页
├─ 地址栏显示 🔒 锁图标（HTTPS）
└─ 无需极空间账号登录
```

---

## 📊 配置完成检查清单

### 域名配置
- [ ] 域名已购买
- [ ] 域名实名认证已通过
- [ ] 域名隐私保护已开启（可选）
- [ ] DNS 已修改为 Cloudflare DNS
- [ ] DNS 已生效（Cloudflare 显示"有效"）

### Cloudflare 配置
- [ ] Cloudflare 账号已创建
- [ ] 站点已添加
- [ ] Tunnel 已创建
- [ ] Tunnel Token 已获取
- [ ] Tunnel 状态显示"健康"

### NAS 配置
- [ ] cloudflared 容器正在运行
- [ ] 容器日志显示"Connection registered"
- [ ] Public Hostname 已配置
- [ ] 域名可正常访问

---

## 🔧 高级配置

### 配置多个子域名

如果需要为不同服务配置不同子域名：

#### API 子域名
```
在 Cloudflare DNS 添加记录：
类型：CNAME
名称：api
目标：<tunnel-id>.cfargotunnel.com
代理状态：已代理

在 Tunnel 添加路由：
子域：api
域：yourdomain.cn
服务：http://backend:3000

访问：https://api.yourdomain.cn
```

#### 音乐服务子域名
```
在 Cloudflare DNS 添加记录：
类型：CNAME
名称：music
目标：<tunnel-id>.cfargotunnel.com
代理状态：已代理

在 Tunnel 添加路由：
子域：music
域：yourdomain.cn
服务：http://music-service:8080

访问：https://music.yourdomain.cn
```

---

### 配置访问控制（可选）

如果需要限制访问权限：

```
Cloudflare Zero Trust → Access → Applications
→ Add an application
├─ 选择：Self-hosted
├─ Application domain：yourdomain.cn
├─ Policy name：Email verification
├─ Action：Allow
├─ Include：Emails ending in @yourdomain.com
└─ 保存

效果：只有指定邮箱域名用户可以访问
```

---

## ⚠️ 常见问题排查

### 问题 1: DNS 未生效
```
现象：访问域名显示"无法访问此网站"
排查：
├─ 使用 DNSChecker.org 检查 DNS 是否更新
├─ 确认阿里云 DNS 已修改为 Cloudflare DNS
├─ 清除浏览器缓存和 DNS 缓存（ipconfig /flushdns）
└─ 等待 DNS 传播（最长 48 小时）
```

### 问题 2: Tunnel 连接失败
```
现象：Tunnel 状态显示红色
排查：
├─ 检查 Docker 容器是否正常运行
├─ 确认 Token 是否正确
├─ 检查网络连接（pr-network）
├─ 查看容器日志：docker logs cloudflared-tunnel
└─ 重启容器：docker restart cloudflared-tunnel
```

### 问题 3: 502 Bad Gateway
```
现象：访问域名显示 502 错误
排查：
├─ 检查 Public Hostname 配置的服务地址
├─ 确认前端容器正在运行
├─ 确认端口号正确（frontend:80）
├─ 检查容器网络连接
└─ 验证前端服务可访问：curl http://localhost:5173
```

### 问题 4: SSL 证书错误
```
现象：浏览器提示"不安全的连接"
排查：
├─ 确认 Cloudflare SSL 模式设置为 Flexible
├─ 等待 SSL 证书自动签发（5-10 分钟）
├─ 清除浏览器缓存重试
└─ 检查 DNS 是否已完全生效
```

### 问题 5: 容器无法连接网络
```
现象：容器启动后无法连接 Cloudflare
排查：
├─ 确认网络名称正确
├─ 检查网络是否存在：docker network ls
├─ 创建网络：docker network create personal-resource-manager_pr-network
└─ 重启容器
```

---

## 📝 配置文件说明

### docker-compose.tunnel.yml
```
位置：项目根目录
用途：部署 Cloudflare Tunnel 容器
敏感信息：Tunnel Token（已隐藏）

使用方法：
1. 复制 docker-compose.tunnel.yml.example 为 docker-compose.tunnel.yml
2. 替换 YOUR_TUNNEL_TOKEN 为实际 Token
3. 启动容器：docker-compose -f docker-compose.tunnel.yml up -d
```

### 注意事项
```
1. Tunnel Token 是敏感信息，不要提交到 Git 仓库
2. docker-compose.tunnel.yml 已添加到 .gitignore
3. 定期检查容器日志，确保 Tunnel 连接正常
4. 如更换域名，需要重新创建 Tunnel
```

---

## 💰 费用说明

| 项目 | 费用 |
|------|------|
| 域名购买 | ¥29-55/年（.cn/.com） |
| 域名隐私保护 | ¥39/年（可选） |
| Cloudflare DNS | 免费 |
| Cloudflare Tunnel | 免费 |
| Cloudflare CDN | 免费 |
| Cloudflare SSL | 免费 |
| **总计** | **¥29-94/年** |

**Cloudflare 所有基础功能完全免费，无流量限制！**

---

## 🔗 相关链接

- [Cloudflare 官网](https://www.cloudflare.com)
- [Cloudflare Dashboard](https://dash.cloudflare.com)
- [Cloudflare Tunnel 文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [阿里云域名控制台](https://dc.console.aliyun.com)
- [DNSChecker DNS 检测工具](https://dnschecker.org)
- [DB Browser for SQLite](https://sqlitebrowser.org)

---

## 📅 更新记录

- **2026-04-01**: 初始版本，记录完整配置流程
- **示例域名**: yourdomain.cn
- **Tunnel**: nas-tunnel
- **状态**: ✅ 已配置成功

---

## 📞 技术支持

如有问题，请检查：
1. Docker 容器日志
2. Cloudflare Tunnel 状态
3. DNS 解析是否生效
4. 网络连接是否正常

---

**文档维护者**: PersonalResourceManager 项目组  
**最后更新**: 2026年4月1日
