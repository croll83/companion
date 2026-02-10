<p align="center">
  <img src="screenshot.png" alt="The Vibe Companion - Openclaw Version" width="100%" />
</p>

<h1 align="center">The Vibe Companion - Openclaw Version</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/the-vibe-companion"><img src="https://img.shields.io/npm/v/the-vibe-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-vibe-companion"><img src="https://img.shields.io/npm/dm/the-vibe-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

<br />

This project is a fork of the amazing work done by The Vibe Companion https://github.com/The-Vibe-Company/companion.git.

## Why
Exposing cloud-code on the web is great. And I can't replace cloud-code from my day2day activities. Max license is expensive but fully deserved. But as an Openclaw user and dev I can't get with the idea of having to pay an additional API service, on a pay-per-use model (tokens), with unpredictable costs if Openclaw becomes the brain of everything around you: emails, bookings, conversations, home control.

## What you get
If you are a Claude Max subscriber and also an Openclaw user, this package gives you the ability to configure an Openclaw provider that leverage Anthropic models under your same Claude Max subscription.

## How it works
Claude Companion extend the diagram that you can see in The Vibe Companion section by exposing /v1/messages HTTP REST API that respect the same format and standards used by the official anthropic provider in openclaw.

That means that you can just configure a new provider in the openclaw.json file that points to this docker on the 3455 port:

```
"providers": {
  "openrouter": { ... },
  "google": { ... },
  "claude-companion": {
    "baseUrl": "http://<IP-COMPANION>:3455",
    "apiKey": "dummy",
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
}
```

It also maps the .openclaw/workspace/dev folder (you have to create it manually) and set it as the base working folder for claude code, so that if you wish to use cloud code via web interface (the basic use case from The Vibe Companion), you can access to the same files that Openclaw will see and work on.

And of course it includes The Vibe Companion web dashboard: you can just open http://[IP Address]:3456 and enjoy a remote access to Claude Code!

## SECURITY ALERT!
This endpoint does not enforce any security or ApiKey. DO NOT EXPOSE THE CONTAINER TO INTERNET or anyone will be using Claude on your bills maxing out your burnrate.

The best solution is to run the container on the same host where you run Openclaw, just set the "network_mode: host" if you are on Linux server, or use port mapping (3455 and 3456) if you run on Mac/Windows

If you do run already Tailscale to access Openclaw remotely, The Vibe Companion will work same way, no additional conf needed.

PLEASE, TAKE CARE ABOUT YOUR SECURITY, this is not for newbie.

## SETUP
### 1. Clone the repo

```bash
git clone https://github.com/nicekid1/clawd-companion.git
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
      "id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4 (Companion)",
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

- `claude-companion/claude-sonnet-4-20250514` — Sonnet 4
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


# The Vibe Comanion
https://github.com/The-Vibe-Company/companion.git

Claude Code in your browser. We reverse-engineered the undocumented WebSocket protocol hidden inside the CLI and built a web UI on top of it. No API key needed, it runs on your existing Claude Code subscription.

```bash
bunx the-vibe-companion
```

Open [localhost:3456](http://localhost:3456). That's it.

## Why

Claude Code is powerful but stuck in a terminal. You can't easily run multiple sessions, there's no visual feedback on tool calls, and if the process dies your context is gone.

The Vibe Companion fixes that. It spawns Claude Code processes, streams their output to your browser in real-time, and lets you approve or deny tool calls from a proper UI.

## What you get

- **Multiple sessions.** Run several Claude Code instances side by side. Each gets its own process, model, and permission settings.
- **Streaming.** Responses render token by token. You see what the agent is writing as it writes it.
- **Tool call visibility.** Every Bash command, file read, edit, grep, visible in collapsible blocks with syntax highlighting.
- **Subagent nesting.** When an agent spawns sub-agents, their work renders hierarchically so you can follow the full chain.
- **Permission control.** Four modes, from auto-approve everything down to manual approval for each tool call.
- **Session persistence.** Sessions save to disk and auto-recover with `--resume` after server restarts or CLI crashes.
- **Environment profiles.** Store API keys and config per-project in `~/.companion/envs/` without touching your shell.

## How it works

The Claude Code CLI has a hidden `--sdk-url` flag. When set, it connects to a WebSocket server instead of running in a terminal. The protocol is NDJSON (newline-delimited JSON).

```
┌──────────────┐    WebSocket (NDJSON)    ┌─────────────────┐    WebSocket (JSON)    ┌─────────────┐
│  Claude Code │ ◄───────────────────────► │   Bun + Hono    │ ◄───────────────────► │   Browser   │
│     CLI      │  /ws/cli/:session        │     Server      │  /ws/browser/:session │   (React)   │
└──────────────┘                          └─────────────────┘                       └─────────────┘
```

1. You type a prompt in the browser
2. Server spawns `claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID`
3. CLI connects back over WebSocket
4. Messages flow both ways: your prompts to the CLI, streaming responses back
5. Tool calls show up as approval prompts in the browser

We documented the full protocol (13 control subtypes, permission flow, reconnection logic, session lifecycle) in [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md).

## Development

```bash
git clone https://github.com/The-Vibe-Company/companion.git
cd companion/web
bun install
bun run dev       # backend + Vite HMR on :5174
```

Production: `bun run build && bun run start` serves everything on `:3456`.

## Tech stack

Bun runtime, Hono server, React 19, Zustand, Tailwind v4, Vite.

## Contributing

Check [open issues](https://github.com/The-Vibe-Company/companion/issues), fork, branch, PR. For protocol-level work, read the [WebSocket spec](WEBSOCKET_PROTOCOL_REVERSED.md) first.

## License

MIT
