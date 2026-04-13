import { randomUUID, randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import PQueue from 'p-queue';
import { LogBuffer } from './log-buffer.js';
import { buildArdourEnv } from './executor.js';

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
      const err = new Error('MAX_SESSIONS: Max concurrent sessions reached');
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

    // Node.js owns `sessionDir` (for PID, uploads, exports); Ardour creates
    // its session inside `sessionDir/data/` (create_session fails if dir exists).
    const sessionDir = resolve(this._config.sessionsDir, id);
    mkdirSync(sessionDir, { recursive: true });
    const ardourSessionDir = join(sessionDir, 'data');

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
      uploads: new Map(),
    };

    this._sessions.set(id, session);

    // Spawn the process with full Ardour env (ARDOUR_DLL_PATH, DYLD_FALLBACK_LIBRARY_PATH, etc.)
    const env = {
      ...buildArdourEnv(),
      MCP_HTTP_PORT: String(port),
    };

    let bin, args;
    if (session.gui) {
      // GUI mode: let Ardour create the session itself with its configured audio backend.
      // Pre-creating via luasession (Dummy backend) caused an I/O config mismatch when the
      // GUI opened the file, triggering Route::output_change_handler → DiskReader reconfigure
      // with a bogus buffer size → PlaybackBuffer hang (huge allocation).
      bin = this._config.ardourGuiBin;
      args = ['-n', '-N', ardourSessionDir];
      session._guiEnv = { ...env, MCP_HTTP_PORT: String(port) };
      session.logBuffer.append(`[gui] Launching ${bin} ${args.join(' ')}`);
    } else {
      // Headless mode: arlua with mcp_host.lua script
      bin = this._config.luasessionBin;
      args = [
        this._config.mcpHostLua,
        ardourSessionDir,
        name,
        String(sampleRate),
        String(tempo),
        String(timeSignature.numerator),
        String(timeSignature.denominator),
      ];
    }

    try {
      const spawnEnv = session._guiEnv || env;
      const child = this._spawner(bin, args, { env: spawnEnv, cwd: sessionDir });
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
        // Only release port if not already released
        if (session.status !== 'stopped' && session.status !== 'dead') {
          this._portPool.release(session.port);
        }
        try { rmSync(join(sessionDir, 'ardour.pid'), { force: true }); } catch {}
        if (session.status === 'stopping') {
          session.status = 'stopped';
        } else {
          session.status = 'dead';
        }
        // Schedule removal from the map
        const to = this._clock ? this._clock.setTimeout.bind(this._clock) : setTimeout;
        to(() => this._sessions.delete(id), 5 * 60 * 1000);
      });

      child.on('error', () => {
        if (session.status !== 'stopped' && session.status !== 'dead') {
          this._portPool.release(session.port);
        }
        session.status = 'dead';
      });

      // For GUI mode, poll the MCP HTTP port since there's no READY marker
      if (session.gui) {
        this._pollForReady(session);
      }
    } catch (e) {
      this._portPool.release(port);
      this._sessions.delete(id);
      throw e;
    }

    return { session_id: id, status: 'starting' };
  }

  async _pollForReady(session) {
    const startupTimeout = this._config.sessionStartupTimeoutMs || 60000;
    const deadline = Date.now() + startupTimeout;
    const pollInterval = 1000;
    while (Date.now() < deadline) {
      if (session.status !== 'starting') return; // crashed or destroyed
      try {
        const res = await this._httpClient(session.mcpBaseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          session.status = 'ready';
          session.logBuffer.append('MCP HTTP is responding — session ready');
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    session.logBuffer.append(`Startup timeout: MCP HTTP not responding on port ${session.port} after ${startupTimeout}ms`);
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
    if (session.status === 'stopping' || session.status === 'stopped' || session.status === 'dead') return;

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

      // If child already exited (e.g. synchronous kill()), resolve immediately
      if (session.status === 'stopped' || session.status === 'dead') {
        return finish();
      }

      const to = this._clock ? this._clock.setTimeout.bind(this._clock) : setTimeout;
      const timer = to(() => {
        if (session.child && session.child.kill) {
          try { session.child.kill('SIGKILL'); } catch {}
        }
        finish();
      }, timeoutMs);

      if (session.child) {
        session.child.once('exit', () => {
          if (typeof timer === 'number' || typeof timer === 'object') {
            const cl = this._clock ? this._clock.clearTimeout.bind(this._clock) : clearTimeout;
            cl(timer);
          }
          finish();
        });
      } else {
        finish();
      }
    });
  }

  /**
   * Register an uploaded file against a session. Returns an opaque id of the form
   * `upl_<16-hex-chars>` (generated from 8 random bytes). Callers receive only
   * this id and resolve to a path server-side via getUploadPath().
   */
  registerUpload(sessionId, filename, bytes, path) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    const id = 'upl_' + randomBytes(8).toString('hex');
    s.uploads.set(id, { filename, bytes, path, createdAt: this._now() });
    return id;
  }

  getUploadPath(sessionId, uploadId) {
    const s = this._sessions.get(sessionId);
    return s?.uploads.get(uploadId)?.path || null;
  }

  cacheDecodedPath(sessionId, uploadId, decodedPath) {
    const s = this._sessions.get(sessionId);
    if (!s) return false;
    const u = s.uploads.get(uploadId);
    if (!u) return false;
    u.decodedPath = decodedPath;
    return true;
  }

  getDecodedPath(sessionId, uploadId) {
    const s = this._sessions.get(sessionId);
    return s?.uploads.get(uploadId)?.decodedPath || null;
  }

  getUploads(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return [];
    return [...s.uploads.entries()].map(([id, u]) => ({
      upload_id: id,
      filename: u.filename,
      bytes: u.bytes,
      created_at: new Date(u.createdAt).toISOString(),
    }));
  }

  _sanitizeSessionName(name) {
    const clean = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return clean || 'session';
  }
}
