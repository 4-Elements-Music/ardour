# Session Manager + Developer Test App — Design Spec

## Overview

A session management layer that spawns persistent headless Ardour instances, proxies real-time manipulation requests to them, and provides a browser-based developer tool for testing. This enables the iterative AI workflow: create session, add tracks, load audio, adjust mix, export, analyze, refine, repeat.

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
3. **Port Pool** — Allocates and releases ports from a configurable range. Scans for occupied ports on startup to detect orphaned Ardour processes.
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

Tests use a `FakeArdourProcess` helper — a lightweight HTTP server that simulates MCP HTTP responses, supports configurable startup delay, crash simulation, and timeout simulation.

### Prerequisites (C++ Work)

Two changes to Ardour's C++ codebase are required before the Node.js work can function:

1. **Extend `hardour` binary** — Add EventLoop setup, backend selection (`--backend Dummy`), and MCP HTTP port CLI flag (`--mcp-http-port N`) so it can host a live session with the MCP HTTP control surface in headless mode. (~150 lines)
2. **Add `session/lua_eval` MCP tool** — A new MCP HTTP tool that executes a **sandboxed** Lua snippet in the session context. The Lua state has `io`, `os`, `loadfile`, `dofile`, and `require` stripped. This tool enables audio file import (`LuaAPI.import_audio_file`), export (`SimpleExport`), tempo/time-signature changes (`TempoMap`), and automation — all without adding more C++ tools. (~200 lines)

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

The `gui` flag launches the full Ardour GUI instead of headless mode. Only works when config `ALLOW_GUI=true` (development). Production always forces headless.

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
2. Send `session/save` via MCP HTTP (3s timeout, fire-and-forget on failure)
3. SIGTERM to Ardour process group (`process.kill(-pid, 'SIGTERM')`)
4. Wait 5s for exit
5. SIGKILL process group if still alive
6. Wait for `exit` event, then release port
7. Clean up session temp files

**Response:** `200 OK` with `{"status": "stopped"}`

#### `POST /v1/sessions/:id/upload`

Upload an audio file to the session's upload directory. The returned path can then be used in `session/lua_eval` to import the file onto a track.

**Request:** `multipart/form-data` with a `file` field.

**Constraints:**
- Max file size: 100MB (configurable)
- Allowed extensions: `.wav`, `.flac`, `.aiff`, `.ogg`, `.mp3`, `.mid`, `.midi`, `.sf2`, `.sfz`
- File is written to `<sessions_dir>/<session_id>/uploads/<original_filename>`

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

- `starting`: Ardour process spawned, waiting for MCP HTTP to respond. Health check polls every 500ms.
- `ready`: MCP HTTP health check passed, accepting actions.
- `unhealthy`: periodic liveness check failed (3 consecutive failures).
- `stopping`: graceful shutdown in progress. Reaper and health checks skip this state.
- `dead`: process exited unexpectedly.

**Startup timeout:** If the session doesn't reach `ready` within `sessionStartupTimeoutMs` (default 30s), the process is killed (SIGTERM → 5s → SIGKILL), port released after `exit` event, session marked `dead`.

### Lifecycle Management

- **Idle timeout**: configurable TTL (default 30 minutes). Background reaper runs every 60s, checks `lastActivity` timestamps, shuts down idle sessions. Sessions in `starting` or `stopping` state are exempt.
- **Max concurrent sessions**: configurable (default 5). `POST /v1/sessions` returns `429` when full.
- **Crash detection**: child process `exit` event handler marks session as `dead`, waits for `exit` event completion, then releases port. Retains session info for 5 minutes (cleanup timer).
- **Periodic health check**: staggered across sessions (interval / session count) to avoid thundering herd. Send MCP HTTP `session/get_info` call (5s timeout) to each `ready` session. 3 consecutive failures → mark `unhealthy` → trigger shutdown. Health checks skip sessions not in `ready` state.
- **Auto-save**: the reaper checks `lastSave` alongside `lastActivity`. If a `ready` session hasn't been saved in >5 minutes and has had activity, trigger `session/save` via MCP HTTP (fire-and-forget). Keeps auto-save off the action hot path.
- **Session directory cleanup**: the reaper also cleans up temp directories for `dead` sessions whose 5-minute retention has expired, and for `stopped` sessions.

