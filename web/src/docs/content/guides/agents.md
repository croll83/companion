---
title: Agents
description: Build reusable agent configurations with custom prompts, triggers, and automation
---

# Agents

Agents are reusable configurations that start sessions with specific settings, a prompt, and triggers. Navigate to **Agents** in the sidebar (or go to `#/agents`). Every run is listed on the **Runs** page (`#/runs`, also in the sidebar).

Agents work with Claude Code and Codex. The few options that only one backend supports are marked below.

Sessions can also create and manage agents themselves with the built-in `create_agent`, `run_agent` and related tools. See [Companion MCP tools](#/docs/guides/companion-mcp).

## Create an agent

1. Click **+ New Agent**
2. Fill in the **identity** section:
   - **Name**: A descriptive name (e.g., "PR Reviewer", "Test Runner")
   - **Description**: What this agent does
   - **Icon**: Choose from 18 icons (bot, terminal, pencil, search, shield, rocket, wrench, etc.)

3. Write the **prompt**:
   - This is the instruction the agent receives when a run starts
   - Use `{{input}}` as a placeholder for input provided by the trigger
   - Example: `Review the following pull request and provide feedback: {{input}}`
   - If the prompt has no `{{input}}` and a trigger provides input, the input is appended after the prompt in a delimited `<trigger_input>` block, so it is never dropped

4. Pick the **context** each run starts from (see **Context** below): **Brief** (default) or **Fork a session**

5. Configure the **controls row**:
   - **Backend**: Claude Code or Codex
   - **Model**: Which model to use
   - **Permissions**: see **Permissions** below
   - **Working directory**: The folder the agent works in. Without one, each run gets a fresh temporary directory
   - **Environment profile** (optional): Apply an [environment profile](#/docs/guides/environments) explicitly. Global and folder-matched profiles apply anyway
   - **Internet access** (Codex only): Toggle network access

6. Click **Create**

## Context

- **Brief** (default): every run starts a new, empty session. The prompt must say everything the agent needs to know.
- **Fork a session**: every run starts from a **copy** of another session's conversation, so the agent knows everything that session discussed. Pick the source session in the editor. The run works in the source session's folder (the agent's own folder is not used). The source session is never changed: Claude Code runs with `--resume <source> --fork-session`, and Codex runs `thread/fork`, which writes a new thread.

The source must be a session of the same backend as the agent, with at least one message. The editor refuses a source that cannot be forked. If the source can no longer be resumed when a run starts (its transcript was cleaned up, the session was deleted, or its folder is gone), the run fails with the reason.

## Permissions

Agent runs are unattended: nobody is there to answer an approval prompt.

- **Claude Code** agents always run with full permissions (`bypassPermissions`). The editor shows this as a fixed **Full permissions** badge. To limit what an agent can do, use **Allowed tools** (see Advanced configuration).
- **Codex** never asks for approvals in agent runs. The mode you pick selects the sandbox: **Full Auto** runs without a sandbox (`danger-full-access`), **Supervised** runs in the `workspace-write` sandbox.

## Runs

A **run** starts when a trigger fires. It is **complete when its session reports the first turn result**. The run then records:

- when it finished, and so its duration
- **success** or **error**: a run fails when that result is an error (for example `error_max_turns`), or when the CLI exits before producing one
- the error message and the result subtype

The session itself is kept after the run: open it from the Runs page to read the outcome or to continue the conversation.

If the server restarts while a run is in progress, the run is closed as interrupted (a restart ends every CLI).

**One run at a time.** While a run of an agent is in progress, new schedule, webhook, and **Run** triggers for that agent are refused. A webhook call gets `409`, a refused scheduled run is reported on the agent card, and **Run** shows the reason. To get unstuck from a run that never finishes, archive its session.

**Failures.** After 5 failed runs in a row the agent is disabled. A successful run resets the count.

**Temporary directories.** An agent without a working directory gets a new temporary directory per run. It is deleted once the run is complete and its session is archived or deleted. It is never deleted while a session still uses it. If you unarchive such a session, an empty directory is recreated so the session can start.

## Run an agent manually

Click **Run** on an agent card. If the prompt contains `{{input}}`, a dialog asks for the input. Manual runs work even when the agent is disabled, but not while another run of it is in progress.

## Enable and disable

Toggle agents on/off from the agent card menu. Disabled agents don't run on schedule or webhook triggers, but can still be run manually.

## Agent cards

Each agent card shows:
- Name, description, and icon
- Backend type
- Trigger badges (Manual, Webhook, Schedule, Linear Agent)
- **Running** while a run is in progress (links to the Runs page)
- A schedule problem, if any (a past one-time date, a skipped scheduled run)
- **Created by session …** for agents a session created through the Companion MCP tools, with a link to that session
- Stats: total runs, last run time, next scheduled run

## Triggers

### Manual trigger

Always available. Click **Run** on the agent card.

### Webhook trigger

Lets a script or service on this machine or on your Tailscale network start the agent.

**Setup:**
1. Open the agent editor
2. In the **Triggers** section, toggle **Webhook** on
3. A secret URL is generated when you save
4. Copy the webhook URL from the agent card menu

**Calling the webhook:**

```bash
curl -X POST http://your-companion:3456/api/agents/pr-reviewer/webhook/YOUR_SECRET \
  -H "Content-Type: application/json" \
  -d '{"input": "Review PR #42 on the main branch"}'
```

The body is either JSON with an optional `input` field or plain text (used as the input). The input is limited to 256 KB.

**Security model:**
- The secret in the URL is the only credential: no Companion token is needed.
- Calls are accepted **only from this machine (loopback) or your Tailscale network** (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Anything else gets `403`, even with the right secret. If a local proxy or tunnel forwards the request, the forwarded client address must also be in those ranges.
- Each agent accepts at most 10 webhook calls per minute (`429` with `Retry-After` beyond that).
- The call honours the agent's **enabled** switch and the one-run-at-a-time rule (`409` with the reason).
- Regenerate the secret from the agent card menu to invalidate the old URL.

**Responses:** `200` run started, `401` wrong secret, `403` webhook disabled or caller not on loopback/tailnet, `404` unknown agent, `409` agent disabled or a run in progress, `413` body too large, `429` rate limited.

Webhook runs appear on the Runs page with the trigger **Webhook**.

### Schedule trigger

Run agents automatically on a recurring schedule or once at a specific time.

Schedules run in the **time zone set in Settings**. If no time zone is set, they run in the server's local time zone. Changing the setting re-arms every schedule.

**Recurring (cron):**

1. In the agent editor, toggle **Schedule** on
2. Choose a **preset** or enter a cron expression with **5 fields**: minute, hour, day of month, month, day of week. Nicknames such as `@daily` and `@hourly` work too. A seconds field (6 or 7 fields) is rejected.

| Preset | Cron expression |
|---|---|
| Every hour | `0 * * * *` |
| Daily at 8am | `0 8 * * *` |
| Weekdays at 9am | `0 9 * * 1-5` |
| Weekly on Monday | `0 8 * * 1` |

3. The agent card shows the next scheduled run time

An invalid expression is refused when you save, with the reason.

**One-time (datetime):**

1. Toggle **Schedule** on
2. Switch to **One-time** mode
3. Pick a date and time
4. The agent runs once at that time, then the schedule turns itself off

A date in the past is refused when you save. If the server was down when a one-time run was due, the run does not happen late: the agent card reports that it was missed.

A scheduled run that is refused (the agent has a run in progress) is reported on the agent card too.

### Linear Agent trigger

See [Linear integration](#/docs/guides/linear-integration).

## Run history

The **Runs** page lists every run with its agent, trigger, status (running, success, error), start time, duration and a link to the session. Filter by agent, trigger or status. Click a run for its details, including the error and the result subtype.

The same data is available through the API:

```bash
curl "http://localhost:3456/api/executions?agentId=pr-reviewer&status=error" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Run records are stored as daily JSONL files in `~/.companion/executions/` (under `COMPANION_HOME` if set).

## Advanced configuration

The agent editor has an **Advanced** section (click to expand) with additional configuration options.

### MCP servers

Add [Model Context Protocol](https://modelcontextprotocol.io/) servers to give the agent access to external tools and data sources.

1. In the agent editor, expand **Advanced**
2. Under **MCP Servers**, click **Add Server**
3. Fill in:
   - **Name**: Identifier for the server (e.g., `github`, `database`)
   - **Type**: `stdio` (command-line process), `sse` (server-sent events), or `http`
   - **Command + Args** (stdio): The command to run (e.g., `npx -y @modelcontextprotocol/server-github`)
   - **URL** (sse/http): The server URL

### Allowed tools (Claude Code only)

Limit the agent to a set of Claude Code's built-in tools. Type a tool name (for example `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `WebFetch`) and press Enter. The agent then has **only** those built-in tools: The Companion starts Claude Code with `--tools`. Leave the list empty to allow all tools.

- Only plain tool names are accepted. Permission patterns such as `Bash(git *)` are not supported.
- MCP server tools are not affected by this list.
- Codex has no per-tool restriction, so the option is hidden for Codex agents. Use the Codex sandbox mode instead.

### Per-agent environment variables

Add key-value environment variables specific to this agent. They override variables from environment profiles.

### Codex-specific

| Option | Description |
|---|---|
| **Internet access** | Toggle network access for Codex sessions |
| **Permissions** | The sandbox mode (see **Permissions** above) |

## Import and export

### Export an agent

1. On the **Agents** page, open the agent card menu
2. Click **Export**
3. A `.agent.json` file is downloaded

The exported file contains the agent's configuration. Tracking fields (ID, creation date, run count) and Linear credentials are excluded.

### Import an agent

1. On the **Agents** page, click **Import**
2. Select a `.agent.json` file
3. The agent is created **disabled** — review its configuration before enabling it

Files exported by older versions may contain `skills`, `branch`, `createBranch` or `useWorktree`. These options were never applied to runs and have been removed; they are ignored on import.

> **Warning:** Imported agents start disabled. Review the agent's prompt, environment variables, and permissions before enabling it, especially if the file came from an external source.

### REST API

```bash
# Export
curl http://localhost:3456/api/agents/pr-reviewer/export \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o pr-reviewer.agent.json

# Import
curl -X POST http://localhost:3456/api/agents/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d @pr-reviewer.agent.json
```

## Scheduled Runs (removed)

Older versions had a separate **Scheduled Runs** feature. It has been removed. On first start, existing scheduled jobs are converted once into agents with a schedule trigger.

## Storage

Agents are stored as individual JSON files in `~/.companion/agents/` (under `COMPANION_HOME` if set). The agent ID is a slug derived from the name (e.g., "PR Reviewer" becomes `pr-reviewer`).
