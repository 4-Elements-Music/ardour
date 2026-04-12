# Node.js Session Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js session manager that spawns persistent arlua instances with MCP HTTP surfaces, proxies AI client requests, and exposes a browser-based developer test app.

**Architecture:** Fastify API service with per-session state. Each session spawns `luasession` running `mcp_host.lua` with a unique `MCP_HTTP_PORT` env var. The `ActionProxy` forwards MCP tool calls to the right Ardour instance. All stateful modules use constructor dependency injection for testability, with a `FakeArdourProcess` helper for integration tests.

**Tech Stack:** Node.js 20+, Fastify v5, Ajv, p-queue, @fastify/multipart, @fastify/static, ffmpeg/ffprobe (external).

**Spec:** `docs/superpowers/specs/2026-04-11-session-manager-design.md`

**C++ Prerequisites (DONE, commits `cd9d622071` and `f2760863e6`):**
- `MCP_HTTP_PORT` env var override in `mcp_http.cc`
- `api-service/lua/mcp_host.lua` session host script
- `session/lua_eval` MCP tool

---

### Task 1: Install New Dependencies

Add the three required npm packages to `api-service/package.json`.

**Files:**
- Modify: `api-service/package.json`

- [ ] **Step 1: Install packages**

```bash
cd /Users/shanekoss/Repos/ardour/api-service
npm install @fastify/multipart @fastify/static p-queue
```

- [ ] **Step 2: Verify package.json dependencies**

Check that `package.json` now lists (in addition to existing `ajv`, `fastify`, `uuid`):
- `@fastify/multipart`
- `@fastify/static`
- `p-queue`

Run:
```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -3
```
Expected: All 83 existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add api-service/package.json api-service/package-lock.json
git commit -m "feat: add @fastify/multipart, @fastify/static, p-queue"
```

---

### Task 2: Extend config.js with Session Configuration

Add the new config keys from the spec.

**Files:**
- Modify: `api-service/src/config.js`

- [ ] **Step 1: Add new config fields**

Append to `api-service/src/config.js` after existing fields (before the closing `}`):

```js
  // Sessions
  allowGui: process.env.ALLOW_GUI === 'true',
  maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10),
  sessionIdleTimeoutMs: parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '1800000', 10),
  sessionStartupTimeoutMs: parseInt(process.env.SESSION_STARTUP_TIMEOUT_MS || '30000', 10),
  sessionHealthIntervalMs: parseInt(process.env.SESSION_HEALTH_INTERVAL_MS || '30000', 10),
  sessionAutoSaveIntervalMs: parseInt(process.env.SESSION_AUTO_SAVE_MS || '300000', 10),
  mcpPortRangeStart: parseInt(process.env.MCP_PORT_RANGE_START || '4821', 10),
  mcpPortRangeEnd: parseInt(process.env.MCP_PORT_RANGE_END || '4920', 10),
  luasessionBin: resolve(ARDOUR_ROOT, 'build/luasession/luasession'),
  ardourGuiBin: process.env.ARDOUR_GUI_BIN || 'ardour8',
  mcpHostLua: resolve(ARDOUR_ROOT, 'api-service/lua/mcp_host.lua'),
  sessionsDir: process.env.SESSIONS_DIR || '/tmp/ardour-sessions',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || '104857600', 10),
  actionQueueDepth: parseInt(process.env.ACTION_QUEUE_DEPTH || '20', 10),
  actionQueueTimeoutMs: parseInt(process.env.ACTION_QUEUE_TIMEOUT_MS || '120000', 10),
  actionTimeoutMs: parseInt(process.env.ACTION_TIMEOUT_MS || '10000', 10),
  luaEvalMaxBytes: parseInt(process.env.LUA_EVAL_MAX_BYTES || '65536', 10),
  luaEvalTimeoutMs: parseInt(process.env.LUA_EVAL_TIMEOUT_MS || '30000', 10),
  logRingBufferSize: parseInt(process.env.LOG_RING_BUFFER_SIZE || '10000', 10),
  analysisTimeoutMs: parseInt(process.env.ANALYSIS_TIMEOUT_MS || '600000', 10),
  maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '100', 10),
  maxSessionUploadBytes: parseInt(process.env.MAX_SESSION_UPLOAD_BYTES || '1073741824', 10),
  maxSessionExportBytes: parseInt(process.env.MAX_SESSION_EXPORT_BYTES || '2147483648', 10),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
