#!/usr/bin/env python3
"""Re-point a companion session's cliSessionId to an existing, intact Claude
transcript (recovers from the 'phantom cliSessionId' bug where companion adopts
an ephemeral CLI session id that never persisted, then clears it to None).

Run ONLY with the-companion stopped (the running service rewrites launcher.json
from memory and would clobber this edit, and reads launcher.json only at startup).

Each mapping is verified: the target transcript must exist in the session's cwd
project dir AND contain real messages, or the entry is skipped.
"""
import json
import os
import shutil
import subprocess
import sys

LAUNCHER = "/home/jarvis/.companion/sessions/launcher.json"
PROJECTS = "/home/jarvis/.claude/projects"

# companion sessionId -> CLI transcript id to resume.
# 71488ab8: point to the FULL rebuilt transcript f6e72d36 (from companion cache,
# includes the post-17:11 redteam/llm-wiki work) — NOT b10011c7, which stops at 17:11.
REPOINT = {
    "71488ab8-7055-48c3-b590-12c5c182d474": "f6e72d36-1c0f-40e3-955d-dfdff02532c9",
}


def proj_dir(cwd):
    return os.path.join(PROJECTS, "".join(c if c.isalnum() else "-" for c in cwd.rstrip("/")))


def transcript_msgs(cwd, cli_id):
    p = os.path.join(proj_dir(cwd), cli_id + ".jsonl")
    if not os.path.exists(p):
        return -1
    n = 0
    for line in open(p):
        if not line.strip():
            continue
        try:
            if json.loads(line).get("type") in ("user", "assistant"):
                n += 1
        except json.JSONDecodeError:
            continue
    return n


def main():
    if subprocess.run(["systemctl", "--user", "is-active", "--quiet", "the-companion"]).returncode == 0:
        sys.exit("ERRORE: the-companion è attivo. Fermalo prima: systemctl --user stop the-companion")

    shutil.copy2(LAUNCHER, LAUNCHER + ".bak2")
    data = json.load(open(LAUNCHER))

    patched = 0
    for entry in data:
        target = REPOINT.get(entry.get("sessionId"))
        if not target:
            continue
        n = transcript_msgs(entry.get("cwd", ""), target)
        if n <= 0:
            print(f"SKIP {entry['sessionId'][:8]}: transcript {target[:8]} assente/vuoto (msgs={n})")
            continue
        old = entry.get("cliSessionId")
        entry["cliSessionId"] = target
        patched += 1
        print(f"patch {entry['sessionId'][:8]}: cliSessionId {str(old)[:8]} -> {target[:8]} ({n} msg)")

    json.dump(data, open(LAUNCHER, "w"))
    print(f"fatto: {patched} sessioni ri-puntate (backup launcher.json.bak2)")


if __name__ == "__main__":
    main()
