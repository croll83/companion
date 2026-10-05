---
title: Companion MCP tools
description: Let Claude Code and Codex schedule wake-ups and create agents on their own
---

# Companion MCP tools

Every Claude Code and Codex session started by Companion has a built-in MCP server called `companion`. With it the model can decide on its own to come back to the work later, or to set up a job that runs without it. In Claude Code the tools appear as `mcp__companion__<tool>`. In Codex they appear under the `companion` server.

You don't need to set anything up. To turn the tools off, open **Settings → General → Companion MCP tools for sessions**. The change applies to sessions started or restarted after it.

## The three ways to continue work later

| | What runs | What it knows | Use it for |
|---|---|---|---|
| **Wake-up** (`schedule_wakeup`) | The **same session**, at a set time or on a schedule | Its whole conversation | Follow-ups that need this context: "check the deploy in 30 minutes", waiting for CI, a daily check-in on the same task |
| **Agent, fork mode** (`create_agent` with `context_mode: "fork"`) | A **new session per run**, started from a **copy** of this conversation | Everything said up to the moment the run starts | Independent jobs that need the background of this conversation, without filling up the conversation itself |
| **Agent, brief mode** (`create_agent`, the default) | A **new session per run** | **Only its prompt** | Recurring or triggered jobs: nightly reports, periodic checks, webhook-triggered work |

A brief-mode prompt has to stand on its own: the goal, the paths and commands, what "done" means, and where to write the result (for example `reports/nightly-<date>.md`). Then you, or another session, can read the result later. The source session of a fork-mode agent is never changed by its runs.

## Tools

### Wake-ups

- **`schedule_wakeup`**: `message`, plus one of `at` (an ISO date-time, preferably with an offset), `in_minutes`, or `cron` (5 fields: minute hour day-of-month month day-of-week). The target is this session unless `session_id` is given. The message is delivered as a user message starting with `[scheduled wake-up …]`. If the session is busy, it waits for the current turn to end. If the session's CLI is stopped, it is restarted on its conversation first. See [Sessions → Wake-ups](#/docs/guides/sessions-and-permissions) for details.
- **`list_wakeups`**: pending wake-ups with their next time, plus recently delivered, skipped or missed ones.
- **`cancel_wakeup`**: `wakeup_id`.

### Agents

- **`create_agent`**: `name` and `prompt`. Optional:
  - a schedule: `at`, `in_minutes` or `cron`
  - `webhook: true`
  - `cwd`: defaults to this session's folder; `"temp"` gives each run a throwaway folder
  - `backend` and `model`: default to this session's
  - `context_mode`: `"brief"` or `"fork"`
  - `enabled`: defaults to true

  When the webhook is on, the tool returns its URL. The URL uses this machine's Tailscale address (`tailscale ip -4`), or `localhost` when there is none. It is reachable only from this machine and the tailnet (see [Agents → Webhook](#/docs/guides/agents)).
- **`list_agents`**, **`get_agent`**: list agents, or show one in full (prompt, triggers, webhook URL).
- **`update_agent`**: changes only the fields given. `clear_schedule` turns the schedule off. `webhook: false` turns the webhook off, and the URL stays the same.
- **`delete_agent`**: deletes the agent. Its past runs and their sessions are kept.
- **`run_agent`**: starts a run now, with an optional `input`, and returns the run's session id.
- **`list_agent_runs`**: recent runs with status (running, success or error), session id, start and end times, and any error.
- **`get_run_result`**: the final answer of a run, truncated to `max_chars` (4000 by default, at most 20000).

Agents created by a session show **Created by session …** on their card in the Agents page, with a link to that session.

## Limits and safety

- Sessions together may create at most **20 agents** and have at most **50 pending wake-ups**. Agents and wake-ups you create yourself don't count. Past the limit, the tool returns an error that asks the model to clean up or to ask you.
- Each session's MCP server uses its own token. The token identifies the session and works only for the routes these tools use. Companion's own auth token is no longer passed to Claude Code or Codex.
- A Codex session running sandboxed (workspace-write) cannot create, change, run or delete an agent that runs with full access. That includes every Claude agent, since Claude agents always run with full permissions. It also cannot schedule wake-ups into a full-access session.
- Claude Code asks for your approval before calling MCP tools, unless the session runs with full permissions (bypass).
- Your own MCP servers keep working. Companion adds `companion` next to them:
  - Claude Code: through `--mcp-config`
  - Codex: through an `[mcp_servers.companion]` entry in the session's own `config.toml`. The rest of that file is left as it is.
