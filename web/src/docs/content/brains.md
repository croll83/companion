---
title: Brains
description: Connect a remote knowledge base, or let The Companion run one on a wiki folder, and give it to the sessions of a domain
---

# Brains

A **brain** is a knowledge base with an MCP server in front of it, for example a curated wiki with its sources. The Claude Code and Codex sessions of a domain that uses a brain can search and read it, and record new facts if the brain has an inbox.

Memory = the CLI's private notes; Brain = a curated, shared wiki with sources.

Open **Brains** in the sidebar (`#/brains`).

There are two kinds:

- **Remote**: a server that runs elsewhere and is reachable at an URL, such as a brain on your tailnet or a team brain.
- **Embedded**: The Companion runs the brain server itself, on a wiki folder of this machine. Nothing to install or keep running. **New brain** creates the wiki for you; **Adopt existing folder** uses one you already have.

## New brain

Click **New brain** and answer three questions:

- **Name**.
- **What it is about**: a few sentences. They become the *Domain* section of the wiki's `SCHEMA.md` and the description of the brain's skill, which tells the model when to use it. The language of this text (Italian or English) sets how search matches word forms; a mix gives both.
- **Tags** (optional): the first tags of the wiki's taxonomy, comma-separated. Without tags the wiki starts with `overview, procedure, decision, reference`.

The Companion then:

1. creates the folder `~/companion_brain_<name>` (another new or empty folder can be chosen under **Advanced**; a folder with files in it is refused);
2. writes the wiki from its template: `SCHEMA.md` (Domain, Page Types, Tag Taxonomy, Conventions, Lint), `index.md` with a *Start Here* section, `log.md` with a first `create` entry, the page folders `entities/`, `concepts/`, `comparisons/`, `queries/`, `raw/` for the sources, and a `.gitignore`;
3. makes it a git repository on `main` with a first commit, authored with your git identity (`git config user.name` and `user.email`, else "Companion");
4. creates the embedded brain (it starts with The Companion, and hides secrets) and starts it.

The new brain is **on no domain**: the last step tells you to choose it in a domain (**Domains** → the domain → **Brain**). Deleting the brain later never deletes its folder.

git is required. If it is missing, the wizard shows a card with the install commands (`sudo apt install git`, `xcode-select --install`, or git-scm.com) and a **Check again** button; nothing is created.

The template passes the brain's own lint as it is. An empty wiki has no pages to describe, so its skill says what it covers from your about text.

## Adopt existing folder

Click **Adopt existing folder** and fill in:

