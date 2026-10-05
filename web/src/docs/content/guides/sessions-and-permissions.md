---
title: Sessions & Permissions
description: Create sessions, manage them, and control agent permissions
---

# Sessions & Permissions

A session is a conversation with an agent backed by a CLI subprocess. Each session has its own message history, tool call log, task list, and permission state.

## Creating a session

Click **New Session** on the home page. Configure:

| Option | Description |
|---|---|
| **Backend** | Claude Code or Codex |
| **Working directory** | The folder the agent operates in |
| **Model** (Claude Code) | Which Claude model to use |
| **Branch** (optional) | Git branch to check out or create |
| **Use worktree** (optional) | Create an isolated [git worktree](#/docs/guides/git-worktrees) |
| **Environment** (optional) | Apply an [environment profile](#/docs/guides/environments) |
| **Linear issue** (optional) | Link a [Linear issue](#/docs/guides/linear-integration) for context |

Click **Start** to launch the session.

### What happens at creation

1. The server spawns a CLI subprocess (Claude Code or Codex) with `--sdk-url` pointing back to the server
2. The CLI connects to the server over WebSocket
3. The server bridges messages between the CLI and your browser
4. If a branch is selected, the server checks it out (or creates a worktree)

### Backend differences

**Claude Code** uses the NDJSON WebSocket protocol. It supports model selection, permission modes, and session resumption via `--resume`. Requires an Anthropic API key or Claude Pro/Team/Enterprise subscription.

**Codex** uses a JSON-RPC WebSocket protocol. It has its own authentication (OpenAI account) and supports an internet access toggle. Some features like permission modes may work differently.

The UI adapts to show only the options available for the selected backend.

### Via the REST API

```bash
curl -X POST http://localhost:3456/api/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "cwd": "/path/to/project",
    "backendType": "claude",
    "branch": "feature/my-branch",
    "useWorktree": true,
    "envSlug": "my-env-profile"
  }'
```

## Working with sessions

### Sidebar

The sidebar lists all active and recent sessions. Each entry shows the session name, backend type, connection status, and working directory. Click a session to switch to it.

### Chat view

The chat view displays messages in a timeline:

- **User messages**: Your prompts
- **Assistant messages**: Streaming agent responses
- **Tool call blocks**: Expandable blocks showing the tool name, input, and output
- **Permission banners**: Inline approve/deny buttons for sensitive actions

### Task panel

The right-side panel shows a structured breakdown of the agent's work. Tasks are automatically extracted from `TodoWrite`, `TaskCreate`, and `TaskUpdate` tool calls. Each task shows its status: pending, in progress, or completed.

At the top of the panel, the **Project** and **User** sections list the configuration files the agent loads:

- **Claude Code sessions**:
  - `CLAUDE.md` and `CLAUDE.local.md`, from the session's directory up to the repository root
  - `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`
  - commands, agents and skills, including symlinked skills and skills synced from claude.ai
- **Codex sessions**:
  - `AGENTS.md` from the session's directory up to the repository root
  - `~/.codex/AGENTS.md`. The Companion links it into every Codex session.
  - `~/.codex/config.toml`. The Companion copies it into each Codex session when the session is created, so an edit applies only to sessions created afterwards. Existing and resumed sessions keep their own copy.

Click a file to edit it. JSON and TOML files are checked before they are saved, and an invalid file is not written. Skills synced from claude.ai are read-only. Use the **+** button on a section to create a missing file, or a new command, agent or skill, from a template. The **+** button never overwrites an existing file.

### Session tabs

| Tab | Description |
|---|---|
| **Chat** | Main conversation view |
| **Diff** | File changes made during the session |
| **Editor** | In-app code editor (CodeMirror) |
| **Terminal** | Terminal access to the session's environment |
| **Process** | Raw CLI process output |

### Interrupting the agent

Click the **stop button** in the composer area to interrupt a running agent. This sends an interrupt signal to the CLI subprocess.

### Wake-ups (scheduled messages)

A wake-up sends a message into an existing session at a set time, so the agent picks up the work later with its whole conversation. Open the session's **Context** panel and use **Wake-ups → Schedule**:

- **Once**: a date and time
- **Repeat (cron)**: a 5-field cron expression, such as `0 9 * * 1-5`

Times are read in the time zone set in **Settings** (or the server's local zone when none is set). The panel lists pending wake-ups with their next time and a **Cancel** button. A wake-up that could not run shows why, with a **Dismiss** button.

When a wake-up fires, its message is sent as a user message that starts with `[scheduled wake-up <id>, set <when> by <who>]`, so the agent knows nobody typed it just now. Then:

- **The CLI is not running** (idle-killed, crashed, or the server restarted): the message is queued and the session is relaunched on its saved conversation (`--resume` for Claude Code, `thread/resume` for Codex). The message is delivered once the CLI is back.
- **A turn is running**: the message waits until the turn ends. It is never mixed into the running turn.
- **The session is archived**: a one-time wake-up is skipped. A recurring one skips that time and stays scheduled, in case the session is unarchived.
- **The session was deleted**: its wake-ups are deleted too.

Wake-ups survive restarts (they are stored in `~/.companion/wakeups/`, readable only by you). A one-time wake-up whose time passed while the server was down still fires at startup if it is less than 24 hours late. Otherwise it is shown as **missed**.

Wake-ups work the same for Claude Code and Codex sessions. A session can schedule its own wake-ups with the built-in `schedule_wakeup` tool (see [Companion MCP tools](#/docs/guides/companion-mcp)). From a script, use the REST API:

```bash
curl -X POST http://localhost:3456/api/sessions/SESSION_ID/wakeups \
  -H "Content-Type: application/json" \
  -d '{"message": "Check whether CI passed and fix it if not", "at": "2026-10-06T09:00"}'
```

Send `"cron": "0 9 * * 1-5"` instead of `at` for a repeating wake-up. A wake-up scheduled through the Companion MCP tools is recorded as created by that session (`"createdBy": "session:<id>"`), whatever the request body says.

### Sending a message to a session from outside

`POST /api/sessions/:id/message` with `{"content": "..."}` sends a user message into a session. It works for sessions whose CLI is not running: the message is queued and the session is relaunched on its saved conversation, like a wake-up. The response says `"delivery": "sent"` or `"queued"`. Archived sessions answer `409`.

### Archiving sessions

Remove sessions from the sidebar by archiving them. This:

- Stops the CLI subprocess
- Removes the session file from disk
- If a [Linear issue](#/docs/guides/linear-integration) is linked, prompts you to choose what happens to the issue status

## Permissions

When an agent wants to perform a sensitive action — writing files, running commands, accessing the network — The Companion intercepts the request and presents it for your approval.

### How it works

1. The CLI sends a permission request (e.g., "can I run `rm -rf node_modules`?")
2. A **permission banner** appears inline in the chat with the tool name and input
3. You click **Allow** or **Deny**
4. Your response is sent back to the CLI, which proceeds or skips accordingly

If you don't respond, the agent waits indefinitely — it will never act without your explicit consent.

### Permission modes

You can set the permission mode per session to control how much approval is required.

| Mode | Behavior |
|---|---|
| **Default** | Every sensitive tool call requires individual approval |
| **Accept Edits** | File edits are auto-approved; commands and network access still need approval |
| **Bypass** | All tool calls are auto-approved without prompting |

> **Warning:** Bypass mode removes all safety gates. Only use this in isolated environments or when you fully trust the agent's task.

You can change the permission mode at any time during a session. The change takes effect immediately for all subsequent tool calls.

### AI validation

AI validation uses a separate model to evaluate tool calls before execution. It categorizes each request as safe, dangerous, or uncertain.

#### Setup

1. Go to **Settings** and enter your **Anthropic API key**
2. Toggle **AI Validation** on

#### Categories

| Category | Behavior |
|---|---|
| **Safe** (read-only, benign commands) | Auto-approved if "auto-approve safe" is enabled |
| **Dangerous** (destructive commands like `rm -rf`) | Auto-denied if "auto-deny dangerous" is enabled |
| **Uncertain** | Shown to you with the AI's recommendation |

#### Per-session override

Click the **shield icon** in the session header to toggle AI validation on or off for that specific session, overriding the global setting.

## Session recovery

### Automatic persistence

Sessions are saved to disk as JSON files in `$TMPDIR/vibe-sessions/`. Writes are debounced to minimize I/O during streaming. The saved state includes the session configuration, message history, task list, permission state, and CLI process PID.

### What happens on server restart

1. The server reads all persisted session files
2. For each session with a recorded PID, it checks if the CLI process is still running
3. If alive, it gives a grace period for the CLI to reconnect its WebSocket
4. If gone (or no reconnection), the server relaunches the CLI with `--resume` using the session's internal ID

This means you can restart The Companion without losing your work. The agent picks up where it left off.

### Limitations

- If both the server and CLI crash simultaneously, the last few messages may not be persisted (due to write debouncing)
- Runtime state in the CLI process is lost on restart, though conversation history is preserved