```

- [ ] **Step 2: Verify tests still pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -3
```
Expected: All 83 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add api-service/src/config.js
git commit -m "feat: extend config with session manager settings"
```

---

### Task 3: Port Pool Module

Implements port allocation and release with a startup scan for orphaned processes.

**Files:**
- Create: `api-service/src/lib/port-pool.js`
- Create: `api-service/src/lib/port-pool.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/lib/port-pool.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  it('allocates lowest available port in range', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    assert.equal(pool.allocate(), 5000);
    assert.equal(pool.allocate(), 5001);
  });

  it('releases ports back to pool', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    const p = pool.allocate();
    pool.release(p);
    assert.equal(pool.allocate(), 5000);
  });

  it('returns null when all ports exhausted', () => {
    const pool = new PortPool({ start: 5000, end: 5001, portChecker: async () => false });
    pool.allocate();
    pool.allocate();
    assert.equal(pool.allocate(), null);
  });

  it('release is idempotent', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    pool.release(5005);
    pool.release(5005);
    assert.equal(pool.allocate(), 5000);
  });

  it('availableCount reflects state', () => {
    const pool = new PortPool({ start: 5000, end: 5002, portChecker: async () => false });
    assert.equal(pool.availableCount(), 3);
    pool.allocate();
    assert.equal(pool.availableCount(), 2);
  });

  it('scan marks occupied ports unavailable', async () => {
    const occupied = new Set([5002]);
    const pool = new PortPool({
      start: 5000, end: 5010,
      portChecker: async (port) => occupied.has(port),
    });
    await pool.scan();
    assert.equal(pool.allocate(), 5000);
    assert.equal(pool.allocate(), 5001);
    assert.equal(pool.allocate(), 5003); // skips 5002
  });

  it('constructor rejects invalid range', () => {
    assert.throws(() => new PortPool({ start: 5010, end: 5000, portChecker: async () => false }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 PortPool | head -5
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement port-pool.js**

Create `api-service/src/lib/port-pool.js`:

```js
import { createConnection } from 'net';

/**
 * Check whether a TCP port is in use by trying to connect.
 * Returns true if something is listening on the port.
 */
export async function tcpPortInUse(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let done = false;
    const cleanup = (inUse) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => cleanup(true));
    socket.on('timeout', () => cleanup(false));
    socket.on('error', () => cleanup(false));
  });
}

export class PortPool {
  constructor({ start, end, portChecker = tcpPortInUse } = {}) {
    if (typeof start !== 'number' || typeof end !== 'number' || start > end) {
      throw new Error(`Invalid port range: start=${start} end=${end}`);
    }
    this._start = start;
    this._end = end;
    this._occupied = new Set();
    this._portChecker = portChecker;
  }

  /**
   * Scan the range in parallel, marking in-use ports as occupied.
   */
  async scan() {
    const ports = [];
    for (let p = this._start; p <= this._end; p++) ports.push(p);
    const results = await Promise.all(ports.map(async (p) => [p, await this._portChecker(p)]));
    for (const [p, inUse] of results) {
      if (inUse) this._occupied.add(p);
    }
  }

  /**
   * Allocate the lowest available port in the range. Returns null if exhausted.
   */
  allocate() {
    for (let p = this._start; p <= this._end; p++) {
      if (!this._occupied.has(p)) {
        this._occupied.add(p);
        return p;
      }
    }
    return null;
  }

  /**
   * Release a port back to the pool. Idempotent.
   */
  release(port) {
    this._occupied.delete(port);
  }

  /**
   * Number of ports currently free.
   */
  availableCount() {
    return (this._end - this._start + 1) - this._occupied.size;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass (83 existing + 7 new = 90).

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/port-pool.js api-service/src/lib/port-pool.test.js
git commit -m "feat: add port pool with startup scan"
```

---

### Task 4: Log Ring Buffer Module

Bounded per-session log storage with monotonic cursor-based retrieval.

**Files:**
- Create: `api-service/src/lib/log-buffer.js`
- Create: `api-service/src/lib/log-buffer.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/lib/log-buffer.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from './log-buffer.js';

describe('LogBuffer', () => {
  it('appends lines with monotonic sequence numbers', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('first');
    buf.append('second');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[0].text, 'first');
    assert.equal(lines[1].seq, 2);
  });

  it('since cursor returns only newer lines', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('a');
    buf.append('b');
    buf.append('c');
    const { lines, cursor } = buf.since(1);
    assert.deepEqual(lines.map(l => l.text), ['b', 'c']);
    assert.equal(cursor, 3);
  });

  it('evicts oldest when maxLines exceeded', () => {
    const buf = new LogBuffer({ maxLines: 3 });
    buf.append('1'); buf.append('2'); buf.append('3'); buf.append('4');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].text, '2');
    assert.equal(lines[0].seq, 2);
  });

  it('since older than buffer returns all available with gap silent', () => {
    const buf = new LogBuffer({ maxLines: 3 });
    for (let i = 1; i <= 10; i++) buf.append(`line ${i}`);
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].text, 'line 8');
  });

  it('splits multi-line input into separate entries', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('one\ntwo\nthree');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.text), ['one', 'two', 'three']);
  });

  it('returns empty when no new lines', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('x');
    const { lines, cursor } = buf.since(1);
    assert.equal(lines.length, 0);
    assert.equal(cursor, 1);
  });

  it('cursor is current seq when nothing yet', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    const { cursor } = buf.since(0);
    assert.equal(cursor, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 LogBuffer | head -3
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement log-buffer.js**

Create `api-service/src/lib/log-buffer.js`:

```js
/**
 * Bounded ring buffer for per-session log capture.
 * Each appended line gets a monotonically-increasing sequence number.
 * When maxLines is exceeded, oldest lines are evicted.
 */
export class LogBuffer {
  constructor({ maxLines = 10000 } = {}) {
    this._maxLines = maxLines;
    this._lines = []; // [{ seq, text }]
    this._nextSeq = 1;
  }

  /**
   * Append text (may contain newlines — split into separate entries).
   */
  append(text) {
    if (text == null || text === '') return;
    const parts = String(text).split('\n');
    for (const p of parts) {
      if (p === '' && parts.length > 1 && p === parts[parts.length - 1]) continue; // trailing newline
      this._lines.push({ seq: this._nextSeq++, text: p });
    }
    while (this._lines.length > this._maxLines) {
      this._lines.shift();
    }
  }

  /**
   * Return lines with seq > cursor, plus the new cursor value.
   */
  since(cursor) {
    const c = parseInt(cursor, 10) || 0;
    const lines = this._lines.filter(l => l.seq > c);
    const newCursor = this._lines.length > 0 ? this._lines[this._lines.length - 1].seq : c;
    return { lines, cursor: newCursor };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -3
```
Expected: All tests pass (90 existing + 7 new = 97).

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/log-buffer.js api-service/src/lib/log-buffer.test.js
git commit -m "feat: add log ring buffer with sequence cursor"
```

---

### Task 5: FakeArdourProcess Test Helper

An HTTP server that simulates an Ardour MCP HTTP endpoint for integration tests.

**Files:**
- Create: `api-service/test/helpers/fake-ardour.js`
- Create: `api-service/test/helpers/fake-clock.js`

- [ ] **Step 1: Implement fake-clock.js**

Create `api-service/test/helpers/fake-clock.js`:

```js
/**
 * Injectable clock for testing time-dependent behavior without real timers.
 * Tests call advance(ms) to move virtual time forward.
 */
export class FakeClock {
  constructor(startTime = 0) {
    this._now = startTime;
    this._timers = new Map();
    this._nextId = 1;
  }

  now() { return this._now; }

  setTimeout(fn, ms) {
    const id = this._nextId++;
    this._timers.set(id, { fireAt: this._now + ms, fn, repeating: false, interval: 0 });
    return id;
  }

  clearTimeout(id) { this._timers.delete(id); }

  setInterval(fn, ms) {
    const id = this._nextId++;
    this._timers.set(id, { fireAt: this._now + ms, fn, repeating: true, interval: ms });
    return id;
  }

  clearInterval(id) { this._timers.delete(id); }

  /**
   * Advance virtual time by ms, firing any timers that come due.
   */
  advance(ms) {
    const target = this._now + ms;
    while (true) {
      let nextTimer = null;
      let nextId = null;
      for (const [id, t] of this._timers) {
        if (t.fireAt <= target && (nextTimer == null || t.fireAt < nextTimer.fireAt)) {
          nextTimer = t;
          nextId = id;
        }
      }
      if (!nextTimer) break;
      this._now = nextTimer.fireAt;
      if (nextTimer.repeating) {
        nextTimer.fireAt = this._now + nextTimer.interval;
      } else {
        this._timers.delete(nextId);
      }
      nextTimer.fn();
    }
    this._now = target;
  }
}
```

- [ ] **Step 2: Implement fake-ardour.js**

Create `api-service/test/helpers/fake-ardour.js`:

```js
import { createServer } from 'http';

/**
 * Fake Ardour MCP HTTP server for tests.
 *
 * Usage:
 *   const fake = new FakeArdourProcess();
 *   await fake.start(4900);
 *   fake.setToolResponse('hello_world', { text: 'hi' });
 *   // ... make requests to http://127.0.0.1:4900/mcp
 *   await fake.stop();
 */
export class FakeArdourProcess {
  constructor() {
    this._server = null;
    this._port = null;
    this._toolResponses = new Map();
    this._simulateDelay = 0;
    this._simulateCrash = false;
    this._simulateTimeout = false;
    this._requestCount = 0;
  }

  setToolResponse(tool, structuredContent) {
    this._toolResponses.set(tool, structuredContent);
  }

  simulateDelay(ms) { this._simulateDelay = ms; }
  simulateCrash() { this._simulateCrash = true; }
  simulateTimeout(enabled = true) { this._simulateTimeout = enabled; }

  get requestCount() { return this._requestCount; }

  async start(port) {
    this._port = port;
    return new Promise((resolve, reject) => {
      this._server = createServer(async (req, res) => {
        this._requestCount++;
        if (this._simulateTimeout) return; // never respond
        if (this._simulateDelay) {
          await new Promise(r => setTimeout(r, this._simulateDelay));
        }
        if (this._simulateCrash) {
          req.socket.destroy();
          return;
        }
        let body = '';
        req.on('data', c => body += c.toString());
        req.on('end', () => {
          try {
            const msg = JSON.parse(body);
            const toolName = msg.params?.name || '';
            const structured = this._toolResponses.get(toolName) ?? { ok: true };
            const result = {
              jsonrpc: '2.0',
              id: msg.id ?? null,
              result: {
                content: [{ type: 'text', text: JSON.stringify(structured) }],
                structuredContent: structured,
              },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
      this._server.listen(port, '127.0.0.1', () => resolve());
      this._server.on('error', reject);
    });
  }

  async stop() {
    if (this._server) {
      return new Promise(resolve => this._server.close(resolve));
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api-service/test/helpers/fake-clock.js api-service/test/helpers/fake-ardour.js
git commit -m "feat: add FakeArdourProcess and FakeClock test helpers"
```

---

### Task 6: Extract MCP Tool Schemas to JSON

Build script that extracts tool definitions from `tools_json.inc` for Node.js consumption.

**Files:**
- Create: `api-service/scripts/extract-tools.js`
- Create: `api-service/src/schemas/mcp-tools.json` (generated)
- Modify: `api-service/package.json` (add script)

- [ ] **Step 1: Create the extractor script**

Create `api-service/scripts/extract-tools.js`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INC_PATH = resolve(__dirname, '../../libs/surfaces/mcp_http/tools_json.inc');
const OUT_PATH = resolve(__dirname, '../src/schemas/mcp-tools.json');

const src = readFileSync(INC_PATH, 'utf8');

// tools_json.inc is wrapped in R"mcp( ... )mcp"
const match = src.match(/R"mcp\(([\s\S]*?)\)mcp"/);
if (!match) {
  console.error('Could not find R"mcp(...)mcp" block in', INC_PATH);
  process.exit(1);
}

const json = match[1].trim();
const parsed = JSON.parse(json);

if (!parsed.tools || !Array.isArray(parsed.tools)) {
  console.error('Expected { tools: [...] } structure');
  process.exit(1);
}

writeFileSync(OUT_PATH, JSON.stringify(parsed, null, 2) + '\n');
console.log(`Extracted ${parsed.tools.length} tools to ${OUT_PATH}`);
```

- [ ] **Step 2: Add npm script**

Edit `api-service/package.json` — add to the `scripts` object:

```json
    "extract-tools": "node scripts/extract-tools.js",
```

- [ ] **Step 3: Run it**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm run extract-tools
```
Expected: `Extracted N tools to .../mcp-tools.json`

Verify the file exists:
```bash
ls -la /Users/shanekoss/Repos/ardour/api-service/src/schemas/mcp-tools.json
head -20 /Users/shanekoss/Repos/ardour/api-service/src/schemas/mcp-tools.json
```
Expected: Valid JSON with a `tools` array.

- [ ] **Step 4: Commit**

```bash
git add api-service/scripts/extract-tools.js api-service/src/schemas/mcp-tools.json api-service/package.json
git commit -m "feat: extract MCP tool schemas to JSON for Node.js"
```

---

### Task 7: Session Manager — Core (create/get/list/destroy)

The main session lifecycle manager. Spawns luasession processes with mcp_host.lua.

**Files:**
- Create: `api-service/src/lib/session-manager.js`
- Create: `api-service/src/lib/session-manager.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/lib/session-manager.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { SessionManager } from './session-manager.js';
import { PortPool } from './port-pool.js';
import { FakeClock } from '../../test/helpers/fake-clock.js';
import { FakeArdourProcess } from '../../test/helpers/fake-ardour.js';

function makeConfig(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'sm-test-'));
  return {
    sessionsDir: tmp,
    maxConcurrentSessions: 5,
    sessionStartupTimeoutMs: 5000,
    actionTimeoutMs: 2000,
    actionQueueDepth: 20,
    actionQueueTimeoutMs: 30000,
    mcpPortRangeStart: 5900,
    mcpPortRangeEnd: 5920,
    logRingBufferSize: 100,
    luasessionBin: '/bin/echo',
    mcpHostLua: '/tmp/mcp_host.lua',
    ardourRoot: '/tmp',
    ...overrides,
  };
}

function makeFakeSpawner(mockArdour) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 99999;
    child.kill = () => child.emit('exit', 0, null);
    // Simulate ready marker after 10ms
    setTimeout(() => child.stdout.emit('data', Buffer.from('MCP_HTTP_READY\n')), 10);
    return child;
  };
}

describe('SessionManager.create', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('spawns a session with allocated port', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5900);

    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5901 });
    const clock = new FakeClock(1000);
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(fake),
      httpClient: globalThis.fetch,
    });

    const result = await sm.create({ sessionName: 'test', sampleRate: 48000 });
    assert.ok(result.session_id);
    assert.equal(result.status, 'starting');

    // Wait for ready
    await new Promise(r => setTimeout(r, 50));
    const session = sm.get(result.session_id);
    assert.ok(session);
    assert.equal(session.port, 5900);
  });

  it('rejects when max concurrent reached', async () => {
    const config = makeConfig({ maxConcurrentSessions: 1 });
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    await sm.create({ sessionName: 's1' });
    await assert.rejects(
      () => sm.create({ sessionName: 's2' }),
      /MAX_SESSIONS/
    );
  });

  it('list and get work', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    assert.ok(sm.get(r.session_id));
    assert.equal(sm.listAll().length, 1);
    assert.equal(sm.activeCount(), 1);
  });

  it('destroy removes session and releases port', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    await sm.destroy(r.session_id);
    const session = sm.get(r.session_id);
    // Session either gone or in stopped/dead state
    if (session) {
      assert.ok(['stopping', 'stopped', 'dead'].includes(session.status));
    }
    assert.equal(portPool.availableCount(), 6);
  });

  it('destroy is idempotent', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    await sm.destroy(r.session_id);
    await sm.destroy(r.session_id); // should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 SessionManager | head -3
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement session-manager.js**

Create `api-service/src/lib/session-manager.js`:

```js
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import PQueue from 'p-queue';
import { LogBuffer } from './log-buffer.js';

/**
 * SessionManager — spawns luasession with mcp_host.lua, tracks sessions,
 * handles graceful shutdown and crash recovery.
 *
 * Dependencies (injected for testability):
 *   config      - required config object
 *   portPool    - PortPool instance
 *   clock       - { now(), setTimeout, clearTimeout, setInterval, clearInterval } or null (use real)
 *   spawner     - child_process.spawn-compatible function
 *   httpClient  - fetch-compatible function
 */
export class SessionManager {
  constructor({ config, portPool, clock = null, spawner, httpClient }) {
    if (!config) throw new Error('config required');
    if (!portPool) throw new Error('portPool required');
    if (!spawner) throw new Error('spawner required');
    if (!httpClient) throw new Error('httpClient required');
    this._config = config;
    this._portPool = portPool;
    this._clock = clock;
    this._spawner = spawner;
    this._httpClient = httpClient;
    this._sessions = new Map(); // id -> session object
  }

  _now() { return this._clock ? this._clock.now() : Date.now(); }

  async create({
    sampleRate = 48000,
    sessionName = null,
    tempo = 120,
    timeSignature = { numerator: 4, denominator: 4 },
    gui = false,
  } = {}) {
    if (this.activeCount() >= this._config.maxConcurrentSessions) {
      const err = new Error('Max concurrent sessions reached');
      err.code = 'MAX_SESSIONS';
      throw err;
    }

    const id = randomUUID();
    const name = this._sanitizeSessionName(sessionName || `session-${id.slice(0, 8)}`);
    const port = this._portPool.allocate();
    if (port == null) {
      const err = new Error('No ports available');
      err.code = 'NO_PORTS';
      throw err;
    }

    const sessionDir = resolve(this._config.sessionsDir, id);
    mkdirSync(sessionDir, { recursive: true });

    const session = {
      id,
      status: 'starting',
      sessionName: name,
      sampleRate,
      tempo,
      timeSignature,
      gui: gui && this._config.allowGui,
      port,
      mcpBaseUrl: `http://127.0.0.1:${port}/mcp`,
      child: null,
      pid: null,
      sessionDir,
      createdAt: this._now(),
      lastActivity: this._now(),
      lastSave: this._now(),
      healthFailCount: 0,
      exitCode: null,
      stderrTail: [],
      logBuffer: new LogBuffer({ maxLines: this._config.logRingBufferSize }),
      actionQueue: new PQueue({ concurrency: 1 }),
      exports: new Map(),
      analyses: new Map(),
      uploadBytesUsed: 0,
      exportBytesUsed: 0,
    };

    this._sessions.set(id, session);

    // Spawn the process
    const env = {
      ...process.env,
      MCP_HTTP_PORT: String(port),
    };
    const args = [
      this._config.mcpHostLua,
      sessionDir,
      name,
      String(sampleRate),
      String(tempo),
      String(timeSignature.numerator),
      String(timeSignature.denominator),
    ];
    const bin = session.gui ? this._config.ardourGuiBin : this._config.luasessionBin;

    try {
      const child = this._spawner(bin, args, { env, cwd: sessionDir });
      session.child = child;
      session.pid = child.pid;

      // Write PID file for orphan detection
      try { writeFileSync(join(sessionDir, 'ardour.pid'), String(child.pid)); } catch {}

      // Capture stdout/stderr into log buffer
      if (child.stdout) {
        child.stdout.on('data', (d) => {
          const text = d.toString();
          session.logBuffer.append(text);
          if (text.includes('MCP_HTTP_READY') && session.status === 'starting') {
            session.status = 'ready';
          }
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (d) => {
          const text = d.toString();
          session.logBuffer.append(text);
          // Keep last 50 lines for crash reporting
          const lines = text.split('\n').filter(Boolean);
          session.stderrTail.push(...lines);
          while (session.stderrTail.length > 50) session.stderrTail.shift();
        });
      }

      // Handle process exit
      child.on('exit', (code) => {
        session.exitCode = code;
        this._portPool.release(session.port);
        try { rmSync(join(sessionDir, 'ardour.pid'), { force: true }); } catch {}
        if (session.status === 'stopping') {
          session.status = 'stopped';
          // Schedule removal from the map
          const to = this._clock ? this._clock.setTimeout.bind(this._clock) : setTimeout;
          to(() => this._sessions.delete(id), 5 * 60 * 1000);
        } else {
          session.status = 'dead';
          const to = this._clock ? this._clock.setTimeout.bind(this._clock) : setTimeout;
          to(() => this._sessions.delete(id), 5 * 60 * 1000);
        }
      });

      child.on('error', () => {
        session.status = 'dead';
        this._portPool.release(session.port);
      });
    } catch (e) {
      this._portPool.release(port);
      this._sessions.delete(id);
      throw e;
    }

    return { session_id: id, status: 'starting' };
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  listAll() {
    return Array.from(this._sessions.values());
  }

  activeCount() {
    let n = 0;
    for (const s of this._sessions.values()) {
      if (s.status === 'starting' || s.status === 'ready' || s.status === 'unhealthy') n++;
    }
    return n;
  }

  async destroy(id, { timeoutMs = 5000 } = {}) {
    const session = this._sessions.get(id);
    if (!session) return;
    if (session.status === 'stopping' || session.status === 'stopped') return;

    session.status = 'stopping';
    // Reject all queued actions
    session.actionQueue.clear();
    session.actionQueue.pause();

    // SIGTERM
    if (session.child && session.child.kill) {
      try { session.child.kill('SIGTERM'); } catch {}
    }

    // Wait for exit up to timeoutMs
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const to = this._clock ? this._clock.setTimeout.bind(this._clock) : setTimeout;
      const timer = to(() => {
        if (session.child && session.child.kill) {
          try { session.child.kill('SIGKILL'); } catch {}
        }
        finish();
      }, timeoutMs);
      if (session.child) session.child.once('exit', () => finish());
      else finish();
    });
  }

  _sanitizeSessionName(name) {
    const clean = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return clean || 'session';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/session-manager.js api-service/src/lib/session-manager.test.js
git commit -m "feat: add SessionManager with lifecycle and spawning"
```

---

### Task 8: Tool Validator and Action Proxy

Validates MCP tool calls against schemas, then proxies them to the right Ardour instance via the per-session queue.

**Files:**
- Create: `api-service/src/lib/action-proxy.js`
- Create: `api-service/src/lib/action-proxy.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/lib/action-proxy.test.js`:

```js
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import PQueue from 'p-queue';
import { ActionProxy } from './action-proxy.js';
import { FakeArdourProcess } from '../../test/helpers/fake-ardour.js';

const toolSchemas = {
  tools: [
    {
      name: 'tracks/add',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' } },
        required: ['name', 'type'],
      },
    },
    {
      name: 'hello_world',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  ],
};

function makeSession(port) {
  return {
    id: 's1',
    port,
    mcpBaseUrl: `http://127.0.0.1:${port}/mcp`,
    status: 'ready',
    lastActivity: 0,
    actionQueue: new PQueue({ concurrency: 1 }),
  };
}

describe('ActionProxy.execute', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('proxies a valid tool call', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5940);
    fake.setToolResponse('hello_world', { text: 'hi' });

    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5940);
    const result = await proxy.execute(session, 'hello_world', { name: 'x' });
    assert.ok(result.result);
    assert.equal(result.result.structuredContent.text, 'hi');
  });

  it('rejects unknown tool', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5941);
    await assert.rejects(
      () => proxy.execute(session, 'nonexistent/tool', {}),
      /UNKNOWN_TOOL/
    );
  });

  it('rejects invalid params', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5942);
    await assert.rejects(
      () => proxy.execute(session, 'tracks/add', { name: 'Kick' }), // missing 'type'
      /INVALID_PARAMS/
    );
  });

  it('updates lastActivity', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5943);
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5943);
    const before = session.lastActivity;
    await new Promise(r => setTimeout(r, 5));
    await proxy.execute(session, 'hello_world', {});
    assert.ok(session.lastActivity > before);
  });
});

