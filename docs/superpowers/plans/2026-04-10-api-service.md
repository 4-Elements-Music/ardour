# Headless DAW API Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js API service that accepts JSON job specs, generates Lua scripts, executes them via arlua, and returns rendered audio files.

**Architecture:** Fastify HTTP server → JSON schema validation → Lua script generator → arlua subprocess → file response. Async job model with polling. All audio files referenced from a local library directory.

**Tech Stack:** Node.js 20+, Fastify, Ajv (JSON Schema), uuid, child_process.

**Spec:** `docs/superpowers/specs/2026-04-10-headless-daw-api-design.md`

---

### Task 1: Project Scaffolding and Health Endpoint

**Files:**
- Create: `api-service/package.json`
- Create: `api-service/src/server.js`
- Create: `api-service/src/routes/health.js`
- Create: `api-service/src/config.js`

- [ ] **Step 1: Create package.json**

```bash
mkdir -p api-service/src/routes api-service/src/lib api-service/src/schemas api-service/src/workers
```

Create `api-service/package.json`:
```json
{
  "name": "ardour-headless-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test src/**/*.test.js"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "uuid": "^10.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd api-service && npm install
```

- [ ] **Step 3: Create config.js**

Create `api-service/src/config.js`:
```js
import { resolve } from 'path';

const ARDOUR_ROOT = resolve(import.meta.dirname, '../../');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // Paths
  arluaBin: resolve(ARDOUR_ROOT, 'build/luasession/luasession'),
  ardevEnv: resolve(ARDOUR_ROOT, 'build/gtk2_ardour/ardev_common_waf.sh'),
  ardourRoot: ARDOUR_ROOT,
  libraryBaseDir: process.env.LIBRARY_BASE_DIR || resolve(ARDOUR_ROOT, 'library'),
  jobsDir: process.env.JOBS_DIR || '/tmp/ardour-jobs',

  // Limits
  maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '10', 10),
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10),
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS || '120000', 10),
  outputTtlMs: parseInt(process.env.OUTPUT_TTL_MS || '3600000', 10),
  maxTracks: parseInt(process.env.MAX_TRACKS || '64', 10),
  maxRegionsPerTrack: parseInt(process.env.MAX_REGIONS_PER_TRACK || '128', 10),
  maxPluginsPerTrack: parseInt(process.env.MAX_PLUGINS_PER_TRACK || '16', 10),
  maxJobSpecBytes: parseInt(process.env.MAX_JOB_SPEC_BYTES || '1048576', 10), // 1MB
};
```

- [ ] **Step 4: Create server.js**

Create `api-service/src/server.js`:
```js
import Fastify from 'fastify';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          requestId: req.id,
        };
      },
    },
  },
  bodyLimit: config.maxJobSpecBytes,
  requestIdHeader: 'x-request-id',
  genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
});

app.register(healthRoutes, { prefix: '/v1' });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

- [ ] **Step 5: Create health route**

Create `api-service/src/routes/health.js`:
```js
export async function healthRoutes(app) {
  app.get('/health', async (req, reply) => {
    return { status: 'ok' };
  });
}
```

- [ ] **Step 6: Test it runs**

```bash
cd api-service && node src/server.js &
curl http://localhost:3000/v1/health
# Expected: {"status":"ok"}
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add api-service/
git commit -m "feat: scaffold API service with Fastify and health endpoint"
```

---

### Task 2: Job Queue and Executor

**Files:**
- Create: `api-service/src/lib/job-queue.js`
- Create: `api-service/src/lib/executor.js`

The job queue manages pending/active/completed jobs. The executor spawns arlua as a subprocess with the right environment variables.

- [ ] **Step 1: Create job-queue.js**

Create `api-service/src/lib/job-queue.js`:
```js
import { config } from '../config.js';

export class JobQueue {
  constructor() {
    this.jobs = new Map();    // jobId -> job state
    this.pending = [];        // jobIds waiting to run
    this.active = new Set();  // jobIds currently running
    this.onJobReady = null;   // callback when a job can start
  }

  addJob(jobId, spec) {
    if (this.pending.length + this.active.size >= config.maxQueueDepth) {
      return { accepted: false, reason: 'queue_full' };
    }

    const job = {
      id: jobId,
      spec,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      outputs: [],
      analysis: null,
      error: null,
    };

    this.jobs.set(jobId, job);
    this.pending.push(jobId);
    this._tryProcessNext();
    return { accepted: true };
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  markProcessing(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'processing';
    job.startedAt = Date.now();
    this.active.add(jobId);
  }

  markComplete(jobId, outputs, analysis) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'complete';
    job.completedAt = Date.now();
    job.outputs = outputs;
    job.analysis = analysis;
    this.active.delete(jobId);
    this._scheduleCleanup(jobId);
    this._tryProcessNext();
  }

