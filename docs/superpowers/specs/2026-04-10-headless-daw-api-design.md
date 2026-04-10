# Headless DAW API Service — Design Spec

## Overview

A stateless HTTP API service that accepts fully-specified mix jobs as JSON, executes them via Ardour's headless engine, and returns rendered audio. The service is a faithful executor — all creative/mixing decisions are made by the client.

## Architecture

```
Client (AI orchestration)
    |
    | POST /v1/jobs  (JSON job spec)
    v
API Service (Node.js)
    |
    | Validates, sanitizes, generates Lua script
    v
arlua (Ardour headless Lua engine)
    |
    | Reads from local file library
    | Renders via Ardour engine
    v
Rendered audio files
    |
    | Response (file download or job status)
    v
Client
```

### Components

1. **API Service** — HTTP server (Fastify). Validates job specs, sanitizes inputs, generates Lua scripts, spawns arlua workers, manages temp sessions, returns results.
2. **Lua Script Generator** — Translates the declarative JSON job spec into an imperative Lua script that drives Ardour. All client-supplied strings are escaped to prevent Lua injection.
3. **arlua (luasession)** — Ardour's headless Lua engine. Executes the generated script. Already built and validated.
4. **Local File Library** — All stems, samples, MIDI files, soundfonts, and virtual instrument presets live on the same machine. Referenced by path in job specs, constrained to an allowlisted base directory.

### Why Not Embed HTTP in arlua?

Embedding an HTTP server in the C++ luasession binary couples networking to the audio engine. Keeping them separate means:
- The API service can queue/throttle jobs without blocking Ardour
- arlua stays single-purpose (run a script, exit)
- Easier to scale (multiple arlua workers behind one API)
- Crash isolation — a bad Lua script doesn't take down the API

## Job Specification

A single JSON object describes the entire mix job.

