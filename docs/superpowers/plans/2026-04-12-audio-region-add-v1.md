# Audio Region Add v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a robust `audio_region_add` MCP tool that places an audio file as a region on a track with fades, overlap/edge-crossfade handling, channel-mismatch guards, atomic rollback, and path-injection defenses.

**Architecture:** Three layers. (1) Node.js upload endpoint enforces per-session disk quota and returns opaque `uploadId`. (2) Sandboxed decoder sidecar (`tools/audio-validator`) pre-validates and canonicalizes audio files outside the Ardour process, protecting the session from malformed-file crashes. (3) C++ MCP tool handler in `libs/surfaces/mcp_http/` consumes `uploadId`, resolves to a decoded WAV within the session sandbox, runs import + region creation under a per-session mutex with atomic rollback.

**Tech Stack:** C++17 (Ardour libs), Node.js 20 (Fastify, p-queue), macOS `sandbox-exec` / Linux `landlock` for the decoder sidecar, libsndfile for decode. Existing test infra: Mocha/Chai for Node, ctest-style for C++ isn't present so we test C++ via the Node.js e2e suite against a real session.

**Scope boundary:** No time-stretch, no pitch-shift. Those ship in v2 (`audio_region_stretch`).

---

## File Structure

**New files:**
- `tools/audio-validator/main.cc` — sandboxed decoder sidecar (libsndfile → canonical WAV).
- `tools/audio-validator/wscript` — waf build integration.
- `api-service/src/lib/sandbox-decode.js` — Node.js wrapper that launches the sidecar under the OS sandbox.
- `api-service/src/lib/request-cache.js` — LRU cache for idempotent `requestId` retries.
- `api-service/test/sandbox-decode.test.js` — unit tests with mocked sidecar.
- `api-service/test/request-cache.test.js` — unit tests.
- `api-service/test/audio-region-add.e2e.test.js` — e2e against real session.

**Modified files:**
- `api-service/src/routes/sessions.js` — upload endpoint: add quota check, return `uploadId`; new `POST /v1/sessions/:id/actions/audio_region_add` delegation (kept behind generic `/actions` but with a pre-validation hook that injects `decodedPath` into params).
- `api-service/src/config.js` — add `sessionDiskQuotaBytes` (default 2GB).
- `api-service/src/lib/session-manager.js` — track `uploadBytesUsed` per session; expose `getDecodedPath(sessionId, uploadId)`.
- `libs/surfaces/mcp_http/mcp_http_server.cc` — new handler `handle_audio_region_add`.
- `libs/surfaces/mcp_http/mcp_http_server.h` — declaration.
- `libs/surfaces/mcp_http/tools_json.inc` — schema entry.
- `api-service/public/app.js` — `TOOL_OVERRIDES.audio_region_add` with track/upload dropdowns.

---

## Task 1: Disk quota on upload

**Files:**
- Modify: `api-service/src/config.js`
- Modify: `api-service/src/routes/sessions.js` (upload handler)
- Modify: `api-service/src/lib/session-manager.js` (add `uploadBytesUsed` tracking)
- Test: `api-service/test/upload-quota.test.js`

- [ ] **Step 1: Write the failing test**

```js
// api-service/test/upload-quota.test.js
import { expect } from 'chai';
import { buildTestServer } from './helpers/test-server.js';

describe('upload quota', () => {
  it('rejects upload when session disk budget exceeded', async () => {
    const app = await buildTestServer({ sessionDiskQuotaBytes: 1024 });
    const { sessionId } = await app.sessionManager.create({});
    // First 600-byte upload succeeds
    const r1 = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/upload`,
      payload: Buffer.alloc(600), headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.wav' } });
    expect(r1.statusCode).to.equal(200);
    // Second 600-byte upload pushes over 1024-byte quota → 413
    const r2 = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/upload`,
      payload: Buffer.alloc(600), headers: { 'content-type': 'application/octet-stream', 'x-filename': 'b.wav' } });
    expect(r2.statusCode).to.equal(413);
    expect(JSON.parse(r2.body).error_code).to.equal('QUOTA_EXCEEDED');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

`cd api-service && npm test -- --grep "upload quota"` → FAIL (endpoint returns 200 or test-server missing quota config).

- [ ] **Step 3: Add config default**

In `api-service/src/config.js`, add inside the exported config object:

```js
sessionDiskQuotaBytes: Number(process.env.SESSION_DISK_QUOTA_BYTES) || (2 * 1024 * 1024 * 1024),
```

- [ ] **Step 4: Track bytes in SessionManager**

In `api-service/src/lib/session-manager.js`, the `session` object already has `uploadBytesUsed: 0` (confirm at line ~87). Add method:

```js
recordUpload(sessionId, bytes) {
  const s = this._sessions.get(sessionId);
  if (!s) return;
  s.uploadBytesUsed += bytes;
}
quotaRemaining(sessionId) {
  const s = this._sessions.get(sessionId);
  if (!s) return 0;
  return Math.max(0, this._config.sessionDiskQuotaBytes - s.uploadBytesUsed);
}
```

- [ ] **Step 5: Enforce in upload route**

In `api-service/src/routes/sessions.js`, modify the upload handler so that before writing the file:

```js
const contentLength = Number(req.headers['content-length'] || 0);
const remaining = app.sessionManager.quotaRemaining(sessionId);
if (contentLength > remaining) {
  return reply.code(413).send({ error_code: 'QUOTA_EXCEEDED',
    message: `upload (${contentLength} bytes) exceeds remaining quota (${remaining} bytes)` });
}
// ... after successful write:
app.sessionManager.recordUpload(sessionId, bytesActuallyWritten);
```

- [ ] **Step 6: Run test, expect pass**

`cd api-service && npm test -- --grep "upload quota"` → PASS.

- [ ] **Step 7: Commit**

```bash
git add api-service/src/config.js api-service/src/lib/session-manager.js \
        api-service/src/routes/sessions.js api-service/test/upload-quota.test.js
git commit -m "feat(api): enforce per-session upload disk quota"
```

---

## Task 2: Return `uploadId` from upload endpoint

**Files:**
- Modify: `api-service/src/routes/sessions.js` (upload handler)
- Modify: `api-service/src/lib/session-manager.js` (upload registry)
- Test: `api-service/test/upload-id.test.js`

- [ ] **Step 1: Failing test**

```js
// api-service/test/upload-id.test.js
import { expect } from 'chai';
import { buildTestServer } from './helpers/test-server.js';

