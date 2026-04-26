# Audio Region Stretch v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `audio_region_stretch` async MCP tool so the Director's already-emitted `time_stretch` / `pitch_shift` actions execute against Ardour. Companion: a Director-side plan (separate file) wires the executor handlers.

**Architecture:** C++ MCP handler in `libs/surfaces/mcp_http/mcp_http_server.cc` mirrors the `audio_region_add` pattern (validation, per-session mutex, atomic rollback, reversible command). Node `JobQueue` wraps the synchronous C++ call so HTTP requests return immediately with a `jobId`. Progress fractions reported via a server-side channel keyed by jobId. Spec: `docs/superpowers/specs/2026-04-26-audio-region-stretch-design.md`.

**Tech Stack:** C++17 (Ardour), Node.js (Fastify api-service), JSON-RPC (MCP), Rubber Band Library, Python 3.12 (downstream executor).

---

## File structure

| File | Responsibility |
|---|---|
| `libs/surfaces/mcp_http/mcp_http_server.cc` | New `handle_audio_region_stretch_tool` C++ handler + tool dispatch entry. Modifies the existing 9255-line file. |
| `libs/surfaces/mcp_http/mcp_http_server.h` | One forward decl if needed. |
| `api-service/src/schemas/mcp-tools.json` | Schema entry for the new tool. |
| `api-service/src/routes/sessions.js` | Tool dispatch: enqueue the stretch as a job rather than calling inline. |
| `api-service/src/lib/job-queue.js` | Extend to update per-job `progress` field. |
| `api-service/src/routes/jobs.js` | Already serves `/v1/jobs/:id`; verify the new job type works. |
| `api-service/test/audio-region-stretch-hook.test.js` | New integration test. |
| `api-service/src/routes/audio-region-stretch-hook.test.js` | New unit-ish hook test mirroring `audio-region-add-hook.test.js`. |

---

## Task 1: C++ tool handler skeleton (no Rubber Band yet)

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc` — add `handle_audio_region_stretch_tool` near line 6029 (next to audio_region_add) and a dispatch entry near line 8918.

- [ ] **Step 1: Locate the audio_region_add handler and dispatch table**

```bash
grep -n "handle_audio_region_add_tool\|tool_name == \"audio_region/add\"" \
    components/ardour/libs/surfaces/mcp_http/mcp_http_server.cc
```

Expected: handler at line 6029 area, dispatch at ~8918.

- [ ] **Step 2: Add a forward declaration + the dispatch case**

In the file, find `if (tool_name == "audio_region/add") { ... }` block (~line 8918). Add immediately after it:

```cpp
if (tool_name == "audio_region/stretch") {
    response = handle_audio_region_stretch_tool (session, root, id);
}
```

- [ ] **Step 3: Add the handler stub returning INVALID_PARAMS for everything**

Just below the `handle_audio_region_add_tool` function, add:

```cpp
static std::mutex g_audio_region_stretch_mutex;

static std::string
audio_region_stretch_validation_error (const std::string& id,
                                       const std::string& code,
                                       const std::string& message,
                                       const std::string& region_id)
{
    pt::ptree resp;
    resp.put ("jsonrpc", "2.0");
    resp.put ("id", id);
    resp.put ("result.ok", false);
    resp.put ("result.code", code);
    resp.put ("result.message", message);
    resp.put ("result.regionId", region_id);
    std::ostringstream oss;
    pt::write_json (oss, resp, false);
    return oss.str ();
}