```json
{
  "session": {
    "sample_rate": 48000,
    "tempo": [
      {"bar": 1, "bpm": 120.0},
      {"bar": 17, "bpm": 140.0, "ramp": true}
    ],
    "time_signature": [
      {"bar": 1, "numerator": 4, "denominator": 4},
      {"bar": 9, "numerator": 6, "denominator": 8}
    ],
    "duration_bars": 32,
    "render_range": {"start_bar": 1, "end_bar": 32}
  },
  "tracks": [
    {
      "name": "Bass Loop",
      "type": "audio",
      "channels": 1,
      "regions": [
        {
          "file": "stems/funky-bass.wav",
          "position_bar": 1,
          "position_beat": 1,
          "start_offset_ms": 0,
          "length_bars": 8,
          "loop_count": 4,
          "pitch_shift_semitones": 0,
          "time_stretch_ratio": 1.0,
          "fade_in_ms": 10,
          "fade_out_ms": 50,
          "gain_db": 0.0
        }
      ],
      "plugins": [
        {
          "uri": "urn:ardour:a-comp#stereo",
          "preset": null,
          "params": {"0": -18.0, "1": 4.0},
          "sidechain_source": "Kick"
        }
      ],
      "sends": [
        {"bus": "FX Reverb", "gain_db": -12.0}
      ],
      "automation": [
        {
          "target": "gain",
          "points": [
            {"bar": 1, "beat": 1, "value_db": -3.0},
            {"bar": 16, "beat": 1, "value_db": -6.0},
            {"bar": 17, "beat": 1, "value_db": -3.0}
          ]
        },
        {
          "target": "pan",
          "points": [
            {"bar": 1, "beat": 1, "value": 0.3},
            {"bar": 8, "beat": 1, "value": 0.7}
          ]
        },
        {
          "target": "plugin",
          "plugin_index": 0,
          "param_index": 0,
          "points": [
            {"bar": 1, "beat": 1, "value": -18.0},
            {"bar": 16, "beat": 1, "value": -12.0}
          ]
        }
      ],
      "gain_db": -3.0,
      "pan": 0.3,
      "mute": false,
      "solo": false,
      "phase_invert": false,
      "group": "Bass Section"
    },
    {
      "name": "Synth Pad",
      "type": "midi",
      "regions": [
        {
          "file": "midi/pad-Cmaj.mid",
          "position_bar": 1
        }
      ],
      "instrument": {
        "uri": "https://community.ardour.org/node/7596",
        "preset": "Warm Pad",
        "params": {}
      },
      "plugins": [],
      "gain_db": -6.0,
      "pan": 0.5
    },
    {
      "name": "Strings",
      "type": "midi",
      "regions": [
        {
          "file": "midi/strings-arrangement.mid",
          "position_bar": 1
        }
      ],
      "instrument": {
        "uri": "urn:ardour:a-fluidsynth",
        "files": ["soundfonts/orchestral-strings.sf2"],
        "bank": 0,
        "program": 48,
        "preset": null,
        "params": {}
      },
      "gain_db": -8.0,
      "pan": 0.5
    },
    {
      "name": "Lead Melody",
      "type": "midi",
      "regions": [
        {
          "notes": [
            {"pitch": 60, "velocity": 100, "start_beat": 0, "duration_beats": 1},
            {"pitch": 64, "velocity": 90, "start_beat": 1, "duration_beats": 0.5},
            {"pitch": 67, "velocity": 110, "start_beat": 1.5, "duration_beats": 1.5}
          ],
          "cc": [
            {"controller": 1, "time_beat": 0, "value": 64},
            {"controller": 1, "time_beat": 2, "value": 127}
          ],
          "pitch_bend": [
            {"time_beat": 1.5, "value": 0},
            {"time_beat": 2.5, "value": 8192}
          ],
          "position_bar": 1,
          "length_bars": 4,
          "loop_count": 8
        }
      ],
      "instrument": {
        "uri": "urn:ardour:a-fluidsynth",
        "files": ["soundfonts/gm-piano.sf2"],
        "bank": 0,
        "program": 0
      },
      "gain_db": -4.0,
      "pan": 0.5
    }
  ],
  "buses": [
    {
      "name": "FX Reverb",
      "type": "aux",
      "plugins": [
        {"uri": "urn:ardour:a-reverb", "params": {"0": 0.6, "1": 0.4}}
      ],
      "gain_db": 0.0,
      "pan": 0.5,
      "mute": false
    },
    {
      "name": "Drum Bus",
      "type": "group",
      "source_tracks": ["Kick", "Snare", "HiHat"],
      "plugins": [
        {"uri": "urn:ardour:a-comp#stereo", "params": {"0": -12.0}}
      ],
      "gain_db": -1.0
    }
  ],
  "vcas": [
    {
      "name": "All Music",
      "controls": ["Bass Loop", "Synth Pad", "Strings", "Lead Melody"],
      "gain_db": 0.0
    }
  ],
  "markers": [
    {"name": "Intro", "bar": 1},
    {"name": "Verse 1", "bar": 9},
    {"name": "Chorus", "bar": 17},
    {"name": "Outro", "bar": 25}
  ],
  "master": {
    "gain_db": 0.0,
    "plugins": [
      {"uri": "urn:ardour:a-eq#stereo", "params": {"0": 80.0, "1": 2.0}}
    ]
  },
  "output": {
    "formats": [
      {"format": "wav", "bit_depth": 24, "sample_rate": 48000},
      {"format": "flac", "bit_depth": 16, "sample_rate": 44100}
    ],
    "stems": false,
    "stem_groups": [],
    "include_click": false
  },
  "analyze_only": false
}
```

### Field Reference

**session**: Global session parameters.
- `tempo[]`: Array of tempo points. Each has `bar` (1-indexed), `bpm` (float), optional `ramp` (boolean — if true, tempo ramps smoothly from previous to this one). Minimum one entry at bar 1.
- `time_signature[]`: Array of meter changes. Each has `bar`, `numerator`, `denominator`. Minimum one entry at bar 1.
- `duration_bars`: Total session length in bars.
- `render_range`: Optional. `start_bar` and `end_bar` to render a sub-range (e.g., just the chorus). Defaults to full session.
- `sample_rate`: Session sample rate in Hz.

