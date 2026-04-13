# Audio Region Add — Design Spec

**Date:** 2026-04-12
**Author:** session-manager team
**Status:** Approved (post-review)

## Goal

Let API clients (AI agents or GUI tools) place an audio file as a region on an audio track at a specific time/bar position, with robust handling of channel mismatch, fades, overlaps/edge-crossfades, snapping, repetition, and atomic rollback on failure. Time-stretch/pitch-shift are carved out to a v2 follow-up tool.

## Architecture

Three-layer flow:

1. **Node.js upload endpoint** (existing `/v1/sessions/:id/upload`) — client POSTs file, receives `uploadId`. Disk quota enforced here. Files live in `<sessionDir>/uploads/<uploadId>/<basename>`.
2. **Sandboxed decoder sidecar** (new) — before Ardour touches a file, a subprocess (seccomp/landlock on Linux, sandbox-exec on macOS, AppArmor fallback) validates the audio header and transcodes to a canonical WAV in `<sessionDir>/decoded/<uploadId>.wav`. If decode fails, the file never reaches Ardour — protecting the session from libsndfile/libvorbis crashes.
3. **MCP tool `audio_region_add`** (new, C++ in `libs/surfaces/mcp_http/`) — resolves `uploadId` → decoded WAV path, validates against an allowlist of session-owned paths, invokes `Session::import_files` under the butler/RT coordination, creates the `AudioRegion` with `sourceOffsetSamples` + `timelineLengthSamples`, applies fades/gain/reverse/polarity, handles channel mismatch + overlap + edge-crossfade, snaps to grid, and paste-repeats. All wrapped in an atomic commit that rolls back on failure. Per-session mutex serializes concurrent calls.

## API Contract

### Inputs

```jsonc
{
  "trackId": "track:abc123",                    // required (naming: "trackId" across all tools going forward)
  "uploadId": "upl_9f3a...",                    // required; returned by /v1/sessions/:id/upload
  "name": "kick.wav",                           // optional; defaults to uploadId's basename

  // Position (tagged union — NOT oneOf schema)
  "position": { "unit": "samples", "value": 48000 },
  // unit: "samples" | "seconds" | "beats" | "bars+beats"
  // for "bars+beats" value is an object: { "bar": 5, "beat": 2.5 }

  // Region bounds (both optional — defaults: offset=0, length=rest-of-source)
  "sourceOffsetSamples": 0,                     // pre-stretch (indexes the source file)
  "timelineLength": { "unit": "samples", "value": 96000 },  // optional; tagged union as above

  // Session integration
  "copyToSession": true,                        // default true
  "channelMismatch": "error",                   // "error" | "truncate" | "auto-track" (see allowTrackCreation)
  "allowTrackCreation": false,                  // default false; must be true for "auto-track" to take effect
  "sampleRateConversion": "auto",               // "auto" | "strict" | "none"
  "srcQuality": "best",                         // "best" | "medium" | "fast" (libsamplerate)

  // Region properties (set at insert time; avoids round-trips)
  "fadeInSamples": 64,
  "fadeOutSamples": 64,
  "gainDb": 0.0,
  "polarityInvert": false,
  "reverse": false,

  // Placement semantics
  "snap": "none",                               // "none" | "bar" | "beat" | "grid"
  "onOverlap": "error",                         // "error" | "trim-existing" | "crossfade" | "layer"
  "overlapCrossfadeMs": 10,                     // used when onOverlap == "crossfade"
  "edgeCrossfade": "auto",                      // "auto" | "none"; if auto and new region touches an existing region within edgeTolerance, create a crossfade
  "edgeToleranceMs": 10,
  "edgeCrossfadeMs": 10,

  // Paste multiple copies
  "repeat": { "count": 1, "strideBeats": 0 },   // default count=1 (single insert)

  // BWF/iXML
  "preserveOriginalTimestamp": false,           // if true, position is overridden by the file's embedded timestamp when present

  // Atomicity & observability
  "dryRun": false,                              // if true, perform all validation + planning, return projected result, do not persist
  "requestId": "req_abc"                        // optional; idempotent retry key (same requestId within 10min returns cached result)
}
```

### Output (success)

```jsonc
{
  "ok": true,
  "regionId": "region:...",
  "trackId": "track:...",                       // effective track (may differ if auto-track fired)
  "trackCreated": false,
  "originalTrackId": "track:abc123",            // the trackId the caller passed in
  "newTrackId": null,
  "newTrackName": null,

  "startSample": 48000,
  "timelineLengthSamples": 96000,
  "sourceId": "source:...",
  "sourceChannels": 2,
  "sourceSampleRate": 44100,
  "sourceLengthSamples": 441000,

  "sampleRateConverted": true,
  "fileCopied": true,
  "sessionFilePath": "/.../interchange/.../kick-001.wav",

  "fadeInSamples": 64, "fadeOutSamples": 64,
  "gainDb": 0.0, "polarityInvert": false, "reverse": false,

  "edgeCrossfadesCreated": [
    { "side": "start", "neighborRegionId": "region:...", "lengthSamples": 441 }
  ],
  "overlapAction": "none",                      // "none" | "trimmed-existing" | "crossfaded" | "layered"
  "overlappingRegionsAffected": [],

  "repeatedRegionIds": [ "region:...", "region:..." ]
}
```

