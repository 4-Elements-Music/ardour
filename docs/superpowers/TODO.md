# Known Issues & TODO

## HIGH PRIORITY — Ardour GUI plugin discovery hangs on first launch (macOS)

**Symptom:** When SessionManager spawns the Ardour GUI in "GUI mode", the first launch pegs 100% CPU indefinitely and macOS shows a beachball. Running overnight doesn't complete it. MCP HTTP endpoint responds (on a separate thread) but the main GUI event loop is stuck.

**Root cause (suspected):** Ardour's AU plugin discovery/enumeration step hangs on a specific plugin in the user's Audio Units library. This happens BEFORE the per-plugin scanner subprocess with timeouts kicks in — it's in the initial enumeration phase. The standalone `ardour-au-scanner` binary has per-plugin timeouts but the enumeration step in the main Ardour process does not.

**Tried (didn't work):**
- `use-audio-units=false` in `~/Library/Preferences/Ardour9/config`
- `discover-plugins-on-start=false`
- `plugin-scan-timeout=50` (5 sec per plugin)
- `LV2_PATH=/nonexistent`, `VST_PATH=/nonexistent`, etc. env vars
- `-d --disable-plugins` and `-n --no-splash` CLI flags

**Current workaround:** User opens Ardour GUI manually ONCE, clicks Skip/Cancel on any scan dialog, quits. After that, the cache is populated (or plugins marked "not found") and subsequent GUI launches from the SessionManager are fast.

**What to investigate:**
1. Run Ardour GUI under `lldb` to find where the enumeration hangs (which specific AU plugin).
2. Check if `AudioComponentFindNext` with a specific ComponentDescription is the hang point — might be a specific vendor/subtype.
3. Add per-plugin timeout at the enumeration phase (pre-scanner step), not just per-plugin scan phase.
4. Consider a C++ patch: add an env var like `ARDOUR_SKIP_AU_DISCOVERY=1` that hard-bypasses `au_refresh()` even when `use_audio_units` is true (currently that flag only skips AU inside `refresh()`, but a bug may cause the enumeration to happen anyway).
5. Test whether the issue is specific to macOS 15+ or affects older versions.

**User impact:** GUI mode in SessionManager requires a manual "first launch" on each new machine. Not acceptable for production or shared environments.

## MEDIUM PRIORITY

### Port-binding waste in GUI mode
The Ardour GUI binds MCP HTTP twice on startup — once at the config default (4820), then again at the `MCP_HTTP_PORT` env var. See logs:
```
[vh|1|default||4820]: lws_socket_bind: source ads 0.0.0.0
[vh|1|default||4821]: lws_socket_bind: source ads 0.0.0.0
```
The first bind steals port 4820 briefly. Fix: make `MCP_HTTP_PORT` env var take effect in MCPHttp constructor, not in `set_state()`.

### Session directory cleanup
Dead sessions leave their `/tmp/ardour-sessions/<uuid>/` directories behind. TimeoutReaper should clean these up after the 5-minute retention expires.

### Deferred from plan
From `2026-04-11-nodejs-session-manager.md` "Known Deferred Items":
- Export service (`POST /v1/sessions/:id/export`)
- Analysis service (`POST /v1/sessions/:id/analyze`) with ffmpeg
- Session auto-save implementation (currently stubbed)
- Plugin preset discovery MCP tool
- Auth (Bearer token)
- Metrics (Prometheus `/metrics` endpoint)
- Orphan PID file reaping on Node.js startup

## LOW PRIORITY

### Log buffer growth for long-lived sessions
Log ring buffer is bounded to 10k lines, but the `stderrTail` array is separate and bounded to 50. Could consolidate.

### GUI/headless session migration
Can't convert a headless session to GUI after creation. Would need to kill luasession, launch Ardour GUI on the saved session file. Future feature.

## Audio region follow-ups

- [ ] F6: Replace direct-exec audio-validator launch with proper sandboxing on macOS. `sandbox-exec` is Apple-deprecated and hangs children in UE state on Darwin 24+. Investigate App Sandbox via XPC service or `sandbox_init()` with hand-tuned operations. Linux: wire up landlock. Process isolation alone handles the primary threat (crash containment); FS sandboxing is defense-in-depth.
- [ ] F7: Production audio_region_add path should detect and recover from UE-state validator children. macOS macOS Sequoia (Darwin 24) leaves SIGKILL'd libsndfile children in uninterruptible state when killed mid-I/O, until reboot. Mitigations: pre-validate file size, use longer default timeout, periodic ghost sweep, or migrate sidecar to a runtime that doesn't wedge libsndfile (e.g. soxr or ffmpeg).
