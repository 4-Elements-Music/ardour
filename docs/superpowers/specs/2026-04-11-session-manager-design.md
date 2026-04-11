# Session Manager + Developer Test App — Design Spec

## Overview

A session management layer that spawns persistent headless Ardour instances, proxies real-time manipulation requests to them, and provides a browser-based developer tool for testing. This enables the iterative AI workflow: create session, add tracks, load audio, adjust mix, export, analyze, refine, repeat.

### Prerequisites Status

This spec depends on two C++ changes to Ardour that **do not exist yet**:

1. **`hardour` binary extension** — headless Ardour with MCP HTTP surface support. Without this, sessions cannot be spawned.
2. **`session/lua_eval` MCP tool** — sandboxed Lua execution in the session context. Without this, audio import, tempo changes, and automation are impossible.

Both are described in detail in the "C++ Work Required" section. The Node.js implementation cannot function until these are built. The workflow descriptions in this spec assume both are complete.

## Architecture

```
AI Client / Browser Test App
    |
    | REST API (JSON)
    v
Node.js API Service (Fastify)
    |
    | Session Manager: spawns, tracks, kills Ardour instances
    | Action Proxy: routes tool calls (one at a time per session)
    | Per-session async queue ensures serial access
    v
Headless Ardour Instance(s)
    |
    | MCP HTTP Surface (JSON-RPC over HTTP, one port per instance)
    | Each instance has its own session, audio engine, plugin state
    v
Audio Files (upload via API, import via lua_eval, export to session dir)
```

### Components

1. **Session Manager** — Spawns headless Ardour processes with MCP HTTP surfaces on unique ports. Tracks active sessions, handles lifecycle (create, health check, idle timeout, crash recovery, shutdown). Accepts injectable dependencies (spawner, clock, HTTP client) for testability.
2. **Action Proxy** — Routes MCP HTTP tool calls from the API to the correct Ardour instance. Per-session async queue ensures one action at a time (Ardour is not thread-safe for mutations). Single and batch actions.
3. **Port Pool** — Allocates and releases ports from a configurable range. Scans for occupied ports on startup (parallel, with per-port 500ms timeout) to detect orphaned Ardour processes.
4. **Timeout Reaper** — Background interval that kills sessions idle beyond a configurable TTL. Also handles periodic auto-save and session directory cleanup.
5. **Developer Test App** — Vanilla HTML/JS/CSS browser UI served by the API for exercising all endpoints.

### Design for Testability

All stateful components accept injected dependencies:

```js
class SessionManager {
  constructor({ spawner, clock, httpClient, config }) { ... }
}
class TimeoutReaper {
  constructor({ sessionManager, clock, config }) { ... }
  reap() { ... }  // callable directly in tests
}
class PortPool {
  constructor({ start, end, portChecker }) { ... }
}
```

The `clock` interface provides both time and timer functions for full testability:
```js
// clock interface
{
  now(),                          // returns current timestamp (ms)
  setTimeout(fn, ms),             // schedule delayed callback
  clearTimeout(id),               // cancel delayed callback
  setInterval(fn, ms),            // schedule repeating callback
  clearInterval(id),              // cancel repeating callback
}
```

Tests use a `FakeArdourProcess` helper — a lightweight HTTP server that simulates MCP HTTP responses, supports configurable startup delay, crash simulation, and timeout simulation.

**Note on existing code:** The existing batch API modules (`JobQueue`, `executor.js`) use module-level config singletons. The new session modules use constructor injection for testability. This inconsistency is intentional — existing code will not be refactored in this phase.

### Dependencies

New npm packages required (not currently in `package.json`):
- `@fastify/multipart` — file upload handling
- `@fastify/static` — serving the developer test app

## Session Lifecycle

### Endpoints

#### `POST /v1/sessions`

Create a new Ardour session. Returns `202 Accepted` immediately — the client polls for readiness.

**Request:**
```json
{
  "sample_rate": 48000,
  "session_name": "my-mix",
  "tempo": 120,
  "time_signature": {"numerator": 4, "denominator": 4},
  "gui": false
}
```

All fields optional. Defaults: `sample_rate: 48000`, `session_name: auto-generated (includes session ID)`, `tempo: 120`, `time_signature: 4/4`, `gui: false`.

Session IDs are generated with `crypto.randomUUID()`.

The `gui` flag launches the full Ardour GUI instead of headless mode. Only works when config `ALLOW_GUI=true` (development). Production always forces headless. GUI-mode sessions respond to the same MCP HTTP tool calls — the developer can watch each API call take effect in real time.

**Tempo and time signature application:** After the Ardour process reaches `ready` state, the session manager automatically issues a `session/lua_eval` call to set the requested tempo and time signature:

```lua
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo(120, 120, 4), Temporal.timepos_t(0))
tm:set_meter(Temporal.Meter(4, 4), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)
```

This happens before the session status transitions from `starting` to `ready`, so the client always sees the correct tempo when the session becomes available.

