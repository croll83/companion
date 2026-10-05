# CLAUDE.md

Standing instructions for Claude Code and Codex sessions in this repo (`AGENTS.md` is a symlink to this file).

## What this is

The Companion is a web UI for Claude Code and Codex sessions. This is Marco's independent fork `croll83/companion`, and its only remote is `origin`. The upstream TypeScript app is archived. Do not sync from upstream, re-add it as a remote, or treat it as maintained.

All code is under `web/`:
- `server/`: Hono on Bun. It listens on port 3456 in production and 3457 in dev.
- `src/`: React 19 + Zustand, served by Vite on 5174 in dev. The in-app docs (`#/docs`) are in `src/docs/content/`.
- `bin/cli.ts`: the `the-companion` CLI (`start`, `stop`, `restart`, `status`, `logs`).

## Architecture

Messages flow browser <-> `/ws/browser/:id` <-> server <-> CLI process.
- Claude Code speaks NDJSON (see `WEBSOCKET_PROTOCOL_REVERSED.md`).
  - `cliBridgeMode` (`server/cli-bridge-mode.ts`) picks the transport.
  - This host runs `"stdio"`, set in `~/.companion/settings.json`. The CLI is spawned without `--sdk-url`, and the protocol runs over its stdin/stdout. Keep this host on stdio.
  - The code default is still `"loopback"` (`--sdk-url` to `/ws/cli/:id`), which current Claude CLIs reject.
- Codex speaks JSON-RPC to `codex app-server`. `COMPANION_CODEX_TRANSPORT` picks the transport (default `ws`). Mapping notes are in `web/CODEX_MAPPING.md`.
- To add a Claude model, add it to `CLAUDE_MODELS` (`src/utils/backends.ts`).
  - Add it to `MODEL_EFFORT_LEVELS` (`server/effort.ts`) only if it accepts `--effort`. Models missing from that map never receive the flag.
  - For flagship models, check `REFUSAL_CHAIN` in `src/utils/refusal-fallback.ts`.
- Sessions persist to `COMPANION_SESSION_DIR`. The service sets it to `~/.companion/sessions/`. That directory includes `launcher.json`, which holds each `cliSessionId` used for `--resume`. If the variable is unset, sessions go to `$TMPDIR/vibe-sessions`.
- All other state lives under `COMPANION_HOME`, which defaults to `~/.companion/`.
- Every raw protocol message is recorded to `~/.companion/recordings/<sessionId>_<backend>_<ISO-time>_<rand>.jsonl`.
  - The first line is a header. Each later line is `{ts (ms), dir: in|out, ch: cli|browser, raw}`.
  - These files are the fastest way to see what happened before a failure.
  - Code: `server/recorder.ts`, `server/replay.ts`.

## The live service hosts this session

- `the-companion.service` (user systemd, drop-in `persistent-sessions.conf`) runs every Claude and Codex CLI, including the one running this session. Anything those CLIs start shares its cgroup (`KillMode=control-group`).
- The following kill every session, including yours:
  - stopping or restarting the service (`systemctl` or `the-companion stop|restart`)
  - applying an in-app update (it restarts the unit)
  - killing its main bun process

  Killing a claude or codex child kills that session. Never do any of these without Marco's explicit approval.
- Once Marco approves a restart, run it detached and log a check:
  `systemd-run --user --collect --unit=companion-restart-$(date +%s) bash -c 'sleep 3; systemctl --user restart the-companion; sleep 20; { systemctl --user is-active the-companion; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3456/; } > /tmp/companion-restart.log 2>&1'`
- Jobs started from a session also die on restart. If a job must survive, launch it with `systemd-run --user`.
- Logs do not go to the journal. They go to `~/.companion/logs/companion.log` and `companion.error.log`, and `console.warn`/`console.error` output lands in the error log.
  - Log rotation (`server/logger.ts`) deletes only its own `companion_<ISO>_<pid>.log` files (over 2M lines in total). It never deletes these two files. When one of them grows past `COMPANION_LOG_STDIO_MAX_MB` (default 100, 0 turns it off), rotation copies it to `<name>.1` and then truncates it in place. Look in the `.1` file for older lines. The size bound runs only while the per-boot log writer is on (`COMPANION_LOG_FILE` not `0`).
  - Servers older than this fix could delete the two files while still writing to them. If the files are missing, read `/proc/$(systemctl --user show -p MainPID --value the-companion)/fd/1` (and `fd/2`).
  - The per-boot `companion_<ISO>_<pid>.log` contains only `log.*` lines.

## Deploy without a release

