---
title: The Companion
description: Web UI for Claude Code and Codex sessions
---

# The Companion

A browser-based interface for running multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) sessions with streaming output, tool call visibility, and permission control.

## Quick start

```bash
bunx the-companion
```

Open [http://localhost:3456](http://localhost:3456). See the [Installation](#/docs/get-started/installation) guide for more options.

## Subscription and authentication

The Companion is a local UI layer that runs on your machine. It does not have its own account system or billing.

- **Claude Code** requires an Anthropic API key or a Claude Pro/Team/Enterprise subscription with Claude Code enabled.
- **Codex** requires an OpenAI account with Codex CLI access.

All model inference happens through your own subscriptions. The Companion bridges your browser to these CLI tools over a local WebSocket connection.

## Features

- [Sessions & Permissions](#/docs/guides/sessions-and-permissions) — Run parallel sessions, approve tool calls, and recover work after restarts.
- [Docker & Environments](#/docs/guides/docker-and-environments) — Define environment profiles with variables, Docker containers, init scripts, and port forwarding.
- [Git Worktrees](#/docs/guides/git-worktrees) — Isolate sessions with git worktrees so multiple agents can work on the same repo without conflicts.
- [Agents](#/docs/guides/agents) — Build reusable agent configurations with custom prompts, triggers (webhook, schedule), and Docker/git support.
- [Saved Prompts](#/docs/guides/saved-prompts) — Create reusable prompts scoped globally or to specific projects. Insert them in any session with @mentions.
- [Linear Integration](#/docs/guides/linear-integration) — Search and create Linear issues, link them to sessions, and auto-transition issue status.
- [Deploy](#/docs/deploy/cloud-vm) — Run The Companion on cloud VMs for always-on access with secure Tailscale networking.
