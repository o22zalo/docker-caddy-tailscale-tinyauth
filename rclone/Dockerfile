FROM node:22-alpine

RUN --mount=type=cache,target=/var/cache/apk apk add rclone

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY scripts/lib ./scripts/lib
COPY scripts ./scripts