**tracks[]**: Ordered list of tracks to create.
- `name`: Track name (string).
- `type`: `"audio"` or `"midi"`.
- `channels`: Channel count (1=mono, 2=stereo). Optional, default 2.
- `regions[]`: Audio/MIDI content to place on the track.
  - **For audio regions (file-based):**
    - `file`: Path to audio file, relative to the library base directory.
    - `position_bar` / `position_beat`: Where to place the region (1-indexed).
    - `start_offset_ms`: Offset into the source file to begin playback (optional; default 0).
    - `length_bars`: Trim region to this length (optional; defaults to full file).
    - `loop_count`: Repeat the region N times end-to-end (optional; default 1). Implemented by placing N copies.
    - `pitch_shift_semitones`: Pitch shift via RubberBand (optional; default 0).
    - `time_stretch_ratio`: Time stretch via RubberBand (optional; 1.0 = no change).
    - `fade_in_ms` / `fade_out_ms`: Fade durations (optional).
    - `gain_db`: Per-region gain adjustment (optional).
  - **For MIDI regions (file-based):**
    - `file`: Path to MIDI file, relative to library base directory.
    - `position_bar`: Where to place (1-indexed).
    - `length_bars`: Trim (optional).
    - `loop_count`: Repeat (optional).
  - **For MIDI regions (inline notes):**
    - `notes[]`: Array of `{pitch, velocity, start_beat, duration_beats}`. `start_beat` is relative to region start.
    - `cc[]`: MIDI CC events. Array of `{controller, time_beat, value}`.
    - `pitch_bend[]`: Pitch bend events. Array of `{time_beat, value}` where value is 0-16383 (8192 = center).
    - `position_bar`: Where to place.
    - `length_bars`: Region length.
    - `loop_count`: Repeat (optional).
- `plugins[]`: Insert effects chain, top to bottom.
  - `uri`: LV2 plugin URI.
  - `preset`: Preset name to load (optional).
  - `params`: Map of parameter index (string) to value (float).
  - `sidechain_source`: Name of track/bus to use as sidechain key input (optional).
- `instrument`: For MIDI tracks, the virtual instrument plugin.
  - `uri`: LV2 plugin URI.
  - `files[]`: Files to load (SF2 soundfonts, SFZ patches, etc.).
  - `bank` / `program`: MIDI bank and program number for multi-timbral instruments (optional).
  - `preset`: Preset name (optional).
  - `params`: Parameter overrides.
- `sends[]`: Aux sends to buses.
  - `bus`: Target bus name.
  - `gain_db`: Send level.
- `automation[]`: Time-varying parameter changes.
  - `target`: `"gain"`, `"pan"`, `"mute"`, or `"plugin"`.
  - `plugin_index` / `param_index`: Required when target is `"plugin"`.
  - `points[]`: Array of `{bar, beat, value}` or `{bar, beat, value_db}` for gain.
- `gain_db`: Static track fader level (used as initial value if automation overrides).
- `pan`: Stereo pan (0.0=L, 0.5=C, 1.0=R).
- `mute` / `solo`: Boolean, optional.
- `phase_invert`: Flip polarity (optional; default false).
- `group`: Track group name (optional). Tracks with the same group name are linked.

**buses[]**: FX return / group buses.
- `type`: `"aux"` (FX return) or `"group"` (summing bus).
- `source_tracks[]`: For group buses, list of track names that route to this bus.
- `plugins[]`: Insert chain (same format as tracks).
- `gain_db` / `pan` / `mute`: Bus mixer controls.

**vcas[]**: VCA fader groups.
- `name`: VCA name.
- `controls[]`: List of track/bus names controlled by this VCA.
- `gain_db`: VCA fader level.

**markers[]**: Arrangement markers.
- `name`: Marker name (e.g., "Chorus").
- `bar`: Bar position (1-indexed).

**master**: Master bus settings.
- `gain_db`: Master fader.
- `plugins[]`: Master bus insert chain.

