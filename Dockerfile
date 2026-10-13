FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

FROM node:26-alpine AS runner

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/itglue-mcp"

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcp

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

USER mcp

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the actual HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables for HTTP transport.
# 0.0.0.0 is the in-container bind. Startup still refuses to listen without a
# real CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1 refuses this host and only
# binds 127.0.0.1. AUTH_MODE=env reads ITGLUE_* from the environment after
# X-Gateway-S2S verifies; set AUTH_MODE=gateway so credentials come from
# request headers and never fall back to the process environment.
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

CMD ["node", "dist/index.js"]