describe('ActionProxy.executeBatch', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('runs multiple actions sequentially', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5945);
    fake.setToolResponse('hello_world', { ok: true });
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 100 },
    });
    const session = makeSession(5945);
    const out = await proxy.executeBatch(session, [
      { tool: 'hello_world', params: {} },
      { tool: 'hello_world', params: {} },
    ]);
    assert.equal(out.total, 2);
    assert.equal(out.completed, 2);
    assert.ok(out.results.every(r => r.success));
  });

  it('stops on error with stop_on_error', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5946);
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 100 },
    });
    const session = makeSession(5946);
    const out = await proxy.executeBatch(session, [
      { tool: 'unknown', params: {} },
      { tool: 'hello_world', params: {} },
    ], { stopOnError: true });
    assert.equal(out.completed, 0);
    assert.equal(out.results[0].success, false);
    assert.equal(out.results[1], null);
  });

  it('rejects batch exceeding max size', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 2 },
    });
    const session = makeSession(5947);
    await assert.rejects(
      () => proxy.executeBatch(session, [
        { tool: 'hello_world' }, { tool: 'hello_world' }, { tool: 'hello_world' },
      ]),
      /BATCH_TOO_LARGE/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 ActionProxy | head -3
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement action-proxy.js**

Create `api-service/src/lib/action-proxy.js`:

```js
import Ajv from 'ajv';

/**
 * ActionProxy — validates MCP tool calls against schemas, forwards them to
 * the correct Ardour MCP HTTP endpoint via the session's action queue.
 *
 * Dependencies (injected):
 *   toolSchemas - { tools: [{ name, inputSchema }, ...] }
 *   httpClient  - fetch-compatible function
 *   config      - { actionTimeoutMs, actionQueueTimeoutMs, maxBatchSize }
 */
export class ActionProxy {
  constructor({ toolSchemas, httpClient, config }) {
    if (!toolSchemas) throw new Error('toolSchemas required');
    if (!httpClient) throw new Error('httpClient required');
    if (!config) throw new Error('config required');
    this._httpClient = httpClient;
    this._config = config;
    this._validators = new Map();

    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of toolSchemas.tools || []) {
      // MCP HTTP accepts slash, underscore, and dot forms. Register all variants.
      const name = tool.name;
      const variants = [name];
      if (name.includes('/')) variants.push(name.replace(/\//g, '_'), name.replace(/\//g, '.'));
      if (name.includes('_') && !name.includes('/')) variants.push(name.replace(/_/g, '/'));
      const validator = tool.inputSchema ? ajv.compile(tool.inputSchema) : () => true;
      for (const v of variants) {
        this._validators.set(v, { tool: name, validator });
      }
    }
  }

  _validate(tool, params) {
    const entry = this._validators.get(tool);
    if (!entry) {
      const err = new Error(`Unknown tool: ${tool}`);
      err.code = 'UNKNOWN_TOOL';
      throw err;
    }
    if (params == null) params = {};
    if (!entry.validator(params)) {
      const err = new Error(`Invalid params for ${tool}`);
      err.code = 'INVALID_PARAMS';
      err.details = entry.validator.errors;
      throw err;
    }
    return entry.tool;
  }

  async _proxyCall(session, tool, params, requestId = null) {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: params || {} },
      id: 1,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._config.actionTimeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (requestId) headers['x-request-id'] = requestId;
    try {
      const res = await this._httpClient(session.mcpBaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`Upstream HTTP ${res.status}`);
        err.code = 'UPSTREAM_DOWN';
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        const te = new Error('Upstream timeout');
        te.code = 'UPSTREAM_TIMEOUT';
        throw te;
      }
      if (!e.code) {
        const ue = new Error(e.message || 'Upstream unreachable');
        ue.code = 'UPSTREAM_DOWN';
        throw ue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(session, tool, params, requestId = null) {
    const canonical = this._validate(tool, params);
    const task = () => this._proxyCall(session, canonical, params, requestId);
    const queuePromise = session.actionQueue.add(task);

    // Wrap with queue wait timeout
    const timer = new Promise((_, reject) => setTimeout(() => {
      const err = new Error('Queue wait timed out');
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, this._config.actionQueueTimeoutMs));

    const result = await Promise.race([queuePromise, timer]);
    session.lastActivity = Date.now();
    return result;
  }

  async executeBatch(session, actions, { stopOnError = true, timeoutMs = 60000 } = {}) {
    if (!Array.isArray(actions)) {
      const err = new Error('actions must be an array');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    const maxSize = this._config.maxBatchSize || 100;
    if (actions.length > maxSize) {
      const err = new Error(`Batch exceeds max size: ${actions.length} > ${maxSize}`);
      err.code = 'BATCH_TOO_LARGE';
      err.max = maxSize;
      throw err;
    }

    // All actions occupy one queue slot
    const batchTask = async () => {
      const results = new Array(actions.length).fill(null);
      const deadline = Date.now() + timeoutMs;
      let completed = 0;
      let timedOut = false;

      for (let i = 0; i < actions.length; i++) {
        if (Date.now() >= deadline) { timedOut = true; break; }
        const { tool, params } = actions[i];
        try {
          const canonical = this._validate(tool, params);
          const resp = await this._proxyCall(session, canonical, params);
          results[i] = { tool, success: true, result: resp.result ?? resp };
          completed++;
        } catch (e) {
          results[i] = { tool, success: false, error: e.message, error_code: e.code };
          if (stopOnError) break;
        }
      }
      return { results, completed, total: actions.length, timed_out: timedOut };
    };

    const queuePromise = session.actionQueue.add(batchTask);
    const timer = new Promise((_, reject) => setTimeout(() => {
      const err = new Error('Queue wait timed out');
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, this._config.actionQueueTimeoutMs));

    const result = await Promise.race([queuePromise, timer]);
    session.lastActivity = Date.now();
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/action-proxy.js api-service/src/lib/action-proxy.test.js
git commit -m "feat: add ActionProxy with tool validation and batch support"
```

---

### Task 9: Timeout Reaper

Background cleanup of idle sessions, auto-save triggering, dead session cleanup.

**Files:**
- Create: `api-service/src/lib/timeout-reaper.js`
- Create: `api-service/src/lib/timeout-reaper.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/lib/timeout-reaper.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutReaper } from './timeout-reaper.js';
import { FakeClock } from '../../test/helpers/fake-clock.js';

function makeSession(id, status, lastActivity, lastSave = null) {
  return {
    id, status, lastActivity,
    lastSave: lastSave ?? lastActivity,
    actionQueue: { clear() {}, pause() {} },
  };
}

describe('TimeoutReaper.reap', () => {
  it('does not reap recently-active sessions', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [makeSession('s1', 'ready', 999_000)],
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, []);
  });

  it('reaps idle sessions past threshold', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [makeSession('s1', 'ready', 900_000)], // 100s old
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, ['s1']);
  });

  it('skips starting and stopping sessions', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [
        makeSession('s1', 'starting', 500_000),
        makeSession('s2', 'stopping', 500_000),
      ],
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, []);
  });

  it('triggers auto-save on ready session with stale lastSave', async () => {
    const clock = new FakeClock(1_000_000);
    const savedSessions = [];
    const session = makeSession('s1', 'ready', 999_000, 500_000);
    const sm = {
      listAll: () => [session],
      destroy: async () => {},
    };
    const saver = async (s) => savedSessions.push(s.id);
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      saveSession: saver,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(savedSessions, ['s1']);
  });

  it('start and stop control the interval', () => {
    const clock = new FakeClock(0);
    let reapCount = 0;
    const sm = { listAll: () => { reapCount++; return []; }, destroy: async () => {} };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.start(1000);
    clock.advance(2500);
    assert.equal(reapCount, 2);
    reaper.stop();
    clock.advance(2000);
    assert.equal(reapCount, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 TimeoutReaper | head -3
```
Expected: FAIL.

- [ ] **Step 3: Implement timeout-reaper.js**

Create `api-service/src/lib/timeout-reaper.js`:

```js
/**
 * TimeoutReaper — background interval that reaps idle sessions,
 * triggers auto-save, and cleans up dead session directories.
 *
 * Dependencies (injected):
 *   sessionManager - has listAll() and destroy(id)
 *   clock          - FakeClock-compatible or null (uses real timers)
 *   config         - { sessionIdleTimeoutMs, sessionAutoSaveIntervalMs }
 *   saveSession    - optional async (session) => void
 */
export class TimeoutReaper {
  constructor({ sessionManager, clock = null, config, saveSession = null }) {
    if (!sessionManager) throw new Error('sessionManager required');
    if (!config) throw new Error('config required');
    this._sm = sessionManager;
    this._clock = clock;
    this._config = config;
    this._saveSession = saveSession;
    this._intervalId = null;
  }

  _now() { return this._clock ? this._clock.now() : Date.now(); }

  /**
   * Run one reap cycle synchronously. Safe to call in tests.
   */
  reap() {
    const now = this._now();
    for (const session of this._sm.listAll()) {
      if (session.status !== 'ready' && session.status !== 'unhealthy') {
        continue;
      }

      const idleFor = now - session.lastActivity;
      if (idleFor >= this._config.sessionIdleTimeoutMs) {
        // fire-and-forget
        Promise.resolve().then(() => this._sm.destroy(session.id)).catch(() => {});
        continue;
      }

      // Auto-save check
      if (this._saveSession && session.status === 'ready') {
        const sinceSave = now - (session.lastSave ?? 0);
        if (sinceSave >= this._config.sessionAutoSaveIntervalMs && session.lastActivity > (session.lastSave ?? 0)) {
          session.lastSave = now;
          Promise.resolve().then(() => this._saveSession(session)).catch(() => {});
        }
      }
    }
  }

  start(intervalMs = 60000) {
    const si = this._clock ? this._clock.setInterval.bind(this._clock) : setInterval;
    this._intervalId = si(() => this.reap(), intervalMs);
  }

  stop() {
    if (this._intervalId != null) {
      const ci = this._clock ? this._clock.clearInterval.bind(this._clock) : clearInterval;
      ci(this._intervalId);
      this._intervalId = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/lib/timeout-reaper.js api-service/src/lib/timeout-reaper.test.js
git commit -m "feat: add TimeoutReaper for idle cleanup and auto-save"
```

---

### Task 10: Sessions Route — Create/List/Get/Delete

Wire up the core session HTTP endpoints.

**Files:**
- Create: `api-service/src/routes/sessions.js`
- Create: `api-service/src/routes/sessions.test.js`

- [ ] **Step 1: Write failing tests**

Create `api-service/src/routes/sessions.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';

function fakeSessionManager() {
  const sessions = new Map();
  return {
    _sessions: sessions,
    async create(opts) {
      const id = 'id-' + sessions.size;
      const s = {
        id, status: 'starting', sessionName: opts.sessionName, sampleRate: opts.sampleRate,
        createdAt: Date.now(), lastActivity: Date.now(),
      };
      sessions.set(id, s);
      return { session_id: id, status: 'starting' };
    },
    get(id) { return sessions.get(id) || null; },
    listAll() { return [...sessions.values()]; },
    activeCount() { return sessions.size; },
    async destroy(id) {
      const s = sessions.get(id);
      if (s) s.status = 'stopped';
    },
  };
}

function buildApp(sm, config = {}) {
  const app = Fastify({ logger: false });
  app.decorate('sessionManager', sm);
  app.decorate('actionProxy', null);
  app.decorate('exportService', null);
  app.decorate('config', { maxConcurrentSessions: 5, allowGui: false, ...config });
  app.register(sessionRoutes, { prefix: '/v1' });
  return app;
}

describe('POST /v1/sessions', () => {
  it('creates a session and returns 202', async () => {
    const sm = fakeSessionManager();
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { sample_rate: 48000, session_name: 'test' },
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.ok(body.session_id);
    assert.equal(body.status, 'starting');
    await app.close();
  });

  it('returns 429 when MAX_SESSIONS reached', async () => {
    const sm = fakeSessionManager();
    sm.create = async () => { const e = new Error('max'); e.code = 'MAX_SESSIONS'; throw e; };
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/sessions', payload: {} });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error_code, 'MAX_SESSIONS');
    await app.close();
  });

  it('returns 503 when NO_PORTS', async () => {
    const sm = fakeSessionManager();
    sm.create = async () => { const e = new Error('no ports'); e.code = 'NO_PORTS'; throw e; };
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/sessions', payload: {} });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});

describe('GET /v1/sessions', () => {
  it('lists active sessions', async () => {
    const sm = fakeSessionManager();
    await sm.create({ sessionName: 'a' });
    await sm.create({ sessionName: 'b' });
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/sessions' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sessions.length, 2);
    assert.ok(body.capacity);
    await app.close();
  });
});

describe('GET /v1/sessions/:id', () => {
  it('returns session details', async () => {
    const sm = fakeSessionManager();
    const r = await sm.create({ sessionName: 'x' });
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${r.session_id}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().session_id, r.session_id);
    await app.close();
  });

  it('returns 404 for unknown id', async () => {
    const sm = fakeSessionManager();
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/missing' });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('DELETE /v1/sessions/:id', () => {
  it('destroys session and returns 200', async () => {
    const sm = fakeSessionManager();
    const r = await sm.create({ sessionName: 'x' });
    const app = buildApp(sm);
    await app.ready();
    const res = await app.inject({ method: 'DELETE', url: `/v1/sessions/${r.session_id}` });
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | grep -A1 "POST /v1/sessions" | head -3
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sessions.js**

Create `api-service/src/routes/sessions.js`:

```js
/**
 * Sessions routes — lifecycle (create/list/get/delete).
 *
 * Reads sessionManager, config from Fastify decorators set in server.js.
 */
export async function sessionRoutes(app) {
  // POST /v1/sessions — create session (202 Accepted)
  app.post('/sessions', async (req, reply) => {
    const body = req.body || {};
    const opts = {
      sampleRate: body.sample_rate ?? 48000,
      sessionName: body.session_name ?? null,
      tempo: body.tempo ?? 120,
      timeSignature: body.time_signature ?? { numerator: 4, denominator: 4 },
      gui: !!body.gui,
    };
    try {
      const result = await app.sessionManager.create(opts);
      return reply.code(202).send({
        ...result,
        poll_url: `/v1/sessions/${result.session_id}`,
      });
    } catch (e) {
      if (e.code === 'MAX_SESSIONS') {
        return reply.code(429).send({ error_code: 'MAX_SESSIONS', error: e.message });
      }
      if (e.code === 'NO_PORTS') {
        return reply.code(503).send({ error_code: 'NO_PORTS', error: e.message });
      }
      req.log.error({ err: e }, 'session create failed');
      return reply.code(500).send({ error_code: 'INTERNAL', error: e.message });
    }
  });

  // GET /v1/sessions — list
  app.get('/sessions', async () => {
    const sessions = app.sessionManager.listAll().map(sessionToResponse);
    return {
      sessions,
      capacity: {
        active: app.sessionManager.activeCount(),
        max: app.config.maxConcurrentSessions,
      },
    };
  });

  // GET /v1/sessions/:id
  app.get('/sessions/:id', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    return sessionToResponse(s);
  });

  // DELETE /v1/sessions/:id
  app.delete('/sessions/:id', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping') {
      return reply.code(200).send({ status: 'stopping' });
    }
    await app.sessionManager.destroy(req.params.id);
    return reply.code(200).send({ status: 'stopped' });
  });
}

