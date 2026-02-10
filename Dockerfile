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

# ── Non-root user (UID 1000) ──────────────────────────────────────────
# --dangerously-skip-permissions requires non-root. UID 1000 must match the
# host user so bind-mounted files have correct ownership.
# If UID 1000 already exists (e.g. 'bun' in oven/bun), reuse it; otherwise create one.
ARG HOST_UID=1000
RUN EXISTING=$(getent passwd ${HOST_UID} | cut -d: -f1) && \
    if [ -z "$EXISTING" ]; then \
      groupadd -g ${HOST_UID} companion && \
      useradd -l -u ${HOST_UID} -g ${HOST_UID} -m -s /bin/bash companion; \
      EXISTING=companion; \
    fi && \
    HOME_DIR=$(getent passwd ${HOST_UID} | cut -d: -f6) && \
    chown -R ${HOST_UID}:${HOST_UID} /app && \
    mkdir -p /workspace && chown ${HOST_UID}:${HOST_UID} /workspace && \
    mkdir -p "$HOME_DIR/.claude" && chown -R ${HOST_UID}:${HOST_UID} "$HOME_DIR/.claude"

# ── Runtime ───────────────────────────────────────────────────────────
WORKDIR /app/web

ENV NODE_ENV=production
ENV PORT=3456
# Main server (WS + Web UI):  3456
# Messages API (/v1/messages): 3455 (PORT - 1)
EXPOSE 3456 3455

# Switch to non-root user (by UID, works regardless of username)
USER 1000

CMD ["bun", "run", "start"]
