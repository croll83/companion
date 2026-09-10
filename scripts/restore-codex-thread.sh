#!/usr/bin/env bash
# Ri-punta una sessione Codex di companion a un thread precedente (rollout ancora
# su disco) dopo che un relaunch ha fatto fallback a un thread fresco.
# Uso: restore-codex-thread.sh <companionSessionId> <threadId>
# Deve girare a servizio FERMO: companion riscrive launcher.json dalla memoria.
set -euo pipefail
SID="${1:?companionSessionId}"; TID="${2:?threadId}"
L="/home/jarvis/.companion/sessions/launcher.json"
HOME_DIR="/home/jarvis/.companion/codex-home/$SID"
RO=$(ls "$HOME_DIR"/sessions/*/*/*/rollout-*"$TID"*.jsonl 2>/dev/null | head -1)
[ -n "$RO" ] || { echo "rollout per $TID non trovato in $HOME_DIR"; exit 1; }
LK="$HOME_DIR/thread-writer-locks/$TID.lock"
if [ -e "$LK" ] && fuser "$LK" >/dev/null 2>&1; then echo "lock ancora tenuto da: $(fuser "$LK")"; exit 1; fi
systemctl --user stop the-companion
cp "$L" "$L.bak-$(date +%s)"
python3 - "$L" "$SID" "$TID" <<'PY'
import json,sys
p,sid,tid=sys.argv[1:]
d=json.load(open(p)); hit=False
for e in d:
    if e.get("sessionId")==sid:
        e["cliSessionId"]=tid; e.pop("pid",None); e.pop("exitCode",None); e["resumeFailures"]=0; hit=True
if not hit: print("sessione non trovata"); sys.exit(1)
json.dump(d,open(p,"w"),indent=2); print("cliSessionId ->",tid)
PY
systemctl --user start the-companion
sleep 3; systemctl --user is-active the-companion