function sessionToResponse(s) {
  const out = {
    session_id: s.id,
    status: s.status,
    session_name: s.sessionName,
    sample_rate: s.sampleRate,
    created_at: new Date(s.createdAt).toISOString(),
    last_activity: new Date(s.lastActivity).toISOString(),
    uptime_seconds: Math.floor((Date.now() - s.createdAt) / 1000),
  };
  if (s.status === 'dead') {
    out.exit_code = s.exitCode;
    out.stderr_tail = s.stderrTail;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/routes/sessions.js api-service/src/routes/sessions.test.js
git commit -m "feat: add session lifecycle routes (POST/GET/DELETE /v1/sessions)"
```

---

### Task 11: Actions Routes (single + batch) and Tools Discovery

Wire up `POST /v1/sessions/:id/actions`, `POST .../actions/batch`, and `GET /v1/tools`.

**Files:**
- Modify: `api-service/src/routes/sessions.js` (add actions endpoints)
- Create: `api-service/src/routes/tools.js`
- Create: `api-service/src/routes/tools.test.js`
- Modify: `api-service/src/routes/sessions.test.js` (add action tests)

- [ ] **Step 1: Add action routes to sessions.js**

Edit `api-service/src/routes/sessions.js` — add these endpoints before `sessionToResponse`:

```js
  // POST /v1/sessions/:id/actions
  app.post('/sessions/:id/actions', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping' || s.status === 'stopped' || s.status === 'dead') {
      return reply.code(409).send({ error_code: 'SESSION_STOPPING', status: s.status });
    }
    if (s.status !== 'ready') {
      return reply.code(409).send({ error_code: 'NOT_READY', status: s.status });
    }
    const { tool, params } = req.body || {};
    if (!tool) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'tool required' });
    try {
      const result = await app.actionProxy.execute(s, tool, params, req.id);
      return result.result ?? result;
    } catch (e) {
      return mapProxyError(reply, e);
    }
  });

  // POST /v1/sessions/:id/actions/batch
  app.post('/sessions/:id/actions/batch', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status !== 'ready') {
      return reply.code(409).send({ error_code: 'NOT_READY', status: s.status });
    }
    const { actions, stop_on_error = true, timeout_ms = 60000 } = req.body || {};
    if (!Array.isArray(actions)) {
      return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'actions must be an array' });
    }
    try {
      const out = await app.actionProxy.executeBatch(s, actions, {
        stopOnError: stop_on_error,
        timeoutMs: timeout_ms,
      });
      return out;
    } catch (e) {
      return mapProxyError(reply, e);
    }
  });

  // GET /v1/sessions/:id/logs?since=<cursor>
  app.get('/sessions/:id/logs', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    const since = req.query.since ?? 0;
    const { lines, cursor } = s.logBuffer.since(since);
    return { lines, cursor: String(cursor) };
  });
