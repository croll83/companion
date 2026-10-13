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

- **Name** and **What it is about**. The about text becomes the description of the brain's skill, which tells the model when to use the brain.
- **Base URL**. The Companion derives the MCP endpoint (`<base>/mcp`), the health check (`<base>/healthz`) and the API (`<base>/api/v1`). Under **Advanced** you can override the MCP and health URLs.
- **Authentication**: none, or a bearer token. The token is stored only in `~/.companion/brains/<slug>/secret` (readable by you alone) and is never shown again or returned by the API.

**Test connection** checks the health URL and performs an MCP `initialize` against the server, then closes the test session.

## One brain per domain, off by default

- A new brain is on **nowhere**. Choose it in a domain's page, under **Brain**.
- Each domain has **at most one brain**: two brains would mix up where agents read and write. Choosing a brain replaces the current one.
- GLOBAL's brain is the default for every domain without a choice of its own. A domain can also choose **No brain**, or go back to **As in GLOBAL**.
- Removing a brain clears it from every domain. The remote server and its wiki are not touched.

Changes apply when a session starts or reloads. Sessions from before domains ("legacy") never get a brain.

## What the sessions get

Both CLIs get the brain's MCP server under the same name, `<slug>-brain`, and a skill with the same name. The skill is generated from the name and about text, or you can write your own (a body, or a whole `SKILL.md` with frontmatter) in the brain's page.

- **Claude Code**: the server is added to the session's generated MCP config (a bearer token goes in as an `Authorization` header in that private file), and the skill comes from a small plugin The Companion generates. Tools appear as `mcp__<slug>-brain__<tool>`.
- **Codex**: the server is added to the session's `config.toml` with `bearer_token_env_var`; the token itself is set only in the environment of the Codex process, never written to disk there. Codex does not show MCP server instructions to the model, so the skill is linked into the session and its `AGENTS.md` gets a line naming the brain.

## A plugin that serves the same brain

If a marketplace plugin serves the same MCP URL as a brain (for example the brain's own plugin), the tools would show up twice under two names. Wherever the brain is on, it wins: Claude sessions get the plugin turned off, Codex sessions skip its server and skill.

The brain's page lists such plugins. **Adopt plugin as brain** gives the brain to every domain where the plugin is on and turns the plugin off there, in one step. Tool names change for Claude (from `mcp__plugin_<plugin>_<server>__...` to `mcp__<slug>-brain__...`): update allowlists or notes that mention the old names. A resumed session sees the new names from its next turn.
