#!/bin/bash
# check_dylibs.sh — verify every /opt/homebrew dylib referenced by an Ardour
# binary still exists on disk. Catches the Homebrew-rolled-forward case.
#
# Usage: ./check_dylibs.sh [binary_path]
# Default: build/luasession/luasession (relative to ardour submodule root)
#
# Exit codes:
#   0 — all dylibs present
#   1 — at least one dylib missing
#   2 — fatal (binary not found, otool missing)
set -e

BINARY="${1:-build/luasession/luasession}"
if [ ! -f "$BINARY" ]; then
  echo "check_dylibs: binary not found: $BINARY" >&2
  exit 2
fi
if ! command -v otool >/dev/null 2>&1; then
  echo "check_dylibs: otool not found (install Xcode command line tools)" >&2
  exit 2
fi

# Collect homebrew-prefixed dylib paths and check existence.
missing_count=0
missing_paths=()
while IFS= read -r path; do
  if [ ! -f "$path" ]; then
    missing_paths+=("$path")
    missing_count=$((missing_count + 1))
  fi
done < <(otool -L "$BINARY" 2>/dev/null | awk '/^\t/ {print $1}' | grep '^/opt/homebrew' || true)

if [ "$missing_count" -gt 0 ]; then
  echo "check_dylibs: $missing_count missing dylib(s) referenced by $BINARY:" >&2
  for p in "${missing_paths[@]}"; do
    echo "  $p" >&2
  done
  exit 1
fi

echo "check_dylibs: all homebrew dylibs present for $BINARY"
exit 0
