# Audio Region Stretch — Design Spec

**Date:** 2026-04-26
**Status:** Draft
**Companion plan:** `components/ardour/docs/superpowers/plans/2026-04-26-audio-region-stretch-v1.md`
**Cross-component plan:** Director-side executor handlers will be specified in
`components/4ElementsDirector/docs/superpowers/plans/2026-04-26-rubber-band-executor.md`.

---

## Goal

Let API clients time-stretch and/or pitch-shift an existing audio
region on a Director-managed Ardour session, asynchronously, without
blocking the HTTP request thread or other concurrent tools on the
same session. This unblocks the five Director plan actions that
currently soft-fail at execution time:

- `time_stretch`
- `pitch_shift`
- `reshape_rhythm` (composes time_stretch with rhythmic
  redistribution; the redistribution piece is out of scope here)
- `reharmonize` (composes pitch_shift on individual notes; out of
  scope here)
- `pitch_correct` (composes pitch_shift toward a snap target; out of
  scope here)

The two foundational primitives, **time stretch** and **pitch shift**
on an audio region, are this spec's surface. The three composite
actions become Director-side compositions of the two primitives in a
follow-up spec.

## Why async

Audio Region Add is inline because it's bounded — `Session::import_files`
plus a region create finishes in well under a second for any file
that fits within the upload size limit. Stretches are categorically
different: Rubber Band's "Finer" engine processes audio at roughly
0.2-0.5× real time on Apple Silicon, so a 30-second region typically
takes 1-3 minutes. A 4-minute composer cue with `stretchFactor=1.2`
can take 8 minutes.

Holding an HTTP request open for 8 minutes is operationally fragile
(client-side timeouts, proxy timeouts, retry storms on transient
failures, no progress visibility). The existing `JobQueue` +
`/v1/jobs/:id/status` infrastructure already serves the
plugin-indexer and Lua-eval long-running tasks; reusing it gives us
progress reporting and cancellation for free.

## Architecture

Same three-layer flow as `audio_region_add`, plus the job machinery:

1. **Node.js route** (`POST /v1/sessions/:id/actions` with
   `tool: "audio_region_stretch"`). Validates the request shape,
   enqueues a job in the existing `JobQueue`, returns
   `{ jobId, status: "pending" }` immediately. The status endpoint
   `GET /v1/jobs/:jobId` returns `{ status, progress, result?, error? }`
   for polling.

2. **Worker** picks the job off the queue and dispatches the C++
   tool `audio_region/stretch` against the running Ardour MCP
   session. The tool executes synchronously inside the worker (the
   call itself blocks until the stretch finishes), then writes the
   final region descriptor back into `job.outputs.result`.

3. **MCP tool `audio_region/stretch`** (new, C++ in
   `libs/surfaces/mcp_http/`) — resolves `regionId`, builds an
   `ARDOUR::TimeFXRequest`, runs `RBStretch::run()` (or `Pitch::run()`
   for pitch-only) on a worker thread, replaces the region's source
   with the stretched output. Wrapped in `begin_reversible_command`
   so it shows up as a single undoable operation. Per-session mutex
   serializes concurrent stretch calls (same pattern as
   `audio_region_add`).

The C++ tool itself is not async — it's a normal blocking handler
that returns when the stretch finishes. **Async lives in the Node
job queue layer.** This keeps the C++ side simple and avoids
introducing a new concurrency primitive in the MCP server.

## API contract

### Action call (Node)

```jsonc
POST /v1/sessions/:id/actions
{
  "tool": "audio_region_stretch",
  "params": {
    "regionId": "region:xyz...",         // required
    "timeRatio": 1.0,                    // default 1.0; > 1 = longer, < 1 = shorter; range [0.25, 4.0]
    "semitones": 0.0,                    // default 0.0; pitch shift in semitones; range [-24, +24]
    "preserveFormants": false,           // default false; only meaningful when semitones != 0
    "engine": "finer",                   // "finer" | "faster"; "finer" = best quality, slower
    "crispness": 5,                      // 0-6, Rubber Band crispness setting; default 5
    "requestId": "req_..."               // optional; idempotency key (jobId returned on cache-hit)
  }
}
```

### Immediate response

```jsonc
{
  "ok": true,
  "jobId": "job_...",
  "status": "pending",
  "estimatedDurationMs": 60000           // rough estimate based on region length × engine factor
}
```

### Polling

```jsonc
GET /v1/jobs/:jobId
{
  "ok": true,
  "jobId": "job_...",
  "status": "running",                   // "pending" | "running" | "done" | "failed" | "cancelled"
  "progress": { "fraction": 0.42, "phase": "stretching" },
  "createdAt": 1714172400123,
  "startedAt": 1714172401045,
  "completedAt": null,
  "result": null,
  "error": null
}
```

### Final result on success