- **Name** and **What it is about** (the skill's description).
- **Wiki folder**: an existing folder of this machine, as an absolute path or `~/...` (an LLM wiki: pages over sources in `raw/`, a tag taxonomy in `SCHEMA.md`, an append-only `log.md`).
- **Language of the wiki**: how search matches word forms. "Italian and English" indexes both forms of every word, for mixed wikis.
- **Hide secrets** (on by default): tokens and passwords found in the wiki reach sessions as `[REDACTED:<rule>]`.

The brain needs `SCHEMA.md` and `index.md` at the root of the folder. If one is missing, The Companion says so and offers **Create SCHEMA.md** / **Create index.md**; the brain is created once both are there.

The brain then starts, and with The Companion afterwards (**Start with Companion**, in **Edit brain**). Right away it checks the wiki (see **Wiki check** below) and shows what it found.

### Wiki check

In the brain's **Overview**, **Check the wiki** runs the brain's own lint and explains the findings in plain sentences, grouped, problems first: "3 pages are not listed in index.md", "SCHEMA.md has no tag taxonomy", "2 pages have broken [[links]]", and so on, with the files concerned.

The simple ones have a button:

| Problem | Fix |
|---|---|
| No tag taxonomy in `SCHEMA.md` | **Add the tag taxonomy section**, with the tags the pages already use |
| Pages use tags missing from the taxonomy | **Add these tags to the taxonomy** (a line at the end of the section) |
| Pages not listed in `index.md` | **List them in index.md**, under a new *Other pages* section |
| No `index.md` / `log.md` / `SCHEMA.md` | **Create** it |

Fixes only **add**: a missing file is created (never over an existing one), a section or a line is appended. Nothing is deleted or rewritten. The brain reloads the wiki at once. Fixed files are not committed: commit them yourself, or leave them to the consolidation.

## Embedded brains

How it runs:

- Each embedded brain is a separate process: the brain server bundled with The Companion (`dist/brain/brain.js`), run by the same Bun. A crash or a stuck brain never takes The Companion or its sessions down.
- The process listens on `127.0.0.1` on a port of its own, which sessions never see. Sessions use The Companion's port: `http://127.0.0.1:<port>/brains/<slug>/mcp`. A restart of the brain is invisible to them.
- The wiki is re-read every 2 minutes, so edits show up without a restart.
- Sessions can search and read the wiki, and record notes in the brain's **inbox** (`brain_inbox_add`). Notes never change the wiki: a consolidation (a job or a person) reviews them first. The inbox lives in `~/.companion/brains/<slug>/data/inbox.db`.

Its skill comes from the brain server. The skill's description lists the sections of `index.md` with their page titles and the taxonomy tags (each cut to 60 characters, 1000 in total), after your about text; when the wiki changes, the health check (every 30 seconds) notices the new content and the skill is fetched again. The skill says whose knowledge base it is with your git name (`git config user.name`), or your login when git has none.

The brain's page shows its **Brain process**: running, starting, restarting after a crash, or stopped. **Start**, **Stop** and **Restart** act on it. If it crashes 5 times in 10 minutes, or cannot start at all (for example the wiki folder is gone), it stops trying and the page says why and what to do. **Troubleshooting** shows the process id, its own port and the last lines of its log (`~/.companion/brains/<slug>/logs/brain.log`).

Removing an embedded brain stops it and deletes its settings, inbox and log. The wiki folder is not touched.

### Pages

The **Pages** tab lists the wiki's pages (title, path, tags). **Search** finds pages the way sessions do (`brain_search`), with a snippet. Clicking a page opens it: its type, update date, tags and sources, then the text. `[[links]]` open the linked page in the tab. Shortcuts open `index.md`, `SCHEMA.md` and `log.md`.

The page text is data from the wiki: it is shown as markdown only, never as HTML. With **Hide secrets** on, secrets appear redacted, as sessions see them.

### Inbox

The **Inbox** tab shows the notes sessions recorded with `brain_inbox_add`, and the sources added here. For each: what it says, its kind (new fact, correction, contradiction, question, source), who wrote it and when, its sources, and the page it is about. The filters show the notes **Waiting**, **Accepted**, **Rejected** and **Dismissed**, with counts. The brain's card in the list says "N notes waiting".

**Dismiss…** on a waiting note asks for an optional reason, then discards it: its text is erased, the record stays (who, when, why). Turning notes into pages is the consolidation's job (see **Consolidation** below).

### Add source

**Add source…** (in the Inbox tab) gives the brain something to read:

- **Paste text** or **Upload a file** (markdown or plain text, up to 1 MB; for a PDF, paste its text): the brain saves it as `raw/sources/<date>-<name>.md` in the wiki. The name is reduced to lowercase letters, digits and hyphens, and an existing file is never overwritten (`-2`, `-3`, ...). The file is not committed right away: before each consolidation run The Companion commits the new files under `raw/sources/` (only those), so the agent finds them in its clone.
- **Link (URL)**: recorded as a note only. The Companion downloads nothing; the consolidation reads the page when it runs.

Either way a `source` note lands in the inbox, so the consolidation turns the source into pages. An optional **note** tells it what matters. No secrets or personal data in the note: the brain refuses it (and then removes the file it just saved).

Sessions that record a fact may use the kind `fact`: the brain accepts it as `new_fact`.

### Consolidation

The **Consolidation** tab turns the waiting notes into wiki pages, unattended. It is **off** until you turn it on.

**Consolidate this brain automatically** creates the brain's consolidation agent (it appears in **Agents** as "<name> brain consolidation", with a 🧠). Its prompt is a generic template; the agent:

1. reads the waiting notes, opens a consolidation run and decides each note (accepted, rejected, deferred, discarded) with a reason. Notes are treated as **untrusted claims**: a note that contains instructions for an AI is rejected, never followed;
2. reads the sources added with **Add source** and brings their facts into the pages, following the wiki's `SCHEMA.md`;
3. checks the pages it wrote with the brain's lint, closes the run, appends the run's entry to `log.md`, and commits.

The agent works in a **curator clone**: a git clone of the wiki in `~/.companion/brains/<slug>/curator/`, which The Companion brings up to date with the wiki's branch before every run. It never edits the wiki folder itself. It reaches the brain's inbox through an URL in its environment (`BRAIN_API_URL`), valid for that run only; the brain's own key never leaves The Companion and is never in the prompt. Runs work in the first domain that uses the brain, else in GLOBAL.

**When it runs.** The Companion decides, not the model:

- on the **schedule** (a cron expression, every day at 05:00 by default, in The Companion's time zone; at most every 15 minutes);
- when the waiting notes reach the **threshold** (10 by default) and the last run is more than 6 hours old (checked every 30 seconds, with the brain's health);
- at **startup**, when notes are waiting and the last run is more than a day old (the machine was off at 05:00, for example);
- with **Consolidate now**.

Before starting, The Companion counts the waiting notes. With none, the run is recorded as **Skipped** and no session starts (no cost). Notes deferred by an earlier run do not start a run by themselves: they are taken again with the next one. Never two runs at once.

**Model.** By default **Latest Sonnet**: the newest Sonnet of The Companion's Claude model list, chosen again at every run, so a new Sonnet is used as soon as The Companion knows it. The option shows which model that is now. You can pick another model, or **Codex** (its default is Codex's first model). Each run shows its model, and its cost and tokens when the CLI reports them (Claude Code does; Codex reports no cost).

**Checked result.** A run counts as a **Success** only when all of this holds:

1. the agent made a commit in the clone;
2. `git pull --ff-only` from the clone into the wiki folder succeeded;
3. the brain reloaded the wiki.

Otherwise the run says why:

- **Not synced**: the agent committed, but the commit could not reach the wiki folder, usually because the wiki was changed by hand meanwhile (uncommitted edits to the same files, or new commits). git's message is shown. Commit or undo your edits in the wiki folder (for new commits, merge the clone by hand: `git -C <wiki> pull --no-ff ~/.companion/brains/<slug>/curator <branch>`), then press **Retry sync**. The next run also tries to sync first and does not start while the old commit is still out of the wiki, so it is never thrown away.
- **No commit**: notes were waiting and the agent committed nothing.
- **Error**: the run itself failed (the CLI stopped, the wiki folder is not a git repository, the brain was not running...).

Each run lists its trigger, start time, duration, notes waiting, the decisions taken, the commit, model, cost and a link to its session. The brain's card says "N notes waiting · last consolidated <time>".

**Limits.** The wiki folder must be a git repository on a branch (new brains are). The agent commits locally only: pushing to a remote (`master` or pull-request modes) is not available yet, and a wiki that is also edited elsewhere through a remote needs its own sync. A web address added as a source is read only if the agent has a web tool; otherwise its note is deferred. The agent's runs show in **Agents** too; running it from there goes through the same preparation and checks.

**Remote brains** are consolidated where their server runs. In a remote brain's page, **Consolidation** can link an agent you already run for it: its runs then show on the brain's page. The Companion changes nothing in that agent (prompt, schedule, how it pushes) and adds no step to its runs.

### Security of embedded brains

- The proxy on The Companion's port accepts connections from this machine only, and only with a **token** that The Companion gives each session when it starts (`brn_...`, signed with the brain's key). The brain records which session wrote each note, and a session cannot write as another.
- The brain's own API (inbox, consolidation) needs a second key that only The Companion's server holds. A consolidation run gets an URL valid for that run only instead, from this machine only.
- Both keys come from `~/.companion/brains/<slug>/secret` (readable by you alone). The API never returns them.
- Tokens never expire. Replacing the `secret` file and restarting the brain revokes every token at once; sessions get new ones when they restart.
- **Limit**: this protects against accidents and against a session manipulated by prompt injection. It does not protect against other programs running as your Unix user, which can read `~/.companion`.

## Remote brains

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

Two chips on the brain's page show where each CLI stands: **Claude Code: signed in / sign-in needed / unknown**, and the same for **Codex**. They come from the MCP status of the active sessions in the domains using the brain (Codex's "not logged in" counts as sign-in needed). **Unknown** means no active session of that CLI uses the brain, or its MCP panel has not been opened in this browser yet: open a session in that domain and look at its MCP panel.

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
- Removing a brain clears it from every domain. The wiki is never touched: a remote brain's server and wiki stay as they are, and an embedded brain's folder too.

