#!/usr/bin/env python3
"""One-shot: restore lost cliSessionId values in ~/.companion/sessions/launcher.json.

Run ONLY while the-companion service is stopped (the running service rewrites
launcher.json from memory and would clobber this edit).

The mappings below come from the original CLI session ids found in each
session's cache (system_event/result entries); the matching transcripts were
rebuilt under these ids on 2026-08-06. Idempotent: skips entries that already
have a cliSessionId.
"""
import json
import shutil
import subprocess
import sys

LAUNCHER = "/home/jarvis/.companion/sessions/launcher.json"

RESTORE = {
    "aebc82d3-597a-4425-ad08-9aa89001246e": "0f1f2c43-b962-4b42-a61b-5e450398dc27",
    "d6c80a04-4ac3-4f5c-a64a-fedc7b6b6115": "77c7ca69-151d-4a25-83cc-3cec8a95d064",
    "0566f808-4fae-42a9-93cf-0a1d1380c64f": "677b5075-ed8e-4154-a999-f65b66f7fc57",
    "a0d6e0c9-fa4f-44be-8e2a-73fa68f71d9f": "d3a57114-84c1-4150-b0e9-40456310a5cb",
    "eb38c47d-a848-47d3-b8a1-071151b7d447": "e271def1-b8be-49f8-803f-561edb850a1e",
    "18056956-29df-4365-8b2f-b1ca8c600555": "94b0f9c7-4c6a-41c7-a8e2-986ea4309daf",
}


def main():
    check = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", "the-companion"],
    )
    if check.returncode == 0:
        sys.exit("ERRORE: the-companion è attivo. Fermalo prima: systemctl --user stop the-companion")

    shutil.copy2(LAUNCHER, LAUNCHER + ".bak")
    with open(LAUNCHER) as fh:
        data = json.load(fh)

    patched = 0
    for entry in data:
        target = RESTORE.get(entry.get("sessionId"))
        if not target:
            continue
        if entry.get("cliSessionId"):
            print(f"skip {entry['sessionId'][:8]}: cliSessionId già presente ({entry['cliSessionId'][:8]})")
            continue
        entry["cliSessionId"] = target
        patched += 1
        print(f"patch {entry['sessionId'][:8]} -> cliSessionId {target[:8]}")

    with open(LAUNCHER, "w") as fh:
        json.dump(data, fh)
    print(f"fatto: {patched} sessioni patchate (backup in launcher.json.bak)")


if __name__ == "__main__":
    main()