**Response (202):**
```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "starting",
  "poll_url": "/v1/sessions/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Errors:**
- `429` — max concurrent sessions reached
- `503` — no ports available

#### `GET /v1/sessions`

List all active sessions.

**Response:**
```json
{
  "sessions": [
    {
      "session_id": "a1b2c3d4",
      "status": "ready",
      "session_name": "my-mix",
      "sample_rate": 48000,
      "created_at": "2026-04-11T10:00:00Z",
      "last_activity": "2026-04-11T10:05:23Z",
      "uptime_seconds": 323
    }
  ],
  "capacity": {"active": 1, "max": 5}
}
```

#### `GET /v1/sessions/:id`

Session details.

**Response:**
```json
{
  "session_id": "a1b2c3d4",
  "status": "ready",
  "session_name": "my-mix",
  "sample_rate": 48000,
  "created_at": "2026-04-11T10:00:00Z",
  "last_activity": "2026-04-11T10:05:23Z",
  "uptime_seconds": 323
}
```

**Status values:** `starting`, `ready`, `unhealthy`, `stopping`, `dead`.

When `dead`: response includes `exit_code` and `stderr_tail` (last 50 lines of Ardour stderr). Returns `200` with `status: "dead"` — the session resource still exists temporarily, it just failed.

Dead session info is retained for 5 minutes, then cleaned up by the reaper (same timer pattern as `job-queue.js` `_scheduleCleanup`).

**Errors:**
- `404` — unknown session ID (never existed, or dead info already expired)

#### `DELETE /v1/sessions/:id`

Graceful shutdown. **Idempotent** — if session is already in `stopping` state, returns 200 immediately without starting a new shutdown sequence.

1. Set status to `stopping`
2. **Reject all queued actions** with `409` (session stopping) — do not leave HTTP requests hanging
3. Send `session/save` via MCP HTTP (3s timeout, fire-and-forget on failure)
4. `child.kill('SIGTERM')` to the Ardour process
5. Wait 5s for exit
6. `child.kill('SIGKILL')` if still alive
7. Wait for `exit` event, then release port
8. Clean up session temp files

**Response:** `200 OK` with `{"status": "stopped"}`

**Note on process signals:** We use `child.kill(signal)` (not `process.kill(-pid, signal)`) because with `detached: false` the child is in the same process group as Node.js. Using `process.kill(-pid)` would kill the API server itself. The Dummy backend does not spawn sub-processes, so killing only the child PID is sufficient.

#### `POST /v1/sessions/:id/upload`

Upload an audio file to the session's upload directory. The returned path can then be used in `session/lua_eval` to import the file onto a track.

**Request:** `multipart/form-data` with a `file` field.

**Constraints:**
- Max file size: 100MB (configurable)
- Allowed extensions: `.wav`, `.flac`, `.aiff`, `.ogg`, `.mp3`, `.mid`, `.midi`, `.sf2`, `.sfz`
- **Duplicate filenames:** If a file with the same name already exists, the upload is rejected with `409 Conflict`. The client should use a unique name or delete the previous file first. This prevents overwriting files that Ardour may be actively reading from.
- Upload directory is created lazily on first upload with `mkdir({ recursive: true })`.

**Response:**
```json
{
  "path": "/tmp/ardour-sessions/a1b2c3d4/uploads/kick.wav",
  "filename": "kick.wav",
  "size": 221376
}
```

The returned `path` is an absolute filesystem path that can be passed to `LuaAPI.import_audio_file()` via the `session/lua_eval` tool.

#### `GET /v1/tools`

Tool discovery. Returns the catalog of available MCP tools with their JSON schemas and categories.

**Response:**
```json
{
  "tools": [
    {
      "name": "tracks/add",
      "category": "tracks",
      "description": "Add a new audio or MIDI track",
      "input_schema": { ... }
    },
    ...
  ],
  "categories": ["session", "transport", "tracks", "track_control", "plugins", "regions", "midi", "markers", "lua"]
}
```

The tool schemas are loaded from `tools_json.inc` at startup. This endpoint is also used by the developer test app to auto-generate parameter forms.

### Session Status Lifecycle

```
starting → ready → (active use) → stopping → stopped
                 → unhealthy → stopping → stopped
                 → dead (crash detected)
