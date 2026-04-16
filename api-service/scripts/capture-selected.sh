#!/bin/bash
# Fires a preset/capture MCP call against the first active session. Auto-uses Ardour's
# selected track and auto-names the preset.
#
# Bind to a global hotkey via macOS Shortcuts app:
#   1. Shortcuts → New Shortcut
#   2. Add action "Run Shell Script" → Shell: /bin/bash → body:
#        ~/Repos/ardour/api-service/scripts/capture-selected.sh
#   3. In Shortcut Details → Add Keyboard Shortcut → pick your hotkey (e.g. ⌘⇧C)
#
# Optional: pass a preset name as the first argument:
#   capture-selected.sh "Amati Viola — Legato Long"
#
# Displays a macOS notification with the result.

HOST="${ARDOUR_API_HOST:-http://localhost:3000}"
NAME="$1"

SID=$(curl -sf "$HOST/v1/sessions" | /usr/bin/python3 -c "
import sys, json
d = json.load(sys.stdin)
ready = [s for s in d.get('sessions', []) if s.get('status') == 'ready']
print(ready[0]['session_id'] if ready else '')
")

if [ -z "$SID" ]; then
  /usr/bin/osascript -e 'display notification "No ready session." with title "Preset capture"'
  exit 1
fi

BODY='{"tool":"preset/capture","params":{}}'
if [ -n "$NAME" ]; then
  # Escape name for JSON.
  ESCAPED=$(/usr/bin/python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "$NAME")
  BODY="{\"tool\":\"preset/capture\",\"params\":{\"presetName\":$ESCAPED}}"
fi

RESP=$(curl -sf -X POST "$HOST/v1/sessions/$SID/actions" -H 'Content-Type: application/json' -d "$BODY")

MSG=$(/usr/bin/python3 <<EOF
import json
try:
    r = json.loads('''$RESP''')
    if r.get('success'):
        print(f"{r.get('plugin','?')} @ {r.get('track','?')} ▸ {r.get('preset_name','?')}")
    else:
        print(r.get('message') or r.get('error_code') or 'capture failed')
except Exception as e:
    print(f'parse error: {e}')
EOF
)

/usr/bin/osascript -e "display notification \"$MSG\" with title \"Preset capture\""
echo "$RESP"
