FROM node:22-alpine

RUN apk add --no-cache rclone

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY scripts/lib ./scripts/lib
COPY rclone/scripts ./rclone/scripts
