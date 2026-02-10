FROM oven/bun:1 AS base

# Install git and curl (needed by companion server and Claude Code installer)
RUN apt-get update && \
    apt-get install -y curl git && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code via npm (native installer unreliable in Docker)
RUN npm install -g @anthropic-ai/claude-code@latest

# Verify claude is available
RUN claude --version

WORKDIR /app

# ── Install dependencies ──────────────────────────────────────────────
# bun.lock lives at the repo root, package.json inside web/
COPY bun.lock ./
COPY web/package.json ./web/
RUN cd web && bun install --frozen-lockfile 2>/dev/null || (cd /app/web && bun install)

# ── Copy source ───────────────────────────────────────────────────────
COPY web/ ./web/

# ── Build frontend (vite) ────────────────────────────────────────────
RUN cd web && bun run build

# ── Runtime ───────────────────────────────────────────────────────────
WORKDIR /app/web

ENV NODE_ENV=production
ENV PORT=3456

# Main server (WS + Web UI):  3456
# Messages API (/v1/messages): 3455 (PORT - 1)
EXPOSE 3456 3455

CMD ["bun", "run", "start"]