```

- `starting`: Ardour process spawned, health check polling every 500ms, tempo/time-sig applied after MCP HTTP responds.
- `ready`: MCP HTTP health check passed and initial setup complete, accepting actions.
- `unhealthy`: periodic liveness check failed (3 consecutive failures).
- `stopping`: graceful shutdown in progress. Reaper, health checks, and action proxy all skip this state. Queued actions are rejected.
- `dead`: process exited unexpectedly.

**Startup timeout:** If the session doesn't reach `ready` within `sessionStartupTimeoutMs` (default 30s), the process is killed (`child.kill('SIGTERM')` → 5s → `child.kill('SIGKILL')`), port released after `exit` event, session marked `dead`.

### Lifecycle Management

- **Idle timeout**: configurable TTL (default 30 minutes). Background reaper runs every 60s, checks `lastActivity` timestamps, shuts down idle sessions. Sessions in `starting` or `stopping` state are exempt.
- **Max concurrent sessions**: configurable (default 5). `POST /v1/sessions` returns `429` when full.
- **Crash detection**: child process `exit` event handler marks session as `dead`, waits for `exit` event completion, then releases port. Retains session info for 5 minutes (cleanup timer).
- **Periodic health check**: staggered across sessions (interval / session count) to avoid thundering herd. Send MCP HTTP `session/get_info` call (5s timeout) to each `ready` session. 3 consecutive failures → mark `unhealthy` → trigger shutdown. Health checks skip sessions not in `ready` state.
- **Auto-save**: the reaper checks `lastSave` alongside `lastActivity`. If a `ready` session hasn't been saved in >5 minutes and has had activity, trigger `session/save` via MCP HTTP (fire-and-forget). Keeps auto-save off the action hot path.
- **Session directory cleanup**: the reaper also cleans up temp directories for `dead` sessions whose 5-minute retention has expired, and for `stopped` sessions.

## Action Proxying

### Concurrency Control

Each session has an async queue (use `p-queue` with `concurrency: 1`, or a custom Promise chain). Actions are processed one at a time per session. If a request arrives while another is in progress, it waits in the queue.

The queue has a max depth (default 20). If exceeded, the request is rejected with `429`.

**Queue waiter timeout:** Requests waiting in the queue are subject to a configurable timeout (default 120s via `actionQueueTimeoutMs`). If a request waits longer than this without reaching the front of the queue, it is rejected with `504`. This prevents zombie HTTP connections when the queue is slow.

**Batch actions occupy a single queue slot.** A batch of 10 actions takes one position in the queue and executes all 10 sequentially within that slot. This prevents a large batch from consuming the entire queue depth.

**Session deletion drains the queue.** When a session enters `stopping` state, all queued actions are immediately rejected with `409`.

### `POST /v1/sessions/:id/actions`

Proxy a single MCP tool call to the session's Ardour instance.

**Request:**
```json
{
  "tool": "tracks/add",
  "params": {"name": "Bass", "type": "audio", "channels": 2}
}
```

**Response:** The MCP HTTP response body, passed through faithfully (including error codes and messages from Ardour).

```json
{
  "success": true,
  "result": {"id": "42", "name": "Bass", "type": "audio"}
}
```

**Errors:**
- `400` — unknown tool name or invalid params (validated against MCP tool schemas)
- `404` — unknown session ID
- `409` — session not in `ready` state
- `429` — action queue full
- `502` — Ardour instance unreachable
- `504` — Ardour instance timed out (10s default) or queue wait timed out

**Validation:** The API validates tool names against the known tool set. Unknown tools are rejected with 400 before reaching Ardour. Tool parameters are validated against the JSON schemas from `tools_json.inc`. `session/lua_eval` has additional validation: max code length (64KB), execution timeout (30s).

**Request tracing:** The `x-request-id` header is forwarded to the MCP HTTP call and logged on both sides for cross-boundary debugging.

Each action updates the session's `lastActivity` timestamp.

### `POST /v1/sessions/:id/actions/batch`

Send multiple tool calls in sequence. The entire batch occupies a single queue slot.

**Request:**
```json
{
  "actions": [
    {"tool": "tracks/add", "params": {"name": "Kick", "type": "audio"}},
    {"tool": "tracks/add", "params": {"name": "Snare", "type": "audio"}},
    {"tool": "track/set_fader", "params": {"id": "42", "db": -6}}
  ],
  "stop_on_error": true,
  "timeout_ms": 60000
}
```

`stop_on_error` defaults to `true`. When `false`, all actions execute regardless of individual failures.

`timeout_ms` defaults to `60000` (60s). If the aggregate time exceeds this, remaining actions are skipped.

**Response:**
```json
{
  "results": [
    {"tool": "tracks/add", "success": true, "result": {"id": "42", "name": "Kick"}},
    {"tool": "tracks/add", "success": true, "result": {"id": "43", "name": "Snare"}},
    {"tool": "track/set_fader", "success": true, "result": {}}
  ],
  "completed": 3,
  "total": 3
}
```

When `stop_on_error: true` and an action fails, subsequent actions are skipped and their results are `null`.

## File Upload and Import

### Workflow

1. Client uploads a file: `POST /v1/sessions/:id/upload` (multipart/form-data)
2. API writes it to `<session_dir>/uploads/<filename>`, returns the absolute path
3. Client imports it onto a track via `POST /v1/sessions/:id/actions`:

```json
{
  "tool": "session/lua_eval",
  "params": {
    "code": "local rgn = ARDOUR.LuaAPI.import_audio_file(Session, '/tmp/ardour-sessions/abc123/uploads/kick.wav')\nif not rgn:isnil() then\n  local track = Session:route_by_name('Kick')\n  if track and not track:isnil() then\n    track:to_track():playlist():add_region(rgn, Temporal.timepos_t(0), 1, false, 0, 0, false)\n  end\nend"
  }
}
```

### Documented Lua Snippets

To avoid requiring clients to craft raw Lua, the spec defines standard snippets. These are documented here and in the test app's help section. The API does NOT template them — the client (AI or test app) constructs the Lua code using these patterns.

**Constants:** Ardour uses 1920 ticks per beat. To convert bar/beat to ticks at a given time signature: `ticks = ((bar - 1) * numerator * (4 / denominator) + (beat - 1)) * 1920`.

**Gain values:** Ardour uses linear gain internally, not dB. Conversion: `linear = 10 ^ (dB / 20)`. Common values: 0dB = 1.0, -3dB = 0.7079, -6dB = 0.5012, -12dB = 0.2512, -inf = 0.0.

**Pan values:** Ardour pan convention: `0.0 = left, 0.5 = center, 1.0 = right`. Note: this matches the `track/set_pan` MCP tool convention.

**Import audio onto track:**
```lua
local rgn = ARDOUR.LuaAPI.import_audio_file(Session, '{{path}}')
if not rgn:isnil() then
  local track = Session:route_by_name('{{track_name}}')
  if track and not track:isnil() then
    -- position_ticks: bar 1 beat 1 = 0, bar 2 beat 1 = 7680 (at 4/4)
    track:to_track():playlist():add_region(rgn, Temporal.timepos_t.from_ticks({{position_ticks}}), 1, false, 0, 0, false)
  end