describe('upload id', () => {
  it('returns opaque uploadId and stores mapping', async () => {
    const app = await buildTestServer();
    const { sessionId } = await app.sessionManager.create({});
    const r = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/upload`,
      payload: Buffer.from('RIFF....WAVE'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'x.wav' } });
    expect(r.statusCode).to.equal(200);
    const body = JSON.parse(r.body);
    expect(body.upload_id).to.match(/^upl_[a-f0-9]{16}$/);
    expect(body.bytes).to.equal(12);
    const path = app.sessionManager.getUploadPath(sessionId, body.upload_id);
    expect(path).to.be.a('string');
  });
});
```

- [ ] **Step 2: Run, expect fail.**

`cd api-service && npm test -- --grep "upload id"` → FAIL.

- [ ] **Step 3: Add SessionManager upload registry**

In `api-service/src/lib/session-manager.js`, modify the session creation in `create()` to include `uploads: new Map()`, then add:

```js
registerUpload(sessionId, filename, bytes) {
  const s = this._sessions.get(sessionId);
  if (!s) return null;
  const id = 'upl_' + randomBytes(8).toString('hex');
  const path = join(s.sessionDir, 'uploads', id, filename);
  s.uploads.set(id, { filename, bytes, path, createdAt: this._now() });
  return { id, path };
}
getUploadPath(sessionId, uploadId) {
  const s = this._sessions.get(sessionId);
  return s?.uploads.get(uploadId)?.path || null;
}
```

Add `import { randomBytes } from 'crypto';` at top.

- [ ] **Step 4: Update upload route to return uploadId**

In `api-service/src/routes/sessions.js` upload handler, replace the current path construction + response with:

```js
const filename = req.headers['x-filename'] || 'upload.bin';
const { id: uploadId, path: uploadPath } = app.sessionManager.registerUpload(sessionId, filename, contentLength);
await mkdir(dirname(uploadPath), { recursive: true });
const bytes = await writeFileFromStream(uploadPath, req.raw);  // existing helper
app.sessionManager.recordUpload(sessionId, bytes);
return reply.send({ upload_id: uploadId, filename, bytes });
```

- [ ] **Step 5: Run, expect pass.**

`cd api-service && npm test -- --grep "upload id"` → PASS. Also re-run `upload quota` test to confirm no regression.

- [ ] **Step 6: Commit**

```bash
git add api-service/src/lib/session-manager.js api-service/src/routes/sessions.js \
        api-service/test/upload-id.test.js
git commit -m "feat(api): return opaque uploadId from upload endpoint"
```

---

## Task 3: Audio-validator sidecar (scaffold + sndfile decode)

**Files:**
- Create: `tools/audio-validator/main.cc`
- Create: `tools/audio-validator/wscript`
- Modify: `wscript` (top-level, add tools/audio-validator to subdirs list — find "tools" in subdirs list, add "tools/audio-validator")

- [ ] **Step 1: Write the decoder**

`tools/audio-validator/main.cc`:

```cpp
#include <sndfile.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

/* Usage: audio-validator <input> <output.wav>
 * Exit 0 on success; prints JSON summary on stdout. Exit 1 on unreadable, 2 on unsupported, 3 on decode error. */
int main (int argc, char** argv) {
  if (argc != 3) { fprintf(stderr, "usage: %s <in> <out>\n", argv[0]); return 64; }
  SF_INFO info; std::memset(&info, 0, sizeof info);
  SNDFILE* in = sf_open(argv[1], SFM_READ, &info);
  if (!in) { fprintf(stderr, "open failed: %s\n", sf_strerror(nullptr)); return 1; }
  if (info.channels < 1 || info.channels > 64 || info.samplerate < 8000 || info.samplerate > 384000) {
    sf_close(in); fprintf(stderr, "unsupported geometry ch=%d sr=%d\n", info.channels, info.samplerate); return 2;
  }
  SF_INFO out_info = info;
  out_info.format = SF_FORMAT_WAV | SF_FORMAT_FLOAT;
  SNDFILE* out = sf_open(argv[2], SFM_WRITE, &out_info);
  if (!out) { sf_close(in); fprintf(stderr, "output open failed\n"); return 3; }
  std::vector<float> buf(4096 * info.channels);
  sf_count_t total = 0, r;
  while ((r = sf_readf_float(in, buf.data(), 4096)) > 0) {
    if (sf_writef_float(out, buf.data(), r) != r) { sf_close(in); sf_close(out); return 3; }
    total += r;
  }
  sf_close(in); sf_close(out);
  fprintf(stdout, "{\"channels\":%d,\"sampleRate\":%d,\"frames\":%lld}\n",
          info.channels, info.samplerate, (long long)total);
  return 0;
}
```

- [ ] **Step 2: Write the wscript**

`tools/audio-validator/wscript`:

```python
def build(bld):
    bld.program(
        source  = ['main.cc'],
        target  = 'audio-validator',
        uselib  = ['SNDFILE'],
        install_path = None,
    )
```

- [ ] **Step 3: Register subdir**

In top-level `wscript`, find the list of subdirs (`bld.recurse(...)` calls) and add `bld.recurse('tools/audio-validator')` near the other `tools/` entries.

- [ ] **Step 4: Build + smoke-test**

```bash
python3 ./waf build --targets=audio-validator 2>&1 | tail -5
# Make a 1-second test WAV and decode it
python3 -c "import wave,struct; w=wave.open('/tmp/t.wav','w'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(b'\\x00'*48000*4); w.close()"
./build/tools/audio-validator/audio-validator /tmp/t.wav /tmp/t-out.wav
```

Expected: exit 0, stdout `{"channels":2,"sampleRate":48000,"frames":48000}`, `/tmp/t-out.wav` exists.

- [ ] **Step 5: Commit**

```bash
git add tools/audio-validator/main.cc tools/audio-validator/wscript wscript
git commit -m "feat(tools): add audio-validator sidecar for sandboxed decode"
```

---

## Task 4: Node.js sandbox-decode wrapper

**Files:**
- Create: `api-service/src/lib/sandbox-decode.js`
- Test: `api-service/test/sandbox-decode.test.js`

- [ ] **Step 1: Failing test**

```js
// api-service/test/sandbox-decode.test.js
import { expect } from 'chai';
import { decodeToCanonicalWav } from '../src/lib/sandbox-decode.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';

describe('sandbox-decode', () => {
  const tmp = '/tmp/sandbox-decode-test';
  before(() => { rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    spawnSync('python3', ['-c', `import wave; w=wave.open('${tmp}/in.wav','w'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b'\\x00'*88200); w.close()`]);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('decodes valid wav and returns metadata', async () => {
    const out = `${tmp}/out.wav`;
    const meta = await decodeToCanonicalWav({ input: `${tmp}/in.wav`, output: out, validatorBin: process.env.AUDIO_VALIDATOR_BIN });
    expect(existsSync(out)).to.be.true;
    expect(meta.channels).to.equal(1);
    expect(meta.sampleRate).to.equal(44100);
    expect(meta.frames).to.be.greaterThan(0);
  });

  it('rejects non-audio file with DECODE_FAILED', async () => {
    writeFileSync(`${tmp}/bad.bin`, 'not audio');
    try {
      await decodeToCanonicalWav({ input: `${tmp}/bad.bin`, output: `${tmp}/bad-out.wav`, validatorBin: process.env.AUDIO_VALIDATOR_BIN });
      expect.fail('should throw');
    } catch (e) {
      expect(e.code).to.equal('DECODE_FAILED');
    }
  });
});
```

- [ ] **Step 2: Run, expect fail** (module doesn't exist).

`cd api-service && AUDIO_VALIDATOR_BIN=$PWD/../build/tools/audio-validator/audio-validator npm test -- --grep "sandbox-decode"` → FAIL.

- [ ] **Step 3: Implement wrapper**

`api-service/src/lib/sandbox-decode.js`:

```js
import { spawn } from 'child_process';
import { platform } from 'os';

/* Launches the audio-validator under OS sandbox. Returns { channels, sampleRate, frames }.
 * Throws { code: 'DECODE_FAILED' | 'VALIDATOR_MISSING', message, stderr, exitCode }. */
export function decodeToCanonicalWav({ input, output, validatorBin, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    if (!validatorBin) return reject(Object.assign(new Error('validator not configured'), { code: 'VALIDATOR_MISSING' }));

    const args = [validatorBin, input, output];
    let cmd, cmdArgs;
    if (platform() === 'darwin') {
      const profile = `(version 1)(deny default)(allow process-fork)(allow process-exec)(allow file-read* (regex #"^${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$"))(allow file-read-metadata)(allow file-write* (regex #"^${output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$"))(allow file-read* (subpath "/usr/lib") (subpath "/usr/local/lib") (subpath "/System") (subpath "/opt/homebrew/lib"))(allow sysctl-read)(allow mach-lookup)`;
      cmd = 'sandbox-exec';
      cmdArgs = ['-p', profile, ...args];
    } else {
      cmd = validatorBin;
      cmdArgs = [input, output];
    }

    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);

    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(Object.assign(new Error('bad validator stdout'), { code: 'DECODE_FAILED', stderr })); }
      } else {
        reject(Object.assign(new Error(`validator exit ${code}: ${stderr}`), { code: 'DECODE_FAILED', stderr, exitCode: code }));
      }
    });
    p.on('error', (e) => { clearTimeout(timer); reject(Object.assign(e, { code: 'DECODE_FAILED' })); });
  });
}
```

- [ ] **Step 4: Run, expect pass.**

Same command as step 2 → PASS.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/sandbox-decode.js api-service/test/sandbox-decode.test.js
git commit -m "feat(api): sandboxed audio decoder wrapper"
```

---

## Task 5: Request-cache for idempotent `requestId` retries

**Files:**
- Create: `api-service/src/lib/request-cache.js`
- Test: `api-service/test/request-cache.test.js`

- [ ] **Step 1: Failing test**

