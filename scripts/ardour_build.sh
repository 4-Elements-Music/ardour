#!/bin/bash
# ardour_build.sh — autonomous Ardour build & deploy CLI for the 4em fork.
#
# Usage:
#   ardour_build.sh doctor      Inspect current state, report drift
#   ardour_build.sh deps        Install missing Homebrew formulae from Brewfile
#   ardour_build.sh build       Configure + compile Ardour (wraps build_ardour.sh)
#   ardour_build.sh verify      Spawn luasession + smoke-test the MCP surface
#   ardour_build.sh all         doctor -> deps -> build -> verify
set -e

ARDOUR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$ARDOUR_DIR/scripts"

# ──────────────────────────────────────────────
# Subcommand: doctor
# ──────────────────────────────────────────────
cmd_doctor() {
  echo "[doctor] checking dylib references..."
  if ! "$SCRIPT_DIR/check_dylibs.sh" "$ARDOUR_DIR/build/luasession/luasession"; then
    echo "[doctor] DYLIB DRIFT — run \`ardour_build.sh deps build\` to recover" >&2
    return 1
  fi

  echo "[doctor] checking Brewfile presence..."
  if ! brew bundle check --file="$ARDOUR_DIR/Brewfile" --no-upgrade >/dev/null 2>&1; then
    echo "[doctor] missing Brewfile formulae — run \`ardour_build.sh deps\`" >&2
    return 1
  fi
  echo "[doctor] Brewfile satisfied"

  echo "[doctor] healthy: dylibs resolve, Brewfile satisfied"
  return 0
}

# ──────────────────────────────────────────────
# Subcommand: deps
# ──────────────────────────────────────────────
cmd_deps() {
  echo "[deps] running brew bundle install..."
  brew bundle install --file="$ARDOUR_DIR/Brewfile" --no-upgrade
  echo "[deps] done"
}

# ──────────────────────────────────────────────
# Subcommand: build
# ──────────────────────────────────────────────
cmd_build() {
  echo "[build] delegating to build_ardour.sh..."
  cd "$ARDOUR_DIR" && ./build_ardour.sh build 2>&1 | tee build.log
}

# ──────────────────────────────────────────────
# Subcommand: verify
# ──────────────────────────────────────────────
cmd_verify() {
  local bin="$ARDOUR_DIR/build/luasession/luasession"
  if [ ! -f "$bin" ]; then
    echo "[verify] luasession not built — run \`ardour_build.sh build\` first" >&2
    return 2
  fi

  # Just confirm the binary loads its dylibs and prints a version.
  # Full MCP smoke test belongs in api-service integration tests; this is
  # the cheap "does it crash on launch" check.
  if ! "$bin" --version >/dev/null 2>&1; then
    echo "[verify] luasession failed to launch — check dylib resolution" >&2
    "$bin" --version
    return 1
  fi

  local ver
  ver=$("$bin" --version 2>&1 | head -1)
  echo "[verify] OK — $ver"
  return 0
}

# ──────────────────────────────────────────────
# Dispatch
# ──────────────────────────────────────────────
cmd="${1:-}"
shift || true

case "$cmd" in
  doctor) cmd_doctor "$@" ;;
  deps)   cmd_deps "$@" ;;
  build)  cmd_build "$@" ;;
  verify) cmd_verify "$@" ;;
  all)    cmd_doctor && cmd_deps && cmd_build && cmd_verify ;;
  ""|-h|--help)
    head -9 "$0" | tail -8
    exit 0
    ;;
  *)
    echo "ardour_build.sh: unknown subcommand: $cmd" >&2
    echo "  try: ardour_build.sh --help" >&2
    exit 2
    ;;
esac
