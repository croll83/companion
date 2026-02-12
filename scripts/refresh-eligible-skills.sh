#!/bin/bash
# refresh-eligible-skills.sh
#
# Generates .eligible-skills.json in the OpenClaw workspace by querying
# `openclaw skills` for ready/eligible skills. The clawd-companion container
# reads this file to inject only active skill documentation into Claude's
# system prompt.
#
# Usage:
#   ./refresh-eligible-skills.sh              # one-shot
#   watch -n 300 ./refresh-eligible-skills.sh  # every 5 min
#
# Or add to crontab:
#   */5 * * * * /path/to/refresh-eligible-skills.sh
#
# The output file is written to the OpenClaw workspace directory, which is
# mounted into the companion container at /workspace.

set -euo pipefail

WORKSPACE="${OPENCLAW_WORKSPACE:-/home/jarvis/.openclaw/workspace}"
OUTPUT="$WORKSPACE/.eligible-skills.json"

# Parse the openclaw skills table output.
# Each ready skill has "✓ ready" in its Status column.
# We extract the skill name from the second column, stripping emoji prefixes.
openclaw skills 2>&1 | python3 -c "
import sys, json, re

eligible = []
for line in sys.stdin:
    # Match lines with ready marker and extract skill name from table
    if '✓ ready' not in line and '✓' not in line:
        continue
    # Split by │ separator
    parts = line.split('│')
    if len(parts) < 3:
        continue
    # Skill name is in the second column, strip emoji and whitespace
    raw_name = parts[2].strip() if len(parts) > 2 else parts[1].strip()
    # Remove emoji prefixes (any non-ASCII chars at the start)
    name = re.sub(r'^[^\x00-\x7F\s]+\s*', '', raw_name).strip()
    if name and not name.startswith('Status') and not name.startswith('─'):
        eligible.append(name)

with open('$OUTPUT', 'w') as f:
    json.dump(sorted(set(eligible)), f)
print(f'[refresh-eligible-skills] wrote {len(eligible)} eligible skills to $OUTPUT')
"