## Action Proxying

### Concurrency Control

Each session has an async queue. Actions are processed one at a time per session. If a request arrives while another is in progress, it waits in the queue. This prevents concurrent mutations to Ardour's non-thread-safe session state.

The queue has a max depth (default 20). If exceeded, the request is rejected with `429`.

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
- `504` — Ardour instance timed out (10s default)

**Validation:** The API validates tool names against the known tool set. Unknown tools are rejected with 400 before reaching Ardour. Tool parameters are validated against the JSON schemas from `tools_json.inc`. `session/lua_eval` has additional validation: max code length (64KB), execution timeout (30s).

**Request tracing:** The `x-request-id` header is forwarded to the MCP HTTP call and logged on both sides for cross-boundary debugging.

Each action updates the session's `lastActivity` timestamp.

### `POST /v1/sessions/:id/actions/batch`

Send multiple tool calls in sequence. Each action goes through the same per-session queue.

**Request:**
```json
{
  "actions": [
    {"tool": "tracks/add", "params": {"name": "Kick", "type": "audio"}},
    {"tool": "tracks/add", "params": {"name": "Snare", "type": "audio"}},
    {"tool": "track_control/set_fader", "params": {"track": "Kick", "value_db": -6}}
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
    {"tool": "track_control/set_fader", "success": true, "result": {}}
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
    "code": "local rgn = ARDOUR.LuaAPI.import_audio_file(Session, '/tmp/ardour-sessions/abc123/uploads/kick.wav')\nlocal track = Session:route_by_name('Kick')\nif track and not track:isnil() then\n  track:to_track():playlist():add_region(rgn, Temporal.timepos_t(0), 1, false, 0, 0, false)\nend"
  }
}
```

### Convenience: Documented Lua Snippets

To avoid requiring clients to craft raw Lua, the spec defines standard snippets that the API or client can template:

**Import audio onto track:**
```lua
local rgn = ARDOUR.LuaAPI.import_audio_file(Session, '{{path}}')
if not rgn:isnil() then
  local track = Session:route_by_name('{{track_name}}')
  if track and not track:isnil() then
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

**Add automation point:**
```lua
local r = Session:route_by_name('{{track_name}}')
if r and not r:isnil() then
  local ac = r:gain_control()
  local al = ac:alist()
  al:add(Temporal.timepos_t.from_ticks({{ticks}}), {{value}}, false, true)
  ac:set_automation_state(ARDOUR.AutoState.Play)
end
```

**Export session:**
```lua
local se = Session:simple_export()
se:set_name('{{name}}')
se:set_folder('{{folder}}')
se:set_range(Session:current_start_sample(), Session:current_end_sample())
se:set_preset('75969a1c-3133-4694-864b-a1fa50e43348')
se:check_outputs()
se:run_export()
```

These snippets are documented here and in the test app's help section. The API does NOT template them — the client (AI or test app) constructs the Lua code using these patterns.

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

**Response (202):**
```json
{
  "export_id": "exp-xyz",
  "status": "exporting",
  "poll_url": "/v1/sessions/a1b2c3d4/exports/exp-xyz"
}
```

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
  "sample_rate": 48000
}
```

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
        "crest_factor_db": 15.3,
        "frequency_spectrum": {
          "bands_hz": [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
          "levels_db": [-18, -12, -8, -14, -22, -30, -38, -42, -48, -52]
        }
      }
    ]
  }
}
```

Analysis uses `ffmpeg -filter_complex ebur128` on the exported file for accurate LUFS measurement, plus `ffprobe` for peak/RMS. Per-track analysis solos each track, exports, analyzes, un-solos — done via a batch `lua_eval` sequence within the session's action queue.

## Process Management

### Spawning

The session manager spawns headless Ardour via:

```bash
hardour --backend Dummy --mcp-http-port 4823 /tmp/ardour-sessions/<session_id>/session-name
```

With the environment from `buildArdourEnv()` (same as existing executor.js).

For GUI mode (`gui: true` + `ALLOW_GUI=true`):
```bash
ardour8 --mcp-http-port 4823 /tmp/ardour-sessions/<session_id>/session-name
```

Child processes are spawned with `detached: false`. Shutdown uses process group kills (`process.kill(-pid, signal)`) to ensure Ardour sub-processes (plugin hosts, etc.) are also terminated.

### Port Pool

- Configurable range via `MCP_PORT_RANGE_START` (default 4821) and `MCP_PORT_RANGE_END` (default 4920).
- In-memory set of allocated ports. Lowest available port is assigned on session create.
- Port released on session destroy or crash — but only after the child process `exit` event fires (not before).
- **Startup port scan:** on API service startup, probe every port in the range with a quick TCP connect. Ports already in use (orphaned Ardour from a previous crash) are marked as occupied. Log a warning for each detected orphan.
- After spawn, health check verifies Ardour is actually listening on the expected port (polls every 500ms, up to startup timeout). If port conflict detected, retry with next available port (up to 3 retries).

### Session Directories

Each session gets an isolated working directory:

```
/tmp/ardour-sessions/<session_id>/
  session-name/
    session-name.ardour    # Ardour session file
    interchange/           # Audio files
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

