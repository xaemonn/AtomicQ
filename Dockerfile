# Stage 1: Build Dashboard Frontend
FROM node:20-alpine AS dashboard-builder
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci --legacy-peer-deps
COPY dashboard/ ./
RUN npm run build

# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
# Compile TypeScript and copy the Lua scripts into dist/lua
RUN npm run build

# Stage 3: Runner (Final Image)
FROM node:20-alpine
WORKDIR /app

# Only install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy compiled backend from builder
COPY --from=backend-builder /app/dist ./dist

# Copy built dashboard from stage 1
COPY --from=dashboard-builder /app/dashboard/dist ./dashboard/dist

# Default environment variables
ENV PORT=3000
ENV REDIS_URL=redis://redis:6379
ENV NODE_ENV=production

# Expose the API port
EXPOSE 3000

# Healthcheck for Observability
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:$([ -f /tmp/health_port ] && cat /tmp/health_port || echo ${PORT:-3000})/health || exit 1

# Entrypoint
CMD ["node", "dist/server.js"]
