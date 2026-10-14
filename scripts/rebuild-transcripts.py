#!/usr/bin/env python3
"""Rebuild Claude Code transcript .jsonl files from the companion session cache.

The companion cache (~/.companion/sessions/<id>.json) keeps the full chat
history (user prompts + assistant API messages) but NOT tool_result contents.
So the rebuilt transcript keeps only text blocks from assistant messages
(tool_use / thinking dropped) — enough context for --resume to work and the
model to continue the conversation.

Usage:
  rebuild-transcripts.py --plan plan.json [--only <companion-id>] [--dry-run]

plan.json: list of {companionId, cliSessionId, cwd}
Writes to ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
Refuses to overwrite a transcript that already contains real messages.
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

CACHE_DIR = os.path.expanduser("~/.companion/sessions")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")


def encode_cwd(cwd: str) -> str:
    cwd = cwd.rstrip("/") or "/"
    out = []
    for ch in cwd:
        out.append(ch if ch.isalnum() else "-")
    return "".join(out)


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def transcript_message_count(path: str) -> int:
    n = 0
    try:
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    if json.loads(line).get("type") in ("user", "assistant"):
                        n += 1
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        return -1
    return n


def rebuild(companion_id: str, cli_id: str, cwd: str, dry_run: bool) -> dict:
    cache_path = os.path.join(CACHE_DIR, companion_id + ".json")
    with open(cache_path) as fh:
        cache = json.load(fh)
    state = cache.get("state", {})
    history = cache.get("messageHistory", [])
    version = state.get("claude_code_version") or "2.1.218"
    git_branch = state.get("git_branch") or ""
    cwd = cwd.rstrip("/") or "/"
    perm = state.get("permissionMode") or "bypassPermissions"

    common = {
        "isSidechain": False,
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": cwd,
        "sessionId": cli_id,
        "version": version,
        "gitBranch": git_branch,
    }

    lines = []
    parent = None
    n_user = n_asst = n_skipped_asst = 0
    for entry in history:
        etype = entry.get("type")
        ts = entry.get("timestamp") or 0
        if etype == "user_message":
            u = str(uuid.uuid4())
            lines.append({
                "parentUuid": parent,
                "promptId": str(uuid.uuid4()),
                "type": "user",
                "message": {"role": "user", "content": entry.get("content", "")},
                "uuid": u,
                "timestamp": iso(ts),
                "permissionMode": perm,
                "promptSource": "sdk",
                **common,
            })
            parent = u
            n_user += 1
        elif etype == "assistant":
            msg = entry.get("message") or {}
            content = msg.get("content") or []
            text_blocks = [b for b in content if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
            if not text_blocks:
                n_skipped_asst += 1
                continue
            u = str(uuid.uuid4())
            lines.append({
                "parentUuid": parent,
                "type": "assistant",
                "message": {
                    "model": msg.get("model", ""),
                    "id": msg.get("id", ""),
                    "type": "message",
                    "role": "assistant",
                    "content": text_blocks,
                    "stop_reason": msg.get("stop_reason") or "end_turn",
                    "stop_sequence": None,
                    "usage": msg.get("usage") or {"input_tokens": 0, "output_tokens": 0},
                },
                "uuid": u,
                "timestamp": iso(ts),
                **common,
            })
            parent = u
            n_asst += 1
        # 'result' duplicates the last assistant text; 'system_event' is CLI-internal — both skipped.

    if not lines or n_user == 0:
        return {"companion": companion_id[:8], "cli": cli_id[:8], "status": "EMPTY", "user": n_user, "assistant": n_asst}

    proj = os.path.join(PROJECTS_DIR, encode_cwd(cwd))
    out_path = os.path.join(proj, cli_id + ".jsonl")
    existing = transcript_message_count(out_path)
    if existing > 0:
        return {"companion": companion_id[:8], "cli": cli_id[:8], "status": "SKIP_HAS_MESSAGES", "existing": existing}

    if not dry_run:
        os.makedirs(proj, exist_ok=True)
        if existing >= 0:
            os.rename(out_path, out_path + ".stub.bak")
        tmp = out_path + ".tmp"
        with open(tmp, "w") as fh:
            for line in lines:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")
        os.chmod(tmp, 0o600)
        os.rename(tmp, out_path)

    return {
        "companion": companion_id[:8], "cli": cli_id[:8],
        "status": "DRY" if dry_run else "WRITTEN",
        "user": n_user, "assistant": n_asst, "skipped_toolonly": n_skipped_asst,
        "path": out_path,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--only")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.plan) as fh:
        plan = json.load(fh)

    for item in plan:
        if args.only and not item["companionId"].startswith(args.only):
            continue
        try:
            res = rebuild(item["companionId"], item["cliSessionId"], item["cwd"], args.dry_run)
        except Exception as exc:  # keep going, report per-session
            res = {"companion": item["companionId"][:8], "status": "ERROR", "error": str(exc)}
        print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