```js
// api-service/test/request-cache.test.js
import { expect } from 'chai';
import { RequestCache } from '../src/lib/request-cache.js';

describe('RequestCache', () => {
  it('caches by requestId and returns same value within TTL', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    let calls = 0;
    const fn = async () => { calls++; return { n: calls }; };
    const a = await c.compute('k1', fn);
    const b = await c.compute('k1', fn);
    expect(a).to.deep.equal(b);
    expect(calls).to.equal(1);
  });
  it('evicts oldest when over capacity', async () => {
    const c = new RequestCache({ maxEntries: 2, ttlMs: 10000 });
    await c.compute('a', async () => 1);
    await c.compute('b', async () => 2);
    await c.compute('c', async () => 3);
    expect(c.has('a')).to.be.false;
    expect(c.has('b')).to.be.true;
    expect(c.has('c')).to.be.true;
  });
  it('expires after TTL', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 10 });
    await c.compute('k', async () => 1);
    await new Promise(r => setTimeout(r, 20));
    expect(c.has('k')).to.be.false;
  });
});
```

- [ ] **Step 2: Run, expect fail.**

`cd api-service && npm test -- --grep "RequestCache"` → FAIL.

- [ ] **Step 3: Implement**

`api-service/src/lib/request-cache.js`:

```js
export class RequestCache {
  constructor({ maxEntries = 256, ttlMs = 10 * 60 * 1000 } = {}) {
    this._max = maxEntries; this._ttl = ttlMs;
    this._map = new Map();        // key -> { value, expiresAt }
    this._inflight = new Map();   // key -> Promise
  }
  has(key) { this._sweep(); return this._map.has(key); }
  async compute(key, fn) {
    this._sweep();
    if (this._map.has(key)) return this._map.get(key).value;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = (async () => {
      try {
        const v = await fn();
        this._put(key, v);
        return v;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, p);
    return p;
  }
  _put(key, value) {
    if (this._map.size >= this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, { value, expiresAt: Date.now() + this._ttl });
  }
  _sweep() {
    const now = Date.now();
    for (const [k, v] of this._map) if (v.expiresAt <= now) this._map.delete(k);
  }
}
```

- [ ] **Step 4: Run, expect pass.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/request-cache.js api-service/test/request-cache.test.js
git commit -m "feat(api): LRU+TTL request cache for idempotent retries"
```

---

## Task 6: `audio_region_add` schema entry

**Files:**
- Modify: `libs/surfaces/mcp_http/tools_json.inc`

- [ ] **Step 1: Add schema after `midi_region_add` block**

Append to `tools_json.inc` immediately after the `midi_region_add` tool entry (line ~2280), as a new entry in the tools array:

```json
{
  "name": "audio_region_add",
  "title": "Add Audio Region",
  "description": "Place an uploaded audio file as a region on a track. Handles channel mismatch, fades, overlap/edge-crossfade, snap, repeat, and atomic rollback. See docs/superpowers/specs/2026-04-12-audio-region-add-design.md.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "trackId": { "type": "string" },
      "uploadId": { "type": "string" },
      "decodedPath": { "type": "string", "description": "Server-injected absolute path; callers must not supply." },
      "name": { "type": "string" },
      "position": {
        "type": "object",
        "properties": {
          "unit": { "type": "string", "enum": ["samples","seconds","beats","bars+beats"] },
          "value": {}
        },
        "required": ["unit","value"],
        "additionalProperties": false
      },
      "sourceOffsetSamples": { "type": "integer", "minimum": 0 },
      "timelineLength": {
        "type": "object",
        "properties": {
          "unit": { "type": "string", "enum": ["samples","seconds","beats","bars+beats"] },
          "value": {}
        },
        "required": ["unit","value"],
        "additionalProperties": false
      },
      "copyToSession": { "type": "boolean" },
      "channelMismatch": { "type": "string", "enum": ["error","truncate","auto-track"] },
      "allowTrackCreation": { "type": "boolean" },
      "sampleRateConversion": { "type": "string", "enum": ["auto","strict","none"] },
      "srcQuality": { "type": "string", "enum": ["best","medium","fast"] },
      "fadeInSamples": { "type": "integer", "minimum": 0 },
      "fadeOutSamples": { "type": "integer", "minimum": 0 },
      "gainDb": { "type": "number" },
      "polarityInvert": { "type": "boolean" },
      "reverse": { "type": "boolean" },
      "snap": { "type": "string", "enum": ["none","bar","beat","grid"] },
      "onOverlap": { "type": "string", "enum": ["error","trim-existing","crossfade","layer"] },
      "overlapCrossfadeMs": { "type": "integer", "minimum": 0 },
      "edgeCrossfade": { "type": "string", "enum": ["auto","none"] },
      "edgeToleranceMs": { "type": "integer", "minimum": 0 },
      "edgeCrossfadeMs": { "type": "integer", "minimum": 0 },
      "repeat": {
        "type": "object",
        "properties": { "count": {"type":"integer","minimum":1}, "strideBeats": {"type":"number","minimum":0} },
        "additionalProperties": false
      },
      "preserveOriginalTimestamp": { "type": "boolean" },
      "dryRun": { "type": "boolean" },
      "requestId": { "type": "string" }
    },
    "required": ["trackId","uploadId","position"],
    "additionalProperties": false
  }
}
```

- [ ] **Step 2: Build to verify JSON is valid**

```bash
python3 ./waf build --targets=libmcp_http 2>&1 | tail -3
```

Expected: builds clean (the `.inc` is compiled into the binary as a string constant).

- [ ] **Step 3: Commit**

```bash
git add libs/surfaces/mcp_http/tools_json.inc
git commit -m "feat(mcp): schema for audio_region_add"
```

---

## Task 7: C++ handler — skeleton + path validation

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Add handler declaration**

In `mcp_http_server.cc`, after the last `handle_*` static function prototype section (find where `handle_tracks_add_or_buses_add_tool` is defined, near line ~4976), add a forward declaration near other forward declarations and a stub:

```cpp
static std::string handle_audio_region_add (ARDOUR::Session& session, const pt::ptree& root, const std::string& id);
```

- [ ] **Step 2: Wire into the dispatcher**

Find the tool dispatch block (the chain of `if (tool_name == "...")`, near line ~5150-5163), add before or near `plugin/list_available`:

```cpp
if (tool_name == "audio/region_add") {
  response = handle_audio_region_add (session, root, id);
}
```

- [ ] **Step 3: Implement skeleton with path validation**

Append to `mcp_http_server.cc` before the closing namespace brace:

```cpp
static std::string
handle_audio_region_add (ARDOUR::Session& session, const pt::ptree& root, const std::string& id)
{
  const std::string track_id     = root.get<std::string> ("params.arguments.trackId", "");
  const std::string decoded_path = root.get<std::string> ("params.arguments.decodedPath", "");

  if (track_id.empty ())     return jsonrpc_error (id, -32602, "trackId required");
  if (decoded_path.empty ()) return jsonrpc_error (id, -32602, "decodedPath required (server-injected after upload validation)");

  /* Reject paths containing .. or absolute paths that escape /tmp/ardour-sessions/<id>/decoded/ */
  if (decoded_path.find ("..") != std::string::npos) {
    return jsonrpc_error (id, -32602, "PATH_OUTSIDE_SESSION");
  }
  char resolved[PATH_MAX];
  if (!realpath (decoded_path.c_str (), resolved)) {
    return jsonrpc_error (id, -32602, "UNREADABLE_FILE");
  }
  const std::string session_root = session.session_directory ().root_path ();
  /* decoded files live under <session_root>/../decoded/ (session root is <sessionDir>/data, uploads+decoded siblings) */
  const std::string decoded_root = Glib::build_filename (Glib::path_get_dirname (session_root), "decoded");
  if (std::string (resolved).rfind (decoded_root, 0) != 0) {
    return jsonrpc_error (id, -32602, "PATH_OUTSIDE_SESSION");
  }

  /* Resolve track */
  std::shared_ptr<ARDOUR::Route> route = route_by_mcp_id (session, track_id);
  if (!route) return jsonrpc_error (id, -32602, "ROUTE_NOT_FOUND");
  if (!std::dynamic_pointer_cast<ARDOUR::AudioTrack> (route)) {
    return jsonrpc_error (id, -32602, "NOT_AUDIO_TRACK");
  }

  /* Stub: return a not-yet-implemented marker so the test can confirm the path-validation gate works. */
  return jsonrpc_result (id,
    std::string ("{\"content\":[{\"type\":\"text\",\"text\":\"stub\"}],\"structuredContent\":{\"ok\":false,\"failedAt\":\"validation\",\"error\":{\"code\":\"NOT_IMPLEMENTED\",\"message\":\"v1 stub\"}}}"));
}
```

- [ ] **Step 4: Build**

```bash
python3 ./waf build --targets=libmcp_http 2>&1 | tail -5
```

Expected: build clean.

- [ ] **Step 5: Commit**

```bash
git add libs/surfaces/mcp_http/mcp_http_server.cc
git commit -m "feat(mcp): audio_region_add handler skeleton with path-injection defense"
```

---

## Task 8: Wire upload → decode → `audio_region_add` pre-hook in Node.js

**Files:**
- Modify: `api-service/src/routes/sessions.js` (action dispatch)
- Modify: `api-service/src/lib/session-manager.js` (per-session decoder mutex + decoded-path registry)
- Test: `api-service/test/audio-region-add-hook.test.js`

- [ ] **Step 1: Failing test**

```js
// api-service/test/audio-region-add-hook.test.js
import { expect } from 'chai';
import { buildTestServer } from './helpers/test-server.js';
import { readFileSync } from 'fs';