On `SIGTERM` or `SIGINT`:

1. Stop accepting new requests (`app.close()`)
2. Stop the reaper and health check intervals
3. For each active session: set status `stopping`, send SIGTERM to process group
4. Wait up to 10s for all processes to exit
5. SIGKILL any survivors
6. Release all ports, clean up
7. Exit

This prevents orphaned Ardour processes on API restarts.

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
- Fetched via `GET /v1/sessions/:id/logs` (returns last N lines, supports `since` cursor for polling)
- Useful for debugging when things go wrong

### Log Streaming

`GET /v1/sessions/:id/logs?since=<cursor>` — returns new log lines since the cursor position. The test app polls this every 2 seconds when the log panel is open.

**Response:**
```json
{
  "lines": ["[INFO] Session loaded", "[INFO] MCP HTTP listening on 4823"],
  "cursor": "142"
}
```

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
app.register(import('@fastify/static'), { root: 'public', prefix: '/' });
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
luaEvalMaxBytes: parseInt(process.env.LUA_EVAL_MAX_BYTES || '65536', 10),  // 64KB
luaEvalTimeoutMs: parseInt(process.env.LUA_EVAL_TIMEOUT_MS || '30000', 10),

// Analysis
ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Max sessions reached | `429` with `{"error_code": "MAX_SESSIONS", "error": "Max concurrent sessions reached"}` |
| No ports available | `503` with `{"error_code": "NO_PORTS", "error": "No ports available"}` |
| Session not found | `404` with `{"error_code": "NOT_FOUND"}` |
| Session crashed | `200` with `{"status": "dead", "exit_code": 1, "stderr_tail": "..."}` |
| Session not ready | `409` with `{"error_code": "NOT_READY", "error": "Session not ready", "status": "starting"}` |
| Session already stopping | `200` with `{"status": "stopping"}` (DELETE is idempotent) |
| Ardour unreachable | `502` with `{"error_code": "UPSTREAM_DOWN"}` |
| Ardour timeout | `504` with `{"error_code": "UPSTREAM_TIMEOUT"}` |
| Unknown tool name | `400` with `{"error_code": "UNKNOWN_TOOL", "tool": "..."}` |
| Invalid tool params | `400` with `{"error_code": "INVALID_PARAMS", "details": [...]}` |
| Action queue full | `429` with `{"error_code": "QUEUE_FULL"}` |
| Startup timeout | Session process killed, marked `dead` |
| Export failure | Export status becomes `failed` with error message |
| Upload too large | `413` with `{"error_code": "FILE_TOO_LARGE"}` |
| Upload bad extension | `400` with `{"error_code": "INVALID_FILE_TYPE"}` |
| Lua eval too large | `400` with `{"error_code": "LUA_CODE_TOO_LARGE"}` |

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
        sessions.js           # NEW: session CRUD + upload + actions + export + analyze
        tools.js              # NEW: tool discovery endpoint
      lib/
        session-manager.js    # NEW: spawn, track, kill Ardour instances
        port-pool.js          # NEW: port allocation/release + startup scan
        timeout-reaper.js     # NEW: idle session cleanup + auto-save + dir cleanup
        action-proxy.js       # NEW: proxy to MCP HTTP + validation + per-session queue
        export-service.js     # NEW: export + analysis on live sessions
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
        fake-clock.js         # Injectable time source

  headless/
    load_session.cc           # MODIFIED: add EventLoop, --backend, --mcp-http-port

  libs/surfaces/mcp_http/
    mcp_http_server.cc        # MODIFIED: add sandboxed lua_eval handler
    tools_json.inc            # MODIFIED: add lua_eval tool schema
