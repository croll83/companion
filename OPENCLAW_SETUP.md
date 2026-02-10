# Claude Companion — OpenClaw Setup Guide

## What is it

Claude Companion is a Docker bridge that exposes an Anthropic-compatible `/v1/messages` SSE endpoint, but internally routes requests through the Claude Code CLI (Pro/Max subscription). This lets OpenClaw use Claude models without an API key — everything goes through your subscription.

## Prerequisites

- Docker and Docker Compose installed
- An active Claude Pro or Max subscription
- OpenClaw already installed and running

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/croll83/clawd-companion.git
cd clawd-companion
```

### 2. Configure docker-compose

Edit `docker-compose.yml` and set the workspace volume to the path where OpenClaw works:

```yaml
services:
  companion:
    build: .
    network_mode: host
    environment:
      - PORT=3456
      - CLAUDE_CWD=/workspace
    volumes:
      - claude-config:/root/.claude
      - /path/to/.openclaw/workspace/dev:/workspace   # <-- change this
    restart: unless-stopped

volumes:
  claude-config:
```

> **Note:** `network_mode: host` makes the container listen directly on host ports (3456 for the dashboard, 3455 for the API). No firewall rules needed if OpenClaw runs on the same host.

### 3. Build and start

```bash
docker compose build
docker compose up -d
```

> First build takes ~2 minutes (downloads the Bun runtime and Claude Code binary).

### 4. Login to Claude Code (first time only)

```bash
docker compose exec companion claude login
```

This starts an OAuth flow in the browser. Complete the login — the session is saved in the `claude-config` Docker volume and persists across restarts.

### 5. Verify it works

```bash
curl --no-buffer -X POST http://localhost:3455/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "stream": true,
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello, what model are you?"}]
  }'
```

You should see streaming SSE events with the response.

### 6. Add the provider to OpenClaw

Edit your `openclaw.json` (usually at `~/.openclaw/openclaw.json`) and add inside `models.providers`:

```json
"claude-companion": {
  "baseUrl": "http://localhost:3455",
  "apiKey": "not-needed",
  "api": "anthropic-messages",
  "models": [
    {
      "id": "sonnet",
      "name": "Claude Sonnet Latest (Companion)",
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 200000,
      "maxTokens": 16384,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    },
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6 (Companion)",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 200000,
      "maxTokens": 16384,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
    }
  ]
}
```

### 7. Restart OpenClaw

```bash
# if running as a container
docker compose restart openclaw

# if running as a process
# just kill and restart the openclaw process
```

### 8. Use the models

From OpenClaw you can now select:

- `claude-companion/sonnet` — Sonnet Latest
- `claude-companion/claude-opus-4-6` — Opus 4.6

Or set them as default in `openclaw.json`:

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "claude-companion/claude-opus-4-6"
    }
  }
}
```

## Ports

| Port  | Service |
|-------|---------|
| 3456  | Web Dashboard + WebSocket |
| 3455  | API `/v1/messages` (Anthropic-compatible) |

## Notes

- **No API key needed** — the companion uses the authenticated Claude Code session
- **Model can be switched per-request** via the `model` field in the request body
- **Costs are zero** in the config because they go through the Max/Pro subscription
- **The dashboard** is accessible at `http://<host>:3456`
- **If the login expires**, re-run `docker compose exec companion claude login`
