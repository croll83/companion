#!/usr/bin/env bash
# Regenerate the list of Codex app-server methods this Companion knows about.
#
# Source of truth is the INSTALLED codex CLI (`generate-json-schema`), not the
# upstream repo: openai/codex is archived and the binary is what actually talks
# to us, so its schema matches the protocol we will really receive.
#
# The output is committed so tests and runtime never need codex installed.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT_DIR/web/server/protocol/codex-known-methods.generated.ts"
TMP="$(mktemp -d /tmp/codex-schema-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

command -v codex >/dev/null || { echo "[sync] codex CLI not found in PATH"; exit 1; }
VERSION="$(codex --version 2>/dev/null | head -1)"
echo "[sync] generating schema from: $VERSION"
codex app-server generate-json-schema --out "$TMP" --experimental >/dev/null

python3 - "$TMP" "$OUT" "$VERSION" <<'PY'
import json, sys, os, datetime
tmp, out, version = sys.argv[1], sys.argv[2], sys.argv[3]

def methods(bundle_path, defname):
    with open(bundle_path) as f:
        d = json.load(f)
    variants = (d.get("definitions") or {}).get(defname) or {}
    arr = variants.get("oneOf") or variants.get("anyOf") or []
    found = set()
    for v in arr:
        enum = ((v.get("properties") or {}).get("method") or {}).get("enum") or []
        for m in enum:
            if isinstance(m, str) and m:
                found.add(m)
    return sorted(found)

# The v1 bundle carries both ServerNotification and ServerRequest; v2 adds newer
# notification variants. Union them so nothing is missed either way.
b1 = os.path.join(tmp, "codex_app_server_protocol.schemas.json")
b2 = os.path.join(tmp, "codex_app_server_protocol.v2.schemas.json")
notifs = sorted(set(methods(b1, "ServerNotification")) | set(methods(b2, "ServerNotification")))
reqs = sorted(set(methods(b1, "ServerRequest")) | set(methods(b2, "ServerRequest")))
if not notifs or not reqs:
    raise SystemExit(f"refusing to write an empty list (notifications={len(notifs)}, requests={len(reqs)})")

def block(name, items, doc):
    body = "\n".join(f'  "{i}",' for i in items)
    return f"/** {doc} */\nexport const {name}: readonly string[] = [\n{body}\n];\n"

with open(out, "w") as f:
    f.write(f'''// GENERATED FILE — do not edit by hand.
// Regenerate with: ./scripts/sync-codex-known-methods.sh
//
// Methods the Codex app-server can send us, extracted from the schema published
// by the installed CLI. Used to tell "known protocol, we simply don't act on it"
// apart from "genuinely outside the protocol we know" — only the latter is real
// drift worth alarming the user about.
//
// Source CLI: {version}
// Generated:  {datetime.datetime.now().strftime("%Y-%m-%d")}

''')
    f.write(block("CODEX_SERVER_NOTIFICATIONS", notifs, "server -> client notifications (no response expected)"))
    f.write("\n")
    f.write(block("CODEX_SERVER_REQUESTS", reqs, "server -> client requests (a response IS expected)"))
print(f"[sync] wrote {out}: {len(notifs)} notifications, {len(reqs)} requests")
PY
