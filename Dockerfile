FROM oven/bun:1 AS base

# Install git, curl and Node.js (needed for Claude Code npm package)
RUN apt-get update && \
    apt-get install -y curl git nodejs npm && \
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

# ── Create non-root user matching host UID/GID ───────────────────────
# Required: --dangerously-skip-permissions refuses to run as root.
# UID/GID must match the host user so bind-mounted files have correct ownership.
ARG HOST_UID=1000
ARG HOST_GID=1000

RUN (groupadd -g ${HOST_GID} companion 2>/dev/null || true) && \
    useradd -l -u ${HOST_UID} -g ${HOST_GID} -m -d /home/companion -s /bin/bash companion

# Ensure the companion user owns the app directory
RUN chown -R companion:companion /app

# Create /workspace with correct ownership (mount point for host workspace)
RUN mkdir -p /workspace && chown companion:companion /workspace

# Create .claude config dir for the companion user
RUN mkdir -p /home/companion/.claude && chown -R companion:companion /home/companion/.claude

# ── Runtime ───────────────────────────────────────────────────────────
WORKDIR /app/web

ENV NODE_ENV=production
ENV PORT=3456
ENV HOME=/home/companion

# Main server (WS + Web UI):  3456
# Messages API (/v1/messages): 3455 (PORT - 1)
EXPOSE 3456 3455

# Switch to non-root user
USER companion

CMD ["bun", "run", "start"]