```

And add this helper at the end of the file (after `sessionToResponse`):

```js
function mapProxyError(reply, e) {
  if (e.code === 'UNKNOWN_TOOL') return reply.code(400).send({ error_code: 'UNKNOWN_TOOL', tool: e.message });
  if (e.code === 'INVALID_PARAMS') return reply.code(400).send({ error_code: 'INVALID_PARAMS', details: e.details });
  if (e.code === 'BATCH_TOO_LARGE') return reply.code(400).send({ error_code: 'BATCH_TOO_LARGE', max: e.max });
  if (e.code === 'QUEUE_FULL') return reply.code(429).send({ error_code: 'QUEUE_FULL' });
  if (e.code === 'QUEUE_TIMEOUT') return reply.code(504).send({ error_code: 'QUEUE_TIMEOUT' });
  if (e.code === 'UPSTREAM_DOWN') return reply.code(502).send({ error_code: 'UPSTREAM_DOWN' });
  if (e.code === 'UPSTREAM_TIMEOUT') return reply.code(504).send({ error_code: 'UPSTREAM_TIMEOUT' });
  return reply.code(500).send({ error_code: 'INTERNAL', error: e.message });
}
```

- [ ] **Step 2: Create tools.js**

Create `api-service/src/routes/tools.js`:

```js
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedCatalog = null;

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const path = resolve(__dirname, '../schemas/mcp-tools.json');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const tools = parsed.tools.map((t) => ({
    name: t.name,
    category: t.name.includes('/') ? t.name.split('/')[0] : 'misc',
    description: t.description || '',
    input_schema: t.inputSchema || {},
  }));
  const categories = Array.from(new Set(tools.map(t => t.category)));
  cachedCatalog = { tools, categories };
  return cachedCatalog;
}

