---
title: Environments
description: Environment-variable profiles applied to sessions and agents, globally or per project folder
---

# Environments

Environment profiles are named sets of environment variables that The Companion adds to the CLI process of a session or agent run. They work the same way for Claude Code and Codex.

Navigate to **Environments** in the sidebar, or open **Manage environments...** from the environment picker on the Home page.

Sessions always run directly on the host that runs The Companion. A profile only adds variables to the CLI's environment. It does not change where or how the CLI runs.

## Scope: where a profile applies

Each profile has a scope, chosen the same way as for [saved prompts](#/docs/guides/saved-prompts):

- **Global**: applied to every session and agent run.
- **Project folders**: applied when the session's working directory is one of the profile's folders or anywhere inside one. A session in a git worktree also matches the folders of the repository it was created from.

A profile without a scope is **unassigned**. Profiles created before scopes existed are unassigned. An unassigned profile never applies on its own. It applies only when you pick it explicitly for a session or an agent. The Environments page lists unassigned profiles in their own group, with a notice. Edit each one and choose **Global** or **Project folders** to make it apply automatically.

## Create a profile

1. Click **New Environment**.
2. Enter a **name**, for example "Production API" or "GLM v5".
3. Choose the **scope**. With **Project folders**, add one or more folders. If a session is open, its folder is filled in for you.
4. Add the key-value **variables**.
5. Click **Create**.

To change a profile's scope or folders later, click **Edit**.

## Which profiles a session gets

When a session's CLI starts, The Companion layers its environment in this order. A later layer overrides an earlier one:

1. Global profiles.
2. Project profiles whose folders contain the session's working directory, from the least specific folder to the most specific. A profile for `~/code/app/api` overrides one for `~/code/app`.
3. The profile you picked explicitly, if any. This can be any profile, including an unassigned one.
4. Variables passed with the session request or set inline on an agent.

After that, two more rules apply. The Claude Code OAuth token (for Claude sessions) or the OpenAI API key (for Codex sessions) from **Settings** is added if no layer set it. A linked Linear connection sets `LINEAR_API_KEY`.

The **Context** panel of a session lists the names of the profiles applied to it, in this order. It shows names only, never the values.

### Restarts and relaunches

The environment is rebuilt from your profiles every time the CLI starts. This covers the first launch, a model change, an automatic recovery, and a relaunch after The Companion itself restarted. As a result:

- Edits to a profile reach a running session the next time its CLI is relaunched.
- A session keeps its explicitly picked profile across restarts. Only the profile's slug is saved with the session, never its values.
- Variables passed with the session request are kept in an owner-only file next to the session state, so a relaunch after a restart still has them.

## Apply a profile explicitly

**To a session**: on the Home page, pick a profile from the environment dropdown. It applies on top of the global and folder-matched profiles. Choose **No environment** to rely on automatic profiles only.

**To an agent**: in the agent editor, pick a profile from the **Env Profile** dropdown. Agent runs also get the global profiles and the profiles matching the agent's working directory.

## Use case: alternative model providers

You can use environment variables to configure an alternative model provider. For example, to use GLM v5 in one project:

1. Create a profile named "GLM v5" and scope it to the project's folder.
2. Set these variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `https://your-glm-endpoint.example.com/v1` |
| `ANTHROPIC_API_KEY` | `your-glm-api-key` |
| `ANTHROPIC_MODEL` | `glm-v5` |

3. Every new session in that folder uses the provider. Other projects are not affected.

> **Tip:** The exact variables depend on your provider's compatibility layer. Many providers offer OpenAI- or Anthropic-compatible APIs that accept the same environment variables.

## Storage

Each profile is a JSON file in `~/.companion/envs/`, named by slug (for example `glm-v5.json`). Profiles often hold secrets, so the directory is owner-only (`0700`) and each file is `0600`. Files written by older versions are tightened the next time any profile is saved.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/envs` | List all profiles |
| `GET` | `/api/envs/:slug` | Get a single profile |
| `POST` | `/api/envs` | Create a profile. Body: `name`, `variables`, `scope` (`"global"` or `"project"`), and `folders` for project profiles. Without `scope` the profile is unassigned. |
| `PUT` | `/api/envs/:slug` | Update a profile. Any of `name`, `variables`, `scope`, `folders`. |
| `DELETE` | `/api/envs/:slug` | Delete a profile |