### Output (failure)

```jsonc
{
  "ok": false,
  "failedAt": "stretch" | "import" | "validation" | "channel-mismatch" | "overlap" | "region-create" | "persist",
  "error": { "code": "INSUFFICIENT_SOURCE", "message": "…" },
  "persisted": {                                // describes what WAS written before rollback (so caller can reason about state)
    "fileCopied": false,
    "sessionFilePath": null,
    "trackCreated": false,
    "regionsCreated": []
  }
}
```

### Error codes

Codes actually emitted by the v1 implementation (reconciled post-implementation):

- `MISSING_UPLOAD` — `uploadId` not provided or unknown on this session.
- `DECODE_FAILED` — audio-validator sidecar rejected or timed out.
- `VALIDATOR_MISSING` — validator binary not configured (server-ops error).
- `UNREADABLE_FILE` — `realpath()` failed, or libsndfile couldn't open the decoded file during `dryRun` metadata peek.
- `PATH_OUTSIDE_SESSION` — resolved `decodedPath` falls outside `<sessionDir>/decoded/`.
- `ROUTE_NOT_FOUND` — `trackId` did not resolve to any route.
- `NOT_AUDIO_TRACK` — route is not an audio track.
- `CHANNEL_MISMATCH` — file channels ≠ track channels under `channelMismatch=error`, or under `auto-track` with `allowTrackCreation=false`.
- `INVALID_POSITION` — tagged-union `position` or `timelineLength` invalid.
- `POSITION_BEFORE_ZERO` — negative numeric position/length value.
- `INSUFFICIENT_SOURCE` — `sourceOffsetSamples + timelineLength > sourceLengthSamples`.
- `OVERLAP_REFUSED` — `onOverlap=error` and the new region intersects existing regions.
- `IMPORT_FAILED` — `Session::import_files` cancelled or returned no sources, or imported source wasn't audio.
- `REGION_CREATE_FAILED` — `RegionFactory::create` returned null, `new_audio_track` returned empty, or `effective_track` has no playlist.
- `REVERSE_NOT_SUPPORTED` — `reverse=true` requested; Ardour has no non-destructive region-level reverse API.
- `INVALID_PARAMS` — param-level sanity failure (negative fades, `gainDb` non-finite or outside ±60dB, bad enum on `onOverlap`/`edgeCrossfade`/`snap`/`channelMismatch`, `repeat.count` outside [1,100], negative stride, negative `overlapCrossfadeMs`/`edgeToleranceMs`/`edgeCrossfadeMs`).

**Upload-layer errors** (returned by `POST /v1/sessions/:id/upload`, not the tool call):
- `FILE_TOO_LARGE` — per-file byte limit exceeded.
- `SESSION_UPLOAD_QUOTA` — per-session byte quota exhausted.
- `INVALID_FILENAME` / `INVALID_FILE_TYPE` / `FILE_EXISTS` — filename sanitization, extension allowlist, collision.

**Deprecated in v1** (not emitted by any code path): `UPLOAD_NOT_AUDIO`, `UNSUPPORTED_FORMAT`, `QUOTA_EXCEEDED`, `INTERNAL_ERROR`.

## Security & Robustness Requirements

1. **No free-form `filePath`.** Only `uploadId` is accepted. Resolver uses `realpath()` and asserts the resolved path has prefix `<sessionDir>/decoded/`. Opens with `O_NOFOLLOW` on the final component.
2. **Sandboxed decode.** A separate sidecar process (`tools/audio-validator`) reads the upload, verifies header, decodes to canonical 32-bit-float interleaved WAV at the source sample rate. Runs under `sandbox-exec -p '(version 1)(deny default)(allow file-read* (subpath "<uploads>"))(allow file-write* (subpath "<decoded>"))'` on macOS. RLIMIT_AS=512MB, RLIMIT_CPU=30s, RLIMIT_FSIZE=4GB. If exit code != 0 → `DECODE_FAILED`.
3. **Autosave before import.** The handler triggers `Session::save_state("audio-region-add autosave")` right before `import_files`. If the process crashes during import, the session recovers to pre-call state.
4. **Per-session mutex.** A `std::mutex` on the session guards the whole `audio_region_add` handler. Concurrent calls queue; no parallelism.
5. **Atomic rollback.** Snapshot before mutation: list of `<sessionDir>/interchange/**/*`, list of track IDs. On any post-validation failure: delete new interchange files, destroy new tracks, undo region insertion via `Session::undo(1)` (one grouped undo transaction scoped to this operation).
6. **Disk quota.** Checked in Node.js upload endpoint AND before stretch/copy in the C++ handler. Default 2GB per session. Configurable via `config.sessionDiskQuotaBytes`. Rejects with `QUOTA_EXCEEDED` when `statvfs` headroom < 2× requested copy size.
7. **Event-loop hygiene.** In v1 the work is short (no stretch), but `import_files` can still be slow on large files. The handler dispatches `import_files` on the butler thread (where it already runs); only the final `RegionFactory::create` + `playlist->add_region` hops to the session event loop. The JSON-RPC call blocks until completion but with a 60s wall-clock cap; longer imports return `IMPORT_FAILED` with `message="timeout"` and rollback fires.
8. **Idempotent retry.** `requestId`-keyed result cache (LRU, 10 min TTL, 256 entries). Same `requestId` returning within TTL = replays the cached response without side-effects.

