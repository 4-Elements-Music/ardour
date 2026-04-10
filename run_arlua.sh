#!/bin/bash
# Wrapper to run arlua (luasession) with the in-tree build's environment.
# Usage: ./run_arlua.sh [lua_script.lua]  — or no args for interactive REPL

TOP="$(cd "$(dirname "$0")" && pwd)"
. "$TOP/build/gtk2_ardour/ardev_common_waf.sh"

exec "$TOP/build/luasession/luasession" "$@"