```

## C++ Work Required

### 1. Extend `hardour` Binary

**File:** `headless/load_session.cc`

Add:
- `MyEventLoop` class (copy pattern from `luasession/luasession.cc`)
- `EventLoop::set_event_loop_for_thread()` and `SessionEvent::create_per_thread_pool()` calls
- CLI argument parsing: `--backend <name>`, `--mcp-http-port <port>`
- Pass backend name to `AudioEngine::set_backend()`
- After session creation, verify `ControlProtocolManager::instance().set_session()` is called (it should be automatic in Session constructor)
- SIGTERM handler for graceful shutdown

**Risk:** MCP HTTP GUI component (`mcp_http_gui.cc`) may have GTK dependencies. May need conditional compilation or a stub for headless mode.

### 2. Add `session/lua_eval` MCP Tool

**Files:** `libs/surfaces/mcp_http/mcp_http_server.cc`, `tools_json.inc`

Add a new tool handler that:
1. Accepts `{"code": "..."}` as input
2. Creates a **sandboxed** Lua state: strip `io`, `os`, `loadfile`, `dofile`, `require` from the global environment. Keep `ARDOUR.*`, `Session`, `Temporal.*`, `PBD.*`, `Evoral.*`, `print`, `string`, `table`, `math`, `tonumber`, `tostring`, `type`, `pairs`, `ipairs`
3. Calls `luaL_dostring(L, code)` to execute the snippet
4. Captures `print()` output via a custom print handler
5. Returns `{"success": true, "output": "...", "return_value": "..."}` or `{"success": false, "error": "..."}`
6. Execution timeout: kill the Lua coroutine after configurable limit (default 30s)

This enables: audio import, export, tempo changes, time-sig changes, automation curves, and any future Lua-accessible Ardour feature — all without adding more C++ MCP tools.

## Multi-Instance Validation

Tested and confirmed: 5 simultaneous arlua instances with Dummy backend coexist without conflicts. No config directory isolation needed. No lock file contention. Each instance maintains fully independent state.

The same should hold for hardour instances once the binary is extended, since they use the same Ardour core with the same Dummy backend.

## Known Limitations

- **Click track**: No Lua binding for `Session::click_io()`. Cannot enable/disable metronome via API.
- **No track deletion via MCP**: `tracks/add` exists but no `tracks/delete`. Use `session/undo` as workaround.
- **No tempo change via MCP**: Must use `session/lua_eval` with TempoMap Lua API.
- **No automation via MCP**: Must use `session/lua_eval` with gain/pan/plugin automation Lua API.
- **Snapshot restore**: `session/quick_snapshot` creates snapshots but there's no MCP tool to restore one.
- **Single-client per session**: Ardour's session manipulation is not concurrent-safe. One client per session, enforced by the per-session action queue.
- **Auth**: Not in this spec. Add Bearer token auth when deploying beyond localhost.
- **Plugin preset discovery**: No MCP tool for listing a plugin's available presets. AI must know preset names in advance or use raw parameter values.
- **Session directories in `/tmp`**: Subject to OS cleanup on reboot. Configure `SESSIONS_DIR` to a persistent path for long-running sessions.
