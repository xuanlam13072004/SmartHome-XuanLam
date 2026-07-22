FROM node:20-slim

WORKDIR /app

COPY mqtt-worker-service/package*.json ./mqtt-worker-service/

WORKDIR /app/mqtt-worker-service
RUN npm ci --omit=dev

WORKDIR /app
COPY shared ./shared
COPY mqtt-worker-service ./mqtt-worker-service

WORKDIR /app/mqtt-worker-service
USER node
CMD ["npm", "run", "start"]
