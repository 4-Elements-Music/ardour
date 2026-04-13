# Ardour API Service

Fastify HTTP service that manages headless Ardour sessions for AI agents. One process per session; each session exposes an MCP HTTP control surface that the Node.js layer proxies.

## audio_region_add tool

Places an uploaded audio file as a region on a track with atomic rollback on failure. Full spec: `docs/superpowers/specs/2026-04-12-audio-region-add-design.md`.

### Two-step flow

1. **Upload** the file:
   ```
   POST /v1/sessions/:id/upload
   Content-Type: multipart/form-data
   ```
   Response: `{ upload_id, filename, bytes, path }`. Clients should use `upload_id` (opaque) — never the path.

2. **Call the tool**:
   ```
   POST /v1/sessions/:id/actions
   Content-Type: application/json

   { "tool": "audio_region_add", "params": {
       "trackId": "route:...",
       "uploadId": "upl_abc123...",
       "position": { "unit": "bars+beats", "value": { "bar": 2, "beat": 1 } },
       "sourceOffsetSamples": 0,
       "timelineLength": { "unit": "samples", "value": 48000 },
       "fadeInSamples": 64,
       "fadeOutSamples": 64,
       "gainDb": 0,
       "onOverlap": "error",
       "edgeCrossfade": "auto",
       "snap": "beat",
       "repeat": { "count": 4, "strideBeats": 1 },
       "channelMismatch": "auto-track",
       "allowTrackCreation": true,
       "dryRun": false,
       "requestId": "req_..."
   } }
   ```

### Server-side pipeline

1. Route strips any client-supplied `decodedPath` (server-injected only).
2. Upload resolver checks idempotency via `RequestCache` (keyed `<sessionId>:<requestId>`).
3. `decodeOnce(sessionId, uploadId, …)` runs the sandboxed `audio-validator` sidecar to produce a canonical WAV at `<sessionDir>/decoded/<uploadId>.wav`. The in-flight dedupe prevents two parallel first-decodes.
4. The C++ MCP handler validates the resolved path against `<sessionDir>/decoded/` prefix with a trailing-slash boundary check, resolves the track, parses all params, autosaves the session, imports the file via `Session::import_files`, creates the region with the requested properties (fades/gain/polarity/reverse), handles channel mismatch (error / truncate / auto-track), detects + resolves overlaps, creates edge crossfades for near-abutting neighbors, commits in a single reversible command, and repeats N-1 copies at beat strides.
5. Atomic rollback: imported sources, auto-created tracks, and `RegionFactory`-registered regions all register cleanup closures; any post-mutation failure reverses them in reverse order before returning.
6. A file-scope `std::mutex` serializes concurrent calls on the same session.

### Error codes

`MISSING_UPLOAD`, `UPLOAD_NOT_AUDIO`, `UNSUPPORTED_FORMAT`, `DECODE_FAILED`, `PATH_OUTSIDE_SESSION`, `ROUTE_NOT_FOUND`, `NOT_AUDIO_TRACK`, `CHANNEL_MISMATCH`, `INSUFFICIENT_SOURCE`, `INVALID_POSITION`, `POSITION_BEFORE_ZERO`, `OVERLAP_REFUSED`, `QUOTA_EXCEEDED`, `IMPORT_FAILED`, `REGION_CREATE_FAILED`, `INVALID_PARAMS`, `REVERSE_NOT_SUPPORTED`, `UNREADABLE_FILE`, `VALIDATOR_MISSING`.

### Known limitations (v1)

- No time-stretch / pitch-shift; tracked as **F2** (`audio_region_stretch` follow-up, Rubber Band).
- `reverse: true` rejected — Ardour has no non-destructive reverse API at the region level.
- `timelineLength` with unit `beats` / `bars+beats` not yet supported; use `samples` or `seconds`.
- `dryRun` does not project overlap/edge-crossfade outcomes (emits empty arrays).
- macOS sandbox hardening for the decoder sidecar is deferred (process isolation alone handles the primary crash-containment threat). See **F6**, **F7** in `docs/superpowers/TODO.md`.