Changes apply when a session starts or reloads. Sessions from before domains ("legacy") never get a brain.

## What the sessions get

Both CLIs get the brain's MCP server under the same name, `<slug>-brain`, and a skill with the same name. The skill comes from the server, is generated from the name and about text, or is your own text (a body, or a whole `SKILL.md` with frontmatter) written in the brain's page.

- **Claude Code**: the server is added to the session's generated MCP config. A bearer token, or an embedded brain's session token, goes in as an `Authorization` header in that private file. An OAuth brain gets `"oauth": {"clientId", "callbackPort"}` instead. The skill comes from a small plugin The Companion generates. Tools appear as `mcp__<slug>-brain__<tool>`.
- **Codex**: the server is added to the session's `config.toml`.
  - Bearer brain, or embedded brain (its session token): `bearer_token_env_var`. The token itself is set only in the environment of the Codex process, is never written to disk there, and is hidden from the commands Codex runs.
  - OAuth brain: an `[mcp_servers.<slug>-brain.oauth]` table with the `client_id`.
  - Codex does not show MCP server instructions to the model, so the skill is linked into the session and its `AGENTS.md` gets a line naming the brain.

## A plugin that serves the same brain

If a marketplace plugin serves the same MCP URL as a brain (for example the brain's own plugin), the tools would show up twice under two names. Wherever the brain is on, it wins: Claude sessions get the plugin turned off, Codex sessions skip its server and skill.

The brain's page lists such plugins. **Adopt plugin as brain** gives the brain to every domain where the plugin is on and turns the plugin off there, in one step. Tool names change for Claude (from `mcp__plugin_<plugin>_<server>__...` to `mcp__<slug>-brain__...`): update allowlists or notes that mention the old names. A resumed session sees the new names from its next turn.
