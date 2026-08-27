# 多阶段构建：阶段 1 构建前端，阶段 2 运行后端并托管静态界面
FROM node:20-alpine AS builder

WORKDIR /app

# 复制清单文件，利用构建缓存
COPY package.json ./
COPY server/package.json server/
COPY web/package.json web/

# 安装后端 + 前端依赖（含 vite 等构建依赖）
RUN npm install --prefix server && npm install --prefix web

# 复制源码并构建前端
COPY server server
COPY web web
RUN npm run build --prefix web

# ---- 运行阶段 ----
FROM node:20-alpine AS runner

ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server/package.json server/

# 仅安装后端生产依赖
RUN npm install --prefix server --omit=dev

# 复制后端源码与前端构建产物
COPY server server
COPY --from=builder /app/web/dist web/dist

# 以非 root 用户运行（node 镜像内置 node 用户），降低容器逃逸风险
# 注意：挂载宿主目录到 /data 时需保证该目录对 uid 1000（node 用户）可写，如 chown -R 1000:1000 data
RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME /data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const h=require('node:http');h.get('http://127.0.0.1:3001/api/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "server/index.js"]