end
```

**Set tempo:**
```lua
local tm = Temporal.TempoMap.write_copy()
tm:set_tempo(Temporal.Tempo({{bpm}}, {{bpm}}, 4), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)
```

**Set time signature:**
```lua
local tm = Temporal.TempoMap.write_copy()
tm:set_meter(Temporal.Meter({{numerator}}, {{denominator}}), Temporal.timepos_t(0))
Temporal.TempoMap.update(tm)
```

**Add gain automation points (multi-point fade example):**
```lua
local r = Session:route_by_name('{{track_name}}')
if r and not r:isnil() then
  local ac = r:gain_control()
  local al = ac:alist()
  al:clear_list()
  -- Fade in from -inf to -3dB over bars 1-4 (at 120 BPM, 4/4)
  al:add(Temporal.timepos_t.from_ticks(0), 0.0, false, true)         -- bar 1: -inf dB (linear 0.0)
  al:add(Temporal.timepos_t.from_ticks(23040), 0.7079, false, true)  -- bar 4: -3 dB (linear 0.7079)
  ac:set_automation_state(ARDOUR.AutoState.Play)
end
```

**Add pan automation:**
```lua
local r = Session:route_by_name('{{track_name}}')
if r and not r:isnil() then
  local pc = r:pan_azimuth_control()
  if pc and not pc:isnil() then
    local al = pc:alist()
    al:clear_list()
    al:add(Temporal.timepos_t.from_ticks(0), 0.5, false, true)       -- center
    al:add(Temporal.timepos_t.from_ticks({{ticks}}), {{pan}}, false, true)
    pc:set_automation_state(ARDOUR.AutoState.Play)
  end