1. From `web/`, build and copy:
   `bun run build && rsync -a bin server dist package.json ~/.bun/install/global/node_modules/the-companion/`
2. `dist/` is served from disk, so frontend changes appear on a browser refresh. Server changes need a restart, which requires approval (see above).
3. Neither this copy nor the in-app updater installs dependencies. They resolve from `~/.bun/install/global/node_modules/`, so install any new runtime dependency there separately.

## Testing

- Session shells inherit the service environment:
  - `COMPANION_IDLE_KILL_MINUTES=30` breaks the ws-bridge idle-kill tests. Unset it for every vitest run.
  - `PORT=3456`, `NODE_ENV=production`, `__COMPANION_PACKAGE_ROOT` and `COMPANION_SESSION_DIR` would point a dev server at the live service and its data.
- Run a dev server only like this:
  `env -u PORT -u NODE_ENV -u __COMPANION_PACKAGE_ROOT -u COMPANION_SESSION_DIR -u COMPANION_IDLE_KILL_MINUTES COMPANION_HOME=/tmp/companion-dev bun run dev`
  The default `~/.companion` holds the live settings, including the Telegram bot token.
- A single full `bun run test` can OOM this host. From `web/`, run two passes:
  - `env -u COMPANION_IDLE_KILL_MINUTES npx vitest run server/ --maxWorkers=2`
  - `env -u COMPANION_IDLE_KILL_MINUTES npx vitest run src/ --maxWorkers=2`
- No pre-commit hook runs: husky is not installed (no `core.hooksPath`). Before pushing, run from `web/` everything CI runs:
  - `bun run typecheck`
  - `bun run deadcode:check`
  - `bun run dry:check`
  - `bun run test:codex-contract`
  - the two test passes above
  - `bun run build`
- `coverage-gate.yml` requires at least 80% line coverage on every new or changed non-test `.ts`/`.tsx` file under `web/server` and `web/src`. A file that no test imports counts as 0%. Check one file with:
  `env -u COMPANION_IDLE_KILL_MINUTES npx vitest run <tests> --coverage --coverage.include=<file> --coverage.reportsDirectory=/tmp/cov`
- New backend and frontend code must have tests: Vitest, with `foo.test.ts` next to `foo.ts`. In comments, say what each test validates and why.
- Every new or modified component in `web/src/components/` needs a `.test.tsx` with:
  - a render test
  - an axe scan (`toHaveNoViolations()`) in a test whose name contains `axe accessibility`, because `a11y.yml` selects tests by name
  - tests for its interactive behavior
- Never delete or weaken existing tests. Fix the code or the test instead. If you think a test should go, explain why and get Marco's explicit approval first.
- `companionBus` is a singleton. Always `off()` any handler a test subscribes.

## Product rules

- Playground: every message or chat-flow component needs a mock in `web/src/components/Playground.tsx` (`#/playground`). This covers `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool and subagent groups, and similar components. Add or update the mock whenever you add or change one.
- Codex and Claude Code parity: features must work with both backends. If a feature supports only one, gate it in the UI by hiding or disabling it, with a note such as "Requires Claude Code". Also document the limitation in the code.
- Bun >= 1.4 is required (`engines`). Older Bun has oven-sh/bun#32743, which can end a live CLI's stdout and kill its session.
- Never leave a spawned subprocess's stdout or stderr piped and unread. Drain it, or use `"ignore"` (see `runGh` in `server/github-pr.ts`).

## Commits, PRs, releases

- Use Conventional Commits for every commit and for the PR title. Every commit on the branch ends up in the changelog. Name branches `type/short-description`.
- Write the PR body to a file and pass it with `gh pr create --body-file`. It has these sections:
  - `## Summary`
  - `## Why`
  - `## Testing`
  - `## Review provenance`: who implemented the change (AI agent or human) and whether a human reviewed it

  Add a screenshot for visual changes. `agent-browser` is not installed here, so if you have no screenshot, say so and point to `#/playground`.
- Merge with merge commits, not squash, because release-please reads the individual commits.
- Release flow:
  1. Every push to `main` makes release-please (`publish.yml`) open or update a release PR.
  2. Merging that PR creates tag `the-companion-vX.Y.Z` and a GitHub Release.
  3. CI attaches `the-companion-X.Y.Z.tgz` to the release. The in-app updater needs that asset: without it, no update is offered.
- To force a version, push a commit with the footer `Release-As: X.Y.Z`. release-please bumps `.release-please-manifest.json`, `package.json` and `web/package.json` together. If you ever edit versions by hand, keep all three in sync.