## DSP Semantics (v1 — no stretch)

- `sourceOffsetSamples` indexes the source file in source-frames (pre-stretch; stretch is v2).
- `timelineLengthSamples` is the region length on the timeline; in v1 with no stretch, source-length == timeline-length.
- If `timelineLengthSamples` is omitted, defaults to `sourceLengthSamples - sourceOffsetSamples`.
- If requested length exceeds available material → `INSUFFICIENT_SOURCE` (no loop-fill in v1).
- SRC: `"auto"` resamples to session SR if mismatch; `"strict"` errors on mismatch (`UNSUPPORTED_FORMAT`); `"none"` inserts at source SR (plays at wrong speed — callers who want this know why).

## Channel Mismatch (auto-track)

When `channelMismatch="auto-track"` AND `allowTrackCreation=true`:
- Create a new audio track `<originalTrackName>-<N>ch` (e.g. `Vocal-5ch`) with `inputChannels=outputChannels=file.channels`, inserted after the original track.
- Place the region on the new track.
- Return `trackCreated: true, newTrackId, newTrackName`.
- If creation fails (route name collision, out-of-memory) → rollback, `REGION_CREATE_FAILED`.

## Overlap + Edge-Crossfade Logic

Given the target playlist on the chosen track, at position P with length L:

1. **Overlap** (existing region R' where `R'.start < P+L AND R'.end > P`):
   - `error`: `OVERLAP_REFUSED`.
   - `trim-existing`: for each overlapping R', shorten R' so it no longer overlaps (trim to `P` if R' starts before new region; trim to `P+L` if R' ends after).
   - `crossfade`: insert a crossfade of `overlapCrossfadeMs` across each overlap boundary (Ardour's `Region::set_fade_in` / crossfade object in the playlist).
   - `layer`: leave both; Ardour layers them per playlist stacking rules.

2. **Edge crossfade** (existing region R' with a boundary within `edgeToleranceMs` of the new region's edge but NOT overlapping):
   - `auto`: create a crossfade spanning `edgeCrossfadeMs` centered on the boundary (slightly overlap the two by that amount by shortening one edge).
   - `none`: leave edges butt-joined.

Edge-crossfade runs AFTER overlap resolution. Both are reported in the response (`edgeCrossfadesCreated[]`, `overlappingRegionsAffected[]`).

## Naming Convention

- Use **`trackId`** across all region/plugin tools. A follow-up task renames `plugin_add.id` → `plugin_add.trackId` (kept as a separate concern — not part of this spec but tracked in TODO).
- Position/length are always tagged unions `{unit, value}`. A follow-up retrofits `midi_region_add` to match (also tracked in TODO).

## Defaults (summary)

| Option | Default | Rationale |
|---|---|---|
| `channelMismatch` | `error` | No silent topology mutation. |
| `allowTrackCreation` | `false` | Must be explicit. |
| `sampleRateConversion` | `auto` | Common case. |
| `srcQuality` | `best` | Offline import; quality > speed. |
| `fadeInSamples` / `fadeOutSamples` | `64` | Prevent clicks (matches Ardour default). |
| `snap` | `none` | Respect caller's exact position. |
| `onOverlap` | `error` | Refuse silently destructive ops. |
| `overlapCrossfadeMs` | `10` | |
| `edgeCrossfade` | `auto` | User explicitly asked for this behavior. |
| `edgeCrossfadeMs` / `edgeToleranceMs` | `10` | |
| `copyToSession` | `true` | Portable sessions. |
| `preserveOriginalTimestamp` | `false` | |
| `dryRun` | `false` | |

## v2 Follow-up: `audio_region_stretch`

Out of scope for this spec. Separate tool takes `{ trackId, regionId, stretch: {mode,ratio,sourceBpm}, pitchShiftSemitones, preserveFormants, engine }`, runs async as a job (returns `jobId`, polled via `/v1/sessions/:id/jobs/:jobId`), and applies region-property stretch via `AudioRegion::set_stretch` where possible, destructive Rubber Band when user opts in.

## Open Follow-ups (tracked, not in v1)

- [F1] Rename `plugin_add.id` → `plugin_add.trackId`; retrofit `midi_region_add` position to tagged-union form.
- [F2] `audio_region_stretch` v2 async job tool.
- [F3] BWF/iXML parsing in decoder sidecar (v1 reads timestamp; full metadata preservation is v2).
- [F4] `allowTrackCreation` default flip after 3 months of usage data if nobody trips on it.
- [F5] `region_get_full` output convergence with this tool's response shape.