end
```

**Export session:**
```lua
local se = Session:simple_export()
se:set_name('{{name}}')
se:set_folder('{{folder}}')
se:set_range(Session:current_start_sample(), Session:current_end_sample())
-- CD preset (16-bit 44.1kHz): df340c53-88b5-4342-a1c8-58e0704872ea
-- WAV preset (24-bit, session rate): 75969a1c-3133-4694-864b-a1fa50e43348
se:set_preset('{{preset_uuid}}')
se:check_outputs()
se:run_export()
-- run_export() is synchronous in SimpleExport — blocks until file is written
```

**Note on export filenames:** Ardour may append suffixes to the export filename (e.g., sample rate, format info). The export service scans the export directory after `lua_eval` completes and returns whatever files were produced, rather than assuming a specific filename.

## Export and Analysis

### `POST /v1/sessions/:id/export`

Trigger audio export on a live session. Async — returns 202 with poll URL.

**Request:**
```json
{
  "format": "wav",
  "bit_depth": 24,
  "sample_rate": 48000,
  "name": "mix-v1"
}
```

Supported formats: `wav`, `flac`. (`mp3` and `ogg` depend on Ardour build-time encoder availability — document in the test app but don't guarantee.)

To export multiple formats, make separate requests — each produces an independent export with its own `export_id`.

**Response (202):**
```json
{
  "export_id": "exp-xyz",
  "status": "exporting",
  "poll_url": "/v1/sessions/a1b2c3d4/exports/exp-xyz"
}
```

**`GET /v1/sessions/:id/exports`** — list all exports for this session.

**`GET /v1/sessions/:id/exports/:export_id`** — poll for completion.

**Response (complete):**
```json
{
  "export_id": "exp-xyz",
  "status": "complete",
  "file_url": "/v1/sessions/a1b2c3d4/exports/exp-xyz/file",
  "filename": "mix-v1.wav",
  "size": 4521984
}
```

**`GET /v1/sessions/:id/exports/:export_id/file`** — download the rendered audio file.

**Timeouts:** Export has a 120s timeout. If exceeded, status becomes `failed`. Export records are cleaned up after `outputTtlMs` (same as batch jobs).

**Session deletion during export:** Export is cancelled, marked `failed`.

### `POST /v1/sessions/:id/analyze`

Analyze the current session. Async — returns 202 with poll URL. Internally exports, then runs `ffmpeg`/`ffprobe` analysis on the rendered file.

**Request:**
```json
{
  "format": "wav",
  "sample_rate": 48000,
  "export_id": "exp-xyz"
}
```

If `export_id` is provided, analysis runs on an existing export (avoids redundant re-rendering). If omitted, a new export is triggered first.

**Response (202):**
```json
{
  "analysis_id": "anl-xyz",
  "status": "analyzing",
  "poll_url": "/v1/sessions/a1b2c3d4/analysis/anl-xyz"
}
```

**`GET /v1/sessions/:id/analysis/:analysis_id`** — poll for completion.

**Response (complete):**
```json
{
  "analysis_id": "anl-xyz",
  "status": "complete",
  "result": {
    "duration_seconds": 64.0,
    "master": {
      "peak_db": -0.3,
      "true_peak_db": -0.1,
      "rms_db": -14.2,
      "lufs_integrated": -16.1,
      "lufs_short_term_max": -12.4,
      "frequency_spectrum": {
        "bands_hz": [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
        "levels_db": [-22, -18, -14, -12, -11, -13, -15, -17, -20, -28]
      }
    },
    "tracks": [
      {
        "name": "Bass",
        "peak_db": -3.1,
        "true_peak_db": -2.9,
        "rms_db": -18.4,
        "lufs_integrated": -20.2,
        "crest_factor_db": 15.3
      }
    ]
  }
}
```

**Analysis implementation:**
- Master bus analysis: uses `ffmpeg -i mix.wav -filter_complex ebur128=peak=true -f null -` for LUFS + true peak, and `ffprobe -show_entries frame_tags` for peak/RMS.
- Frequency spectrum: uses `ffmpeg` with `asplit` + band-pass filters + `astats` to compute per-octave-band levels. The exact `ffmpeg` command chain will be determined during implementation and documented in `export-service.js`.
- Per-track analysis: each track is soloed, exported, analyzed, then un-soloed — all via sequential `lua_eval` calls through the session's action queue.
- **Per-track analysis timeout:** configurable (default 600s via `analysisTimeoutMs`). A 20-track session with 5s exports produces ~100 seconds of analysis time. The timeout should be generous.
- **ffmpeg availability:** checked at startup (`ffmpeg -version`). If unavailable, log a warning — analysis endpoints return `501 Not Implemented` until ffmpeg is available.

## Process Management

### Spawning

The session manager spawns headless Ardour via:

```bash
hardour --backend "None (Dummy)" --mcp-http-port 4823 /tmp/ardour-sessions/<session_id>/session-name
```

Note: the backend name is `"None (Dummy)"` (not `"Dummy"`) — this matches Ardour's internal backend descriptor name used by `AudioEngine::set_backend()`.

With the environment from `buildArdourEnv()` (same as existing executor.js).

For GUI mode (`gui: true` + `ALLOW_GUI=true`):
```bash
ardour8 --mcp-http-port 4823 /tmp/ardour-sessions/<session_id>/session-name
```

Child processes are spawned with `detached: false`. Shutdown uses `child.kill(signal)` (not `process.kill(-pid)`, which would kill the API server since the child shares the parent's process group). The Dummy backend does not spawn sub-processes, so killing only the child PID is sufficient.

### Port Pool

- Configurable range via `MCP_PORT_RANGE_START` (default 4821) and `MCP_PORT_RANGE_END` (default 4920).
- In-memory set of allocated ports. Lowest available port is assigned on session create.
- Port released on session destroy or crash — but only after the child process `exit` event fires (not before).
- **Startup port scan:** on API service startup, probe every port in the range **in parallel** (`Promise.all` with 100 concurrent `net.createConnection({ port, timeout: 500 })` calls). Ports that accept connections are marked as occupied. For each occupied port, check for a matching PID file in the sessions directory — if found and PID is alive, it's an orphaned Ardour (kill it). If no PID file, log a warning ("port N occupied by unknown process") and skip the port. Parallel scan completes in <1 second worst case.
- After spawn, health check verifies Ardour is actually listening on the expected port (polls every 500ms, up to startup timeout). If port conflict detected, retry with next available port (up to 3 retries).

### Session Directories

Each session gets an isolated working directory:

```
/tmp/ardour-sessions/<session_id>/
  session-name/
    session-name.ardour    # Ardour session file
    interchange/           # Audio files (Ardour copies imports here)
  exports/                 # Rendered output files
  uploads/                 # Files uploaded by client
  ardour.pid               # PID file for orphan detection
```

### PID Files for Orphan Detection

On session creation, write `<session_dir>/ardour.pid` with the child process PID. On API service startup, scan all session directories for PID files. If the PID is still alive (`process.kill(pid, 0)`), it's an orphaned Ardour — kill it and clean up. If dead, just clean up the directory.

### GUI Mode

Config flag `ALLOW_GUI` (env var, default `false`):
- `true`: `POST /v1/sessions` accepts `gui: true`, launches full Ardour GUI
- `false`: `gui` parameter ignored, always headless

The developer test app includes a "GUI mode" toggle that sets this flag on session creation. GUI mode sessions respond to the same MCP HTTP tool calls — the developer can watch each API call take effect in real time.

### API Service Graceful Shutdown

Uses Fastify's `onClose` hook for proper integration:

```js
app.addHook('onClose', async () => {
  reaper.stop();
  healthChecker.stop();
  for (const session of sessionManager.listAll()) {
    await sessionManager.destroy(session.id, { timeout: 5000 });
  }
});

process.on('SIGTERM', () => app.close());
process.on('SIGINT', () => app.close());
```

Fastify's `close()` stops accepting new connections and drains in-flight requests before calling `onClose`. Configure `forceCloseConnections: 'idle'` in Fastify options to close idle connections immediately during shutdown.

Total shutdown timeout: 30s (Fastify drain + session kills). If exceeded, `process.exit(1)`.

### Log Capture

Ardour process stdout/stderr is captured in a **ring buffer** per session (max 10,000 lines, configurable). Old lines are evicted as new ones arrive. Each line gets a monotonically-increasing sequence number for cursor-based retrieval.

This prevents unbounded memory growth for long-running sessions. A 2-hour session with verbose logging stays within ~1-2MB per session.

`GET /v1/sessions/:id/logs?since=<cursor>` — returns new log lines since the cursor position. The test app polls this every 2 seconds when the log panel is open.

**Response:**
```json
{
  "lines": [
    {"seq": 141, "text": "[INFO] Session loaded"},
    {"seq": 142, "text": "[INFO] MCP HTTP listening on 4823"}
  ],
  "cursor": "142"
}
```

## Developer Test App

Single-page vanilla HTML/JS/CSS app served at `GET /` by the Fastify server. No build step, no framework.

### Layout

**Top bar:**
- Active session indicator (green dot + session ID when connected)
- Quick-action buttons: Play, Stop, Save, Export, Analyze
- GUI mode toggle (checkbox)

**Left panel — Session Management:**
- "New Session" button with sample rate dropdown, session name field, tempo/time-sig inputs
- List of active sessions with status badges
- Select to connect, delete button per session

**Center panel — Action Builder:**
- Category dropdown: Session, Transport, Tracks, Track Control, Plugins, Regions, MIDI, Markers, Lua
- Tool dropdown (filtered by category) — populated from `GET /v1/tools`
- Auto-generated parameter form based on tool's JSON schema
- "Send" button, "Add to Batch" button
- File upload section for audio/MIDI/soundfont files
- Help section with documented Lua snippets

**Right panel — Response Log:**
- Scrolling list of request/response pairs with timestamps
- Color-coded: green (success), red (error), yellow (warning)
- Collapsible detail view for each entry
- Clear button

**Bottom panel — Batch Builder:**
- Collapsible
- List of queued actions, drag to reorder, remove individual items
- "Send All" button, "Clear" button
- `stop_on_error` toggle

**Ardour Log panel (toggleable):**
- Displays stdout/stderr from the active session's Ardour process
- Fetched via `GET /v1/sessions/:id/logs?since=<cursor>` (polled every 2s)
- Useful for debugging when things go wrong

### Serving

The test app is static files in `api-service/public/`:
```
api-service/public/
  index.html
  style.css
  app.js
```

Registered as a Fastify static plugin:
```js
import fastifyStatic from '@fastify/static';
app.register(fastifyStatic, { root: resolve(__dirname, '../public'), prefix: '/' });
```

## Integration with Existing Batch API

The batch API (`POST /v1/jobs`) and session API (`POST /v1/sessions`) coexist in the same Node.js service.

| Feature | Batch Jobs | Sessions |
|---------|-----------|----------|
| Use case | One-shot rendering from full spec | Interactive building + iteration |
| Ardour process | Disposable arlua | Persistent hardour |
| Duration | Seconds to minutes | Minutes to hours |
| State | Stateless | Stateful |
| Communication | Generated Lua script | MCP HTTP tool calls |
| Export | Automatic on job completion | On-demand via endpoint |

They share: config, `buildArdourEnv()`, plugin list, auth (when added), health endpoint.

The health endpoint (`GET /v1/health`) is extended:
```json
{
  "status": "ok",
  "queue_depth": 0,
  "active_jobs": 0,
  "sessions": {"active": 2, "max": 5, "available_ports": 98}
}
```

## MCP Tool Name Reference

The MCP HTTP surface uses slash-form tool names. The spec examples use these real names:

| Operation | Tool Name | Key Params |
|-----------|-----------|------------|
| Add track | `tracks/add` | `name`, `type` ("audio"/"midi"), `channels` |
| Add bus | `buses/add` | `name`, `type` |
| List tracks | `tracks/list` | (none) — returns all routes including master bus |
| Get track info | `track/get_info` | `id` — returns fader, pan, mute, solo, sends, plugins |
| Set fader | `track/set_fader` | `id`, `db` |
| Set pan | `track/set_pan` | `id`, `value` (0.0=left, 0.5=center, 1.0=right) |
| Set mute | `track/set_mute` | `id`, `mute` (boolean) |
| Set solo | `track/set_solo` | `id`, `solo` (boolean) |
| Add send | `track/add_send` | `id`, `targetId`, `db` |
| Set send level | `track/set_send_level` | `id`, `sendIndex`, `db` |
| List plugins | `plugin/list_available` | `search` (optional filter string) |
| Add plugin | `plugin/add` | `id` (route), `pluginId` |
| Get plugin params | `plugin/get_description` | `id` (route), `pluginIndex` |
| Set plugin param | `plugin/set_parameter` | `id`, `pluginIndex`, `parameterIndex`, `value` |
| Add marker | `markers/add` | `name`, `beats` |
| Session info | `session/get_info` | (none) — returns name, sample rate, tempo, transport |
| Save | `session/save` | (none) |
| Undo | `session/undo` | (none) |
| Redo | `session/redo` | (none) |
| Store mixer scene | `session/store_mixer_scene` | `index` |
| Recall mixer scene | `session/recall_mixer_scene` | `index` |
| Lua eval | `session/lua_eval` | `code` (string, max 64KB) |

**Note on route identification:** Most tools require a route `id` (string), not a name. Get IDs from `tracks/list` or from the response of `tracks/add`. The master bus appears in `tracks/list` output — identify it by its name (typically "Master").

**Note on plugin parameters:** Call `plugin/get_description` to discover parameter names, indices, ranges, and units before setting values. Different plugins use different parameter layouts.

## Configuration

New config values added to `config.js`:

```js
// Sessions
allowGui: process.env.ALLOW_GUI === 'true',
maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10),
sessionIdleTimeoutMs: parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '1800000', 10),  // 30 min
sessionStartupTimeoutMs: parseInt(process.env.SESSION_STARTUP_TIMEOUT_MS || '30000', 10),  // 30s
sessionHealthIntervalMs: parseInt(process.env.SESSION_HEALTH_INTERVAL_MS || '30000', 10),
sessionAutoSaveIntervalMs: parseInt(process.env.SESSION_AUTO_SAVE_MS || '300000', 10),  // 5 min
mcpPortRangeStart: parseInt(process.env.MCP_PORT_RANGE_START || '4821', 10),
mcpPortRangeEnd: parseInt(process.env.MCP_PORT_RANGE_END || '4920', 10),
hardourBin: resolve(ARDOUR_ROOT, 'build/headless/hardour'),
ardourGuiBin: process.env.ARDOUR_GUI_BIN || 'ardour8',
sessionsDir: process.env.SESSIONS_DIR || '/tmp/ardour-sessions',
maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || '104857600', 10),  // 100MB
actionQueueDepth: parseInt(process.env.ACTION_QUEUE_DEPTH || '20', 10),
actionQueueTimeoutMs: parseInt(process.env.ACTION_QUEUE_TIMEOUT_MS || '120000', 10),  // 2 min
luaEvalMaxBytes: parseInt(process.env.LUA_EVAL_MAX_BYTES || '65536', 10),  // 64KB
luaEvalTimeoutMs: parseInt(process.env.LUA_EVAL_TIMEOUT_MS || '30000', 10),
logRingBufferSize: parseInt(process.env.LOG_RING_BUFFER_SIZE || '10000', 10),
analysisTimeoutMs: parseInt(process.env.ANALYSIS_TIMEOUT_MS || '600000', 10),  // 10 min

