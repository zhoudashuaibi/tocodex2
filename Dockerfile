# ---------- 前端构建 ----------
FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci --workspace web
COPY web ./web
RUN npm run build --workspace web   # 产物 → /app/server/web-dist（vite outDir ../server/web-dist）

# ---------- 运行镜像 ----------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --workspace server --omit=dev
COPY server ./server
COPY --from=web-build /app/server/web-dist ./web-dist
RUN pip3 install --no-cache-dir --break-system-packages curl_cffi==0.15.0 \
 && mkdir -p /app/data \
 && chown -R node:node /app
USER node
ENV TOCODEX2_DATA_DIR=/app/data \
    TOCODEX2_WEB_DIST=/app/web-dist \
    TOCODEX2_IN_CONTAINER=1 \
    NODE_ENV=production
EXPOSE 2026
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:2026/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
