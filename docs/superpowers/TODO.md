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

**From spec (`docs/superpowers/specs/2026-04-12-audio-region-add-design.md`):**

- [ ] F1: Rename `plugin_add.id` → `plugin_add.trackId`; retrofit `midi_region_add` position to tagged-union form for schema consistency across all region/plugin tools.
- [ ] F2: Implement `audio_region_stretch` (v2 async tool) using Rubber Band for time-stretch + pitch-shift. Runs as a background job with a `jobId` poll pattern (not inline like `audio_region_add`).
- [ ] F3: Parse full BWF/iXML metadata in the audio-validator sidecar so `preserveOriginalTimestamp` can honor embedded TimeReference.
- [ ] F4: Revisit `allowTrackCreation` default after 3 months of usage data — if nobody trips on the current safety gate, consider making `auto-track` default.
- [ ] F5: Converge `region_get_full` output shape with the `audio_region_add` response shape so the two tools speak the same vocabulary.

**From security + code-quality reviews during implementation:**

- [x] F6 (closed — won't do for v1): `sandbox-exec` FS sandboxing for the audio-validator sidecar. Rationale: process isolation (separate process = crash containment) is the load-bearing defense in our threat model; FS sandboxing was bonus defense-in-depth. macOS alternatives (sandbox_init, App Sandbox via .app bundle, XPC) are all heavy or broken. Linux landlock is only useful if we ship Linux hosts. Revisit only if we multi-tenant (untrusted uploads from different users touching the same host) or find libsndfile CVEs that let a malformed file do more than crash.
- [ ] F7: Detect and recover from UE-state validator children on macOS 15+. `SIGKILL`'d libsndfile children in uninterruptible I/O never reap. Partial mitigation landed (default timeout bumped 30s→60s). Real fix: migrate sidecar to a runtime with better cancellation (ffmpeg decoder), or document an ops-level host-rotation policy.
- [ ] F8: Stacked-neighbor dedupe in `edgeCrossfadesCreated[]` response. If two playlist regions both end within tolerance of `new_start`, the response emits two entries but `placed_ar.fade_in` is set once (via `max`). Consider merging entries or marking the second as a no-op for clarity.
- [ ] F9: `fadeInSamples:0` + `edgeCrossfade:auto` silently upgrades the zero fade to the edge crossfade length. User's explicit-disable intent is lost. Clean fix requires a "was-default" sentinel; for now, document in the tool schema.
- [ ] F10: Surface a warning when `RegionFactory::create` returns null during `repeat` copy insertion. Currently silently produces fewer copies than requested.
- [ ] F11: `dryRun` projection of overlap + edge-crossfade (currently emits empty arrays). Low-value for v1 since callers rarely dry-run against a dense playlist, but worth closing the projection gap later.