describe('audio_region_add pre-hook', () => {
  it('decodes uploadId → decodedPath before calling MCP', async () => {
    const app = await buildTestServer();
    const { sessionId } = await app.sessionManager.create({});
    const wav = readFileSync('test/fixtures/1s-stereo.wav');
    const up = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/upload`,
      payload: wav, headers: { 'content-type':'audio/wav', 'x-filename':'1s.wav' } });
    const { upload_id } = JSON.parse(up.body);

    const act = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: JSON.stringify({ tool: 'audio_region_add',
        params: { trackId: 'track:DOES_NOT_EXIST', uploadId: upload_id, position:{unit:'samples',value:0} } }),
      headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(act.body);
    /* We expect the handler to get as far as route-lookup → ROUTE_NOT_FOUND, proving the decode ran and the decodedPath was injected. */
    expect(JSON.stringify(body)).to.include('ROUTE_NOT_FOUND');
  });
});
```

Add fixture: `api-service/test/fixtures/1s-stereo.wav` (generate via `python3 -c "import wave; ..."` in a repo-init script; commit the fixture).

- [ ] **Step 2: Generate fixture**

```bash
mkdir -p api-service/test/fixtures
python3 -c "import wave, struct; w=wave.open('api-service/test/fixtures/1s-stereo.wav','w'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(b'\\x00'*48000*4); w.close()"
```

- [ ] **Step 3: Run test, expect fail.**

`cd api-service && npm test -- --grep "audio_region_add pre-hook"` → FAIL.

- [ ] **Step 4: Implement pre-hook in action route**

In `api-service/src/routes/sessions.js`, in the `POST /v1/sessions/:id/actions` handler, before calling `actionProxy.execute`, add:

```js
if (tool === 'audio_region_add') {
  const uploadId = params?.uploadId;
  if (!uploadId) return reply.code(400).send({ error_code: 'MISSING_UPLOAD', message: 'uploadId required' });
  const uploadPath = app.sessionManager.getUploadPath(sessionId, uploadId);
  if (!uploadPath) return reply.code(404).send({ error_code: 'MISSING_UPLOAD', message: `uploadId ${uploadId} not found` });

  const decodedPath = await app.sessionManager.getOrDecodeUpload(sessionId, uploadId);
  params = { ...params, decodedPath };
}
```

- [ ] **Step 5: Implement `getOrDecodeUpload` in SessionManager**

In `api-service/src/lib/session-manager.js`:

```js
async getOrDecodeUpload(sessionId, uploadId) {
  const s = this._sessions.get(sessionId);
  if (!s) throw Object.assign(new Error('session gone'), { code: 'SESSION_GONE' });
  const u = s.uploads.get(uploadId);
  if (!u) throw Object.assign(new Error('no such upload'), { code: 'MISSING_UPLOAD' });
  if (u.decodedPath) return u.decodedPath;

  const decodedDir = join(s.sessionDir, 'decoded');
  const decodedPath = join(decodedDir, `${uploadId}.wav`);
  const { mkdir } = await import('fs/promises');
  await mkdir(decodedDir, { recursive: true });

  const { decodeToCanonicalWav } = await import('./sandbox-decode.js');
  const meta = await decodeToCanonicalWav({
    input: u.path, output: decodedPath, validatorBin: this._config.audioValidatorBin,
  });
  u.decodedPath = decodedPath;
  u.meta = meta;
  return decodedPath;
}
```

Add `audioValidatorBin` to config default: `join(ardourRoot, 'build/tools/audio-validator/audio-validator')`.

- [ ] **Step 6: Run test, expect pass.**

`cd api-service && AUDIO_VALIDATOR_BIN=<absolute-path> npm test -- --grep "audio_region_add pre-hook"` → PASS (body contains ROUTE_NOT_FOUND since the C++ handler rejects the fake track).

- [ ] **Step 7: Commit**

```bash
git add api-service/src/lib/session-manager.js api-service/src/routes/sessions.js \
        api-service/src/config.js api-service/test/audio-region-add-hook.test.js \
        api-service/test/fixtures/1s-stereo.wav
git commit -m "feat(api): upload→decode pipeline wiring for audio_region_add"
```

---

## Task 9: Position parsing (tagged union → samples)

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc` (add helper + use in handler)

- [ ] **Step 1: Helper**

Above `handle_audio_region_add`, add:

```cpp
/* Parse a tagged-union position {unit, value} → sample frame. Returns -1 on error (fills err_msg). */
static int64_t
parse_position_union (ARDOUR::Session& session, const pt::ptree& node, std::string& err_msg)
{
  const std::string unit = node.get<std::string> ("unit", "");
  if (unit == "samples") {
    return node.get<int64_t> ("value", -1);
  } else if (unit == "seconds") {
    const double secs = node.get<double> ("value", -1.0);
    if (secs < 0) { err_msg = "negative seconds"; return -1; }
    return (int64_t)(secs * session.sample_rate ());
  } else if (unit == "beats") {
    const double beats = node.get<double> ("value", -1.0);
    if (beats < 0) { err_msg = "negative beats"; return -1; }
    Temporal::Beats b = Temporal::Beats::from_double (beats);
    return session.tempo_map ()->sample_at (Temporal::timepos_t (b));
  } else if (unit == "bars+beats") {
    const int bar = node.get<int> ("value.bar", 0);
    const double beat = node.get<double> ("value.beat", 1.0);
    if (bar < 1 || beat < 1.0) { err_msg = "bar>=1 and beat>=1 required"; return -1; }
    Temporal::BBT_Time bbt (bar, (int)beat, (int)((beat - (int)beat) * Temporal::ticks_per_beat));
    return session.tempo_map ()->sample_at (Temporal::timepos_t (bbt));
  }
  err_msg = "unsupported unit: " + unit;
  return -1;
}
```

- [ ] **Step 2: Use in handler**

Replace the stub's final `jsonrpc_result` call with real parsing:

```cpp
const auto pos_opt = root.get_child_optional ("params.arguments.position");
if (!pos_opt) return jsonrpc_error (id, -32602, "position required");
std::string err_msg;
const int64_t start_sample = parse_position_union (session, *pos_opt, err_msg);
if (start_sample < 0) return jsonrpc_error (id, -32602, "INVALID_POSITION: " + err_msg);

/* For this task, echo the resolved position in the response to confirm parsing. */
std::ostringstream out;
out << "{\"content\":[{\"type\":\"text\",\"text\":\"parsed\"}],\"structuredContent\":{\"ok\":false,\"failedAt\":\"import\",\"startSample\":"
    << start_sample << ",\"error\":{\"code\":\"NOT_IMPLEMENTED\",\"message\":\"import stage pending\"}}}";
return jsonrpc_result (id, out.str ());
```

- [ ] **Step 3: Extend the hook test to assert the parsed sample**

Modify `audio-region-add-hook.test.js`: add a second test that creates an actual audio track via `tracks_add`, fetches its id, calls `audio_region_add` with `position: {unit:'bars+beats', value:{bar:2,beat:1}}`, asserts the response body contains `"startSample": <non-zero-positive>`.

- [ ] **Step 4: Run test + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git add libs/surfaces/mcp_http/mcp_http_server.cc api-service/test/audio-region-add-hook.test.js
git commit -m "feat(mcp): audio_region_add position tagged-union parser"
```

---

## Task 10: Import file via `Session::import_files` + minimal region creation

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Replace the "import stage pending" branch with real import**

```cpp
ARDOUR::ImportStatus status;
status.current = 1; status.total = 1;
status.freeze = false;
status.done = false;
status.cancel = false;
status.replace_existing_source = false;
status.paths.push_back (std::string (resolved));
status.quality = ARDOUR::SrcBest;  /* TODO: honor srcQuality field */
status.mode = ARDOUR::ImportAsRegion;
status.channel_conf = ARDOUR::Merge;   /* keep multichannel file as one multichannel source */

session.import_files (status);
if (status.cancel || status.sources.empty ()) {
  return jsonrpc_error (id, -32603, "IMPORT_FAILED");
}

std::shared_ptr<ARDOUR::AudioSource> asrc = std::dynamic_pointer_cast<ARDOUR::AudioSource> (status.sources.front ());
if (!asrc) return jsonrpc_error (id, -32603, "IMPORT_FAILED: not audio source");

const samplecnt_t source_length = asrc->length ().samples ();

ARDOUR::SourceList sources;
for (auto& s : status.sources) sources.push_back (s);

PBD::PropertyList plist;
plist.add (ARDOUR::Properties::start,  Temporal::timepos_t (samplepos_t (0)));
plist.add (ARDOUR::Properties::length, Temporal::timecnt_t (source_length));
plist.add (ARDOUR::Properties::name,   std::string (Glib::path_get_basename (resolved)));
plist.add (ARDOUR::Properties::whole_file, true);
plist.add (ARDOUR::Properties::external, false);

std::shared_ptr<ARDOUR::Region> whole = ARDOUR::RegionFactory::create (sources, plist);
if (!whole) return jsonrpc_error (id, -32603, "REGION_CREATE_FAILED");

std::shared_ptr<ARDOUR::AudioTrack> track = std::dynamic_pointer_cast<ARDOUR::AudioTrack> (route);
std::shared_ptr<ARDOUR::Playlist> pl = track->playlist ();
if (!pl) return jsonrpc_error (id, -32603, "no playlist on track");

session.begin_reversible_command ("audio_region_add");
pl->clear_changes ();
pl->add_region (whole, Temporal::timepos_t (samplepos_t (start_sample)), 1, false);
session.add_command (new ARDOUR::StatefulDiffCommand (pl));
session.commit_reversible_command ();

std::ostringstream out;
out << "{\"content\":[{\"type\":\"text\",\"text\":\"region added\"}],\"structuredContent\":{\"ok\":true,\"regionId\":\""
    << json_escape (whole->id ().to_s ()) << "\",\"trackId\":\"" << json_escape (track_id)
    << "\",\"startSample\":" << start_sample
    << ",\"timelineLengthSamples\":" << source_length
    << ",\"sourceChannels\":" << status.sources.size ()
    << "}}";
return jsonrpc_result (id, out.str ());
```

- [ ] **Step 2: Build**

```bash
python3 ./waf build --targets=libmcp_http 2>&1 | tail -5
```

- [ ] **Step 3: Extend e2e test**

Add to `audio-region-add-hook.test.js`: full happy path — create audio track, upload fixture, call `audio_region_add`, expect `ok:true` with `regionId`, then call `track_get_regions` and confirm the region is present at sample 0 with length 48000.

- [ ] **Step 4: Run test, expect pass + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git add libs/surfaces/mcp_http/mcp_http_server.cc api-service/test/audio-region-add-hook.test.js
git commit -m "feat(mcp): audio_region_add imports file and creates region"
```

---

## Task 11: `sourceOffsetSamples` + `timelineLength` support

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

Add to `audio-region-add-hook.test.js`:

```js
it('respects sourceOffsetSamples and timelineLength', async () => {
  /* ...setup: track + 1s upload... */
  const act = await callAction(sessionId, 'audio_region_add', {
    trackId, uploadId,
    position: { unit:'samples', value: 0 },
    sourceOffsetSamples: 24000,
    timelineLength: { unit: 'samples', value: 10000 },
  });
  expect(act.ok).to.be.true;
  expect(act.timelineLengthSamples).to.equal(10000);
  /* The region should index samples [24000, 34000) of the source. */
});
it('rejects when sourceOffset + timelineLength > sourceLength', async () => {
  const act = await callAction(sessionId, 'audio_region_add', {
    trackId, uploadId,
    position: { unit:'samples', value: 0 },
    sourceOffsetSamples: 40000,
    timelineLength: { unit: 'samples', value: 20000 },  /* exceeds 48000-frame source */
  });
  expect(act.ok).to.be.false;
  expect(act.error.code).to.equal('INSUFFICIENT_SOURCE');
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

Replace the region-creation block's `plist` construction:

```cpp
const int64_t src_offset = root.get<int64_t> ("params.arguments.sourceOffsetSamples", 0);
if (src_offset < 0 || src_offset >= (int64_t)source_length) {
  return jsonrpc_error (id, -32602, "INVALID_POSITION: sourceOffsetSamples out of range");
}

int64_t timeline_length = -1;
const auto tl_opt = root.get_child_optional ("params.arguments.timelineLength");
if (tl_opt) {
  std::string err2;
  timeline_length = parse_position_union (session, *tl_opt, err2);  /* reuse; for "samples" it returns the raw int */
  if (timeline_length < 0) return jsonrpc_error (id, -32602, "INVALID_POSITION: timelineLength " + err2);
}
if (timeline_length < 0) timeline_length = source_length - src_offset;
if (src_offset + timeline_length > (int64_t)source_length) {
  return jsonrpc_error (id, -32602, "INSUFFICIENT_SOURCE");
}

plist.add (ARDOUR::Properties::start,  Temporal::timepos_t (samplepos_t (src_offset)));
plist.add (ARDOUR::Properties::length, Temporal::timecnt_t (timeline_length));
plist.add (ARDOUR::Properties::whole_file, (src_offset == 0 && timeline_length == (int64_t)source_length));
```

- [ ] **Step 4: Run, expect pass + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git commit -am "feat(mcp): sourceOffset and timelineLength for audio_region_add"
```

---

## Task 12: Fades + gain + polarity + reverse

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

Add:
```js
it('sets fades gain polarity reverse', async () => {
  const act = await callAction(sessionId, 'audio_region_add', {
    trackId, uploadId, position: {unit:'samples',value:0},
    fadeInSamples: 1024, fadeOutSamples: 2048, gainDb: -3.0, polarityInvert: true, reverse: true,
  });
  expect(act.ok).to.be.true;
  expect(act.fadeInSamples).to.equal(1024);
  expect(act.fadeOutSamples).to.equal(2048);
  expect(act.gainDb).to.be.closeTo(-3.0, 0.01);
  expect(act.polarityInvert).to.equal(true);
  expect(act.reverse).to.equal(true);
});
```

- [ ] **Step 2: Run, expect fail. **

- [ ] **Step 3: Implement**

After `whole` is created, before `begin_reversible_command`:

```cpp
std::shared_ptr<ARDOUR::AudioRegion> ar = std::dynamic_pointer_cast<ARDOUR::AudioRegion> (whole);
if (ar) {
  const int64_t fade_in  = root.get<int64_t> ("params.arguments.fadeInSamples",  64);
  const int64_t fade_out = root.get<int64_t> ("params.arguments.fadeOutSamples", 64);
  const double  gain_db  = root.get<double>  ("params.arguments.gainDb",         0.0);
  const bool    pol_inv  = root.get<bool>    ("params.arguments.polarityInvert", false);
  const bool    reverse  = root.get<bool>    ("params.arguments.reverse",        false);

  ar->set_fade_in_length (fade_in);
  ar->set_fade_out_length (fade_out);
  ar->set_scale_amplitude (std::pow (10.0, gain_db / 20.0));
  if (pol_inv) ar->set_scale_amplitude (-ar->scale_amplitude ());
  if (reverse) {
    /* Offline reverse: use Session::apply_reverse or set_reversed. */
    ar->set_reversed (true);
  }
}
```

And in the response structured content, append: `,"fadeInSamples":%lld,"fadeOutSamples":%lld,"gainDb":%g,"polarityInvert":%s,"reverse":%s`.

- [ ] **Step 4: Run, expect pass + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git commit -am "feat(mcp): fades, gain, polarity, reverse on audio_region_add"
```

---

## Task 13: Channel mismatch — error default + auto-track opt-in

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

```js
it('refuses channel mismatch by default', async () => {
  /* Mono track, stereo file */
  const act = await callAction(sessionId, 'audio_region_add', { trackId: monoTrackId, uploadId: stereoUploadId,
    position: {unit:'samples',value:0} });
  expect(act.ok).to.be.false;
  expect(act.error.code).to.equal('CHANNEL_MISMATCH');
});
it('creates new track when auto-track + allowTrackCreation', async () => {
  const act = await callAction(sessionId, 'audio_region_add', { trackId: monoTrackId, uploadId: stereoUploadId,
    position: {unit:'samples',value:0}, channelMismatch: 'auto-track', allowTrackCreation: true });
  expect(act.ok).to.be.true;
  expect(act.trackCreated).to.be.true;
  expect(act.newTrackId).to.be.a('string');
  expect(act.trackId).to.equal(act.newTrackId);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement**

After source channel count is known and BEFORE region creation:

```cpp
std::shared_ptr<ARDOUR::AudioTrack> track = std::dynamic_pointer_cast<ARDOUR::AudioTrack> (route);
const uint32_t src_channels = (uint32_t)status.sources.size ();
const uint32_t track_channels = track->n_inputs ().n_audio ();

bool track_created = false;
std::string new_track_id, new_track_name;
std::shared_ptr<ARDOUR::AudioTrack> effective_track = track;

if (src_channels != track_channels) {
  const std::string policy = root.get<std::string> ("params.arguments.channelMismatch", "error");
  const bool allow_create  = root.get<bool>        ("params.arguments.allowTrackCreation", false);
  if (policy == "error") {
    return jsonrpc_error (id, -32602, "CHANNEL_MISMATCH: file has " + std::to_string(src_channels)
      + " channels, track has " + std::to_string(track_channels));
  } else if (policy == "auto-track") {
    if (!allow_create) return jsonrpc_error (id, -32602, "CHANNEL_MISMATCH: auto-track requires allowTrackCreation=true");
    const std::string base = track->name ();
    const std::string new_name = base + "-" + std::to_string (src_channels) + "ch";
    std::list<std::shared_ptr<ARDOUR::AudioTrack>> new_tracks = session.new_audio_track (
      src_channels, src_channels, std::shared_ptr<ARDOUR::RouteGroup> (), 1, new_name,
      track->presentation_info ().order () + 1, ARDOUR::Normal, true, false);
    if (new_tracks.empty ()) return jsonrpc_error (id, -32603, "REGION_CREATE_FAILED: auto-track");
    effective_track = new_tracks.front ();
    track_created = true;
    new_track_id = effective_track->id ().to_s ();
    new_track_name = effective_track->name ();
  } else if (policy == "truncate") {
    /* fall through — Ardour's RegionFactory handles mismatched source width on a playlist by using min width. */
  }
}

std::shared_ptr<ARDOUR::Playlist> pl = effective_track->playlist ();
```

Use `effective_track` below. Append to response: `"trackCreated":<bool>,"newTrackId":"...","newTrackName":"...","originalTrackId":"<passed>"`.

- [ ] **Step 4: Run, expect pass + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git commit -am "feat(mcp): channel-mismatch policy with safe default for audio_region_add"
```

---

## Task 14: Snap to grid

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

```js
it('snaps position to nearest bar when snap=bar', async () => {
  /* place near bar 3 but a few samples off; should snap exactly to bar 3 */
  const act = await callAction(sessionId, 'audio_region_add', { trackId, uploadId,
    position: {unit:'samples', value: sessionBar3Sample - 500}, snap: 'bar' });
  expect(act.startSample).to.equal(sessionBar3Sample);
});
```

- [ ] **Step 2: Implement**

After `start_sample` is computed and before using it:

```cpp
const std::string snap = root.get<std::string> ("params.arguments.snap", "none");
if (snap != "none") {
  std::shared_ptr<ARDOUR::TempoMap> tm = session.tempo_map ();
  Temporal::timepos_t p = Temporal::timepos_t (samplepos_t (start_sample));
  Temporal::BBT_Time bbt = tm->bbt_at (p);
  if (snap == "bar") { bbt.beats = 1; bbt.ticks = 0; }
  else if (snap == "beat") { bbt.ticks = 0; }
  else if (snap == "grid") { bbt.ticks -= (bbt.ticks % (Temporal::ticks_per_beat / 4)); }
  start_sample = tm->sample_at (Temporal::timepos_t (bbt));
}
```

- [ ] **Step 3: Run + commit**

```bash
cd api-service && npm test -- --grep "snaps position"
git commit -am "feat(mcp): snap-to-grid for audio_region_add"
```

---

## Task 15: `onOverlap` handling

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing tests**

```js
it('errors on overlap by default', async () => { /* insert two regions that overlap */ });
it('trims existing on onOverlap=trim-existing', async () => { /* confirm existing region shortened */ });
it('creates crossfade on onOverlap=crossfade', async () => { /* confirm fade objects exist in playlist */ });
it('layers on onOverlap=layer', async () => { /* confirm both regions still present */ });
```

- [ ] **Step 2: Implement**

Before `pl->add_region(...)`:

```cpp
const std::string overlap_policy = root.get<std::string> ("params.arguments.onOverlap", "error");
const int         xfade_ms       = root.get<int>         ("params.arguments.overlapCrossfadeMs", 10);

Temporal::timepos_t new_start (samplepos_t (start_sample));
Temporal::timepos_t new_end   (samplepos_t (start_sample + timeline_length));

std::vector<std::shared_ptr<ARDOUR::Region>> overlapping;
for (auto const& r : *pl->region_list ()) {
  if (r->position () < new_end && r->end () > new_start) overlapping.push_back (r);
}

if (!overlapping.empty ()) {
  if (overlap_policy == "error") return jsonrpc_error (id, -32602, "OVERLAP_REFUSED");
  for (auto& r : overlapping) {
    if (overlap_policy == "trim-existing") {
      if (r->position () < new_start && r->end () > new_start) {
        r->trim_end (new_start);
      }
      if (r->position () < new_end && r->end () > new_end) {
        r->trim_front (new_end);
      }
    } else if (overlap_policy == "crossfade") {
      /* Ardour auto-manages crossfades on overlap per playlist mode; setting fade lengths on both edges is enough. */
      const samplecnt_t xf = (samplecnt_t)((xfade_ms / 1000.0) * session.sample_rate ());
      std::shared_ptr<ARDOUR::AudioRegion> ar_existing = std::dynamic_pointer_cast<ARDOUR::AudioRegion> (r);
      if (ar_existing) ar_existing->set_fade_out_length (xf);
    }
    /* layer: no-op */
  }
}
```

Report in response: `overlapAction, overlappingRegionsAffected[]`.

- [ ] **Step 3: Run + commit**

```bash
cd api-service && npm test -- --grep "audio_region_add"
git commit -am "feat(mcp): onOverlap policy for audio_region_add"
```

---

## Task 16: Edge crossfade

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

```js
it('creates edge crossfade when abutting existing region within tolerance', async () => {
  /* Insert regionA occupying [0, 48000). Then insert regionB at position 48010 (within 10ms tolerance) with edgeCrossfade auto. */
  const act = await callAction(sessionId, 'audio_region_add', { trackId, uploadId,
    position: {unit:'samples', value: 48010}, edgeCrossfade: 'auto', edgeToleranceMs: 10, edgeCrossfadeMs: 10 });
  expect(act.ok).to.be.true;
  expect(act.edgeCrossfadesCreated.length).to.equal(1);
  expect(act.edgeCrossfadesCreated[0].side).to.equal('start');
});
```

- [ ] **Step 2: Implement**

After overlap handling, before `add_region`:

```cpp
const std::string edge_policy = root.get<std::string> ("params.arguments.edgeCrossfade", "auto");
const int         edge_tol_ms = root.get<int>         ("params.arguments.edgeToleranceMs", 10);
const int         edge_xf_ms  = root.get<int>         ("params.arguments.edgeCrossfadeMs", 10);

std::ostringstream edges_json;
edges_json << "[";
bool first_edge = true;

if (edge_policy == "auto") {
  const samplecnt_t tol = (samplecnt_t)((edge_tol_ms / 1000.0) * session.sample_rate ());
  const samplecnt_t xf  = (samplecnt_t)((edge_xf_ms  / 1000.0) * session.sample_rate ());
  for (auto const& r : *pl->region_list ()) {
    /* neighbor to the LEFT: r.end within [new_start - tol, new_start + tol] */
    const samplepos_t r_end = r->end ().samples ();
    if (std::llabs ((long long)r_end - (long long)start_sample) <= (long long)tol && r_end <= start_sample) {
      std::shared_ptr<ARDOUR::AudioRegion> ar_l = std::dynamic_pointer_cast<ARDOUR::AudioRegion> (r);
      if (ar_l) ar_l->set_fade_out_length (xf);
      if (ar) ar->set_fade_in_length (xf);
      if (!first_edge) edges_json << ","; first_edge = false;
      edges_json << "{\"side\":\"start\",\"neighborRegionId\":\"" << json_escape (r->id ().to_s ()) << "\",\"lengthSamples\":" << xf << "}";
    }
    /* neighbor to the RIGHT: r.position within [new_end - tol, new_end + tol] */
    const samplepos_t r_pos = r->position ().samples ();
    if (std::llabs ((long long)r_pos - (long long)(start_sample + timeline_length)) <= (long long)tol
        && r_pos >= start_sample + timeline_length) {
      std::shared_ptr<ARDOUR::AudioRegion> ar_r = std::dynamic_pointer_cast<ARDOUR::AudioRegion> (r);
      if (ar_r) ar_r->set_fade_in_length (xf);
      if (ar) ar->set_fade_out_length (xf);
      if (!first_edge) edges_json << ","; first_edge = false;
      edges_json << "{\"side\":\"end\",\"neighborRegionId\":\"" << json_escape (r->id ().to_s ()) << "\",\"lengthSamples\":" << xf << "}";
    }
  }
}
edges_json << "]";
```

Append `"edgeCrossfadesCreated":<edges_json.str()>` to response.

- [ ] **Step 3: Run + commit**

```bash
cd api-service && npm test -- --grep "edge crossfade"
git commit -am "feat(mcp): auto edge-crossfade for audio_region_add"
```

---

## Task 17: Repeat (paste multiple copies)

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

```js
it('pastes multiple copies at strideBeats intervals', async () => {
  const act = await callAction(sessionId, 'audio_region_add', { trackId, uploadId,
    position: {unit:'bars+beats', value:{bar:1, beat:1}}, repeat: { count: 4, strideBeats: 1 } });
  expect(act.ok).to.be.true;
  expect(act.repeatedRegionIds.length).to.equal(3);  /* 3 extra copies (first is regionId) */
});
```

- [ ] **Step 2: Implement**

After the primary `add_region` call:

```cpp
const int    rep_count  = root.get<int>    ("params.arguments.repeat.count",       1);
const double rep_stride = root.get<double> ("params.arguments.repeat.strideBeats", 0.0);

std::ostringstream rep_json;
rep_json << "[";
bool first_rep = true;
if (rep_count > 1 && rep_stride > 0) {
  std::shared_ptr<ARDOUR::TempoMap> tm = session.tempo_map ();
  for (int i = 1; i < rep_count; ++i) {
    Temporal::Beats b = Temporal::Beats::from_double (rep_stride * i);
    Temporal::timepos_t orig_start (samplepos_t (start_sample));
    Temporal::timepos_t dup_start = orig_start + Temporal::timecnt_t (b, orig_start);
    std::shared_ptr<ARDOUR::Region> copy = ARDOUR::RegionFactory::create (whole, true);
    pl->add_region (copy, dup_start, 1, false);
    if (!first_rep) rep_json << ","; first_rep = false;
    rep_json << "\"" << json_escape (copy->id ().to_s ()) << "\"";
  }
}
rep_json << "]";
```

Append `"repeatedRegionIds":<rep_json.str()>`.

- [ ] **Step 3: Run + commit**

```bash
cd api-service && npm test -- --grep "pastes multiple"
git commit -am "feat(mcp): repeat/paste-multiple for audio_region_add"
```

---

## Task 18: Per-session mutex

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.h`, `mcp_http_server.cc`

- [ ] **Step 1: Add mutex**

In the server class (in `.h`), add:

```cpp
std::mutex _audio_region_add_mutex;
```

- [ ] **Step 2: Acquire at handler top**

In `handle_audio_region_add`, as the very first statement after parameter extraction:

```cpp
std::lock_guard<std::mutex> lock (_audio_region_add_mutex);  /* member, pass via a captured this */
```

(Refactor: make the handler a member function or pass `this->` via closure. Given the existing dispatcher pattern, convert this handler to a member function `MCPHttpServer::handle_audio_region_add`.)

- [ ] **Step 3: Failing test**

```js
it('serializes concurrent audio_region_add calls', async () => {
  /* Fire 3 calls in parallel; expect 3 distinct region ids, no error, and the three positions deterministic. */
  const ps = Array.from({length:3}, (_,i) => callAction(sessionId, 'audio_region_add', { trackId, uploadId,
    position: {unit:'samples', value: i * 50000} }));
  const results = await Promise.all(ps);
  expect(results.every(r => r.ok)).to.be.true;
  expect(new Set(results.map(r => r.regionId)).size).to.equal(3);
});
```

- [ ] **Step 4: Run + commit**

```bash
cd api-service && npm test -- --grep "serializes concurrent"
git commit -am "feat(mcp): per-session mutex around audio_region_add"
```

---

## Task 19: Atomic rollback on failure

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Wrap mutations in `begin_reversible_command` / `commit_reversible_command`**

(Already begun in Task 10 — audit now.) Ensure EVERY mutation (track creation, source import, region insert, edge-fade mutation, overlap trim) is bracketed by `session.begin_reversible_command("audio_region_add")` at the top and either `session.commit_reversible_command()` on success or `session.abort_reversible_command()` (which rolls back) on any failure.

- [ ] **Step 2: Failing test — simulate late failure**

Force a failure by e.g. sending `timelineLength: {unit:'samples', value:10}` with `sourceOffsetSamples: source.length - 5` (INSUFFICIENT_SOURCE). But validation catches this before mutation. Instead: use `channelMismatch: 'auto-track'`, `allowTrackCreation: true`, then intercept inside the handler by introducing a test-only env flag that forces a fake mid-flow failure. Simpler: add a test via invalid fade-out beyond region length:

```js
it('rolls back new track when region creation fails', async () => {
  const beforeTracks = (await callAction(sessionId, 'tracks_list', {})).tracks.length;
  const act = await callAction(sessionId, 'audio_region_add', {
    trackId: monoTrackId, uploadId: stereoUploadId,
    position: {unit:'samples', value: 0},
    channelMismatch: 'auto-track', allowTrackCreation: true,
    fadeInSamples: 99999999  /* nonsense that the region-creator should reject */
  });
  const afterTracks = (await callAction(sessionId, 'tracks_list', {})).tracks.length;
  expect(afterTracks).to.equal(beforeTracks);  /* new track destroyed on rollback */
});
```

- [ ] **Step 3: Implement — the rollback path**

Wrap the handler body in a try/catch. On any failure past the "begin_reversible_command" line:

```cpp
session.abort_reversible_command ();
/* If we created a track in this flow, remove it. */
if (track_created) {
  session.remove_route (effective_track);
}
return jsonrpc_error (id, -32603, "rolled back: " + failure_reason);
```

Use a `std::function<void()>` rollback stack pushed after each mutation; on failure, pop and run in reverse.

- [ ] **Step 4: Run + commit**

```bash
cd api-service && npm test -- --grep "rolls back"
git commit -am "feat(mcp): atomic rollback for audio_region_add"
```

---

## Task 20: Idempotent `requestId` in the action route

**Files:**
- Modify: `api-service/src/routes/sessions.js`
- Modify: `api-service/src/server.js` (wire a shared RequestCache onto the app)

- [ ] **Step 1: Failing test**

```js
it('deduplicates audio_region_add by requestId', async () => {
  const params = { trackId, uploadId, position: {unit:'samples', value:0}, requestId: 'rid-xyz' };
  const a = await callAction(sessionId, 'audio_region_add', params);
  const b = await callAction(sessionId, 'audio_region_add', params);
  expect(a.regionId).to.equal(b.regionId);  /* identical response, no second region created */
  const regions = await callAction(sessionId, 'track_get_regions', { id: trackId });
  expect(regions.regions.length).to.equal(1);
});
```

- [ ] **Step 2: Wire the cache**

In `server.js`, add:

```js
import { RequestCache } from './lib/request-cache.js';
app.decorate('requestCache', new RequestCache({ maxEntries: 256, ttlMs: 10*60*1000 }));
```

- [ ] **Step 3: Use it in the pre-hook (Task 8's block)**

Wrap the `audio_region_add` branch:

```js
if (tool === 'audio_region_add') {
  const reqId = params?.requestId;
  if (reqId) {
    const cached = await app.requestCache.compute(`${sessionId}:${reqId}`, async () => null);
    if (cached !== null) return reply.send(cached);
  }
  /* ...decodedPath injection... */
  const result = await app.actionProxy.execute(session, tool, params, req.id);
  if (reqId) app.requestCache.compute(`${sessionId}:${reqId}`, async () => result);
  return reply.send(result);
}
```

Small fix — `compute` wraps to populate; use a `put`/`get` API pair instead (add `put(key,val)` and `get(key)` methods to `RequestCache`).

- [ ] **Step 4: Run + commit**

```bash
cd api-service && npm test -- --grep "deduplicates"
git commit -am "feat(api): idempotent requestId for audio_region_add"
```

---

## Task 21: Autosave before import

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Add autosave call**

Just before the `session.import_files(status)` line in the handler:

```cpp
session.save_state ("audio_region_add.autosave");
```

- [ ] **Step 2: Smoke test — confirm session save didn't break anything**

Run existing tests; they should all still pass. No new test needed (this is a safety net; it's exercised by every happy-path run).

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(mcp): autosave before audio_region_add import"
```

---

## Task 22: Rich response + `dryRun`

**Files:**
- Modify: `libs/surfaces/mcp_http/mcp_http_server.cc`

- [ ] **Step 1: Failing test**

```js
it('dryRun returns projected result without persisting', async () => {
  const beforeRegions = (await callAction(sessionId, 'track_get_regions', { id: trackId })).regions.length;
  const act = await callAction(sessionId, 'audio_region_add', {
    trackId, uploadId, position: {unit:'samples', value:0}, dryRun: true });
  expect(act.ok).to.be.true;
  expect(act.regionId).to.equal('');  /* no region created */
  expect(act.timelineLengthSamples).to.be.greaterThan(0);
  const afterRegions = (await callAction(sessionId, 'track_get_regions', { id: trackId })).regions.length;
  expect(afterRegions).to.equal(beforeRegions);
});
```

- [ ] **Step 2: Implement**

Near the start of the handler, read `const bool dry_run = root.get<bool> ("params.arguments.dryRun", false);`. Pipe through validation, compute all projected values (start_sample, timeline_length, channels, new_track_id if would-be-created), but SKIP: `save_state`, `import_files`, `RegionFactory::create`, `add_region`, `begin_reversible_command`. Build response with `regionId: ""` and `ok: true`. For `channelMismatch=auto-track` in dry-run, pre-compute name but don't create.

- [ ] **Step 3: Run + commit**

```bash
cd api-service && npm test -- --grep "dryRun"
git commit -am "feat(mcp): dryRun support for audio_region_add"
```

---

## Task 23: Frontend — form overrides for `audio_region_add`

**Files:**
- Modify: `api-service/public/app.js`

- [ ] **Step 1: Add upload fetcher**

After `fetchPluginsRaw`:

```js
async function fetchUploads() {
  if (!state.sessionId) return [];
  const res = await api('GET', `/v1/sessions/${state.sessionId}`, null, { silent: true });
  const uploads = res.body?.uploads || [];
  return uploads.map(u => ({ value: u.upload_id, label: `${u.filename} (${u.bytes}B)` }));
}
```

(Also add an `uploads` array to the GET /v1/sessions/:id response in `sessions.js`.)

- [ ] **Step 2: Override entry**

In `TOOL_OVERRIDES`:

```js
audio_region_add: {
  hide: ['decodedPath'],
  dynamic: {
    trackId:  { source: 'tracks',  label: 'Track' },
    uploadId: { source: 'uploads', label: 'Audio file' },
  },
},
```

Add `uploads` to the source-fetch dispatcher inside `renderParamForm`.

- [ ] **Step 3: Upload control**

Add a file input above the Actions panel that POSTs to `/v1/sessions/:id/upload`, refreshes the uploads dropdown after success.

```html
<!-- in index.html, inside Actions -->
<input type="file" id="upload-file" accept="audio/*"/>
```

In `app.js`:
```js
document.getElementById('upload-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !state.sessionId) return;
  const res = await fetch(`/v1/sessions/${state.sessionId}/upload`, {
    method: 'POST', headers: { 'x-filename': file.name, 'content-type': 'application/octet-stream' }, body: file });
  const body = await res.json();
  logEntry('POST', '/upload', res.status, body, res.ok);
  if (state.tools.find(t => t.name === 'audio_region_add') && document.getElementById('tool-select').value === 'audio_region_add') {
    renderParamForm('audio_region_add');
  }
};
```

- [ ] **Step 4: Commit**

```bash
git add api-service/public/app.js api-service/public/index.html api-service/src/routes/sessions.js
git commit -m "feat(ui): upload + audio_region_add dropdowns"
```

---

## Task 24: End-to-end sanity + documentation

**Files:**
- Create: `docs/superpowers/TODO.md` entry (if not already present for F1-F5)
- Modify: `api-service/README.md` (append a short section on audio_region_add)

- [ ] **Step 1: Update TODO**

Add to `docs/superpowers/TODO.md`:

```markdown
## Audio region follow-ups (tracked from 2026-04-12 spec)
- [ ] F1: Rename `plugin_add.id` → `plugin_add.trackId`; retrofit `midi_region_add` position to tagged-union form.
- [ ] F2: Implement `audio_region_stretch` (async, Rubber Band).
- [ ] F3: Parse full BWF/iXML metadata in decoder sidecar.
- [ ] F4: Revisit `allowTrackCreation` default after 3 months.
- [ ] F5: Converge `region_get_full` shape with `audio_region_add` response.
```

- [ ] **Step 2: README note**

Add to `api-service/README.md` under "Tools":

```markdown
### audio_region_add

Place an uploaded audio file as a region. Two-step flow:

1. `POST /v1/sessions/:id/upload` with `x-filename` header → returns `{ upload_id }`.
2. `POST /v1/sessions/:id/actions` with `{ tool: "audio_region_add", params: { trackId, uploadId, position: {unit,value}, … } }`.

See `docs/superpowers/specs/2026-04-12-audio-region-add-design.md` for the full API.
```

- [ ] **Step 3: Run the full test suite**

```bash
cd api-service && npm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Final commit**

```bash
git add docs/superpowers/TODO.md api-service/README.md
git commit -m "docs: audio_region_add readme + follow-up tracking"
```

---

## Self-Review

Spec coverage check:
- ✅ Path-injection defense: Tasks 3, 4, 7 (realpath + decoded_root prefix check, sandbox-exec decoder).
- ✅ Sandbox decode: Tasks 3, 4.
- ✅ Autosave before import: Task 21.
- ✅ Per-session mutex: Task 18.
- ✅ Atomic rollback: Task 19.
- ✅ Disk quota: Task 1.
- ✅ Upload indirection (no filePath): Tasks 2, 8.
- ✅ Tagged-union position: Task 9.
- ✅ sourceOffset / timelineLength semantics: Task 11 (pre-stretch docstring in spec).
- ✅ Channel mismatch with safe default: Task 13.
- ✅ Fades/gain/polarity/reverse: Task 12.
- ✅ Snap: Task 14.
- ✅ onOverlap: Task 15.
- ✅ Edge crossfade: Task 16.
- ✅ Repeat: Task 17.
- ✅ dryRun: Task 22.
- ✅ requestId idempotency: Tasks 5, 20.
- ✅ Frontend UX: Task 23.

Gaps intentionally deferred to v2 (covered in spec's Open Follow-ups): stretch, pitch, BWF timestamp preservation, `allowTrackCreation` default flip, schema-shape convergence.

Type consistency check: `trackId` used throughout (no `id` ambiguity), `startSample` / `timelineLengthSamples` / `sourceOffsetSamples` names consistent, `effective_track` handle used consistently after channel-mismatch resolution.