std::string
handle_audio_region_stretch_tool (ARDOUR::Session& session, pt::ptree& root,
                                  const std::string& id)
{
    std::lock_guard<std::mutex> lg (g_audio_region_stretch_mutex);
    const std::string region_id = root.get<std::string> (
        "params.arguments.regionId", "");
    if (region_id.empty ()) {
        return audio_region_stretch_validation_error (
            id, "INVALID_PARAMS", "regionId required", region_id);
    }
    return audio_region_stretch_validation_error (
        id, "NOT_IMPLEMENTED", "skeleton only", region_id);
}
```

- [ ] **Step 4: Build Ardour and confirm it compiles**

Run from `components/ardour`:
```bash
./build_ardour.sh build 2>&1 | tail -20
```

Expected: clean build; the new function compiles.

- [ ] **Step 5: Commit**

```bash
git add libs/surfaces/mcp_http/mcp_http_server.cc
git commit -m "feat(mcp): audio_region/stretch handler skeleton (returns NOT_IMPLEMENTED)"
```

---

## Task 2: Schema + Node route enqueue

**Files:**
- Modify: `api-service/src/schemas/mcp-tools.json`
- Modify: `api-service/src/routes/sessions.js`

- [ ] **Step 1: Add schema entry**

In `mcp-tools.json`, append (mirror the existing `audio_region_add` entry's structure):

```jsonc
{
  "name": "audio_region_stretch",
  "description": "Time-stretch and/or pitch-shift an audio region. Async — returns jobId.",
  "inputSchema": {
    "type": "object",
    "required": ["regionId"],
    "properties": {
      "regionId": { "type": "string" },
      "timeRatio": { "type": "number", "minimum": 0.25, "maximum": 4.0, "default": 1.0 },
      "semitones": { "type": "number", "minimum": -24, "maximum": 24, "default": 0.0 },
      "preserveFormants": { "type": "boolean", "default": false },
      "engine": { "type": "string", "enum": ["finer", "faster"], "default": "finer" },
      "crispness": { "type": "integer", "minimum": 0, "maximum": 6, "default": 5 },
      "requestId": { "type": "string" }
    }
  }
}
```

- [ ] **Step 2: Wire the dispatch in sessions.js**

Find the existing `tool: "audio_region_add"` branch in `routes/sessions.js`. Add an analogous branch (but using the job queue rather than the inline action proxy):

```js
if (tool === 'audio_region_stretch') {
  const validated = validateStretchParams(params);
  if (validated.error) {
    return reply.code(400).send({ ok: false, ...validated.error });
  }
  const jobId = `job_${randomUUID()}`;
  const accepted = stretchQueue.addJob(jobId, {
    sessionId: id,
    tool: 'audio_region/stretch',
    params: validated.params,
  });
  if (!accepted.accepted) {
    return reply.code(503).send({ ok: false, code: 'QUEUE_FULL' });
  }
  return reply.send({
    ok: true, jobId, status: 'pending',
  });
}
```

`validateStretchParams` is a helper in the same file (~30 LOC) that
range-checks `timeRatio` / `semitones` and rejects no-op `(1.0, 0.0)`.

- [ ] **Step 3: Add the queue worker**

Below the existing `queue.onJobReady = ...` block, add a `stretchQueue` instance with its own onJobReady that calls `actionProxy.callTool(spec.sessionId, 'audio_region/stretch', spec.params)` and stores the result.

- [ ] **Step 4: Write a route test**

Create `src/routes/audio-region-stretch-hook.test.js` with the same skeleton as `audio-region-add-hook.test.js`. The first three tests:

```js
test('rejects missing regionId', async (t) => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions/test/actions',
    payload: { tool: 'audio_region_stretch', params: {} },
  });
  t.equal(res.statusCode, 400);
  t.match(JSON.parse(res.body).code, /INVALID_PARAMS/);
});

test('rejects no-op (timeRatio=1, semitones=0)', async (t) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/sessions/test/actions',
    payload: {
      tool: 'audio_region_stretch',
      params: { regionId: 'region:abc' },
    },
  });
  t.equal(res.statusCode, 400);
  t.match(JSON.parse(res.body).code, /NO_OP/);
});

test('accepts valid stretch and returns jobId', async (t) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/sessions/test/actions',
    payload: {
      tool: 'audio_region_stretch',
      params: { regionId: 'region:abc', timeRatio: 1.5 },
    },
  });
  t.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.match(body.jobId, /^job_/);
  t.equal(body.status, 'pending');
});
```

- [ ] **Step 5: Run tests**

```bash
cd components/ardour/api-service
npm test -- --match "audio-region-stretch"
```

Expected: 3/3 passing.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/mcp-tools.json src/routes/sessions.js \
        src/routes/audio-region-stretch-hook.test.js
git commit -m "feat(api): audio_region_stretch route enqueues job; validation + 3 tests"
```

---

## Task 3: Real C++ implementation — Rubber Band invocation

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Resolve the region**

Replace the skeleton handler body with the resolution + validation block. The pattern mirrors `audio_region_add`'s route resolution:

```cpp
std::shared_ptr<ARDOUR::Region> region = region_by_mcp_id (session, region_id);
if (!region) {
    return audio_region_stretch_validation_error (
        id, "REGION_NOT_FOUND", "region not found", region_id);
}
auto audio_region = std::dynamic_pointer_cast<ARDOUR::AudioRegion> (region);
if (!audio_region) {
    return audio_region_stretch_validation_error (
        id, "NOT_AUDIO_REGION",
        "regionId resolves to a non-audio region", region_id);
}
```

