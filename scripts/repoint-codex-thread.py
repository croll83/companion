#!/usr/bin/env python3
"""Re-point a Companion Codex session at an intact thread rollout.

When thread/resume loses a race with the previous app-server's writer lock,
Companion starts a fresh thread and persists its id, while the real
conversation stays on disk as an unreferenced rollout. This puts the session
back on that rollout.

Run ONLY with the-companion stopped: the service rewrites launcher.json from
memory and reads it only at startup, so a live edit would be clobbered.
"""
import json
import os
import shutil
import sys
from datetime import datetime

LAUNCHER = "/home/jarvis/.companion/sessions/launcher.json"
CODEX_HOME = "/home/jarvis/.companion/codex-home"

# companion sessionId -> codex threadId to resume
REPOINT = {
    "991dbe91-9013-43a4-a107-ce5b42ffa566": "01a0c8a9-6fa1-7341-877c-8ff883a0668e",
}


def find_rollout(session_id, thread_id):
    root = os.path.join(CODEX_HOME, session_id, "sessions")
    for dirpath, _, files in os.walk(root):
        for f in files:
            if thread_id in f and f.endswith(".jsonl"):
                return os.path.join(dirpath, f)
    return None


def main():
    apply = "--apply" in sys.argv
    data = json.load(open(LAUNCHER))
    sessions = data if isinstance(data, list) else data.get("sessions", data)

    changed = 0
    for s in sessions:
        sid = s.get("sessionId")
        if sid not in REPOINT:
            continue
        target = REPOINT[sid]
        rollout = find_rollout(sid, target)
        if not rollout:
            print(f"SKIP {sid[:8]}: no rollout on disk for {target}")
            continue
        size = os.path.getsize(rollout)
        if size < 1024:
            print(f"SKIP {sid[:8]}: rollout for {target} is empty ({size}B)")
            continue
        print(f"{sid[:8]}: {s.get('cliSessionId')} -> {target}  ({size//1024}K, ok)")
        s["cliSessionId"] = target
        changed += 1

    if not changed:
        print("nothing to do")
        return
    if not apply:
        print("\n(dry-run; re-run with --apply)")
        return

    bak = f"{LAUNCHER}.bak-{datetime.now():%Y%m%d-%H%M%S}"
    shutil.copy2(LAUNCHER, bak)
    with open(LAUNCHER, "w") as fh:
        json.dump(data, fh, indent=2)
    print(f"\napplied to {changed} session(s); backup: {bak}")


if __name__ == "__main__":
    main()
