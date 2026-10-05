---
title: Saved Prompts
description: Create reusable prompts and insert them into sessions with @mentions
---

# Saved Prompts

Saved prompts let you store reusable instructions that can be inserted into any session. Navigate to **Prompts** in the sidebar (or go to `#/prompts`).

## Create a prompt

1. Click **New Prompt**
2. Enter a **name** (e.g., `review-pr`, `fix-tests`, `explain-code`)
3. Write the **prompt content** — the actual instructions the agent will receive
4. Choose a **scope**:
   - **Global**: Available in all sessions regardless of working directory
   - **Project**: Only appears in sessions whose working directory matches one of the associated folders
5. For project-scoped prompts, click **Add Folder** to associate one or more project paths
6. Click **Save**

## Edit and delete

- Click the **pencil icon** on any prompt card to edit its name, content, scope, or associated folders
- Click the **trash icon** to delete a prompt
- Use the **search bar** at the top to filter prompts by name or content

## Scope: global vs project

| Scope | Visible in | Use case |
|---|---|---|
| Global | All sessions | General instructions like "review this PR" or "explain this code" |
| Project | Sessions whose cwd matches an associated folder | Project-specific instructions like "use our ESLint config" or "follow our API conventions" |

A single prompt can be associated with multiple project folders. For example, a "run tests" prompt could be linked to both your frontend and backend repos with different test commands.

## Grouped view

The Prompts page groups prompts by scope:

- **Global** section at the top with all global prompts
- **Per-folder** sections below, one for each unique project path

## Using prompts in sessions

Once you've created prompts, you can insert them with `@` in the session composer and in the Home composer. This works the same for Claude Code and Codex sessions.

### How to use

1. Click in the **composer** (the message input).
2. Type `@` at the start of the message or after a space. A **mention menu** opens with matching prompts.
3. Keep typing to narrow the list (for example `@rev`).
4. Pick a prompt from the menu. The `@token` is replaced by the prompt's content, followed by a space:
   - **Tab** inserts the highlighted prompt (the first one, unless you moved the highlight).
   - **Click** inserts the prompt you click.
   - **↑ / ↓** (or moving the pointer over an item) highlights a prompt, then **Enter** inserts it.
   - **Enter** also inserts a prompt when what you typed is its **exact name** (`@review-pr`, any letter case).
5. Add any extra context, then press Enter to send.

**Enter alone sends.** If you have not moved through the menu and the `@token` is not an exact prompt name, Enter sends the message as typed, `@token` included. This applies to a bare `@`, to a partial name such as `@rev`, and to a token that matches no prompt. A message ending in `@something` is never silently held back.

**Escape** closes the menu. It stays closed until you leave that `@token`. **Shift+Enter** always inserts a new line.

### File references are left alone

Claude Code and Codex use `@path` to point at a file. A token that looks like a file path never opens the prompt menu, so Enter sends it as typed:

- it contains `/` or `\` (`@src/foo.ts`, `@~/notes`)
- it ends with a `.extension`, including one you are still typing (`@package.json`, `@README.`)

There is one exception. If such a token is exactly the name of a saved prompt (for example a prompt called `v1.2`), it is treated as that prompt.

### How filtering works

- The text after `@` is matched against prompt **names**, ignoring letter case. Prompt content is not searched.
- Results are ordered in three groups: an **exact** name match first, then names that **start with** the text, then names that **contain** it anywhere. Other prompts are hidden.
- Within each group, and when you've typed only `@`, prompts are ordered by **most recently updated** first.
- **Global prompts** always appear.
- **Project-scoped prompts** appear only when the working directory matches one of the prompt's folders, or is inside one. In a session that is the session's cwd. On Home it is the selected folder.
- The list is reloaded every time the menu opens. Prompts you just created or edited (on the Prompts page or in another tab) show up without reloading the app.

### Save the composer text as a prompt

The **bookmark** button in the session composer saves the current text as a new prompt. Give it a title and choose **Global** or **This project** (the session's folder). Only the text is needed, so this works even while the CLI is disconnected.

### Example workflow

**1. Create a "review-pr" prompt:**

- **Name**: `review-pr`
- **Content**: `Review this pull request. Check for bugs, security issues, and code style. Suggest improvements. Run the test suite and report any failures.`
- **Scope**: Global

**2. Use it in a session:**

Type `@review-pr` and press Enter (or type `@rev` and press Tab). The token is replaced with the full prompt content. Then add extra context and send:

```
Review this pull request. Check for bugs, ... report any failures. Focus especially on the authentication changes in auth.ts.
```

Typing `@review-pr Focus ...` and sending without picking the prompt sends the literal text `@review-pr`. The prompt is expanded only when you pick it from the menu.

**3. Project-specific variant:**

Create another prompt with the same name scoped to your backend project:

- **Name**: `review-pr`
- **Content**: `Review this pull request. Run "bun run test" and "bun run typecheck". Check that all API routes have input validation. Ensure SQL queries use parameterized statements.`
- **Scope**: Project (`/home/user/backend`)

In a session whose cwd is `/home/user/backend` (or a folder inside it), both versions appear in the mention menu, each labelled with its scope. The most recently updated one is listed first, and that is the one Enter inserts for an exact `@review-pr`. To pick the other one, use ↑ / ↓ and Enter, or click it. In other sessions only the global version appears.

## Storage

Prompts are stored in `prompts.json` under the Companion home (`~/.companion/` unless `COMPANION_HOME` is set), as a JSON array. Each prompt has a unique ID, name, content, scope, and timestamps.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/prompts` | List prompts, most recently updated first (optional `?cwd=` and `?scope=` filters) |
| `GET` | `/api/prompts/:id` | Get a single prompt |
| `POST` | `/api/prompts` | Create a prompt |
| `PUT` | `/api/prompts/:id` | Update a prompt |
| `DELETE` | `/api/prompts/:id` | Delete a prompt |