(`region_by_mcp_id` is the analog of `route_by_mcp_id` — confirm the
helper name by grepping; if it doesn't exist, add one near
`route_by_mcp_id` modeled after that function.)

- [ ] **Step 2: Build the TimeFXRequest**

Append to the handler:

```cpp
const double time_ratio = root.get<double> ("params.arguments.timeRatio", 1.0);
const double semitones  = root.get<double> ("params.arguments.semitones", 0.0);
const bool   preserve_formants =
    root.get<bool> ("params.arguments.preserveFormants", false);
const std::string engine =
    root.get<std::string> ("params.arguments.engine", "finer");
const int crispness =
    root.get<int> ("params.arguments.crispness", 5);

if (time_ratio == 1.0 && semitones == 0.0) {
    return audio_region_stretch_validation_error (
        id, "NO_OP", "timeRatio=1 and semitones=0 — nothing to do", region_id);
}
if (time_ratio < 0.25 || time_ratio > 4.0) {
    return audio_region_stretch_validation_error (
        id, "INVALID_PARAMS", "timeRatio out of range [0.25, 4.0]", region_id);
}
if (semitones < -24.0 || semitones > 24.0) {
    return audio_region_stretch_validation_error (
        id, "INVALID_PARAMS", "semitones out of range [-24, 24]", region_id);
}

ARDOUR::TimeFXRequest req;
req.algorithm = ARDOUR::TimeFXRequest::Rubberband;
req.time_fraction = Temporal::ratio_t (
    static_cast<int64_t>(time_ratio * 1000000), 1000000);
// pitch_fraction is a linear frequency ratio, NOT a semitone count.
// Rubber Band's setPitchScale takes a multiplier (1.0 = no shift,
// 2^(1/12) = +1 semitone, 2.0 = +1 octave).
req.pitch_fraction = static_cast<float>(std::pow(2.0, semitones / 12.0));
// engine + crispness fold into req.opts via RubberBand::Options
int rb_opts = 0;
if (engine == "faster") {
    rb_opts |= RubberBand::RubberBandStretcher::OptionEngineFaster;
} else {
    rb_opts |= RubberBand::RubberBandStretcher::OptionEngineFiner;
}
if (preserve_formants) {
    rb_opts |= RubberBand::RubberBandStretcher::OptionFormantPreserved;
}
req.opts = rb_opts;
```

- [ ] **Step 3: Run the stretch**

```cpp
ARDOUR::RBStretch rbs (session, req);
PBD::Progress progress;
session.begin_reversible_command ("AI: stretch audio region");
auto result_region = rbs.run (audio_region, &progress);
if (!result_region) {
    session.abort_reversible_command ();
    return audio_region_stretch_validation_error (
        id, "STRETCH_FAILED", "Rubber Band returned null result", region_id);
}
session.commit_reversible_command ();
```

- [ ] **Step 4: Build the success response**

```cpp
pt::ptree resp;
resp.put ("jsonrpc", "2.0");
resp.put ("id", id);
resp.put ("result.ok", true);
resp.put ("result.regionId", mcp_id_for_region (result_region));
resp.put ("result.originalLengthSamples",
          (uint64_t) audio_region->length_samples ());
resp.put ("result.newLengthSamples",
          (uint64_t) result_region->length_samples ());
resp.put ("result.timeRatio", time_ratio);
resp.put ("result.semitones", semitones);
resp.put ("result.preserveFormants", preserve_formants);
resp.put ("result.engine", engine);
std::ostringstream oss;
pt::write_json (oss, resp, false);
return oss.str ();
```

- [ ] **Step 5: Build + smoke-test against a real session**

```bash
cd components/ardour && ./build_ardour.sh build
cd ../api-service && node test/manual-stretch-smoke.js
```

`manual-stretch-smoke.js` is a 30-line script (write it as part of this step) that:
1. Spins a session
2. Uploads `tests/fixtures/short.wav`
3. Calls `audio_region_add`, captures `regionId`
4. Calls `audio_region_stretch` with `timeRatio=1.5`
5. Polls `/v1/jobs/:id` until done
6. Asserts the `newLengthSamples` is ~50% longer