**output**: Render settings.
- `formats[]`: Array of output formats. Each has `format` (`"wav"`, `"flac"`, `"mp3"`, `"ogg"`), `bit_depth` (for wav/flac), `sample_rate`. Multiple formats rendered in one job.
- `stems`: If `true`, export each track/bus as an individual file in addition to the full mix.
- `stem_groups[]`: Optional list of track/bus names to export as stems (if empty and `stems` is true, export all).
- `include_click`: If `true`, render a click track in the output.

**analyze_only**: If `true`, render internally but return analysis data instead of audio. Analysis includes per-track peak/RMS/LUFS, true-peak, master bus frequency spectrum, and per-track frequency spectrum.

## API Endpoints

All endpoints are prefixed with `/v1/`.

### `POST /v1/jobs`

Submit a mix job. Returns a job ID for async retrieval.

**Request:** JSON body (the job spec above).

**Response:**
- `202 Accepted` with `{"job_id": "abc123", "status": "processing"}`.

**Headers:**
- `X-Request-Id`: Client-supplied or server-generated correlation ID.
- `X-Idempotency-Key`: Optional. If provided, duplicate submissions return the cached result.

### `GET /v1/jobs/:id`

Poll job status or retrieve results.

**Response (processing):**
- `200 OK` with `{"job_id": "abc123", "status": "processing", "progress": 0.45}`.

**Response (complete):**
- `200 OK` with `{"job_id": "abc123", "status": "complete", "outputs": [{"format": "wav", "url": "/v1/jobs/abc123/output/mix.wav"}, ...]}`.
- If `analyze_only`: includes `analysis` object (see below).

**Response (failed):**
- `200 OK` with `{"job_id": "abc123", "status": "failed", "error": "..."}`.

### `GET /v1/jobs/:id/output/:filename`

Download a rendered output file. Supports `Range` headers for resumable downloads. Returns `Content-Length`.

### `GET /v1/health`

Health check. Returns `200 OK` with `{"status": "ok", "queue_depth": 3, "active_jobs": 1}`.

### `GET /v1/plugins`

List available plugins. Returns `[{"name", "uri", "type", "category", "parameters": [...]}]`.

### Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Invalid job spec (schema, bad paths, unknown plugins) |
| `401` | Missing/invalid authentication |
| `413` | Job spec too large (max tracks, max regions, max file size) |
| `429` | Queue full, try later |
| `500` | Internal error |
| `501` | Unimplemented feature (e.g., time-stretch before RubberBand integration) |
| `504` | Job timed out |

### Analysis Response

```json
{
  "analysis": {
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
        "name": "Bass Loop",
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

## Security

### Input Sanitization
- **File path allowlist**: All `file` paths are relative to a configured `LIBRARY_BASE_DIR`. The service resolves and validates that the final absolute path is within the base directory. No `..` traversal, no absolute paths, no symlink escapes.
- **Lua injection prevention**: All client-supplied strings (track names, file paths, preset names) are escaped before interpolation into Lua scripts. Characters `\`, `"`, `'`, `\n`, `\0` are escaped. Alternatively, pass values via a JSON sidecar file that the Lua script reads, avoiding string interpolation entirely.
- **Job size limits**: Configurable maximums for tracks (default 64), regions per track (default 128), plugins per track (default 16), total job spec size (default 1MB).
- **Subprocess resource limits**: arlua spawned with `ulimit` memory cap and CPU time limit. On Linux, use cgroups. On macOS, use `ulimit -v`.

### Authentication
- API key authentication via `Authorization: Bearer <key>` header.
- Keys managed via environment variables or a config file (no database needed for single-dev).

### Path Handling
- The `analyze_only` response returns relative output paths, not absolute filesystem paths.

## Execution Flow

1. API receives `POST /v1/jobs`, assigns `job_id`, validates spec, returns `202`.
2. Job enters the worker queue (bounded, configurable depth, rejects with `429` when full).
3. Worker picks up job:
   a. Creates temp directory `/data/ardour-jobs/<job-id>/`.
   b. Generates Lua script from spec with all strings sanitized.
   c. Spawns `arlua` with the script, with resource limits.
   d. arlua executes: backend setup, session creation, tracks, regions, plugins, automation, mixer, export.
   e. On success: output files are moved to a retrieval directory.
   f. On failure: error captured from stderr, status set to `failed`.
