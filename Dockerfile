# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# Bundle note templates so the image is self-contained (the ./vault bind mount
# overrides this at runtime, but the host vault now ships templates via git too).
COPY --from=builder /app/vault/templates ./vault/templates
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