  markFailed(jobId, error) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = error;
    this.active.delete(jobId);
    this._scheduleCleanup(jobId);
    this._tryProcessNext();
  }

  get queueDepth() {
    return this.pending.length;
  }

  get activeCount() {
    return this.active.size;
  }

  _tryProcessNext() {
    if (this.active.size >= config.maxConcurrentJobs) return;
    if (this.pending.length === 0) return;

    const jobId = this.pending.shift();
    if (this.onJobReady) {
      this.onJobReady(jobId);
    }
  }

  _scheduleCleanup(jobId) {
    setTimeout(() => {
      this.jobs.delete(jobId);
    }, config.outputTtlMs);
  }
}
```

- [ ] **Step 2: Create executor.js**

Create `api-service/src/lib/executor.js`:
```js
import { spawn } from 'child_process';
import { mkdir, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { config } from '../config.js';

export async function executeJob(jobId, luaScript, logger) {
  const jobDir = join(config.jobsDir, jobId);
  const sessionDir = join(jobDir, 'session');
  const exportDir = join(jobDir, 'export');
  const scriptPath = join(jobDir, 'job.lua');

  await mkdir(jobDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });

  // Write the Lua script
  const { writeFile } = await import('fs/promises');
  await writeFile(scriptPath, luaScript, 'utf-8');

  // Build environment from ardev_common_waf.sh
  const env = buildArdourEnv();

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(config.arluaBin, [scriptPath], {
      cwd: config.ardourRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.jobTimeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`arlua exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      // Find output files
      try {
        const outputs = await findOutputFiles(exportDir);
        resolvePromise({ outputs, stdout, stderr });
      } catch (err) {
        reject(new Error(`Export produced no output files: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn arlua: ${err.message}`));
    });
  });
}

function buildArdourEnv() {
  const top = config.ardourRoot;
  const libs = join(top, 'build/libs');

  return {
    ARDOUR_SURFACES_PATH: [
      'osc', 'faderport8', 'faderport', 'generic_midi', 'mackie',
      'us2400', 'push2', 'cc121', 'launch_control_xl', 'contourdesign',
      'websockets', 'console1', 'launchpad_pro', 'launchpad_x',
    ].map(s => join(libs, 'surfaces', s)).join(':'),
    ARDOUR_PANNER_PATH: join(libs, 'panners'),
    ARDOUR_DATA_PATH: [join(top, 'share'), join(top, 'build'), join(top, 'gtk2_ardour'), join(top, 'build/gtk2_ardour')].join(':'),
    ARDOUR_MIDIMAPS_PATH: join(top, 'share/midi_maps'),
    ARDOUR_MIDI_PATCH_PATH: join(top, 'share/patchfiles'),
    ARDOUR_EXPORT_FORMATS_PATH: join(top, 'share/export'),
    ARDOUR_THEMES_PATH: join(top, 'gtk2_ardour/themes'),
    ARDOUR_BACKEND_PATH: [join(libs, 'backends/dummy'), join(libs, 'backends/coreaudio')].join(':'),
    ARDOUR_CONFIG_PATH: [top, join(top, 'gtk2_ardour'), join(top, 'build'), join(top, 'build/gtk2_ardour')].join(':'),
    ARDOUR_DLL_PATH: libs,
    GTK_PATH: join(libs, 'clearlooks-newer'),
    VAMP_PATH: [join(libs, 'vamp-plugins'), join(libs, 'vamp-pyin')].join(':'),
    GTK2_RC_FILES: '/nonexistent',
    DYLD_FALLBACK_LIBRARY_PATH: [
      'tk/ydk-pixbuf', 'tk/ztk', 'tk/ydk', 'tk/ytk', 'tk/ztkmm', 'tk/ydkmm', 'tk/ytkmm',
      'ptformat', 'qm-dsp', 'ardour', 'midi++2', 'pbd', 'aaf', 'gtkmm2ext', 'widgets',
      'appleutility', 'evoral', 'audiographer', 'temporal', 'libltc', 'canvas', 'waveview',
    ].map(d => join(libs, d)).join(':'),
  };
}

async function findOutputFiles(dir) {
  try {
    const files = await readdir(dir);
    const outputs = [];
    for (const f of files) {
      const fullPath = join(dir, f);
      const s = await stat(fullPath);
      if (s.isFile() && s.size > 0) {
        outputs.push({ filename: f, path: fullPath, size: s.size });
      }
    }
    return outputs;
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add api-service/src/lib/
git commit -m "feat: add job queue and arlua executor"
```

---

### Task 3: Lua Script Generator

**Files:**
- Create: `api-service/src/lib/lua-generator.js`
- Create: `api-service/src/lib/sanitizer.js`

This is the core of the service — translating a JSON job spec into a Lua script.

- [ ] **Step 1: Create sanitizer.js**

Create `api-service/src/lib/sanitizer.js`:
```js
/**
 * Escape a string for safe inclusion in a Lua string literal.
 * Prevents Lua injection via track names, file paths, etc.
 */
export function luaString(str) {
  if (typeof str !== 'string') return '""';
  return '"' + str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    + '"';
}

/**
 * Validate that a file path is within the allowed library base directory.
 * Returns the resolved absolute path or throws.
 */
export function resolveLibraryPath(relativePath, baseDir) {
  const { resolve, relative } = await import('path');
  const resolved = resolve(baseDir, relativePath);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..') || resolve(baseDir, rel) !== resolved) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}
```

- [ ] **Step 2: Create lua-generator.js**

Create `api-service/src/lib/lua-generator.js`:
```js
import { luaString } from './sanitizer.js';
import { resolve } from 'path';

export function generateLuaScript(spec, jobDir, libraryBaseDir) {
  const lines = [];
  const exportDir = resolve(jobDir, 'export');
  const sessionDir = resolve(jobDir, 'session');
  const sessionName = 'job-session';

  lines.push('-- Auto-generated by ardour-headless-api');
  lines.push('-- DO NOT EDIT');
  lines.push('');

  // 1. Audio backend setup
  lines.push('AudioEngine:set_backend("None (Dummy)", "", "")');
  lines.push(`AudioEngine:set_sample_rate(${spec.session.sample_rate})`);
  lines.push('AudioEngine:set_buffer_size(1024)');
  lines.push('AudioEngine:start()');
  lines.push('');
  lines.push(`os.execute("mkdir -p " .. ${luaString(sessionDir)})`);
  lines.push(`create_session(${luaString(sessionDir)}, ${luaString(sessionName)}, ${spec.session.sample_rate})`);
  lines.push('');

  // 2. Tempo map
  lines.push('local tm = Temporal.TempoMap.write_copy()');
  for (const t of spec.session.tempo) {
    const pos = barToTicks(t.bar, spec.session.time_signature);
    if (t.ramp && spec.session.tempo.indexOf(t) > 0) {
      const prev = spec.session.tempo[spec.session.tempo.indexOf(t) - 1];
      lines.push(`tm:set_tempo(Temporal.Tempo(${prev.bpm}, ${t.bpm}, 4), Temporal.timepos_t.from_ticks(${pos}))`);
    } else {
      lines.push(`tm:set_tempo(Temporal.Tempo(${t.bpm}, ${t.bpm}, 4), Temporal.timepos_t.from_ticks(${pos}))`);
    }
  }
  for (const ts of spec.session.time_signature) {
    const pos = barToTicks(ts.bar, spec.session.time_signature);
    lines.push(`tm:set_meter(Temporal.Meter(${ts.numerator}, ${ts.denominator}), Temporal.timepos_t.from_ticks(${pos}))`);
  }
  lines.push('Temporal.TempoMap.update(tm)');
  lines.push('');

  // 3. Buses (create before tracks so sends can reference them)
  if (spec.buses) {
    for (const bus of spec.buses) {
      lines.push(`-- Bus: ${bus.name}`);
      lines.push(`local bus_${safeName(bus.name)} = Session:new_audio_route(2, 2, ARDOUR.RouteGroup(), 1, ${luaString(bus.name)}, ARDOUR.PresentationInfo.Flag.AudioBus, ARDOUR.PresentationInfo.max_order):front()`);
      emitMixerSettings(lines, `bus_${safeName(bus.name)}`, bus);
      emitPlugins(lines, `bus_${safeName(bus.name)}`, bus.plugins || []);
      lines.push('');
    }
  }

  // 4. Tracks
  for (const track of spec.tracks) {
    const varName = `track_${safeName(track.name)}`;
    lines.push(`-- Track: ${track.name}`);

    if (track.type === 'audio') {
      const ch = track.channels || 2;
      lines.push(`local ${varName} = Session:new_audio_track(${ch}, ${ch}, ARDOUR.RouteGroup(), 1, ${luaString(track.name)}, ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true):front()`);
    } else {
      lines.push(`local ${varName}_list = Session:new_midi_track(ARDOUR.ChanCount(ARDOUR.DataType("midi"), 1), ARDOUR.ChanCount(ARDOUR.DataType("audio"), 2), true, ARDOUR.PluginInfo(), nil, ARDOUR.RouteGroup(), 1, ${luaString(track.name)}, ARDOUR.PresentationInfo.max_order, ARDOUR.TrackMode.Normal, true, false)`);
      lines.push(`local ${varName} = ${varName}_list:front()`);
    }

    // Instrument (for MIDI tracks)
    if (track.type === 'midi' && track.instrument) {
      emitInstrument(lines, varName, track.instrument, libraryBaseDir);
    }

    // Regions
    for (const region of (track.regions || [])) {
      emitRegion(lines, varName, track, region, spec, libraryBaseDir);
    }

    // Plugins
    emitPlugins(lines, varName, track.plugins || []);

    // Sends
    if (track.sends) {
      for (const send of track.sends) {
        lines.push(`Session:add_internal_sends(bus_${safeName(send.bus)}, ARDOUR.Placement.PostFader, ARDOUR.RouteListPtr())`);
        // TODO: proper send routing needs route list construction
      }
    }

    // Mixer settings
    emitMixerSettings(lines, varName, track);

    // Automation
    if (track.automation) {
      emitAutomation(lines, varName, track.automation);
    }

    lines.push('');
  }

  // 5. Master bus
  if (spec.master) {
    lines.push('-- Master bus');
    lines.push('local master = Session:master_out()');
    emitMixerSettings(lines, 'master', spec.master);
    emitPlugins(lines, 'master', spec.master.plugins || []);
    lines.push('');
  }

  // 6. Session range
  const totalTicks = durationToTicks(spec.session.duration_bars, spec.session.time_signature);
  lines.push(`Session:maybe_update_session_range(Temporal.timepos_t(0), Temporal.timepos_t.from_ticks(${totalTicks}))`);
  lines.push('');

  // 7. Save and export
  lines.push('Session:save_state("")');
  lines.push('');
  lines.push(`os.execute("mkdir -p " .. ${luaString(exportDir)})`);

  for (const fmt of (spec.output.formats || [{ format: 'wav', bit_depth: 24, sample_rate: spec.session.sample_rate }])) {
    const bitDepth = fmt.bit_depth || 24;
    const sampleRate = fmt.sample_rate || spec.session.sample_rate;
    lines.push(`local se = Session:simple_export()`);
    lines.push(`se:set_name("output")`);
    lines.push(`se:set_folder(${luaString(exportDir)})`);
    lines.push(`se:set_range(Session:current_start_sample(), Session:current_end_sample())`);
    // Use CD preset for 16-bit 44100, WAV preset for others
    if (bitDepth === 16 && sampleRate === 44100) {
      lines.push(`se:set_preset("df340c53-88b5-4342-a1c8-58e0704872ea")`); // CD
    } else {
      lines.push(`se:set_preset("75969a1c-3133-4694-864b-a1fa50e43348")`); // WAV @ session rate
    }
    lines.push(`se:check_outputs()`);
    lines.push(`se:run_export()`);
    lines.push('');
  }

  lines.push('close_session()');

  return lines.join('\n');
}

function emitRegion(lines, trackVar, track, region, spec, libraryBaseDir) {
  const pos = barBeatToTicks(region.position_bar || 1, region.position_beat || 1, spec.session.time_signature);

  if (region.file) {
    // File-based region (audio or MIDI)
    const filePath = resolve(libraryBaseDir, region.file);
    lines.push(`do`);
    lines.push(`  local rgn = ARDOUR.LuaAPI.import_audio_file(Session, ${luaString(filePath)})`);
    lines.push(`  if not rgn:isnil() then`);

    // Time-stretch / pitch-shift
    if ((region.time_stretch_ratio && region.time_stretch_ratio !== 1.0) ||
        (region.pitch_shift_semitones && region.pitch_shift_semitones !== 0)) {
      const stretch = region.time_stretch_ratio || 1.0;
      const pitchRatio = region.pitch_shift_semitones ? `2 ^ (${region.pitch_shift_semitones} / 12.0)` : '1.0';
      lines.push(`    local ar = rgn:to_audioregion()`);
      lines.push(`    if ar and not ar:isnil() then`);
      lines.push(`      local rb = ARDOUR.LuaAPI.Rubberband(ar, false)`);
      lines.push(`      rb:set_strech_and_pitch(${stretch}, ${pitchRatio})`);
      lines.push(`      local stretched = rb:process(function(p) return false end)`);
      lines.push(`      if stretched and not stretched:isnil() then rgn = stretched end`);
      lines.push(`    end`);
    }

    // Per-region gain
    if (region.gain_db && region.gain_db !== 0) {
      lines.push(`    local ar = rgn:to_audioregion()`);
      lines.push(`    if ar and not ar:isnil() then ar:set_scale_amplitude(10 ^ (${region.gain_db} / 20)) end`);
    }

    // Fades
    if (region.fade_in_ms) {
      const samples = Math.round((region.fade_in_ms / 1000) * spec.session.sample_rate);
      lines.push(`    local ar = rgn:to_audioregion()`);
      lines.push(`    if ar and not ar:isnil() then ar:set_fade_in_length(${samples}) end`);
    }
    if (region.fade_out_ms) {
      const samples = Math.round((region.fade_out_ms / 1000) * spec.session.sample_rate);
      lines.push(`    local ar = rgn:to_audioregion()`);
      lines.push(`    if ar and not ar:isnil() then ar:set_fade_out_length(${samples}) end`);
    }

    // Place region (with loop_count copies)
    const loopCount = region.loop_count || 1;
    lines.push(`    local pl = ${trackVar}:to_track():playlist()`);
    if (loopCount > 1) {
      lines.push(`    local rgn_len = rgn:length():samples()`);
      lines.push(`    for i = 0, ${loopCount - 1} do`);
      lines.push(`      local copy = (i == 0) and rgn or ARDOUR.RegionFactory.clone_region(rgn, true, false)`);
      lines.push(`      pl:add_region(copy, Temporal.timepos_t.from_ticks(${pos} + i * rgn_len), 1, false, 0, 0, false)`);
      lines.push(`    end`);
    } else {
      lines.push(`    pl:add_region(rgn, Temporal.timepos_t.from_ticks(${pos}), 1, false, 0, 0, false)`);
    }

    lines.push(`  end`);
    lines.push(`end`);
  } else if (region.notes) {
    // Inline MIDI region
    const lenTicks = (region.length_bars || 4) * beatsPerBar(region.position_bar || 1, spec.session.time_signature) * 1920;
    lines.push(`do`);
    lines.push(`  local midi_track = ${trackVar}:to_track():to_midi_track()`);
    lines.push(`  local mr = ARDOUR.LuaAPI.create_midi_region(midi_track, Temporal.timepos_t.from_ticks(${pos}), Temporal.timecnt_t(Temporal.timepos_t.from_ticks(${lenTicks})), ${luaString(track.name + ' region')})`);
    lines.push(`  if not mr:isnil() then`);
    lines.push(`    local src = mr:midi_source(0)`);
    lines.push(`    local model = src:model()`);
    lines.push(`    local cmd = model:new_note_diff_command("Add notes")`);

    for (const note of region.notes) {
      lines.push(`    cmd:add(ARDOUR.LuaAPI.new_noteptr(0, Temporal.Beats(${note.start_beat}, 0), Temporal.Beats(${note.duration_beats}, 0), ${note.pitch}, ${note.velocity}))`);
    }

    lines.push(`    model:apply_diff_command_as_commit(Session, cmd)`);

    // Loop copies
    const loopCount = region.loop_count || 1;
    if (loopCount > 1) {
      lines.push(`    local pl = midi_track:playlist()`);
      lines.push(`    for i = 1, ${loopCount - 1} do`);
      lines.push(`      local copy = ARDOUR.RegionFactory.clone_region(mr, true, false)`);
      lines.push(`      pl:add_region(copy, Temporal.timepos_t.from_ticks(${pos} + i * ${lenTicks}), 1, false, 0, 0, false)`);
      lines.push(`    end`);
    }

    lines.push(`  end`);
    lines.push(`end`);
  }
}

function emitPlugins(lines, routeVar, plugins) {
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i];
    const plugVar = `plugin_${i}`;
    lines.push(`do`);
    lines.push(`  local ${plugVar} = ARDOUR.LuaAPI.new_plugin(Session, ${luaString(plugin.uri)}, ARDOUR.PluginType.LV2, ${luaString(plugin.preset || '')})`);
    lines.push(`  if not ${plugVar}:isnil() then`);
    lines.push(`    ${routeVar}:add_processor_by_index(${plugVar}, ${i}, nil, true)`);

    if (plugin.params) {
      lines.push(`    local pi = ${plugVar}:to_insert()`);
      for (const [paramIdx, value] of Object.entries(plugin.params)) {
        lines.push(`    ARDOUR.LuaAPI.set_processor_param(pi, ${paramIdx}, ${value})`);
      }
    }

    if (plugin.sidechain_source) {
      lines.push(`    ${routeVar}:add_sidechain(${plugVar})`);
    }

    lines.push(`  end`);
    lines.push(`end`);
  }
}

function emitInstrument(lines, trackVar, instrument, libraryBaseDir) {
  lines.push(`do`);
  lines.push(`  local inst = ARDOUR.LuaAPI.new_plugin(Session, ${luaString(instrument.uri)}, ARDOUR.PluginType.LV2, ${luaString(instrument.preset || '')})`);
  lines.push(`  if not inst:isnil() then`);
  lines.push(`    ${trackVar}:add_processor_by_index(inst, 0, nil, true)`);

  if (instrument.files) {
    lines.push(`    local pi = inst:to_insert()`);
    for (const file of instrument.files) {
      const filePath = resolve(libraryBaseDir, file);
      // Set file via plugin property (LV2 instruments use URI-based properties)
      lines.push(`    -- Load instrument file: ${file}`);
      lines.push(`    ARDOUR.LuaAPI.set_plugin_insert_property(pi, "http://www.fluidsynth.org/sf2", ${luaString(filePath)})`);
    }
  }

  lines.push(`  end`);
  lines.push(`end`);
}

function emitMixerSettings(lines, routeVar, settings) {
  if (settings.gain_db !== undefined) {
    const coeff = Math.pow(10, settings.gain_db / 20);
    lines.push(`${routeVar}:gain_control():set_value(${coeff}, PBD.GroupControlDisposition.NoGroup)`);
  }
  if (settings.pan !== undefined) {
    lines.push(`do local pc = ${routeVar}:pan_azimuth_control(); if pc and not pc:isnil() then pc:set_value(${settings.pan}, PBD.GroupControlDisposition.NoGroup) end end`);
  }
  if (settings.mute) {
    lines.push(`${routeVar}:mute_control():set_value(1, PBD.GroupControlDisposition.NoGroup)`);
  }
  if (settings.solo) {
    lines.push(`${routeVar}:solo_control():set_value(1, PBD.GroupControlDisposition.NoGroup)`);
  }
  if (settings.phase_invert) {
    lines.push(`${routeVar}:phase_control():set_value(1, PBD.GroupControlDisposition.NoGroup)`);
  }
}

function emitAutomation(lines, routeVar, automations) {
  for (const auto of automations) {
    if (auto.target === 'gain') {
      lines.push(`do`);
      lines.push(`  local ac = ${routeVar}:gain_control()`);
      lines.push(`  local al = ac:alist()`);
      lines.push(`  al:clear_list()`);
      for (const pt of auto.points) {
        const ticks = (((pt.bar || 1) - 1) * 4 + ((pt.beat || 1) - 1)) * 1920;
        const val = pt.value_db !== undefined ? Math.pow(10, pt.value_db / 20) : pt.value;
        lines.push(`  al:add(Temporal.timepos_t.from_ticks(${ticks}), ${val}, false, true)`);
      }
      lines.push(`  ac:set_automation_state(ARDOUR.AutoState.Play)`);
      lines.push(`end`);
    } else if (auto.target === 'pan') {
      lines.push(`do`);
      lines.push(`  local ac = ${routeVar}:pan_azimuth_control()`);
      lines.push(`  if ac and not ac:isnil() then`);
      lines.push(`    local al = ac:alist()`);
      lines.push(`    al:clear_list()`);
      for (const pt of auto.points) {
        const ticks = (((pt.bar || 1) - 1) * 4 + ((pt.beat || 1) - 1)) * 1920;
        lines.push(`    al:add(Temporal.timepos_t.from_ticks(${ticks}), ${pt.value}, false, true)`);
      }
      lines.push(`    ac:set_automation_state(ARDOUR.AutoState.Play)`);
      lines.push(`  end`);
      lines.push(`end`);
    } else if (auto.target === 'plugin') {
      lines.push(`do`);
      lines.push(`  local proc = ${routeVar}:nth_plugin(${auto.plugin_index || 0})`);
      lines.push(`  if proc and not proc:isnil() then`);
      lines.push(`    local al, cl, pd = ARDOUR.LuaAPI.plugin_automation(proc, ${auto.param_index || 0})`);
      lines.push(`    if al and not al:isnil() then`);
      lines.push(`      al:clear_list()`);
      for (const pt of auto.points) {
        const ticks = (((pt.bar || 1) - 1) * 4 + ((pt.beat || 1) - 1)) * 1920;
        lines.push(`      al:add(Temporal.timepos_t.from_ticks(${ticks}), ${pt.value}, false, true)`);
      }
      lines.push(`    end`);
      lines.push(`  end`);
      lines.push(`end`);
    }
  }
}

// Helpers
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

function barToTicks(bar, timeSigs) {
  // Simplified: assumes first time sig applies throughout
  const ts = timeSigs[0] || { numerator: 4, denominator: 4 };
  const beatsPerBar = ts.numerator * (4 / ts.denominator);
  return ((bar - 1) * beatsPerBar) * 1920;
}

function barBeatToTicks(bar, beat, timeSigs) {
  const barTicks = barToTicks(bar, timeSigs);
  return barTicks + ((beat - 1) * 1920);
}

function beatsPerBar(bar, timeSigs) {
  const ts = timeSigs[0] || { numerator: 4, denominator: 4 };
  return ts.numerator * (4 / ts.denominator);
}

function durationToTicks(bars, timeSigs) {
  return barToTicks(bars + 1, timeSigs);
}
```

- [ ] **Step 3: Commit**

```bash
git add api-service/src/lib/lua-generator.js api-service/src/lib/sanitizer.js
git commit -m "feat: add Lua script generator and input sanitizer"
```

---

### Task 4: Job Routes and Integration

**Files:**
- Create: `api-service/src/routes/jobs.js`
- Create: `api-service/src/routes/plugins.js`
- Modify: `api-service/src/server.js`

- [ ] **Step 1: Create jobs.js**

Create `api-service/src/routes/jobs.js`:
```js
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { config } from '../config.js';
import { generateLuaScript } from '../lib/lua-generator.js';
import { executeJob } from '../lib/executor.js';

export async function jobRoutes(app) {
  const { JobQueue } = await import('../lib/job-queue.js');
  const queue = new JobQueue();

  queue.onJobReady = async (jobId) => {
    const job = queue.getJob(jobId);
    if (!job) return;

    queue.markProcessing(jobId);

    try {
      const luaScript = generateLuaScript(job.spec, `${config.jobsDir}/${jobId}`, config.libraryBaseDir);
      const result = await executeJob(jobId, luaScript, app.log);

      const outputs = result.outputs.map(o => ({
        format: o.filename.split('.').pop(),
        filename: o.filename,
        url: `/v1/jobs/${jobId}/output/${o.filename}`,
        size: o.size,
      }));

      queue.markComplete(jobId, outputs, null);
    } catch (err) {
      app.log.error({ jobId, err: err.message }, 'Job failed');
      queue.markFailed(jobId, err.message);
    }
  };

  // POST /v1/jobs
  app.post('/jobs', async (req, reply) => {
    const spec = req.body;

    // Basic validation
    if (!spec || !spec.session || !spec.tracks) {
      return reply.code(400).send({ error: 'Invalid job spec: missing session or tracks' });
    }

    if ((spec.tracks || []).length > config.maxTracks) {
      return reply.code(413).send({ error: `Too many tracks (max ${config.maxTracks})` });
    }

    const jobId = randomUUID();
    const result = queue.addJob(jobId, spec);

    if (!result.accepted) {
      return reply.code(429).send({ error: 'Queue full, try later' });
    }

    return reply.code(202).send({
      job_id: jobId,
      status: 'pending',
    });
  });

  // GET /v1/jobs/:id
  app.get('/jobs/:id', async (req, reply) => {
    const job = queue.getJob(req.params.id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    const response = {
      job_id: job.id,
      status: job.status,
      progress: job.progress,
    };

    if (job.status === 'complete') {
      response.outputs = job.outputs;
      if (job.analysis) {
        response.analysis = job.analysis;
      }
    }

    if (job.status === 'failed') {
      response.error = job.error;
    }

    return response;
  });

  // GET /v1/jobs/:id/output/:filename
  app.get('/jobs/:id/output/:filename', async (req, reply) => {
    const job = queue.getJob(req.params.id);
    if (!job || job.status !== 'complete') {
      return reply.code(404).send({ error: 'Output not found' });
    }

    const output = job.outputs.find(o => o.filename === req.params.filename);
    if (!output) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const filePath = `${config.jobsDir}/${req.params.id}/export/${req.params.filename}`;

    try {
      const s = await stat(filePath);
      const ext = req.params.filename.split('.').pop();
      const mimeType = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[ext] || 'application/octet-stream';

      reply.header('Content-Type', mimeType);
      reply.header('Content-Length', s.size);
      reply.header('Content-Disposition', `attachment; filename="${req.params.filename}"`);

      return reply.send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'File not found on disk' });
    }
  });
}
```

- [ ] **Step 2: Create plugins.js**

Create `api-service/src/routes/plugins.js`:
```js
import { spawn } from 'child_process';
import { config } from '../config.js';

let pluginCache = null;

export async function pluginRoutes(app) {
  app.get('/plugins', async (req, reply) => {
    if (pluginCache) {
      return pluginCache;
    }

    // Query arlua for available plugins
    const script = `
      for p in ARDOUR.LuaAPI.list_plugins():iter() do
        print(string.format("PLUGIN|%s|%s|%s|%s", p:name(), p:unique_id(), p:type(), p:category()))
      end
    `;

    // For now return a static list of known bundled plugins
    pluginCache = [
      { name: 'ACE Compressor', uri: 'urn:ardour:a-comp', type: 'LV2', category: 'Dynamics' },
      { name: 'ACE Compressor (stereo)', uri: 'urn:ardour:a-comp#stereo', type: 'LV2', category: 'Dynamics' },
      { name: 'ACE EQ', uri: 'urn:ardour:a-eq', type: 'LV2', category: 'EQ' },
      { name: 'ACE EQ (stereo)', uri: 'urn:ardour:a-eq#stereo', type: 'LV2', category: 'EQ' },
      { name: 'ACE Reverb', uri: 'urn:ardour:a-reverb', type: 'LV2', category: 'Reverb' },
      { name: 'ACE Reverb (stereo)', uri: 'urn:ardour:a-reverb#stereo', type: 'LV2', category: 'Reverb' },
      { name: 'ACE Delay', uri: 'urn:ardour:a-delay', type: 'LV2', category: 'Delay' },
      { name: 'ACE FluidSynth', uri: 'urn:ardour:a-fluidsynth', type: 'LV2', category: 'Instrument' },
      { name: 'Reasonable Synth', uri: 'https://community.ardour.org/node/7596', type: 'LV2', category: 'Instrument' },
    ];

    return pluginCache;
  });
}
```

- [ ] **Step 3: Update server.js to register routes**

Add to `api-service/src/server.js` after the health route import:
```js
import { jobRoutes } from './routes/jobs.js';
import { pluginRoutes } from './routes/plugins.js';
```

And register them:
```js
app.register(healthRoutes, { prefix: '/v1' });
app.register(jobRoutes, { prefix: '/v1' });
app.register(pluginRoutes, { prefix: '/v1' });
```

- [ ] **Step 4: Test end-to-end**

Create a test audio file in the library:
```bash
mkdir -p library/stems
cp /System/Library/Sounds/Basso.aiff library/stems/
```

Submit a job:
```bash
cd api-service && node src/server.js &

curl -X POST http://localhost:3000/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "session": {
      "sample_rate": 48000,
      "tempo": [{"bar": 1, "bpm": 120}],
      "time_signature": [{"bar": 1, "numerator": 4, "denominator": 4}],
      "duration_bars": 4
    },
    "tracks": [{
      "name": "Test",
      "type": "audio",
      "regions": [{"file": "stems/Basso.aiff", "position_bar": 1}],
      "gain_db": -3.0,
      "pan": 0.5
    }],
    "master": {"gain_db": 0.0},
    "output": {"formats": [{"format": "wav", "bit_depth": 16, "sample_rate": 44100}]}
  }'
# Expected: {"job_id":"...","status":"pending"}

# Poll until complete:
curl http://localhost:3000/v1/jobs/<job_id>

# Download output:
curl -o output.wav http://localhost:3000/v1/jobs/<job_id>/output/output.wav
file output.wav
# Expected: RIFF ... WAVE audio

kill %1
```

- [ ] **Step 5: Commit**

```bash
git add api-service/
git commit -m "feat: complete API service with job routes, async queue, and end-to-end export"
```

---

### Summary: Task Dependencies

```
Task 1 (Scaffold)
    ↓
Task 2 (Queue + Executor)
    ↓
Task 3 (Lua Generator)  ← this is the big one
    ↓
Task 4 (Routes + Integration)
```

All tasks are sequential — each builds on the previous. After Task 4, the service accepts JSON jobs and returns rendered WAV files.