4. Cleanup: temp session directory deleted. Output files retained for a configurable TTL (default 1 hour), then reaped by a background timer.
5. Client polls `GET /v1/jobs/:id` for status and downloads output files.

### Lua Script Generation

| Job Spec | Lua API |
|----------|---------|
| `session.tempo[]` | `Temporal.TempoMap.write_copy()` / `tm:set_tempo()` / `tm:set_ramped()` |
| `session.time_signature[]` | `tm:set_meter(Temporal.Meter(num, denom), position)` |
| `tracks[].type == "audio"` | `Session:new_audio_track(channels, channels, ...)` |
| `tracks[].type == "midi"` | `Session:new_midi_track(...)` |
| `tracks[].channels` | First two args to `new_audio_track()` |
| `tracks[].regions[].file` (audio) | `ARDOUR.LuaAPI.import_audio_file()` |
| `tracks[].regions[].file` (midi) | `ARDOUR.LuaAPI.import_audio_file()` (handles MIDI) |
| `tracks[].regions[].notes` (inline) | Create `SMFSource`, write notes via MIDI model API |
| `tracks[].regions[].start_offset_ms` | `region:set_start(timepos_from_ms)` |
| `tracks[].regions[].position_bar` | `playlist:add_region(region, timepos_from_bar)` |
| `tracks[].regions[].loop_count` | Place N copies via `playlist:add_region()` at sequential positions |
| `tracks[].regions[].pitch_shift/stretch` | `ARDOUR.LuaAPI.Rubberband` (binding exists, needs integration) |
| `tracks[].regions[].fade_in/out` | `AudioRegion:set_fade_in_length()` / `set_fade_out_length()` |
| `tracks[].regions[].gain_db` | `AudioRegion:set_scale_amplitude(10^(db/20))` |
| `tracks[].plugins[]` | `ARDOUR.LuaAPI.new_plugin()` / `route:add_processor_by_index()` |
| `tracks[].plugins[].params` | `ARDOUR.LuaAPI.set_processor_param()` |
| `tracks[].plugins[].preset` | `plugin:preset_by_label()` / `plugin:load_preset()` |
| `tracks[].plugins[].sidechain_source` | Create sidechain via `PluginInsert:add_sidechain()`, route from source |
| `tracks[].instrument.files` | `ARDOUR.LuaAPI.set_plugin_insert_property()` |
| `tracks[].instrument.bank/program` | MIDI bank/program change events written to region |
| `tracks[].automation[]` | `route:gain_control():alist():add(time, value)` / `plugin_automation()` |
| `tracks[].gain_db` | `route:gain_control():set_value()` |
| `tracks[].pan` | `route:pan_azimuth_control():set_value()` |
| `tracks[].mute/solo` | `route:mute_control()` / `route:solo_control()` |
| `tracks[].phase_invert` | `route:phase_control():set_value()` |
| `tracks[].sends[]` | `Session:add_internal_sends()` / `route:send_level_controllable()` |
| `buses[]` (aux) | `Session:new_audio_route(..., AudioBus)` |
| `buses[]` (group) | `Session:new_audio_route()` + reroute source tracks to bus |
| `vcas[]` | `Session:vca_manager():create_vca()` / assign controls |
| `markers[]` | `Session:locations():add(Location(...))` |
| `master.*` | `Session:master_out()` + same plugin/gain API |
| `output.include_click` | Enable metronome on master before export |
| Export | See Export Strategy below |

### Export Strategy

The export path is the critical blocker. Resolution plan:

1. **Fix `SimpleExport` preset initialization** — Debug the segfault in `set_preset()`. The preset UUID may need to be read from the export format files in `share/export/`. This is the most likely fix.
2. **Bind `ExportHandler` to Lua** — Add Lua bindings for `Session::get_export_handler()`, `ExportHandler::add_timespan()`, etc., following the pattern in `session_utils/export.cc`. This gives full control over export configuration.
3. **C++ export helper in luasession** — Add an `export_session(path, format, bit_depth, sample_rate)` function directly to the luasession binary, bypassing Lua entirely for the export step.

