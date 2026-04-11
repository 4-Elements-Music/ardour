# Session Manager + Developer Test App — Design Spec

## Overview

A session management layer that spawns persistent headless Ardour instances, proxies real-time manipulation requests to them, and provides a browser-based developer tool for testing. This enables the iterative AI workflow: create session, add tracks, adjust mix, export, analyze, refine, repeat.

## Architecture

```
AI Client / Browser Test App
    |
    | REST API (JSON)
    v
Node.js API Service (Fastify)
    |
    | Session Manager: spawns, tracks, kills Ardour instances
    | Action Proxy: routes tool calls to the right instance
    v
Headless Ardour Instance(s)
    |
    | MCP HTTP Surface (JSON-RPC over HTTP, one port per instance)
    | Each instance has its own session, audio engine, plugin state
    v
Audio Files (import from library, export to job dir)
```

### Components

1. **Session Manager** — Spawns headless Ardour processes with MCP HTTP surfaces on unique ports. Tracks active sessions, handles lifecycle (create, health check, idle timeout, crash recovery, shutdown).
2. **Action Proxy** — Routes MCP HTTP tool calls from the API to the correct Ardour instance. Single and batch actions.
3. **Port Pool** — Allocates and releases ports from a configurable range for Ardour instances.
4. **Timeout Reaper** — Background interval that kills sessions idle beyond a configurable TTL.
5. **Developer Test App** — Vanilla HTML/JS/CSS browser UI served by the API for exercising all endpoints.

### Prerequisites (C++ Work)

Two changes to Ardour's C++ codebase are required before the Node.js work can function:

1. **Extend `hardour` binary** — Add EventLoop setup, backend selection (`--backend Dummy`), and MCP HTTP port CLI flag (`--mcp-http-port N`) so it can host a live session with the MCP HTTP control surface in headless mode. (~150 lines)
2. **Add `session/lua_eval` MCP tool** — A new MCP HTTP tool that executes a Lua snippet in the session context via `luaL_dostring()`. This single tool enables audio file import (`LuaAPI.import_audio_file`), export (`SimpleExport`), tempo/time-signature changes (`TempoMap`), and any future Lua-accessible feature without adding more C++ tools. (~200 lines)

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

All fields optional. Defaults: `sample_rate: 48000`, `session_name: auto-generated`, `tempo: 120`, `time_signature: 4/4`, `gui: false`.

The `gui` flag launches the full Ardour GUI instead of headless mode. Only works when config `ALLOW_GUI=true` (development). Production always forces headless.

**Response (202):**
```json
{
  "session_id": "a1b2c3d4",
  "status": "starting",
  "poll_url": "/v1/sessions/a1b2c3d4"
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

When `dead`: response includes `exit_code` and `stderr_tail` (last 50 lines of Ardour stderr).

**Errors:**
- `404` — unknown session ID
- `410` — session crashed (includes crash details, persists for 5 minutes)

#### `DELETE /v1/sessions/:id`

Graceful shutdown.

1. Send `session/save` via MCP HTTP (3s timeout)
2. SIGTERM to Ardour process
3. Wait 5s for exit
4. SIGKILL if still alive
5. Release port, clean up temp files

**Response:** `200 OK` with `{"status": "stopped"}`

### Session Status Lifecycle

```
starting → ready → (active use) → stopping → stopped
                 → unhealthy → stopping → stopped
                 → dead (crash detected)
