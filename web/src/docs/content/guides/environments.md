---
title: Environments
description: Define reusable environment-variable profiles for sessions and agents
---

# Environments

Environment profiles let you define reusable sets of environment variables that are injected into the CLI subprocess when launching sessions or agents.

Navigate to **Environments** in the sidebar, or access from **Settings > Environments**.

## Create a profile

1. Click **New Environment**
2. Enter a **name** (e.g., "Production API", "GLM v5 Setup")
3. Add key-value **variables**
4. Click **Save**

Sessions always run directly on the host that runs The Companion. Variables from the profile are added to the CLI's environment; they do not change where or how the CLI runs.

## Apply a profile

**To a session**: When creating a new session on the Home page, select an environment profile from the **Environment** dropdown.

**To an agent**: In the agent editor, select an environment profile from the **Env Profile** dropdown in the controls row. The profile is applied every time the agent runs.

## Use case: alternative model providers

You can use environment variables to configure alternative model providers. For example, to use GLM v5:

1. Create a new environment profile named "GLM v5"
2. Set these variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `https://your-glm-endpoint.example.com/v1` |
| `ANTHROPIC_API_KEY` | `your-glm-api-key` |
| `ANTHROPIC_MODEL` | `glm-v5` |

3. Select this profile when creating sessions or configuring agents

> **Tip:** The exact variables depend on your model provider's compatibility layer. Many providers offer OpenAI- or Anthropic-compatible APIs that accept the same environment variables.

## Storage

Profiles are stored as individual JSON files in `~/.companion/envs/`, named by slug (e.g., `glm-v5.json`).

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/envs` | List all profiles |
| `GET` | `/api/envs/:slug` | Get a single profile |
| `POST` | `/api/envs` | Create a profile |
| `PUT` | `/api/envs/:slug` | Update a profile |
| `DELETE` | `/api/envs/:slug` | Delete a profile |
