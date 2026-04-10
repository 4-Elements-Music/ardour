# Headless DAW API Service — Design Spec

## Overview

A stateless HTTP API service that accepts fully-specified mix jobs as JSON, executes them via Ardour's headless engine, and returns rendered audio. The service is a faithful executor — all creative/mixing decisions are made by the client.

## Architecture

```
Client (AI orchestration)
    |
    | POST /jobs  (JSON job spec)
    v
API Service (Node.js or Python)
    |
    | Translates JSON -> Lua script
    v
arlua (Ardour headless Lua engine)
    |
    | Reads from local file library
    | Renders via Ardour engine
    v
Rendered WAV/FLAC
    |
    | Response (file download or path)
    v
Client
```

### Components

1. **API Service** — HTTP server. Validates job specs, generates Lua scripts, spawns arlua, manages temp sessions, returns results.
2. **Lua Script Generator** — Translates the declarative JSON job spec into an imperative Lua script that drives Ardour.
3. **arlua (luasession)** — Ardour's headless Lua engine. Executes the generated script. Already built and validated.
4. **Local File Library** — All stems, samples, MIDI files, and virtual instrument presets live on the same machine. Referenced by absolute path in job specs.

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
    "duration_bars": 32
  },
  "tracks": [
    {
      "name": "Bass Loop",
      "type": "audio",
      "regions": [
        {
          "file": "/library/stems/funky-bass.wav",
          "position_bar": 1,
          "position_beat": 1,
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
          "params": {
            "0": -18.0,
            "1": 4.0
          }
        }
      ],
      "sends": [
        {"bus": "FX Reverb", "gain_db": -12.0}
      ],
      "gain_db": -3.0,
      "pan": 0.3,
      "mute": false
    },
    {
      "name": "Synth Pad",
      "type": "midi",
      "regions": [
        {
          "file": "/library/midi/pad-Cmaj.mid",
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
          "file": "/library/midi/strings-arrangement.mid",
          "position_bar": 1
        }
      ],
      "instrument": {
        "uri": "urn:ardour:a-fluidsynth",
        "files": ["/library/soundfonts/orchestral-strings.sf2"],
        "preset": null,
        "params": {}
      },
      "gain_db": -8.0,
      "pan": 0.5
    }
  ],
  "buses": [
    {
      "name": "FX Reverb",
      "type": "aux",
      "plugins": [
        {
          "uri": "urn:ardour:a-reverb",
          "params": {"0": 0.6, "1": 0.4}
        }
      ]
    }
  ],
  "master": {
    "gain_db": 0.0,
    "plugins": [
      {
        "uri": "urn:ardour:a-eq#stereo",
        "params": {"0": 80.0, "1": 2.0}
      }
    ]
  },
  "output": {
    "format": "wav",
    "bit_depth": 24,
    "sample_rate": 48000
  },
  "analyze_only": false
}
```

### Field Reference

**session**: Global session parameters.
- `tempo`: Array of tempo points. Each has `bar` (1-indexed bar number), `bpm` (float), and optional `ramp` (boolean — if true, tempo ramps smoothly from previous tempo to this one; if false or omitted, tempo changes instantly). At minimum one entry at bar 1 is required.
- `time_signature`: Array of time signature changes. Each has `bar` (1-indexed), `numerator`, `denominator`. At minimum one entry at bar 1 is required.
- `duration_bars`: How many bars to render.
- `sample_rate`: Session sample rate in Hz.

**tracks[]**: Ordered list of tracks to create.
- `type`: `"audio"` or `"midi"`.
- `regions[]`: Audio/MIDI files to place on the track.
  - `file`: Absolute path to audio or MIDI file on the local filesystem.
  - `position_bar` / `position_beat`: Where to place the region (1-indexed).
  - `length_bars`: Trim region to this length (optional; defaults to full file length).
  - `loop_count`: Repeat the region N times end-to-end (optional; default 1).
  - `pitch_shift_semitones`: Pitch shift in semitones (optional; default 0). Requires time-stretch gap (#8) to be closed.
  - `time_stretch_ratio`: Time stretch ratio (optional; 1.0 = no change). Same dependency.
  - `fade_in_ms` / `fade_out_ms`: Fade durations in milliseconds (optional).
  - `gain_db`: Per-region gain adjustment (optional).
- `plugins[]`: Insert effects chain, top to bottom.
  - `uri`: LV2 plugin URI.
  - `preset`: Plugin preset name to load (optional).
  - `params`: Map of parameter index (string) to value (float).
- `instrument`: For MIDI tracks, the virtual instrument plugin.
  - `uri`: LV2 plugin URI for the instrument.
  - `files`: Array of file paths to load into the instrument (SF2 soundfonts, SFZ patches, WAV sample sets, etc.). These are set via the instrument's file-loading property (e.g., FluidSynth's soundfont path, or a sampler's sample directory).
  - `preset`: Instrument preset name to load after files (optional).
  - `params`: Parameter overrides (same format as plugins).
- `sends[]`: Aux sends to buses.
  - `bus`: Name of the target bus (must match a bus in `buses[]`).
  - `gain_db`: Send level.
- `gain_db`: Track fader level in dB.
- `pan`: Stereo pan position (0.0 = hard left, 0.5 = center, 1.0 = hard right).
- `mute`: Mute the track (optional; default false).

**buses[]**: FX return / aux buses.
- `type`: `"aux"` (aux bus).
- `plugins[]`: Same format as track plugins.

**master**: Master bus settings.
- `gain_db`: Master fader level.
- `plugins[]`: Master bus insert chain.

**output**: Render settings.
- `format`: `"wav"` or `"flac"`.
- `bit_depth`: 16, 24, or 32.
- `sample_rate`: Output sample rate (may differ from session rate; SRC applied).

**analyze_only**: If `true`, render internally but return analysis data instead of (or alongside) the audio file. Analysis data includes per-track peak/RMS levels, master bus frequency spectrum, and loudness (LUFS). This supports the round-trip mixing workflow where the client makes mix decisions based on analysis.

## API Endpoints

### `POST /jobs`

Submit a mix job. Returns the rendered audio file or analysis data.

**Request:** JSON body (the job spec above).

**Response (success):**
- `200 OK` with `Content-Type: audio/wav` (or `audio/flac`) — the rendered file.
- If `analyze_only: true`: `200 OK` with `Content-Type: application/json` containing analysis data.

**Response (error):**
- `400 Bad Request` — Invalid job spec (missing fields, bad file paths, unknown plugin URIs).
- `500 Internal Server Error` — Ardour/arlua crashed or export failed.

**Response body (analyze_only):**
```json
{
  "analysis": {
    "duration_seconds": 64.0,
    "master": {
      "peak_db": -0.3,
      "rms_db": -14.2,
      "lufs": -16.1
    },
    "tracks": [
      {
        "name": "Bass Loop",
        "peak_db": -3.1,
        "rms_db": -18.4
      }
    ]
  },
  "output_file": "/tmp/sessions/abc123/export/output.wav"
}
```

### `GET /health`

Health check. Returns `200 OK` with `{"status": "ok"}`.

### `GET /plugins`

List available LV2/VST plugins. Returns JSON array of `{"name", "uri", "type", "category"}`.

### `GET /library/search?tags=funky,bass&duration_min=30`

Search the local file library by tags/metadata. This endpoint is optional and depends on how the library is indexed. Could be a simple filesystem glob or backed by a metadata database.

## Execution Flow

1. API service receives `POST /jobs`.
2. Validates the job spec (schema check, file existence, plugin URI validity).
3. Generates a Lua script from the spec (string templating).
4. Creates a temp directory for the session.
5. Spawns `arlua` with the generated script as a subprocess.
6. arlua: sets up Dummy audio backend, creates session, creates tracks/buses, imports files, places regions, instantiates plugins, sets parameters, configures mixer, exports.
7. On success: API reads the exported file and returns it.
8. Cleans up the temp session directory.

### Lua Script Generation

The JSON-to-Lua translator is a straightforward template engine. Each section of the job spec maps to Lua API calls we've already validated:

| Job Spec | Lua API |
|----------|---------|
| `session.tempo[]` | `Temporal.TempoMap.write_copy()` / `tm:set_tempo()` at each bar position. Supports ramped tempos via `Temporal.Tempo(bpm_start, bpm_end, note_type)`. |
| `session.time_signature[]` | `tm:set_meter(Temporal.Meter(num, denom), position)` at each bar position. |
| `tracks[].type == "audio"` | `Session:new_audio_track()` |
| `tracks[].type == "midi"` | `Session:new_midi_track()` |
| `tracks[].regions[].file` | `ARDOUR.LuaAPI.import_audio_file()` |
| `tracks[].regions[].position_bar` | `playlist:add_region(region, Temporal.timepos_t.from_ticks(...))` |
| `tracks[].plugins[]` | `ARDOUR.LuaAPI.new_plugin()` / `route:add_processor_by_index()` |
| `tracks[].plugins[].params` | `ARDOUR.LuaAPI.set_processor_param()` |
| `tracks[].gain_db` | `route:gain_control():set_value()` |
| `tracks[].pan` | `route:pan_azimuth_control():set_value()` |
| `tracks[].sends[]` | `Session:add_internal_sends()` / `route:send_level_controllable()` |
| `buses[]` | `Session:new_audio_route()` |
| `tracks[].instrument.files` | `ARDOUR.LuaAPI.set_plugin_insert_property()` to set file path properties (e.g., FluidSynth soundfont URI) |
| `master.plugins[]` | Same plugin API on `Session:master_out()` |
| Export | Needs resolution (CLI tool or fixed SimpleExport) |

### Export Strategy

The `simple_export` Lua API and `ardour9-export` CLI both had issues during testing. The API service will resolve this by:

1. First priority: fix the `SimpleExport` Lua API preset initialization (likely a missing preset UUID lookup).
2. Fallback: use the export handler directly in the generated Lua script, following the pattern in `session_utils/export.cc`.
3. Last resort: write a small C++ helper linked into luasession that handles export reliably.

## Technology Stack

- **API Service**: Node.js (Express or Fastify). Simple, single-dev friendly, good subprocess handling.
- **Job queue**: In-process for now (no Redis/RabbitMQ). Jobs are synchronous — one at a time. Scale later with a proper queue.
- **arlua**: Existing binary, spawned per job.
- **Temp sessions**: Created in `/tmp/ardour-jobs/<job-id>/`, cleaned up after response.

## Error Handling

- **Bad file path**: Caught during validation before spawning arlua. Returns 400.
- **Unknown plugin URI**: Caught during validation (query available plugins). Returns 400.
- **arlua crash**: Subprocess exit code != 0. API returns 500 with stderr output.
- **Export failure**: No output file produced. API returns 500.
- **Timeout**: Jobs have a configurable timeout (default 120s). Killed if exceeded. Returns 504.

## Known Gaps

1. **Time-stretch / pitch-shift (#8)**: Not yet available in headless Lua. `pitch_shift_semitones` and `time_stretch_ratio` fields will return 501 until the RubberBand binding is added. This is planned as step #2.
2. **Export reliability**: Needs debugging. SimpleExport segfaults on preset init; CLI tool exits on Dummy backend. Will be resolved during implementation.
3. **MIDI region creation**: Importing MIDI files via `import_audio_file` should work (it checks for MIDI file extension), but not yet tested. Will validate during implementation.
4. **Looping**: Ardour regions support looping natively but the Lua API for setting loop count on a region needs verification.
5. **Analysis mode**: Ardour has Vamp analysis plugins and loudness metering, but exposing this data via Lua needs investigation.

## File Structure

```
ardour/
  api-service/
    package.json
    src/
      server.js          # Express/Fastify HTTP server
      routes/
        jobs.js          # POST /jobs handler
        health.js        # GET /health
        plugins.js       # GET /plugins
      lib/
        validator.js     # Job spec schema validation
        lua-generator.js # JSON -> Lua script translator
        executor.js      # Spawns arlua, manages temp sessions
        analyzer.js      # Parse analysis data from Lua output
      schemas/
        job-spec.json    # JSON Schema for job validation
```

## Future Considerations

- **Concurrency**: Multiple arlua instances can run in parallel (separate sessions). Add a worker pool when needed.
- **Caching**: If the same job spec is submitted twice, return cached output.
- **Streaming**: For long renders, stream progress updates via SSE or WebSocket.
- **Auto-mixing**: Server-side analysis and automatic mix decisions. This would add a "smart" mode where the service makes gain/EQ/compression decisions based on frequency analysis. Deferred — keeping the service as a dumb executor for now.
- **Plugin preset library**: A curated set of presets for common use cases (vocal chain, drum bus, mastering) referenced by name rather than raw parameter values.