```

- `starting`: Ardour process spawned, waiting for MCP HTTP to respond
- `ready`: MCP HTTP health check passed, accepting actions
- `unhealthy`: periodic liveness check failed (3 consecutive failures)
- `stopping`: graceful shutdown in progress
- `dead`: process exited unexpectedly

### Lifecycle Management

- **Idle timeout**: configurable TTL (default 30 minutes). Background reaper runs every 60s, checks `lastActivity` timestamps, shuts down idle sessions. Sessions in `starting` state are exempt.
- **Max concurrent sessions**: configurable (default 5). `POST /v1/sessions` returns `429` when full.
- **Crash detection**: child process `exit` event handler marks session as `dead`, releases port, retains session info for 5 minutes.
- **Periodic health check**: every 30s, send MCP HTTP `hello_world` call (5s timeout) to each `ready` session. 3 consecutive failures → mark `unhealthy` → trigger shutdown.
- **Auto-save**: on each action proxy call, if >5 minutes since last save, trigger `session/save` via MCP HTTP. Prevents data loss from crashes.

## Action Proxying

### `POST /v1/sessions/:id/actions`

Proxy a single MCP tool call to the session's Ardour instance.

**Request:**
```json
{
  "tool": "tracks/add",
  "params": {"name": "Bass", "type": "audio", "channels": 2}
}
```

**Response:** The MCP HTTP response body, passed through.

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
- `502` — Ardour instance unreachable
- `504` — Ardour instance timed out (10s default)

**Validation:** The API validates tool names against the known set of 69 MCP tools (+ `session/lua_eval`). Unknown tools are rejected with 400 before reaching Ardour. Tool parameters are validated against the JSON schemas from `tools_json.inc`.

Each action updates the session's `lastActivity` timestamp.

### `POST /v1/sessions/:id/actions/batch`

Send multiple tool calls in sequence.

**Request:**
```json
{
  "actions": [
    {"tool": "tracks/add", "params": {"name": "Kick", "type": "audio"}},
    {"tool": "tracks/add", "params": {"name": "Snare", "type": "audio"}},
    {"tool": "track_control/set_fader", "params": {"track": "Kick", "value_db": -6}}
  ],
  "stop_on_error": true
}
```

`stop_on_error` defaults to `true`. When `false`, all actions execute regardless of individual failures.

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

## Export and Analysis

### `POST /v1/sessions/:id/export`

Trigger audio export on a live session. Uses `session/lua_eval` internally to call `SimpleExport`.

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

**`GET /v1/sessions/:id/exports/:export_id`** — poll for completion, then download.

**`GET /v1/sessions/:id/exports/:export_id/file`** — download the rendered audio file.

### `POST /v1/sessions/:id/analyze`

Analyze the current session. Exports internally, then analyzes the rendered file.

**Request:**
```json
{
  "format": "wav",
  "sample_rate": 48000
}
```

**Response:**
```json
{
  "duration_seconds": 64.0,
  "master": {
    "peak_db": -0.3,
    "rms_db": -14.2,
    "lufs_integrated": -16.1
  },
  "tracks": [
    {"name": "Bass", "peak_db": -3.1, "rms_db": -18.4}
  ]
}
```

Analysis uses `ffmpeg -filter_complex ebur128` on the exported file for accurate LUFS measurement, plus `ffprobe` for peak/RMS. This is more reliable than live metering snapshots.

## Process Management

### Spawning

The session manager spawns headless Ardour via:

```bash
hardour --backend Dummy --mcp-http-port 4823 /tmp/sessions/<session_id>/session-name
```

With the environment from `buildArdourEnv()` (same as existing executor.js).

For GUI mode (`gui: true` + `ALLOW_GUI=true`):
```bash
ardour8 --mcp-http-port 4823 /tmp/sessions/<session_id>/session-name
```

### Port Pool

- Configurable range via `MCP_PORT_RANGE_START` (default 4821) and `MCP_PORT_RANGE_END` (default 4920).
- In-memory set of allocated ports. Lowest available port is assigned on session create.
- Port released on session destroy or crash.
- After spawn, health check verifies Ardour is actually listening on the expected port. If not (port conflict with another process), retry with next available port (up to 3 retries).

### Session Directories

Each session gets an isolated working directory:

```
/tmp/ardour-sessions/<session_id>/
  session-name/
    session-name.ardour    # Ardour session file
    interchange/           # Audio files
  exports/                 # Rendered output files
  uploads/                 # Files uploaded by client