export async function toolRoutes(app) {
  app.get('/tools', async () => loadCatalog());
}
```

- [ ] **Step 3: Create tools.test.js**

Create `api-service/src/routes/tools.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { toolRoutes } from './tools.js';

describe('GET /v1/tools', () => {
  it('returns tool catalog with categories', async () => {
    const app = Fastify({ logger: false });
    app.register(toolRoutes, { prefix: '/v1' });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/tools' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.length > 0);
    assert.ok(Array.isArray(body.categories));
    // Verify each tool has the expected shape
    for (const t of body.tools) {
      assert.ok(t.name);
      assert.ok(t.category);
      assert.ok(t.input_schema);
    }
    await app.close();
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/routes/sessions.js api-service/src/routes/tools.js api-service/src/routes/tools.test.js api-service/src/routes/sessions.test.js
git commit -m "feat: add actions routes + tool discovery endpoint"
```

---

### Task 12: File Upload Route

Implements `POST /v1/sessions/:id/upload` with multipart, sanitization, and disk quota.

**Files:**
- Modify: `api-service/src/routes/sessions.js` (add upload endpoint)
- Modify: `api-service/src/routes/sessions.test.js` (add upload tests)

- [ ] **Step 1: Add upload endpoint to sessions.js**

Add to `api-service/src/routes/sessions.js` before `mapProxyError`:

```js
  // POST /v1/sessions/:id/upload
  app.post('/sessions/:id/upload', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping' || s.status === 'stopped' || s.status === 'dead') {
      return reply.code(409).send({ error_code: 'SESSION_STOPPING', status: s.status });
    }

    const data = await req.file();
    if (!data) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'file required' });

    const rawName = data.filename || 'upload.bin';
    const sanitized = sanitizeUploadFilename(rawName);
    if (!sanitized) {
      return reply.code(400).send({ error_code: 'INVALID_FILENAME', error: 'filename contains path separators or is hidden' });
    }
    const allowedExts = /\.(wav|flac|aiff|ogg|mp3|mid|midi|sf2|sfz)$/i;
    if (!allowedExts.test(sanitized)) {
      return reply.code(400).send({ error_code: 'INVALID_FILE_TYPE', error: 'extension not allowed' });
    }

    const { mkdir, stat, writeFile } = await import('fs/promises');
    const { resolve: resolvePath, relative, join } = await import('path');
    const uploadsDir = resolvePath(s.sessionDir, 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const destPath = resolvePath(uploadsDir, sanitized);
    // Re-verify path is within uploadsDir
    const rel = relative(uploadsDir, destPath);
    if (rel.startsWith('..') || rel.includes('/')) {
      return reply.code(400).send({ error_code: 'INVALID_FILENAME' });
    }
    try {
      await stat(destPath);
      return reply.code(409).send({ error_code: 'FILE_EXISTS', filename: sanitized });
    } catch {}

    // Read the stream with size check
    const chunks = [];
    let size = 0;
    for await (const chunk of data.file) {
      size += chunk.length;
      if (size > app.config.maxUploadBytes) {
        return reply.code(413).send({ error_code: 'FILE_TOO_LARGE', max: app.config.maxUploadBytes });
      }
      if (s.uploadBytesUsed + size > app.config.maxSessionUploadBytes) {
        return reply.code(413).send({ error_code: 'SESSION_UPLOAD_QUOTA', max: app.config.maxSessionUploadBytes });
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    await writeFile(destPath, buf);
    s.uploadBytesUsed += size;

    return reply.code(200).send({
      path: destPath,
      filename: sanitized,
      size,
    });
  });
```

And add the helper at the end of the file:

```js
function sanitizeUploadFilename(name) {
  if (!name) return null;
  if (name.startsWith('.')) return null;
  const basename = String(name).replace(/[\/\\]/g, '_').replace(/\0/g, '');
  if (basename.length > 255) return null;
  return basename;
}
```

- [ ] **Step 2: Add upload tests**

Append to `api-service/src/routes/sessions.test.js`:

```js
import FormData from 'form-data';
import fastifyMultipart from '@fastify/multipart';

describe('POST /v1/sessions/:id/upload', () => {
  async function buildUploadApp(sm, overrides = {}) {
    const app = Fastify({ logger: false });
    app.decorate('sessionManager', sm);
    app.decorate('actionProxy', null);
    app.decorate('exportService', null);
    app.decorate('config', {
      maxConcurrentSessions: 5,
      maxUploadBytes: 1024 * 1024,
      maxSessionUploadBytes: 5 * 1024 * 1024,
      ...overrides,
    });
    await app.register(fastifyMultipart);
    app.register(sessionRoutes, { prefix: '/v1' });
    return app;
  }

  it('rejects filename with path separator', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const sm = fakeSessionManager();
    const r = await sm.create({ sessionName: 'x' });
    const s = sm.get(r.session_id);
    s.status = 'ready';
    s.sessionDir = mkdtempSync(join(tmpdir(), 'up-'));
    s.uploadBytesUsed = 0;

    const app = await buildUploadApp(sm);
    await app.ready();

    const form = new FormData();
    form.append('file', Buffer.from('hi'), { filename: '../etc/passwd', contentType: 'application/octet-stream' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${r.session_id}/upload`,
      payload: form,
      headers: form.getHeaders(),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('accepts valid upload', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const sm = fakeSessionManager();
    const r = await sm.create({ sessionName: 'x' });
    const s = sm.get(r.session_id);
    s.status = 'ready';
    s.sessionDir = mkdtempSync(join(tmpdir(), 'up-'));
    s.uploadBytesUsed = 0;

    const app = await buildUploadApp(sm);
    await app.ready();

    const form = new FormData();
    form.append('file', Buffer.from('fake wav data'), { filename: 'kick.wav', contentType: 'audio/wav' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${r.session_id}/upload`,
      payload: form,
      headers: form.getHeaders(),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.filename, 'kick.wav');
    assert.equal(body.size, 13);
    await app.close();
  });
});
```

- [ ] **Step 3: Install test dep**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm install --save-dev form-data
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/routes/sessions.js api-service/src/routes/sessions.test.js api-service/package.json api-service/package-lock.json
git commit -m "feat: add file upload route with sanitization and quota"
```

---

### Task 13: Server.js Composition — Wire All Modules

Integrate all the new modules into the Fastify server with graceful shutdown.

**Files:**
- Modify: `api-service/src/server.js`

- [ ] **Step 1: Rewrite server.js**

Replace `api-service/src/server.js` with:

```js
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes, queue } from './routes/jobs.js';
import { pluginRoutes } from './routes/plugins.js';
import { sessionRoutes } from './routes/sessions.js';
import { toolRoutes } from './routes/tools.js';
import { SessionManager } from './lib/session-manager.js';
import { ActionProxy } from './lib/action-proxy.js';
import { PortPool } from './lib/port-pool.js';
import { TimeoutReaper } from './lib/timeout-reaper.js';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: config.maxJobSpecBytes,
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
  forceCloseConnections: 'idle',
});

// Load MCP tool schemas
const toolSchemasPath = resolve(__dirname, 'schemas/mcp-tools.json');
let toolSchemas = { tools: [] };
if (existsSync(toolSchemasPath)) {
  toolSchemas = JSON.parse(readFileSync(toolSchemasPath, 'utf8'));
} else {
  app.log.warn('mcp-tools.json not found — run `npm run extract-tools`');
}

// Compose session subsystem
const portPool = new PortPool({ start: config.mcpPortRangeStart, end: config.mcpPortRangeEnd });
await portPool.scan();
app.log.info({ freePorts: portPool.availableCount() }, 'port pool scanned');

const sessionManager = new SessionManager({
  config,
  portPool,
  spawner: spawn,
  httpClient: globalThis.fetch,
});

const actionProxy = new ActionProxy({ toolSchemas, httpClient: globalThis.fetch, config });

const reaper = new TimeoutReaper({
  sessionManager,
  config,
  saveSession: async (s) => {
    try {
      await actionProxy.execute(s, 'session/save', {});
    } catch {}
  },
});
reaper.start(60000);

// Decorators
app.decorate('jobQueue', queue);
app.decorate('sessionManager', sessionManager);
app.decorate('actionProxy', actionProxy);
app.decorate('config', config);

// Register plugins
await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes } });
await app.register(fastifyStatic, { root: resolve(__dirname, '../public'), prefix: '/' });

// Routes
app.register(healthRoutes, { prefix: '/v1' });
app.register(jobRoutes, { prefix: '/v1' });
app.register(pluginRoutes, { prefix: '/v1' });
app.register(sessionRoutes, { prefix: '/v1' });
app.register(toolRoutes, { prefix: '/v1' });

// Graceful shutdown
app.addHook('onClose', async () => {
  reaper.stop();
  for (const s of sessionManager.listAll()) {
    try { await sessionManager.destroy(s.id, { timeoutMs: 5000 }); } catch {}
  }
});

const shutdown = () => {
  app.log.info('shutting down');
  app.close().then(() => process.exit(0)).catch((err) => {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

- [ ] **Step 2: Extend health endpoint**

Edit `api-service/src/routes/health.js`:

```js
export async function healthRoutes(app) {
  app.get('/health', async () => {
    const queue = app.jobQueue;
    const sm = app.sessionManager;
    return {
      status: 'ok',
      queue_depth: queue ? queue.queueDepth : 0,
      active_jobs: queue ? queue.activeCount : 0,
      sessions: sm ? {
        active: sm.activeCount(),
        max: app.config?.maxConcurrentSessions ?? 0,
      } : { active: 0, max: 0 },
    };
  });
}
```

- [ ] **Step 3: Verify server starts**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && timeout 3 npm start 2>&1 | head -10
```
Expected: Log output showing "port pool scanned" and server listening on port 3000.

- [ ] **Step 4: Run all tests**

```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add api-service/src/server.js api-service/src/routes/health.js
git commit -m "feat: wire session manager into server.js with graceful shutdown"
```

---

### Task 14: Developer Test App — Minimal HTML/JS UI

A single-page app that exercises session lifecycle and action proxying.

**Files:**
- Create: `api-service/public/index.html`
- Create: `api-service/public/style.css`
- Create: `api-service/public/app.js`

- [ ] **Step 1: Create index.html**

Create `api-service/public/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Ardour Session Manager Dev Tool</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="top-bar">
    <span id="session-indicator">● No session</span>
    <button id="btn-play">Play</button>
    <button id="btn-stop">Stop</button>
    <button id="btn-save">Save</button>
    <label><input type="checkbox" id="gui-mode"> GUI mode</label>
  </div>
  <div id="main">
    <div id="left-panel">
      <h3>Sessions</h3>
      <div id="new-session">
        <label>Name: <input id="new-name" value="mix"></label>
        <label>SR: <select id="new-sr"><option>48000</option><option>44100</option></select></label>
        <label>BPM: <input id="new-bpm" type="number" value="120"></label>
        <button id="btn-new-session">New Session</button>
      </div>
      <ul id="session-list"></ul>
    </div>
    <div id="center-panel">
      <h3>Actions</h3>
      <select id="tool-select"><option>Loading…</option></select>
      <div id="param-form"></div>
      <button id="btn-send">Send</button>
    </div>
    <div id="right-panel">
      <h3>Response Log</h3>
      <button id="btn-clear-log">Clear</button>
      <div id="log"></div>
    </div>
  </div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create style.css**

Create `api-service/public/style.css`:

```css
* { box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 13px; }
body { margin: 0; background: #1a1a1a; color: #ccc; }
#top-bar { background: #2a2a2a; padding: 8px 12px; border-bottom: 1px solid #444; display: flex; gap: 12px; align-items: center; }
#session-indicator { font-weight: bold; color: #999; }
#session-indicator.connected { color: #4f4; }
button { background: #444; color: #ccc; border: 1px solid #666; padding: 4px 10px; cursor: pointer; border-radius: 3px; }
button:hover { background: #555; }
#main { display: grid; grid-template-columns: 300px 1fr 400px; height: calc(100vh - 50px); }
#left-panel, #center-panel, #right-panel { padding: 12px; overflow-y: auto; border-right: 1px solid #444; }
#right-panel { border-right: none; }
h3 { margin-top: 0; color: #eee; }
#new-session label { display: block; margin: 6px 0; }
#new-session input, #new-session select { width: 100%; padding: 4px; background: #222; color: #ccc; border: 1px solid #555; }
#session-list { list-style: none; padding: 0; }
#session-list li { padding: 6px; margin-bottom: 4px; background: #2a2a2a; border-left: 3px solid #555; cursor: pointer; }
#session-list li.active { border-left-color: #4f4; background: #333; }
#tool-select { width: 100%; padding: 6px; background: #222; color: #ccc; border: 1px solid #555; margin-bottom: 8px; }
#param-form { margin: 8px 0; }
#param-form label { display: block; margin: 4px 0; }
#param-form input, #param-form textarea { width: 100%; padding: 4px; background: #222; color: #ccc; border: 1px solid #555; font-family: inherit; }
#log { max-height: calc(100vh - 140px); overflow-y: auto; }
.log-entry { margin-bottom: 6px; padding: 6px; background: #222; border-left: 3px solid #555; font-size: 11px; }
.log-entry.success { border-left-color: #4f4; }
.log-entry.error { border-left-color: #f44; }
.log-entry pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; }
```

- [ ] **Step 3: Create app.js**

Create `api-service/public/app.js`:

```js
const state = {
  sessionId: null,
  tools: [],
};

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  logEntry(method + ' ' + path, json, res.ok);
  return { ok: res.ok, status: res.status, body: json };
}

function logEntry(label, data, ok) {
  const el = document.createElement('div');
  el.className = 'log-entry ' + (ok ? 'success' : 'error');
  el.innerHTML = '<strong>' + escapeHtml(label) + '</strong><pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
  document.getElementById('log').prepend(el);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshSessions() {
  const { body } = await api('GET', '/v1/sessions');
  const ul = document.getElementById('session-list');
  ul.innerHTML = '';
  for (const s of body.sessions || []) {
    const li = document.createElement('li');
    li.textContent = `${s.session_name} [${s.status}]`;
    if (s.session_id === state.sessionId) li.classList.add('active');
    li.onclick = () => { state.sessionId = s.session_id; updateIndicator(); refreshSessions(); };
    const del = document.createElement('button');
    del.textContent = 'x';
    del.style.marginLeft = '8px';
    del.onclick = async (e) => {
      e.stopPropagation();
      await api('DELETE', `/v1/sessions/${s.session_id}`);
      if (state.sessionId === s.session_id) state.sessionId = null;
      refreshSessions();
      updateIndicator();
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
}

function updateIndicator() {
  const el = document.getElementById('session-indicator');
  if (state.sessionId) {
    el.textContent = '● ' + state.sessionId.slice(0, 8);
    el.classList.add('connected');
  } else {
    el.textContent = '● No session';
    el.classList.remove('connected');
  }
}

async function loadTools() {
  const { body } = await api('GET', '/v1/tools');
  state.tools = body.tools || [];
  const sel = document.getElementById('tool-select');
  sel.innerHTML = '';
  for (const t of state.tools) {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.category + ' / ' + t.name;
    sel.appendChild(opt);
  }
  sel.onchange = () => renderParamForm(sel.value);
  if (state.tools.length) renderParamForm(state.tools[0].name);
}

function renderParamForm(toolName) {
  const tool = state.tools.find(t => t.name === toolName);
  const form = document.getElementById('param-form');
  form.innerHTML = '';
  if (!tool || !tool.input_schema || !tool.input_schema.properties) return;
  const props = tool.input_schema.properties;
  for (const [key, spec] of Object.entries(props)) {
    const label = document.createElement('label');
    label.textContent = key + (tool.input_schema.required?.includes(key) ? ' *' : '') + ':';
    const input = document.createElement('input');
    input.dataset.key = key;
    input.dataset.type = spec.type || 'string';
    if (spec.type === 'boolean') input.type = 'checkbox';
    else if (spec.type === 'integer' || spec.type === 'number') input.type = 'number';
    else input.type = 'text';
    if (spec.description) input.placeholder = spec.description;
    label.appendChild(input);
    form.appendChild(label);
  }
}

async function sendAction() {
  if (!state.sessionId) { alert('Select a session first'); return; }
  const toolName = document.getElementById('tool-select').value;
  const params = {};
  for (const input of document.querySelectorAll('#param-form input')) {
    const key = input.dataset.key;
    const type = input.dataset.type;
    let val = input.value;
    if (val === '') continue;
    if (type === 'integer') val = parseInt(val, 10);
    else if (type === 'number') val = parseFloat(val);
    else if (type === 'boolean') val = input.checked;
    params[key] = val;
  }
  await api('POST', `/v1/sessions/${state.sessionId}/actions`, { tool: toolName, params });
}

document.getElementById('btn-new-session').onclick = async () => {
  const name = document.getElementById('new-name').value;
  const sample_rate = parseInt(document.getElementById('new-sr').value, 10);
  const tempo = parseInt(document.getElementById('new-bpm').value, 10);
  const gui = document.getElementById('gui-mode').checked;
  const { body } = await api('POST', '/v1/sessions', {
    session_name: name, sample_rate, tempo, gui,
  });
  if (body.session_id) { state.sessionId = body.session_id; updateIndicator(); }
  setTimeout(refreshSessions, 500);
};

document.getElementById('btn-send').onclick = sendAction;
document.getElementById('btn-clear-log').onclick = () => document.getElementById('log').innerHTML = '';

loadTools();
refreshSessions();
setInterval(refreshSessions, 5000);
```

- [ ] **Step 2: Verify files exist**

```bash
ls /Users/shanekoss/Repos/ardour/api-service/public/
```
Expected: `index.html`, `style.css`, `app.js`

- [ ] **Step 3: Commit**

```bash
git add api-service/public/
git commit -m "feat: add developer test app (vanilla HTML/JS)"
```

---

### Task 15: End-to-End Integration Test

Run the full stack and verify a real session can be created, manipulated, and destroyed.

**Files:**
- Create: `api-service/test/e2e.test.js`

- [ ] **Step 1: Write the e2e test**

Create `api-service/test/e2e.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SKIP_E2E = !process.env.RUN_E2E;

describe('E2E: real luasession with mcp_host.lua', { skip: SKIP_E2E }, () => {
  it('creates session, runs lua_eval, destroys', async () => {
    // Find luasession binary
    const repoRoot = join(import.meta.dirname, '../..');
    const luasession = join(repoRoot, 'build/luasession/luasession');
    const mcpHost = join(repoRoot, 'api-service/lua/mcp_host.lua');
    const sessionDir = join(tmpdir(), `e2e-${Date.now()}`);

    if (!existsSync(luasession)) {
      assert.fail(`luasession not found at ${luasession} — run the Ardour build first`);
    }

    const port = 5995;
    const libs = join(repoRoot, 'build/libs');
    const env = {
      ...process.env,
      MCP_HTTP_PORT: String(port),
      ARDOUR_DLL_PATH: libs,
      ARDOUR_DATA_PATH: `${join(repoRoot, 'share')}:${join(repoRoot, 'build')}:${join(repoRoot, 'gtk2_ardour')}:${join(repoRoot, 'build/gtk2_ardour')}`,
      ARDOUR_CONFIG_PATH: `${repoRoot}:${join(repoRoot, 'gtk2_ardour')}:${join(repoRoot, 'build')}:${join(repoRoot, 'build/gtk2_ardour')}`,
      ARDOUR_EXPORT_FORMATS_PATH: join(repoRoot, 'share/export'),
      ARDOUR_SURFACES_PATH: `${join(libs, 'surfaces/osc')}:${join(libs, 'surfaces/mcp_http')}:${join(libs, 'surfaces/generic_midi')}`,
      ARDOUR_BACKEND_PATH: join(libs, 'backends/dummy'),
      ARDOUR_PANNER_PATH: join(libs, 'panners'),
      DYLD_FALLBACK_LIBRARY_PATH: [
        'tk/ydk-pixbuf','tk/ztk','tk/ydk','tk/ytk','tk/ztkmm','tk/ydkmm','tk/ytkmm','tk/suil',
        'ptformat','qm-dsp','vamp-sdk','surfaces','ctrl-interface/control_protocol',
        'ctrl-interface/midi_surface','ardour','midi++2','pbd','rubberband','soundtouch',
        'aaf','gtkmm2ext','widgets','appleutility','taglib','evoral','evoral/src/libsmf',
        'audiographer','temporal','libltc','canvas','waveview','ardouralsautil',
      ].map(p => join(libs, p)).join(':'),
    };

    const child = spawn(luasession, [mcpHost, sessionDir, 'e2e', '48000', '120', '4', '4'], { env });
    let ready = false;
    child.stdout.on('data', (d) => { if (d.toString().includes('MCP_HTTP_READY')) ready = true; });
    // Also collect stderr for debug
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    try {
      // Wait up to 15s for ready
      for (let i = 0; i < 30; i++) {
        if (ready) break;
        await new Promise(r => setTimeout(r, 500));
      }
      assert.ok(ready, 'MCP_HTTP_READY not received in 15s. stderr:\n' + stderr.slice(-1000));

      // Test hello_world
      const res1 = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'tools/call',
          params: { name: 'hello_world', arguments: { name: 'e2e' } },
          id: 1,
        }),
      });
      const body1 = await res1.json();
      assert.ok(body1.result.structuredContent || body1.result.content);

      // Test lua_eval
      const res2 = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'tools/call',
          params: { name: 'session/lua_eval', arguments: { code: 'print("ok:" .. Session:name())' } },
          id: 2,
        }),
      });
      const body2 = await res2.json();
      const text = body2.result.content[0].text;
      assert.ok(text.includes('"success":true'), `expected success, got: ${text}`);
      assert.ok(text.includes('ok:e2e'), `expected ok:e2e in output: ${text}`);
    } finally {
      child.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  });
});
```

- [ ] **Step 2: Run with RUN_E2E=1 (only works if Ardour is built)**

```bash
cd /Users/shanekoss/Repos/ardour/api-service
RUN_E2E=1 npm test 2>&1 | tail -15
```
Expected: e2e test passes. If Ardour build is not available, tests are skipped and other tests pass.

Run without RUN_E2E:
```bash
cd /Users/shanekoss/Repos/ardour/api-service && npm test 2>&1 | tail -5
```
Expected: All tests pass (e2e test skipped).

- [ ] **Step 3: Commit**

```bash
git add api-service/test/e2e.test.js
git commit -m "feat: add e2e test for full luasession + MCP HTTP stack"
```

---

### Summary: Task Dependencies

```
Task 1 (deps)
    ↓
Task 2 (config)
    ↓
Task 3 (PortPool) ───┐
Task 4 (LogBuffer) ──┤
Task 5 (test helpers)┤
Task 6 (tool schemas)┤
    ↓                ↓
Task 7 (SessionManager) — depends on PortPool, LogBuffer, helpers
    ↓
Task 8 (ActionProxy) — depends on tool schemas, helpers
    ↓
Task 9 (TimeoutReaper) — depends on SessionManager
    ↓
Task 10 (sessions route — core) — depends on SessionManager
    ↓
Task 11 (actions + tools routes) — depends on ActionProxy
    ↓
Task 12 (upload route) — depends on sessions route
    ↓
Task 13 (server.js wiring) — depends on everything
    ↓
Task 14 (test app frontend) — depends on Task 13 (the API)
    ↓
Task 15 (e2e integration)
```

### Known Deferred Items

These are in the spec but NOT in this plan — add them later:
- Export service (`POST /v1/sessions/:id/export`) — needs lua_eval patterns for SimpleExport
- Analysis service (`POST /v1/sessions/:id/analyze`) — needs ffmpeg integration + per-track solo/export loop
- Session auto-save implementation detail (currently stubbed in server.js)
- Plugin preset discovery
- Auth (Bearer token)
- Metrics (Prometheus)
- Batch action timeout edge cases
- Orphan PID file reaping on startup

These deferred items can be added in a follow-up plan after the core session manager works end-to-end.
