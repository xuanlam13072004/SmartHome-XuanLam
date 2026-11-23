# Admin Console (docs/architecture/admin.md): one container serving the web app
# and its backend (staff sign-in, permissions, forwarding to the API Gateway's
# /admin API and to the Device Simulator).
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV STATIC_DIR=/app/public
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api /app/dist ./dist
COPY --from=web /web/dist ./public
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