// Analysis
ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
```

**Note on `sessionsDir`:** The default `/tmp/ardour-sessions` is subject to OS cleanup on reboot. For long-running sessions on a production server, configure a persistent path.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Max sessions reached | `429` with `{"error_code": "MAX_SESSIONS", "error": "Max concurrent sessions reached"}` |
| No ports available | `503` with `{"error_code": "NO_PORTS", "error": "No ports available"}` |
| Session not found | `404` with `{"error_code": "NOT_FOUND"}` |
| Session crashed | `200` with `{"status": "dead", "exit_code": 1, "stderr_tail": "..."}` |
| Session not ready | `409` with `{"error_code": "NOT_READY", "error": "Session not ready", "status": "starting"}` |
| Session stopping | `409` with `{"error_code": "SESSION_STOPPING"}` |
| Session already stopping (DELETE) | `200` with `{"status": "stopping"}` (idempotent) |
| Ardour unreachable | `502` with `{"error_code": "UPSTREAM_DOWN"}` |
| Ardour timeout | `504` with `{"error_code": "UPSTREAM_TIMEOUT"}` |
| Unknown tool name | `400` with `{"error_code": "UNKNOWN_TOOL", "tool": "..."}` |
| Invalid tool params | `400` with `{"error_code": "INVALID_PARAMS", "details": [...]}` |
| Action queue full | `429` with `{"error_code": "QUEUE_FULL"}` |
| Action queue wait timeout | `504` with `{"error_code": "QUEUE_TIMEOUT"}` |
| Startup timeout | Session process killed, marked `dead` |
| Export failure | Export status becomes `failed` with error message |
| Upload too large | `413` with `{"error_code": "FILE_TOO_LARGE"}` |
| Upload bad extension | `400` with `{"error_code": "INVALID_FILE_TYPE"}` |
| Upload duplicate name | `409` with `{"error_code": "FILE_EXISTS"}` |
| Lua eval too large | `400` with `{"error_code": "LUA_CODE_TOO_LARGE"}` |
| Lua eval runtime error | Proxied as `{"success": false, "error": "..."}` from MCP |
| ffmpeg not available | `501` with `{"error_code": "ANALYSIS_UNAVAILABLE"}` |

All error responses include `error_code` (machine-readable) and `error` (human-readable) fields for AI client parsing.

## File Structure

```
ardour/
  api-service/
    public/
      index.html              # Developer test app
      style.css
      app.js
    src/
      server.js               # Fastify setup + static serving + shutdown hook
      config.js               # Extended with session config
      routes/
        health.js             # Extended with session stats
        jobs.js               # Existing batch API (unchanged)
        plugins.js            # Existing (unchanged)
        sessions.js           # NEW: session CRUD + upload + actions + export + analyze + logs
        tools.js              # NEW: tool discovery endpoint
      lib/
        session-manager.js    # NEW: spawn, track, kill Ardour instances
        port-pool.js          # NEW: port allocation/release + startup scan
        timeout-reaper.js     # NEW: idle session cleanup + auto-save + dir cleanup
        action-proxy.js       # NEW: proxy to MCP HTTP + validation + per-session queue
        export-service.js     # NEW: export + analysis on live sessions
        log-buffer.js         # NEW: ring buffer for per-session log capture
        executor.js           # Existing batch executor (unchanged)
        lua-generator.js      # Existing (unchanged)
        validator.js          # Existing (unchanged)
        sanitizer.js          # Existing (unchanged)
        analyzer.js           # Existing (unchanged)
        job-queue.js          # Existing (unchanged)
      schemas/
        job-spec.json         # Existing (unchanged)
    test/
      helpers/
        fake-ardour.js        # Mock Ardour process for integration tests
        fake-clock.js         # Injectable time source (now + setTimeout/setInterval)

  headless/
    load_session.cc           # MODIFIED: add EventLoop, --backend, --mcp-http-port, explicit MCP HTTP activation

  libs/surfaces/mcp_http/
    mcp_http_server.cc        # MODIFIED: add sandboxed lua_eval handler (dispatched via event loop)
    tools_json.inc            # MODIFIED: add lua_eval tool schema
    wscript                   # MODIFIED: add liblua dependency
