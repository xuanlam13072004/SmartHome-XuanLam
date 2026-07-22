# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files for both the service and shared (if any exist, though shared doesn't have package.json)
# But since the build context is the root, we copy the root package.json if it exists.
# Wait, there's no root package.json.
# We just copy the service package.json.
COPY api-gateway/package*.json ./api-gateway/

# Install all dependencies (including devDependencies)
WORKDIR /app/api-gateway
RUN npm ci

# Copy source code
WORKDIR /app
COPY shared ./shared
COPY api-gateway ./api-gateway

WORKDIR /app/api-gateway
RUN npm run build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install only production dependencies
COPY api-gateway/package*.json ./api-gateway/
WORKDIR /app/api-gateway
# Need to rebuild native bindings for argon2
RUN npm ci --omit=dev

# Copy compiled files and shared
WORKDIR /app
COPY shared ./shared
COPY database ./api-gateway/database
COPY --from=builder /app/api-gateway/dist ./api-gateway/dist
COPY api-gateway/package.json ./api-gateway/package.json

WORKDIR /app/api-gateway
EXPOSE 3000
USER node
CMD ["npm", "run", "start"]