For stem export: iterate over tracks, solo each one, export, unsolo. Or use Ardour's stem export if we can get `ExportHandler` bound.

## Technology Stack

- **API Service**: Node.js with Fastify (fast, schema validation built in, good async).
- **Job queue**: In-process bounded queue with configurable max depth. Reject with `429` when full. Scale to Redis/BullMQ when needed.
- **arlua**: Existing binary, spawned per job with resource limits.
- **Temp sessions**: Created in `/data/ardour-jobs/<job-id>/`, cleaned up after TTL.
- **Container**: Docker image with Ardour + arlua + LV2 plugins + soundfonts. Reproducible builds, resource isolation via cgroup limits.
- **Instance sizing**: Minimum 4 CPU cores, 8GB RAM per worker. Ardour with plugins is CPU-intensive. Scale with more workers, not bigger instances.

## Observability

- **Structured logging**: JSON logs to stdout (12-factor). Fields: `job_id`, `request_id`, `phase` (validate, generate, execute, export), `duration_ms`, `error`.
- **Metrics**: Prometheus endpoint at `/metrics`. Key metrics: `job_duration_seconds`, `job_queue_depth`, `job_status_total{status=complete|failed|timeout}`, `arlua_memory_bytes`, `active_workers`.
- **Request correlation**: `X-Request-Id` header propagated through logs and into the generated Lua script (printed on errors for tracing).

## Error Handling

- **Bad file path**: Caught during validation. Returns 400.
- **Unknown plugin URI**: Caught during validation (query available plugins at startup). Returns 400.
- **arlua crash**: Subprocess exit code != 0. Job status set to `failed` with stderr output. No retry.
- **Export failure**: No output file produced. Status set to `failed`.
- **Timeout**: Configurable per-job (default 120s). Worker sends SIGTERM, waits 5s, then SIGKILL. Status set to `failed` with reason `"timeout"`.
- **Plugin parameter out of range**: Caught at arlua runtime. Status set to `failed` with parameter details.
- **Jobs are safe to retry**: The service is stateless; resubmitting the same spec produces the same result. Use `X-Idempotency-Key` to avoid duplicate work.

## C++ Work Required

Before the API service can ship, these Ardour/arlua changes are needed:

1. **Fix export** (BLOCKER): Either fix `SimpleExport` preset init, bind `ExportHandler` to Lua, or add a C++ export helper to luasession.
2. **RubberBand integration**: The Lua binding exists (`ARDOUR::LuaAPI::Rubberband`) but needs integration testing in the headless context and a clean wrapper for the generated Lua scripts.
3. **MIDI import validation**: Verify `import_audio_file` handles MIDI files correctly.
4. **Inline MIDI region creation**: Add Lua bindings for creating MIDI regions from note data (write to `SMFSource` or `MidiModel`).
5. **Sidechain routing**: Verify `PluginInsert::add_sidechain()` is Lua-accessible.
6. **Analysis/metering**: Validate `PeakMeter` and Vamp analysis work headlessly. Add LUFS metering if not available via existing Vamp plugins.

## File Structure

```
ardour/
  api-service/
    Dockerfile
    package.json
    src/
      server.js              # Fastify HTTP server, middleware, auth
      routes/
        jobs.js              # POST/GET /v1/jobs
        health.js            # GET /v1/health
        plugins.js           # GET /v1/plugins
      lib/
        validator.js         # JSON Schema validation + security checks
        lua-generator.js     # JSON -> sanitized Lua script
        executor.js          # Worker pool, spawns arlua, manages sessions
        analyzer.js          # Parse analysis data from arlua output
        sanitizer.js         # Lua string escaping, path validation
      schemas/
        job-spec.json        # JSON Schema for job validation
      workers/
        job-worker.js        # Individual job execution logic
```