```

## C++ Work Required

### 1. Extend `hardour` Binary

**File:** `headless/load_session.cc`

Add:
- `MyEventLoop` class (~35 lines, copy pattern from `luasession/luasession.cc` lines 103-138)
- `EventLoop::set_event_loop_for_thread()` and `SessionEvent::create_per_thread_pool()` calls
- CLI argument parsing: `--backend <name>` (default `"None (Dummy)"`), `--mcp-http-port <port>` (add to existing `getopt_long`)
- Pass backend name to `AudioEngine::set_backend()`
- **Explicit MCP HTTP activation** (~20 lines): After session loads, find the MCP HTTP protocol via `ControlProtocolManager::instance().cpi_by_name("MCP HTTP Server (Experimental)")`, create an XMLNode with the desired port, set it as `cpi.state`, then call `ControlProtocolManager::instance().activate(cpi)`. This is necessary because `set_session()` only auto-activates protocols with `requested == true`, which won't be set for new sessions.
- Remove the `s->request_roll()` call (line ~273) — a headless server should not auto-play.
- SIGTERM handler for graceful shutdown.

**GTK dependency:** The MCP HTTP `.so` links against `libytkmm`, but this is a non-issue. The library loads via `dlopen` as long as `libytkmm.dylib` exists (it does — the full Ardour build produces it). GUI functions are never called in headless mode (`MCPHttp::tear_down_gui()` is a no-op when no GUI was built).

**Estimated size:** ~100 lines of new/modified code.

### 2. Add `session/lua_eval` MCP Tool

**Files:** `libs/surfaces/mcp_http/mcp_http_server.cc`, `tools_json.inc`, `wscript`

**wscript change:** Add `liblua` to `obj.use` so the surface can create Lua states.

Add a new tool handler that:
1. Accepts `{"code": "..."}` as input
2. Creates a **sandboxed** Lua state using `LuaState(true, true)` — this strips `io`, `os`, `loadfile`, `dofile`, `require`, `package`, `debug`, `rawget`, `rawset`, `coroutine`, `module` (more restrictive than originally documented, which is desirable for security)
3. Registers Ardour bindings via `LuaBindings::stddef()`, `LuaBindings::common()`, `LuaBindings::non_rt()`, then `LuaBindings::set_session()` (follow pattern from `luasession/luasession.cc` lines 420-448)
4. **Dispatches execution to the main event loop** via `_event_loop->call_slot()` — this is critical because Lua calling Session-mutating functions (import, track creation, export) must run on the session thread, not the HTTP service thread. The HTTP handler blocks until the event loop callback completes.
5. Sets a Lua debug hook via `lua_sethook(L, timeout_hook, LUA_MASKCOUNT, 100000)` — the hook checks elapsed wall-clock time and calls `luaL_error()` if the timeout is exceeded
6. Captures `print()` output via a custom print handler that appends to a string buffer
7. Returns `{"success": true, "output": "...", "return_value": "..."}` or `{"success": false, "error": "..."}`

**Thread safety:** All Lua execution runs on the main event loop thread (via `call_slot`), not the HTTP thread. This ensures Session mutations are safe. The HTTP handler uses a condition variable or promise to wait for the event loop callback to complete before returning the response.

**Estimated size:** ~250 lines.

## Multi-Instance Validation

Tested and confirmed: 5 simultaneous arlua instances with Dummy backend coexist without conflicts. No config directory isolation needed. No lock file contention. Each instance maintains fully independent state.

The same should hold for hardour instances once the binary is extended, since they use the same Ardour core with the same Dummy backend. Each session writes to its own session directory. The shared RC config (`~/.config/ardour*/ardour.rc`) is read at startup and not written during normal operation. Control surface state (including MCP HTTP port) is saved per-session, not globally.

**Potential risk:** If `ARDOUR::cleanup()` writes to the global RC config on exit, concurrent hardour shutdowns could race. This should be tested during the C++ implementation phase and mitigated by setting `ARDOUR_CONFIG_PATH` per-instance if needed.

## Known Limitations

- **Click track**: No Lua binding for `Session::click_io()`. Cannot enable/disable metronome via API.
- **No track deletion via MCP**: `tracks/add` exists but no `tracks/delete`. Use `session/undo` as workaround (note: undo is global, not per-track, so it undoes the last operation which may not be the track creation).
- **No tempo change via MCP**: Must use `session/lua_eval` with TempoMap Lua API.
- **No automation via MCP**: Must use `session/lua_eval` with gain/pan/plugin automation Lua API. See documented snippets above.
- **Snapshot restore**: `session/quick_snapshot` creates snapshots but there's no MCP tool to restore one.
- **Single-client per session**: Ardour's session manipulation is not concurrent-safe. One client per session, enforced by the per-session action queue.
- **Auth**: Not in this spec. Add Bearer token auth when deploying beyond localhost.
- **Plugin preset discovery**: No MCP tool for listing a plugin's available presets. AI must know preset names in advance or use raw parameter values via `plugin/get_description`.
- **Session directories in `/tmp`**: Subject to OS cleanup on reboot. Configure `SESSIONS_DIR` to a persistent path for long-running sessions.
- **A/B comparison**: Use `session/store_mixer_scene` and `session/recall_mixer_scene` for mixer snapshots. Full session branching (clone) is not supported in this version.
- **Real-time metering**: No tool for reading live signal levels (as opposed to fader position). The AI cannot monitor actual signal during playback. Use export+analyze for level feedback.
- **Relative fader adjustment**: `track/set_fader` is absolute only. To adjust by a delta, the AI must read the current value first via `track/get_fader`, then compute the new value.
