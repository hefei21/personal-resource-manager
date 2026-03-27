# 构建阶段
FROM node:18-slim as build-stage

WORKDIR /app

# 优先复制 package 文件，利用 Docker 缓存
# 只有 package.json 变化时才重新安装依赖
COPY package.json ./

# 安装依赖（如果 package.json 没变，这层会被缓存）
RUN npm install

# 复制源代码（放在最后，因为源代码变化最频繁）
COPY . .

# 构建
RUN npm run build

# 生产阶段 - 使用更小的基础镜像
FROM nginx:alpine

# 复制构建产物
COPY --from=build-stage /app/dist /usr/share/nginx/html

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
