# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

COPY real-time-service/package*.json ./real-time-service/

WORKDIR /app/real-time-service
RUN npm ci

WORKDIR /app
COPY shared ./shared
COPY real-time-service ./real-time-service

WORKDIR /app/real-time-service
RUN npm run build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

COPY real-time-service/package*.json ./real-time-service/
WORKDIR /app/real-time-service
RUN npm ci --omit=dev

WORKDIR /app
COPY shared ./shared
COPY --from=builder /app/real-time-service/dist ./real-time-service/dist
COPY real-time-service/package.json ./real-time-service/package.json

WORKDIR /app/real-time-service
EXPOSE 3001
USER node
CMD ["npm", "run", "start"]
