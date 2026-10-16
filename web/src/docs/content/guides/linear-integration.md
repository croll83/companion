---
title: Linear Integration
description: Connect Linear for issue-driven development workflows
---

# Linear Integration

The Companion integrates with [Linear](https://linear.app) to let you search issues, create new ones, link them to sessions, see a domain's issues on a board, and automatically transition issue status as you work.

## Setup

1. Navigate to **Integrations** in the sidebar, then click **Linear Settings**
2. Add a connection: a name and a **Linear API key** (starts with `lin_api_`)
   - Get one from [Linear Settings > API](https://linear.app/settings/api)
3. The key is verified against Linear before it is saved
4. On success, you'll see your name, email, and connected workspace

### Several workspaces

Each connection is one API key, so one Linear workspace. Add one connection per workspace (for example a work workspace and a personal one). Where there is more than one, the Home page shows a workspace picker, and each domain linked to Linear says which workspace it uses (see **Domains linked to Linear** below).

API keys stay in `~/.companion/linear-connections.json` (readable only by you). No API response returns them: lists show only their last four characters.

## Domains linked to Linear

A [domain](#/docs/guides/sessions-and-permissions) can be linked to one Linear team, and optionally one project of that team. GLOBAL can be linked too. A domain without a link of its own does not use GLOBAL's: a board belongs to one domain.

1. Open **Domains** → the domain → **Linear**
2. Pick the **workspace** (connection), the **team**, and a **project** or **Whole team**
3. Click **Link domain**

The Companion checks with Linear that the team and the project exist before saving. Only ids and names are stored in the domain registry (`~/.companion/domains.json`), never the key. **Unlink** removes the link. Deleting a connection unlinks every domain that used it. A link whose connection is missing is flagged in the Linear tab.

Once linked:

- the domain has a **board** (below);
- new sessions in the domain list, search and create issues in that project (or team) by default on the Home page (see **Search and browse issues**);
- the domain can have its own transition rules (see **Per-domain rules**).

Everything is read live from Linear with the connection's key. A teammate running his own Companion, with his own key on the same workspace and the same team linked, sees the same issues, states and assignees: nothing about the board is stored locally.

## Board

**Domains** → the domain → **Board** (`#/domains/<slug>/board`) shows the linked team's issues:

- **Columns** are the team's workflow states, in Linear's order: backlog, todo, started, done. Canceled and duplicate states are hidden; **Show canceled** shows them.
- **Cards** show the identifier, title, assignee (avatar and name), priority, labels and the Companion sessions linked to the issue (Claude Code or Codex, archived ones marked), each a link to open it. A label in a group shows as `Group: label`, for example `Soak: soak 24h`.
- Open issues are all shown. Done and canceled ones are shown for 14 days after their last update. Up to 300 issues, most recently updated first.
- **Mine** keeps the issues assigned to you (the user of the connection's key).
- **Refresh** reads Linear again. An open board also refreshes every minute while the browser tab is visible.

Card actions:

- **Move**: pick another state in the card's select (no drag and drop).
- **Open in Linear**.
- **Take it**: assigns the issue to you and, if it has not started yet (triage, backlog or todo), moves it to the team's first "started" state (for example *In Progress*). An issue already started or further keeps its state: Take it never moves an issue back. The board then offers **Start a session**: the Home page opens on this domain with the issue linked, its branch name from Linear and a first message (*Work on BSK-12: …*) you can edit before sending. The session is created through the usual Home page flow, with Claude Code or Codex.

A domain that is not linked shows how to link it instead of a board.

## Search and browse issues

On the **Home page**, the Linear section lets you:

- **Search issues**: Type an issue key (e.g., `ENG-123`) or title to find issues across your workspace. Results exclude completed issues and are sorted with active issues first.
- **Browse project issues**: If you've attached a Linear project to the current repository, recent issues from that project are shown automatically.
- **Domain scope**: if the session's domain is linked to Linear (see **Domains linked to Linear**), its workspace is preselected and, unless the repository has its own project mapping, the recent issues of its project (or whole team) are listed. Typing two or more characters searches Linear inside that project or team. A badge marked *domain* shows the scope.

Toggle between project-scoped and global search with **Search all projects**.

## Create issues

Click **Create Issue** on the Home page to create a new Linear issue:

| Field | Description |
|---|---|
| **Title** | Issue title (required) |
| **Description** | Markdown description |
| **Team** | Which Linear team to assign to (required) |
| **Priority** | None, Urgent, High, Medium, or Low |
| **Assign to me** | Self-assign the issue |

If you have a project attached to the current repo, the issue is automatically added to that project. In a domain linked to Linear, the domain's team is preselected and the issue goes to its project.

## Link issues to sessions

1. On the Home page, search for or create an issue
2. Select the issue — it appears as a **Context** badge
3. Create the session — the issue details (identifier, title, state, description, labels, assignees, URL) are prepended to your first message as context
4. The **branch name** is auto-populated from the issue (e.g., `ENG-123` + "Fix auth flow" becomes `eng-123-fix-auth-flow`)

You can also link or unlink issues after a session is created.

## Auto-transition

Automatically move a linked issue to a specific status when a session starts.

### Configure

Per domain (see **Per-domain rules** below), or as the connection's default:

1. Go to **Linear Settings** and click **Edit** on the connection
2. Toggle **Auto-transition** on
3. Select the **team** (if you have multiple teams)
4. Choose the **target status** from the team's workflow states (e.g., "In Progress")

Every time you create a session with a linked Linear issue, the issue automatically moves to the configured status.

## Archive transition

When you archive a session that has a linked Linear issue (and the issue isn't already "done"), a modal asks what to do:

- **Keep current status**: Leave the issue as-is
- **Move to backlog**: Transition to the team's backlog state
- **Move to configured status**: Transition to a status you've pre-configured in settings

### Configure archive transition

Per domain (see **Per-domain rules** below), or as the connection's default:

1. Go to **Linear Settings** and click **Edit** on the connection
2. Toggle **Archive transition** on
3. Select the target status for archived sessions

## Per-domain rules

The two transitions above can be set per domain, in **Domains** → the domain → **Linear** → **Rules for this domain**, with a target state picked among the linked team's states:

| Choice | Effect |
|---|---|
| **Connection default** | The connection's setting in Linear Settings applies (the default) |
| **Off** | No transition for this domain, even if the connection has one |
| A state | Move the issue to that state |

Which rule applies to a session's issue:

1. the rule of the session's domain, if the domain is linked to the issue's workspace and team and has a rule of that kind;
2. else the connection's setting;
3. else the old global setting, for an API key saved before connections existed.

Nothing is migrated: a domain starts with **Connection default** for both rules, so an existing setup behaves exactly as before until a domain chooses its own. Changing the team of a link resets its rules to **Connection default**, because states belong to a team. The rules apply to Claude Code and Codex sessions alike.

## Project-repo mapping

Associate git repositories with Linear projects so that project-scoped issue search works automatically:

1. On the Home page, click the **attach project** icon in the Linear section
2. Select a Linear project from the dropdown
3. The mapping is saved — when you open the Home page in that repo, project issues are shown automatically

Mappings are stored in `~/.companion/linear-projects.json`.

## Rate limiting

Linear has a 5,000 requests/hour rate limit. The Companion manages this with built-in caching:

| Data | Cache TTL |
|---|---|
| Connection info | 5 minutes |
| Workflow states | 5 minutes |
| Issue searches | 30 seconds |
| Project issues | 60 seconds |
| Projects list | 5 minutes |
| Team projects (domain link) | 5 minutes |
| Viewer ("me" on the board) | 5 minutes |
| Domain board issues | 30 seconds |

The board polls every minute, so several open boards on the same domain share the cached answer. **Refresh** skips the cache. Moving or taking an issue clears that board's cache.

Concurrent duplicate requests are deduplicated to a single API call.
