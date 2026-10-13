---
title: Brains
description: Connect a remote knowledge base (an MCP server) and give it to the sessions of a domain
---

# Brains

A **brain** is a knowledge base with an MCP server in front of it, for example a curated wiki with its sources. The Claude Code and Codex sessions of a domain that uses a brain can search and read it, and record new facts if the brain has an inbox.

Memory = the CLI's private notes; Brain = a curated, shared wiki with sources.

Open **Brains** in the sidebar (`#/brains`).

## Remote brains

This version connects **remote** brains: a server that runs elsewhere and is reachable at an URL, such as a brain on your tailnet or a team brain. Brains that The Companion runs itself ("embedded") come later.

Click **Connect remote brain** and fill in:

- **Name** and **What it is about**. The about text is the description of the generated skill, used when the server publishes no skill of its own (see below). It tells the model when to use the brain.
- **Base URL**. The Companion derives the MCP endpoint (`<base>/mcp`), the health check (`<base>/healthz`), the API (`<base>/api/v1`) and the server's skill (`<base>/skill`). Under **Advanced** you can override the MCP and health URLs.
- **Authentication**: none, a bearer token, or OAuth with a pre-registered client (see below). A bearer token is stored only in `~/.companion/brains/<slug>/secret` (readable by you alone) and is never shown again or returned by the API.

**Test connection** checks the health URL and performs an MCP `initialize` against the server, then closes the test session.

## OAuth (pre-registered client)

Some brains sit behind an identity provider that does not let clients register themselves, such as Microsoft Entra. Their admins register an app once and give you its **client id**. Choose **OAuth (pre-registered client)** and fill in:

- **OAuth client id**: the app's id. It is not a secret.
- **Callback port** (optional): the fixed loopback port of Claude Code's sign-in redirect, if the app registration names one. Codex picks its own port.

The Companion never sees the OAuth tokens. Each CLI signs in by itself, **once**, and keeps the tokens in its own store: Claude Code in its credentials, Codex in the system keyring. The login then serves every session of that CLI. To sign in:

1. Choose the brain in a domain.
2. Open a session of that domain.
3. In the session's MCP panel, find `<slug>-brain` and press **Sign in**.

Do it once from a Claude Code session and once from a Codex session if you use both. The brain's page explains this and links to a domain that uses the brain.

The health check (`/healthz`) does not need a sign-in on brain servers, so the dot still says whether the brain is up. **Test connection** reports an MCP answer of `401` with a sign-in challenge as "reachable, sign-in required", not as a failure.

## Skill from the server

A brain server can publish its own skill at `<base>/skill`, a public endpoint (jarvis-brain and hercle-brain do). It returns the operator's description, the usage rules and the tool list. This is better than a skill written from the about text, and it matters most for Codex, which does not see the server's MCP instructions.

- **New brains** try the server's skill first. If the server has no `/skill` (HTTP 404) or returns something invalid, the brain gets the generated skill and a note on its page says why.
- In the brain's page, the **Skill** section offers **From the server**, **Generated from the about text** and **Custom text**. **Refresh skill** fetches the server's skill again. Nothing changes when the server answers that the skill is unchanged (ETag).
- When the health check reports a new wiki version (`content_hash`) and the skill depends on the wiki, the skill is fetched again automatically. A skill that does not depend on the wiki (`content_hash: null`) is not refetched.
- If a refresh fails, the last skill fetched stays in use, with a note.
- The fetch runs on The Companion's server, with a 5-second timeout and a 64 KB limit. An OAuth brain gets no credentials. A bearer brain gets its token, but only when `/skill` is on the MCP server's own origin.
- The skill is renamed `<slug>-brain` like every brain skill.
- The page shows the skill as plain text and never renders it.

## One brain per domain, off by default

- A new brain is on **nowhere**. Choose it in a domain's page, under **Brain**.
- Each domain has **at most one brain**: two brains would mix up where agents read and write. Choosing a brain replaces the current one.
- GLOBAL's brain is the default for every domain without a choice of its own. A domain can also choose **No brain**, or go back to **As in GLOBAL**.
- Removing a brain clears it from every domain. The remote server and its wiki are not touched.

Changes apply when a session starts or reloads. Sessions from before domains ("legacy") never get a brain.

## What the sessions get

Both CLIs get the brain's MCP server under the same name, `<slug>-brain`, and a skill with the same name. The skill comes from the server, is generated from the name and about text, or is your own text (a body, or a whole `SKILL.md` with frontmatter) written in the brain's page.

- **Claude Code**: the server is added to the session's generated MCP config. A bearer token goes in as an `Authorization` header in that private file. An OAuth brain gets `"oauth": {"clientId", "callbackPort"}` instead. The skill comes from a small plugin The Companion generates. Tools appear as `mcp__<slug>-brain__<tool>`.
- **Codex**: the server is added to the session's `config.toml`.
  - Bearer brain: `bearer_token_env_var`. The token itself is set only in the environment of the Codex process and is never written to disk there.
  - OAuth brain: an `[mcp_servers.<slug>-brain.oauth]` table with the `client_id`.
  - Codex does not show MCP server instructions to the model, so the skill is linked into the session and its `AGENTS.md` gets a line naming the brain.

## A plugin that serves the same brain

If a marketplace plugin serves the same MCP URL as a brain (for example the brain's own plugin), the tools would show up twice under two names. Wherever the brain is on, it wins: Claude sessions get the plugin turned off, Codex sessions skip its server and skill.

The brain's page lists such plugins. **Adopt plugin as brain** gives the brain to every domain where the plugin is on and turns the plugin off there, in one step. Tool names change for Claude (from `mcp__plugin_<plugin>_<server>__...` to `mcp__<slug>-brain__...`): update allowlists or notes that mention the old names. A resumed session sees the new names from its next turn.