- [ ] **Step 6: Commit**

```bash
git add libs/surfaces/mcp_http/mcp_http_server.cc \
        api-service/test/manual-stretch-smoke.js
git commit -m "feat(mcp): real Rubber Band stretch implementation in audio_region/stretch"
```

---

## Task 4: Progress reporting

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`
- Modify: `api-service/src/lib/job-queue.js`
- Modify: `api-service/src/routes/jobs.js`

- [ ] **Step 1: Server-side progress channel**

Add a static map keyed by `requestId` (passed in via params, threaded through to the C++ handler):

```cpp
static std::mutex g_progress_mutex;
static std::map<std::string, double> g_progress;

class StretchProgress : public PBD::Progress {
public:
    StretchProgress (const std::string& key) : _key (key) {}
    void set_progress (float frac) override {
        std::lock_guard<std::mutex> lg (g_progress_mutex);
        g_progress[_key] = frac;
    }
private:
    std::string _key;
};
```

In the handler, instantiate `StretchProgress(request_id)` and pass to `rbs.run()`. Clean up the map entry on completion.

- [ ] **Step 2: Add a progress query MCP tool**

Tool name: `job_progress_query`. Params: `{ requestId }`. Returns: `{ fraction, phase }`. Stub `phase` as `"stretching"` for v1.

- [ ] **Step 3: Wire the Node JobQueue worker to poll C++**

The job worker's loop becomes: kick off the stretch, then while waiting for the response, poll `job_progress_query` every 1s and update `job.progress`. When the stretch returns, set `job.outputs` and `job.status = 'done'`.

- [ ] **Step 4: Test progress endpoint**

Add a test in `audio-region-stretch-hook.test.js` that confirms `GET /v1/jobs/:id` returns `progress.fraction > 0` while the stretch is running.

- [ ] **Step 5: Commit**

```bash
git add libs/surfaces/mcp_http/mcp_http_server.cc \
        api-service/src/lib/job-queue.js api-service/src/routes/jobs.js \
        api-service/src/routes/audio-region-stretch-hook.test.js
git commit -m "feat(mcp): live progress reporting for audio_region_stretch jobs"
```

---

## Task 5: Director executor handlers (cross-component)

This task lives in a separate plan because it crosses repos:
`components/4ElementsDirector/docs/superpowers/plans/2026-04-26-rubber-band-executor.md`.

The high-level shape is three handlers in
`components/ardour_executor/src/fourelem_ardour_executor/executor.py`:

- `_do_time_stretch` — calls `audio_region_stretch` with the action's
  `timeRatio`, polls until done, raises if it fails.
- `_do_pitch_shift` — same flow with `semitones`.
- `_do_reshape_rhythm` — uses `time_stretch` as a primitive, plus
  the rhythm-redistribution math (which is largely Director-side).

After Task 4 lands, write the executor plan and execute it.

---

## Task 6: End-to-end demo update

**Files:**
- Modify: `scripts/demo_end_to_end.py`

- [ ] **Step 1: Inject a stretch action into the demo plan**

After the existing place_audio block in the demo, add a `time_stretch` action with `time_ratio=1.2` on the first placed region.

- [ ] **Step 2: Run the demo**

```bash
uv run python scripts/demo_end_to_end.py
```

Expected: stdout shows `actions_dispatched: N+1` (where N is the prior count), `actions_skipped: 0` (down from the 5 transformation skips before).

- [ ] **Step 3: Commit**

```bash
git add scripts/demo_end_to_end.py
git commit -m "feat(demo): end-to-end demo exercises audio_region_stretch"
```

---

## Self-review

**1. Spec coverage:**
- ✅ C++ tool handler — Tasks 1, 3, 4
- ✅ Async job pattern via Node JobQueue — Task 2
- ✅ Progress reporting — Task 4
- ✅ Per-session mutex + reversible command — Task 1, 3
- ✅ Director executor handlers — Task 5 (deferred to dedicated plan)
- ✅ End-to-end exercise — Task 6

**2. Placeholder scan:** Code blocks throughout; no "TBD". One gap: `mcp_id_for_region` and `region_by_mcp_id` helpers — Task 3 step 1 has a verify-or-add note.

**3. Type consistency:** `regionId` is the canonical key from input through response (matches the existing tool naming convention). `jobId` uses the same `job_<uuid>` shape as plugin-indexer jobs. `requestId` is the idempotency / progress-channel key throughout.