```

### GUI Mode

Config flag `ALLOW_GUI` (env var, default `false`):
- `true`: `POST /v1/sessions` accepts `gui: true`, launches full Ardour GUI
- `false`: `gui` parameter ignored, always headless

The developer test app includes a "GUI mode" toggle that sets this flag on session creation.

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
- Tool dropdown (filtered by category)
- Auto-generated parameter form based on tool's JSON schema
- "Send" button, "Add to Batch" button

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
- Streams stdout/stderr from the active session's Ardour process
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
sessionStartupTimeoutMs: parseInt(process.env.SESSION_STARTUP_TIMEOUT_MS || '15000', 10),
sessionHealthIntervalMs: parseInt(process.env.SESSION_HEALTH_INTERVAL_MS || '30000', 10),
sessionAutoSaveIntervalMs: parseInt(process.env.SESSION_AUTO_SAVE_MS || '300000', 10),  // 5 min
mpcPortRangeStart: parseInt(process.env.MCP_PORT_RANGE_START || '4821', 10),
mpcPortRangeEnd: parseInt(process.env.MCP_PORT_RANGE_END || '4920', 10),
hardourBin: resolve(ARDOUR_ROOT, 'build/headless/hardour'),
ardourGuiBin: process.env.ARDOUR_GUI_BIN || 'ardour8',
sessionsDir: process.env.SESSIONS_DIR || '/tmp/ardour-sessions',

// Analysis
ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Max sessions reached | `429` with `{"error": "Max concurrent sessions reached"}` |
| No ports available | `503` with `{"error": "No ports available"}` |
| Session not found | `404` |
| Session crashed | `410` with crash details (exit code, stderr tail) |
| Session not ready | `409` with `{"error": "Session not ready", "status": "starting"}` |
| Ardour unreachable | `502` with `{"error": "Ardour instance unreachable"}` |
| Ardour timeout | `504` |
| Unknown tool name | `400` with `{"error": "Unknown tool", "tool": "..."}` |
| Invalid tool params | `400` with validation errors |
| Startup timeout | Session marked `dead`, `410` on next request |
| Export failure | Export status becomes `failed` with error message |

## File Structure

```
ardour/
  api-service/
    public/
      index.html              # Developer test app
      style.css
      app.js
    src/
      server.js               # Fastify setup + static serving
      config.js               # Extended with session config
      routes/
        health.js             # Extended with session stats
        jobs.js               # Existing batch API (unchanged)
        plugins.js            # Existing (unchanged)
        sessions.js           # NEW: session CRUD + actions + export + analyze
      lib/
        session-manager.js    # NEW: spawn, track, kill Ardour instances
        port-pool.js          # NEW: port allocation/release
        timeout-reaper.js     # NEW: idle session cleanup
        action-proxy.js       # NEW: proxy to MCP HTTP + validation
        export-service.js     # NEW: export + analysis on live sessions
        executor.js           # Existing batch executor (unchanged)
        lua-generator.js      # Existing (unchanged)
        validator.js          # Existing (unchanged)
        sanitizer.js          # Existing (unchanged)
        analyzer.js           # Existing (unchanged)
        job-queue.js          # Existing (unchanged)
      schemas/
        job-spec.json         # Existing (unchanged)

  headless/
    load_session.cc           # MODIFIED: add EventLoop, --backend, --mcp-http-port

  libs/surfaces/mcp_http/
    mcp_http_server.cc        # MODIFIED: add lua_eval handler
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

**Risk:** MCP HTTP GUI component (`mcp_http_gui.cc`) may have GTK dependencies. May need conditional compilation or a stub for headless mode.

### 2. Add `session/lua_eval` MCP Tool

**Files:** `libs/surfaces/mcp_http/mcp_http_server.cc`, `tools_json.inc`

Add a new tool handler that:
1. Accepts `{"code": "..."}` as input
2. Gets or creates a Lua state in the session context
3. Calls `luaL_dostring(L, code)` to execute the snippet
4. Captures return value and stdout/print output
5. Returns `{"success": true, "output": "...", "return_value": "..."}` or error

This enables: audio import, export, tempo changes, time-sig changes, and any future Lua-accessible Ardour feature — all without adding more C++ MCP tools.

## Multi-Instance Validation

Tested and confirmed: 5 simultaneous arlua instances with Dummy backend coexist without conflicts. No config directory isolation needed. No lock file contention. Each instance maintains fully independent state.

The same should hold for hardour instances once the binary is extended, since they use the same Ardour core with the same Dummy backend.

## Known Limitations

- **Click track**: No Lua binding for `Session::click_io()`. Cannot enable/disable metronome via API.
- **No track deletion via MCP**: `tracks/add` exists but no `tracks/delete`. Use `session/undo` as workaround.
- **No tempo change via MCP**: Must use `session/lua_eval` with TempoMap Lua API.
- **Snapshot restore**: `session/quick_snapshot` creates snapshots but there's no MCP tool to restore one.
- **Single-client per session**: Ardour's session manipulation is not concurrent-safe. One client per session.
- **Auth**: Not in this spec. Add Bearer token auth when deploying beyond localhost.