```jsonc
{
  "ok": true,
  "jobId": "job_...",
  "status": "done",
  "result": {
    "regionId": "region:NEW",             // NEW regionId — Ardour's RBEffect always produces a new
                                          // Region object; the playlist swaps old for new. Director
                                          // executors must update their region reference after stretch.
    "trackId": "track:...",
    "originalLengthSamples": 1323000,
    "newLengthSamples": 1587600,
    "timeRatio": 1.2,
    "semitones": 0.0,
    "preserveFormants": false,
    "engine": "finer",
    "sourceCreated": "source:..."         // the new audio source written to disk
  }
}
```

### Errors

| Code | When |
|---|---|
| `INVALID_PARAMS` | regionId missing, ratio out of range, semitones out of range |
| `REGION_NOT_FOUND` | regionId doesn't resolve in the session |
| `NOT_AUDIO_REGION` | regionId resolves to a MIDI region |
| `NO_OP` | timeRatio == 1.0 AND semitones == 0.0 |
| `STRETCH_FAILED` | Rubber Band returned an error mid-process |
| `JOB_CANCELLED` | client called `DELETE /v1/jobs/:jobId` |
| `QUEUE_FULL` | `JobQueue` rejected the enqueue |

## Implementation notes

### C++ side (`mcp_http_server.cc`)

- New handler: `handle_audio_region_stretch_tool`.
- Pattern mirrors `handle_audio_region_add_tool`:
  - Per-session mutex (`g_audio_region_stretch_mutex`).
  - Validation block with `validation_error` helpers returning
    structured errors.
  - Atomic-rollback `cleanup_stack` for the in-flight source.
  - Single `begin_reversible_command` envelope.
- `TimeFXRequest` constructed with `algorithm = Rubberband`,
  `time_fraction = ratio_t(time_ratio_num, time_ratio_den)`,
  `pitch_fraction = pow(2, semitones/12.0)` (the field is a linear
  frequency ratio, not a semitone count — Rubber Band's
  `setPitchScale` consumes a frequency multiplier).
- `RBEffect::run(region, &progress)` is called directly. The
  existing `Progress` machinery in PBD reports normalized fractions;
  we'll surface that to the Node job-queue side via a server-side
  progress channel (TBD: simplest is an in-memory map keyed by
  jobId).

### Node side

- New schema entry in `src/schemas/mcp-tools.json`.
- `routes/sessions.js` — handle the `audio_region_stretch` tool:
  validate, allocate a `jobId` via `JobQueue.addJob()`, return
  pending response immediately.
- `lib/job-queue.js` — extend to track per-job progress fraction so
  pollers see live updates. Currently `JobQueue` stores a `progress`
  field but the workers don't update it; we'll wire this through.
- The job worker calls `actionProxy.callTool(sessionId,
  'audio_region/stretch', params)` and parks until that returns.
  The progress channel from C++ side updates `job.progress` so the
  HTTP poller sees fraction movement.

### Director / Executor side (separate plan)

- Three new handlers in
  `components/ardour_executor/src/fourelem_ardour_executor/executor.py`:
  `_do_time_stretch`, `_do_pitch_shift`, `_do_reshape_rhythm`.
- Each enqueues the stretch via `client.call_tool_async()` and
  polls for completion (with a generous timeout — say 30 minutes
  per stretch).
- The action types `ReharmonizeAction` and `PitchCorrectAction`
  remain in `actions_skipped` until their composer-MIDI / chord-
  substitution semantics get a separate spec.

## Open questions (parked)

1. Cancellation. `RBEffect` has a `cancel` flag; should we wire it
   to `DELETE /v1/jobs/:jobId`? Probably yes, but defer until we
   see whether long-running stretches are common enough to need it.
2. Persistence across api-service restart. Jobs in flight when the
   server restarts are lost. Mirrors the existing job-queue model;
   not specific to stretch. Out of scope.
3. Quality presets. `engine` + `crispness` give two knobs; do we
   expose a single `quality: "best"|"medium"|"fast"` shorthand?
   Defer until usage patterns emerge.

## Non-goals

- Pitch correction to a target key (deferred to a separate spec
  using this primitive plus chord context).
- Per-MIDI-note pitch shift on audio regions (would require source
  separation; out of architectural scope).
- Stretch of MIDI regions (use the existing `midi_stretch` Lua API
  if needed; no MCP-tool surface planned).

## References

- `components/ardour/libs/ardour/ardour/timefx_request.h` — request struct
- `components/ardour/libs/ardour/rb_effect.cc` — RBStretch / Pitch implementations
- `components/ardour/api-service/src/lib/job-queue.js` — existing async-job machinery
- `components/ardour/docs/superpowers/specs/2026-04-12-audio-region-add-design.md` — analogous-but-inline tool's design
- `components/ardour/docs/superpowers/TODO.md` — F2 entry
- `docs/plans/2026-04-23-next-steps.md` — orchestrator-level reasoning
