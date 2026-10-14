#!/usr/bin/env bash
# Ripristina il contesto della sessione Herd 68a35b5e perso dal relaunch storm
# del 2026-08-31: ri-punta cliSessionId al transcript intatto a8597697.
# Deve girare a servizio FERMO (companion riscrive launcher.json da memoria
# mentre gira, e lo rilegge solo all'avvio).
set -euo pipefail
SID="68a35b5e-4a92-46a0-8357-3103098f79a8"
CLI="a8597697-1230-442a-af84-410bb3cb8191"
L="/home/jarvis/.companion/sessions/launcher.json"
T="/home/jarvis/.claude/projects/-home-jarvis-sviluppo-plancton/${CLI}.jsonl"

[ -s "$T" ] || { echo "transcript mancante: $T"; exit 1; }
systemctl --user stop the-companion
cp "$L" "$L.bak-$(date +%s)"
python3 - "$L" "$SID" "$CLI" <<'PY'
import json,sys
path,sid,cli=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(path)); hit=False
for e in d:
    if e.get("sessionId")==sid:
        e["cliSessionId"]=cli; e.pop("pid",None); e.pop("exitCode",None); hit=True
if not hit: print("sessione non trovata"); sys.exit(1)
json.dump(d,open(path,"w"),indent=2)
print("cliSessionId ->",cli)
PY
systemctl --user start the-companion
sleep 3
systemctl --user is-active the-companion
