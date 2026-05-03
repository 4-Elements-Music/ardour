/**
 * Sessions routes — lifecycle (create/list/get/delete).
 *
 * Reads sessionManager, config from Fastify decorators set in server.js.
 */
import { mkdir, stat, writeFile } from 'fs/promises';
import { join as joinPath, resolve as resolvePath, relative } from 'path';
import { randomUUID } from 'crypto';
import { decodeToCanonicalWav } from '../lib/sandbox-decode.js';
import { JobQueue } from '../lib/job-queue.js';
import { config as globalConfig } from '../config.js';

// Per-route queue for audio_region_stretch jobs.
const stretchQueue = new JobQueue();

const STRETCH_LIMITS = {
  timeRatio: { min: 0.25, max: 4.0 },
  semitones: { min: -24,  max: 24  },
};

export async function sessionRoutes(app) {
  // Wire the stretch queue worker once per app registration.
  stretchQueue.onJobReady = async (jobId, spec) => {
    const session = app.sessionManager.get(spec.sessionId);
    if (!session || session.status !== 'ready') {
      stretchQueue.markFailed(jobId, 'SESSION_GONE');
      return;
    }

    const requestId = spec.params.requestId || jobId;
    let settled = false;

    // Kick off the stretch call as a floating promise so we can poll concurrently.
    const stretchPromise = app.actionProxy.execute(
      session,
      'audio_region/stretch',
      spec.params,
    );

    // Poll job/progress_query every ~stretchProgressPollMs while the stretch is running.
    // We don't await this — it runs until `settled` flips true.
    const pollMs = globalConfig.stretchProgressPollMs;
    (async () => {
      while (!settled) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (settled) break;
        try {
          const pResult = await app.actionProxy.execute(
            session,
            'job/progress_query',
            { requestId },
          );
          const pPayload = pResult?.result ?? pResult;
          const structured = pPayload?.structuredContent ?? pPayload;
          if (structured?.ok) {
            const job = stretchQueue.getJob(jobId);
            if (job) {
              job.progress = { fraction: structured.fraction ?? null, phase: structured.phase ?? 'stretching' };
            }
          }
        } catch {
          // Swallow poll errors — stretch may have just finished.
        }
      }
    })();

    try {
      const result = await stretchPromise;
      settled = true;
      const payload = result.result ?? result;
      const job = stretchQueue.getJob(jobId);
      if (job) job.progress = { fraction: 1.0, phase: 'done' };
      stretchQueue.markComplete(jobId, [], { result: payload });
    } catch (err) {
      settled = true;
      const job = stretchQueue.getJob(jobId);
      if (job) job.progress = { fraction: job.progress?.fraction ?? null, phase: 'failed' };
      stretchQueue.markFailed(jobId, err.message);
    }
  };

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
    const out = sessionToResponse(s);
    out.uploads = app.sessionManager.getUploads(s.id);
    return out;
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

  // GET /v1/sessions/:id/jobs/:jobId — stretch job status + progress
  // Scoped under /sessions to avoid collision with jobs.js GET /jobs/:id.
  app.get('/sessions/:id/jobs/:jobId', async (req, reply) => {
    const job = stretchQueue.getJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    const out = { jobId: job.id, status: job.status, progress: job.progress };
    if (job.status === 'complete') out.result = job.analysis?.result ?? null;
    if (job.status === 'failed') out.error = job.error;
    return out;
  });

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
    let { tool, params } = req.body || {};
    if (!tool) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'tool required' });

    // Parse a session/lua_eval result tolerantly. The C++ surface sometimes emits inner JSON
    // with literal NL inside string values, which is invalid JSON — escape control chars first.
    const parseLuaEvalResult = (rpcResult) => {
      const payload = rpcResult?.result ?? rpcResult;
      const text = payload?.content?.[0]?.text;
      try {
        const fixed = String(text || '').replace(/[\x00-\x1f]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
        return { inner: JSON.parse(fixed), payload };
      } catch {
        return { inner: null, payload };
      }
    };
    // Parse `k=v` lines from Lua output into an object.
    const parseKv = (output) => {
      const out = {};
      for (const line of String(output || '').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
      }
      return out;
    };

    if (tool === 'load_nks_preset') {
      const track = params?.track;
      const nksPath = params?.nksPath;
      if (!track || !nksPath) {
        return reply.code(400).send({
          error_code: 'INVALID_PARAMS',
          error: 'track and nksPath required',
        });
      }
      const { existsSync } = await import('node:fs');
      if (!existsSync(nksPath)) {
        return reply.code(404).send({ error_code: 'NKS_NOT_FOUND', message: `${nksPath} not found` });
      }
      const slot = (params.slot ?? 0) | 0;
      const replace = !!params.replace;

      // Parse NKSF and extract PCHK (component state) in one pass.
      let extracted;
      try {
        const { extractNksfState } = await import('../indexer/nksf-to-vstpreset.js');
        extracted = await extractNksfState(nksPath);
      } catch (e) {
        return reply.code(400).send({
          error_code: 'INVALID_NKS',
          message: `failed to parse NKS: ${e.message}`,
        });
      }
      if (!extracted) {
        return reply.code(400).send({
          error_code: 'INVALID_NKS',
          message: 'not a valid NKSF/NKSN file (missing RIFF/NIKS header)',
        });
      }
      if (!extracted.pchk) {
        return reply.code(400).send({
          error_code: 'INVALID_NKS',
          message: 'NKSF has no PCHK (plugin state) chunk',
        });
      }
      // Extract VST3 FUID from PLID chunk (keys: VST3, vst3_id, vst_id, vst3, VST).
      const plid = extracted.plid || {};
      const fuid = plid.VST3 || plid.vst3 || plid.VST || plid.vst3_id || plid.vst_id || null;
      if (!fuid || !/^[0-9A-Fa-f]{32}$/.test(String(fuid).trim())) {
        return reply.code(400).send({
          error_code: 'NKS_NO_FUID',
          message: 'NKSF PLID chunk has no VST3 FUID; AU-only presets unsupported in this path',
        });
      }
      const fuidNorm = String(fuid).trim().toUpperCase();
      // Reverse-lookup plugin name from known-fuids.json (via presetStore).
      const fuids = (app.presetStore && app.presetStore.knownFuids)
        ? app.presetStore.knownFuids() : {};
      let pluginName = null;
      for (const [name, entry] of Object.entries(fuids)) {
        if (String(entry.uid).toUpperCase() === fuidNorm) { pluginName = name; break; }
      }
      if (!pluginName) {
        return reply.code(400).send({
          error_code: 'PLUGIN_UNKNOWN',
          message: `FUID ${fuidNorm} not in known-fuids.json; run scripts/refresh-nks-index.js`,
          fuid: fuidNorm,
        });
      }
      // Convert PCHK to a temp .vstpreset and load via the existing preset/load Lua flow.
      const { buildVstPreset } = await import('../indexer/nksf-to-vstpreset.js');
      const { writeFile } = await import('node:fs/promises');
      const { tmpdir: ostmp } = await import('node:os');
      const { join: joinp } = await import('node:path');
      const { randomUUID } = await import('node:crypto');
      const presetPath = joinp(ostmp(), `nks-${randomUUID()}.vstpreset`);
      try {
        const presetBytes = buildVstPreset(fuidNorm, extracted.pchk);
        await writeFile(presetPath, presetBytes);
      } catch (e) {
        return reply.code(500).send({
          error_code: 'NKS_CONVERT_FAILED',
          message: `failed to build .vstpreset: ${e.message}`,
        });
      }
      // Now call preset/load with synthetic ardour_uri pointing to the temp file.
      // Ardour Lua: plugin:preset_by_uri("file://" + path).
      const presetUri = `file://${presetPath}`;
      const luaStr = (v) => JSON.stringify(String(v));
      const code = `
local TRACK = ${luaStr(track)}
local SLOT = ${slot}
local URI = ${luaStr(presetUri)}
local PLUGIN_NAME = ${luaStr(pluginName)}
local PLUGIN_TYPE = ${(fuids[pluginName].type ?? 7) | 0}
local REPLACE = ${replace ? 'true' : 'false'}

local route = nil
for r in Session:get_routes():iter() do if r:name() == TRACK then route = r; break end end
if not route then print("ERR no_route") return end

local function current_plugin()
  local p = route:nth_plugin(SLOT)
  if not p or p:isnil() then return nil, nil, nil end
  local ins = p:to_insert()
  if not ins or ins:isnil() then return nil, nil, nil end
  local pl = ins:plugin(0)
  if not pl or pl:isnil() then return nil, nil, nil end
  return p, ins, pl
end

local proc, insert, plugin = current_plugin()
if plugin and REPLACE then
  route:remove_processor(insert, nil, false)
  proc, insert, plugin = nil, nil, nil
end
if not plugin then
  local new_proc = ARDOUR.LuaAPI.new_plugin(Session, PLUGIN_NAME, PLUGIN_TYPE, "")
  if not new_proc or new_proc:isnil() then print("ERR new_plugin_nil") return end
  local rc = route:add_processor_by_index(new_proc, SLOT, nil, true)
  if rc ~= 0 then print("ERR add_rc="..tostring(rc)) return end
  proc, insert, plugin = current_plugin()
end

local rec = plugin:preset_by_uri(URI)
if not rec then print("ERR preset_not_found") return end
if not rec.valid then print("ERR preset_invalid") return end
local ok, err = pcall(function() return plugin:load_preset(rec) end)
if not ok then print("ERR load_preset:"..tostring(err)) return end
print("OK")
print("plugin="..plugin:name())
`.trim();
      try {
        const rpc = await app.actionProxy.execute(s, 'session/lua_eval', { code }, req.id);
        const { inner } = parseLuaEvalResult(rpc);
        if (!inner || !inner.success) {
          return reply.code(500).send({
            error_code: 'LUA_FAILED', message: inner?.error || 'lua_eval failed',
          });
        }
        const lines = String(inner.output || '').split('\n').filter(Boolean);
        if (lines[0] && lines[0].startsWith('ERR ')) {
          return reply.code(400).send({
            error_code: 'NKS_LOAD_FAILED', message: lines[0].slice(4), output: inner.output,
          });
        }
        return {
          success: true,
          track,
          plugin: pluginName,
          fuid: fuidNorm,
          presetPath,
        };
      } catch (e) {
        return reply.code(500).send({ error_code: 'NKS_LOAD_FAILED', message: e.message });
      }
    }

    if (tool === 'preset/search') {
      try {
        const results = app.presetStore.search(params || {});
        return { results, count: results.length };
      } catch (e) {
        return reply.code(500).send({ error_code: 'PRESET_SEARCH_FAILED', message: e.message });
      }
    }

    if (tool === 'preset/load') {
      const track = params?.track;
      const uri = params?.ardour_uri || null;
      const pluginParam = params?.plugin || null;
      const presetName = params?.preset_name || null;
      if (!track) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'track required' });
      if (!uri && !(pluginParam && presetName)) {
        return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'either ardour_uri or (plugin + preset_name) required' });
      }
      const slot = (params.slot ?? 0) | 0;
      const replace = !!params.replace;

      let pluginName, pluginType, pluginUid;
      if (uri) {
        const cap = app.presetStore.captureByUri(uri);
        if (!cap) return reply.code(404).send({ error_code: 'URI_UNKNOWN', message: `No capture record for ${uri} — call preset/capture first or resolve by name instead.` });
        pluginName = cap.plugin;
        pluginType = cap.plugin_type;
        pluginUid = cap.plugin_uid;
      } else {
        // Resolve by name via preset_by_label. We don't know FUID yet — look up via fuids map.
        pluginName = pluginParam;
        const fuids = app.presetStore.knownFuids ? app.presetStore.knownFuids() : {};
        pluginUid = fuids[`${pluginName}`]?.uid || null;
        pluginType = fuids[`${pluginName}`]?.type ?? 7; // default VST3
      }

      const luaStr = (v) => JSON.stringify(String(v));
      const code = `
local TRACK = ${luaStr(track)}
local SLOT = ${slot}
local URI = ${luaStr(uri || '')}
local PRESET_NAME = ${luaStr(presetName || '')}
local PLUGIN_NAME = ${luaStr(pluginName)}
local PLUGIN_TYPE = ${pluginType | 0}
local PLUGIN_UID = ${luaStr(pluginUid || '')}
local REPLACE = ${replace ? 'true' : 'false'}

local route = nil
for r in Session:get_routes():iter() do if r:name() == TRACK then route = r; break end end
if not route then print("ERR no_route") return end

local function current_plugin()
  local p = route:nth_plugin(SLOT)
  if not p or p:isnil() then return nil, nil, nil end
  local ins = p:to_insert()
  if not ins or ins:isnil() then return nil, nil, nil end
  local pl = ins:plugin(0)
  if not pl or pl:isnil() then return nil, nil, nil end
  return p, ins, pl
end

-- Decide: reuse existing, or replace. Identity check matches UID when known, else plugin name.
local proc, insert, plugin = current_plugin()
local reused = false
if plugin and not REPLACE then
  local info = plugin:get_info()
  if info then
    if PLUGIN_UID ~= "" then
      if info.unique_id == PLUGIN_UID then reused = true end
    elseif info.name == PLUGIN_NAME then
      reused = true
    end
  end
end

if not reused then
  if insert then
    local removed = route:remove_processor(insert, nil, false)
    if removed ~= 0 then print("WARN remove_rc="..tostring(removed)) end
  end
  local new_proc = ARDOUR.LuaAPI.new_plugin(Session, PLUGIN_NAME, PLUGIN_TYPE, "")
  if not new_proc or new_proc:isnil() then print("ERR new_plugin_nil") return end
  local add_rc = route:add_processor_by_index(new_proc, SLOT, nil, true)
  if add_rc ~= 0 then print("ERR add_rc="..tostring(add_rc)) return end
  proc, insert, plugin = current_plugin()
  if not plugin then print("ERR fresh_plugin_missing") return end
end

-- Resolve preset record: prefer URI, else look up by label.
local rec
if URI ~= "" then
  rec = plugin:preset_by_uri(URI)
else
  rec = plugin:preset_by_label(PRESET_NAME)
end
if not rec then print("ERR preset_not_found") return end
if not rec.valid then print("ERR preset_invalid") return end
local ok, loaded = pcall(function() return plugin:load_preset(rec) end)
if not ok then print("ERR load_preset:"..tostring(loaded)) return end

print("OK")
print("reused="..tostring(reused))
print("plugin="..plugin:name())
print("loaded="..tostring(loaded))
print("resolved_uri="..tostring(rec.uri))
print("resolved_label="..tostring(rec.label))
local lp = plugin:last_preset()
print("last_uri="..tostring(lp.uri))
print("last_label="..tostring(lp.label))
`.trim();

      try {
        const rpc = await app.actionProxy.execute(s, 'session/lua_eval', { code }, req.id);
        const { inner, payload } = parseLuaEvalResult(rpc);
        if (!inner || !inner.success) {
          return reply.code(500).send({ error_code: 'LOAD_FAILED', message: inner?.error || 'lua_eval failed', payload });
        }
        const lines = String(inner.output || '').split('\n').filter(Boolean);
        if (lines[0] && lines[0].startsWith('ERR ')) {
          return reply.code(400).send({ error_code: 'LOAD_FAILED', message: lines[0].slice(4), output: inner.output });
        }
        const fields = parseKv(lines.slice(1).join('\n'));
        return {
          success: true,
          track,
          plugin: fields.plugin,
          ardour_uri: uri,
          reused: fields.reused === 'true',
          loaded: fields.loaded === 'true',
          last_uri: fields.last_uri,
          last_label: fields.last_label,
        };
      } catch (e) {
        return reply.code(500).send({ error_code: 'LOAD_FAILED', message: e.message });
      }
    }

    if (tool === 'preset/capture') {
      // Auto-detect track when not passed: use the currently-selected route in Ardour.
      const trackParam = (params || {}).track;
      const slot = (params.slot ?? 0) | 0;
      const label = params.label || `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      const presetNameParam = params.presetName || null;
      const notes = params.notes || null;

      // Escape for embedding into Lua string literal.
      const luaStr = (s) => JSON.stringify(String(s));
      const code = `
local TRACK = ${trackParam ? luaStr(trackParam) : '""'}
local SLOT = ${slot}
local LABEL = ${luaStr(label)}

local route = nil
if TRACK == "" then
  -- auto-detect: first selected route
  route = Session:route_by_selected_count(0)
  if route and route:isnil() then route = nil end
else
  for r in Session:get_routes():iter() do if r:name() == TRACK then route = r; break end end
end
if not route then print("ERR no_route") return end

local proc = route:nth_plugin(SLOT)
if not proc or proc:isnil() then print("ERR no_plugin") return end
local ins = proc:to_insert()
if not ins or ins:isnil() then print("ERR not_plugin_insert") return end
local pl = ins:plugin(0)
if not pl or pl:isnil() then print("ERR plugin_nil") return end
local info = pl:get_info()
local ok, cap = pcall(function() return pl:save_preset(LABEL) end)
if not ok then print("ERR save_preset:"..tostring(cap)) return end
if not cap.valid then print("ERR capture_invalid") return end
print("OK")
print("track="..route:name())
print("plugin="..pl:name())
print("unique_id="..info.unique_id)
print("plugin_type="..tostring(info.type))
print("uri="..cap.uri)
print("label="..cap.label)
`.trim();

      try {
        const result = await app.actionProxy.execute(s, 'session/lua_eval', { code }, req.id);
        // result.content[0].text = JSON string with {success, output, error}
        const payload = result.result ?? result;
        const innerText = payload?.content?.[0]?.text;
        let inner = null;
        // C++ session/lua_eval emits inner JSON with literal NL inside string values (bug
        // in the double-escaping path). Tolerate that by escaping raw control chars before parse.
        try {
          const fixed = String(innerText || '').replace(/[\x00-\x1f]/g, (c) => {
            if (c === '\n') return '\\n';
            if (c === '\r') return '\\r';
            if (c === '\t') return '\\t';
            return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
          });
          inner = JSON.parse(fixed);
        } catch {}
        if (!inner || !inner.success) {
          return reply.code(500).send({ error_code: 'CAPTURE_FAILED', message: inner?.error || 'lua_eval failed', payload });
        }
        const lines = (inner.output || '').split('\n').filter(Boolean);
        if (lines[0] && lines[0].startsWith('ERR ')) {
          return reply.code(400).send({ error_code: 'CAPTURE_FAILED', message: lines[0].slice(4), output: inner.output });
        }
        const fields = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf('=');
          if (i > 0) fields[l.slice(0, i)] = l.slice(i + 1);
        }
        if (!fields.uri) {
          return reply.code(500).send({ error_code: 'CAPTURE_FAILED', message: 'uri missing from lua output', output: inner.output });
        }
        // Default preset name: "<Plugin> — <timestamp>" if user didn't supply one.
        const autoName = `${fields.plugin} — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
        const presetName = presetNameParam || autoName;
        app.presetStore.recordCapture({
          plugin: fields.plugin,
          preset_name: presetName,
          ardour_uri: fields.uri,
          ardour_label: fields.label,
          plugin_uid: fields.unique_id,
          plugin_type: fields.plugin_type ? parseInt(fields.plugin_type, 10) : null,
          notes,
        });
        return {
          success: true,
          track: fields.track,
          plugin: fields.plugin,
          preset_name: presetName,
          ardour_uri: fields.uri,
          ardour_label: fields.label,
          plugin_uid: fields.unique_id,
        };
      } catch (e) {
        return reply.code(500).send({ error_code: 'CAPTURE_FAILED', message: e.message });
      }
    }

    if (tool === 'set_crossfade') {
      const a = params?.regionAId;
      const b = params?.regionBId;
      const d = params?.durationS;
      if (!a || !b || typeof d !== 'number' || d <= 0 || d > 30) {
        return reply.code(400).send({
          error_code: 'INVALID_PARAMS',
          error: 'regionAId, regionBId, durationS (0 < d <= 30) required',
        });
      }
      const VALID_CURVES = new Set(['linear', 'equal_power', 'fast_in_slow_out']);
      if (params.curve != null && !VALID_CURVES.has(params.curve)) {
        return reply.code(400).send({
          error_code: 'INVALID_PARAMS',
          error: 'curve must be one of linear|equal_power|fast_in_slow_out',
        });
      }
      const curve = params.curve || 'equal_power';
      const luaStr = (v) => JSON.stringify(String(v));
      // Crossfade = region-A fade-out at the overlap tail + region-B fade-in at the overlap head.
      // Both lengths set to the crossfade duration. Curve name is resolved to an
      // ARDOUR.FadeShape.* constant inside Lua so we are not coupled to enum-int values.
      const code = `
local A = ${luaStr(a)}
local B = ${luaStr(b)}
local DUR = ${d}
local CURVE_NAME = ${luaStr(curve)}
local CURVE = ARDOUR.FadeShape.FadeConstantPower
if     CURVE_NAME == "linear"           then CURVE = ARDOUR.FadeShape.FadeLinear
elseif CURVE_NAME == "fast_in_slow_out" then CURVE = ARDOUR.FadeShape.FadeSymmetric
end
local SR = Session:nominal_sample_rate()
local samples = math.floor(DUR * SR + 0.5)

local function find_region(rid)
  for r in Session:get_routes():iter() do
    local pl = r:to_track() and r:to_track():playlist() or nil
    if pl then
      for reg in pl:region_list():iter() do
        if reg:id():to_s() == rid then return reg end
      end
    end
  end
  return nil
end

local rA = find_region(A)
local rB = find_region(B)
if not rA then print("ERR region_a_not_found") return end
if not rB then print("ERR region_b_not_found") return end

local arA = rA:to_audioregion()
local arB = rB:to_audioregion()
if not arA or arA:isnil() or not arB or arB:isnil() then
  print("ERR not_audio_region") return
end
arA:set_fade_out_length(samples)
arA:set_fade_out_active(true)
arA:set_fade_out_shape(CURVE)
arB:set_fade_in_length(samples)
arB:set_fade_in_active(true)
arB:set_fade_in_shape(CURVE)
print("OK")
`.trim();
      try {
        const rpc = await app.actionProxy.execute(s, 'session/lua_eval', { code }, req.id);
        const { inner } = parseLuaEvalResult(rpc);
        if (!inner || !inner.success) {
          return reply.code(500).send({
            error_code: 'LUA_FAILED',
            message: inner?.error || 'lua_eval failed',
          });
        }
        const lines = String(inner.output || '').split('\n').filter(Boolean);
        if (lines[0] && lines[0].startsWith('ERR ')) {
          return reply.code(400).send({
            error_code: 'CROSSFADE_FAILED',
            message: lines[0].slice(4),
            output: inner.output,
          });
        }
        return {
          success: true,
          regionAId: a,
          regionBId: b,
          durationS: d,
          curve,
        };
      } catch (e) {
        return reply.code(500).send({ error_code: 'CROSSFADE_FAILED', message: e.message });
      }
    }

    if (tool === 'audio_region_stretch') {
      params = { ...(params || {}) };
      const regionId = params.regionId;
      if (!regionId || typeof regionId !== 'string' || regionId.trim() === '') {
        return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'regionId required' });
      }
      const timeRatio = params.timeRatio ?? 1.0;
      const semitones = params.semitones ?? 0.0;
      if (typeof timeRatio !== 'number' || timeRatio < STRETCH_LIMITS.timeRatio.min || timeRatio > STRETCH_LIMITS.timeRatio.max) {
        return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: `timeRatio must be a number in [${STRETCH_LIMITS.timeRatio.min}, ${STRETCH_LIMITS.timeRatio.max}]` });
      }
      if (typeof semitones !== 'number' || semitones < STRETCH_LIMITS.semitones.min || semitones > STRETCH_LIMITS.semitones.max) {
        return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: `semitones must be a number in [${STRETCH_LIMITS.semitones.min}, ${STRETCH_LIMITS.semitones.max}]` });
      }
      if (timeRatio === 1.0 && semitones === 0.0) {
        return reply.code(400).send({ error_code: 'NO_OP', error: 'timeRatio=1.0 and semitones=0 is a no-op; nothing to do' });
      }

      const jobId = 'job_' + randomUUID();
      // Use the jobId as the requestId so the C++ StretchProgress can key g_progress.
      // Honor a caller-supplied requestId when present.
      if (!params.requestId) {
        params.requestId = jobId;
      }
      const spec = { sessionId: req.params.id, params };
      const enqueueResult = stretchQueue.addJob(jobId, spec);
      if (!enqueueResult.accepted) {
        return reply.code(429).send({ error_code: 'QUEUE_FULL', error: 'stretch queue is full, try later' });
      }
      return reply.code(202).send({ ok: true, jobId, status: 'pending' });
    }

    if (tool === 'place_stem_region') {
      // place_stem_region is a thin wrapper that forwards to audio_region_add
      // with stemType + fidelityRank attached. Identical decode/upload semantics.
      params = { ...(params || {}) };
      const VALID_STEMS = new Set(['bass', 'drums', 'vocals', 'other', 'guitar', 'keys', 'piano']);
      if (!VALID_STEMS.has(params.stemType)) {
        return reply.code(400).send({
          error_code: 'INVALID_PARAMS',
          error: 'stemType must be one of bass|drums|vocals|other|guitar|keys|piano',
        });
      }
      if (params.fidelityRank !== undefined) {
        if (!Number.isInteger(params.fidelityRank) || params.fidelityRank < 0 || params.fidelityRank > 2) {
          return reply.code(400).send({
            error_code: 'INVALID_PARAMS',
            error: 'fidelityRank must be an integer in [0, 2]',
          });
        }
      }
      const stemType = params.stemType;
      const fidelityRank = params.fidelityRank;
      // Strip fields the C++ MCP doesn't recognize and forward via audio_region_add
      const inner = { ...params };
      delete inner.requestId;  // re-keyed below per audio_region_add's idempotency cache
      const reqId = params.requestId || `place_stem_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

      const uploadId2 = inner.uploadId;
      if (!uploadId2) {
        return reply.code(400).send({ error_code: 'MISSING_UPLOAD', message: 'uploadId required' });
      }
      const uploadPath = app.sessionManager.getUploadPath(req.params.id, uploadId2);
      if (!uploadPath) {
        return reply.code(404).send({ error_code: 'MISSING_UPLOAD', message: `uploadId ${uploadId2} not found` });
      }
      let decodedPath = app.sessionManager.getDecodedPath(req.params.id, uploadId2);
      if (!decodedPath) {
        try {
          decodedPath = await app.sessionManager.decodeOnce(req.params.id, uploadId2, async () => {
            const decodedDir = joinPath(s.sessionDir, 'decoded');
            await mkdir(decodedDir, { recursive: true });
            const out = joinPath(decodedDir, `${uploadId2}.wav`);
            const cached = app.sessionManager.getDecodedPath(req.params.id, uploadId2);
            if (cached) return cached;
            await decodeToCanonicalWav({ input: uploadPath, output: out, validatorBin: app.config.audioValidatorBin });
            app.sessionManager.cacheDecodedPath(req.params.id, uploadId2, out);
            return out;
          });
        } catch (e) {
          return reply.code(400).send({
            error_code: e.code || 'DECODE_FAILED', message: e.message,
            stderr: e.stderr ? String(e.stderr).slice(-1024) : undefined,
          });
        }
      }
      inner.decodedPath = decodedPath;
      inner.requestId = reqId;
      try {
        const result = await app.actionProxy.execute(s, 'audio_region_add', inner, req.id);
        const payload = result.result ?? result;
        const sc = payload?.structuredContent || payload || {};
        return {
          success: true,
          regionId: sc.regionId,
          stemType,
          fidelityRank,
        };
      } catch (e) {
        return mapProxyError(reply, e);
      }
    }

    if (tool === 'audio_region_add') {
      // Client MUST NOT supply decodedPath — it's server-injected.
      params = { ...(params || {}) };
      delete params.decodedPath;

      if (params.fidelityRank !== undefined) {
        if (!Number.isInteger(params.fidelityRank) || params.fidelityRank < 0 || params.fidelityRank > 2) {
          return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'fidelityRank must be an integer in [0, 2]' });
        }
      }

      const reqId = params.requestId;
      // Include dryRun in the cache key so a dryRun + live call that happen to share a
      // requestId don't cross-replay each other's responses (different operations,
      // same idempotency key is a caller mistake but easy to trip into).
      const cacheKey = reqId
        ? `${req.params.id}:${params.dryRun ? 'dry' : 'live'}:${reqId}`
        : null;

      if (cacheKey && app.requestCache && app.requestCache.has(cacheKey)) {
        return reply.send(app.requestCache.get(cacheKey));
      }

      const uploadId = params.uploadId;
      if (!uploadId) {
        return reply.code(400).send({ error_code: 'MISSING_UPLOAD', message: 'uploadId required' });
      }
      const uploadPath = app.sessionManager.getUploadPath(req.params.id, uploadId);
      if (!uploadPath) {
        return reply.code(404).send({ error_code: 'MISSING_UPLOAD', message: `uploadId ${uploadId} not found` });
      }

      let decodedPath = app.sessionManager.getDecodedPath(req.params.id, uploadId);
      if (!decodedPath) {
        try {
          decodedPath = await app.sessionManager.decodeOnce(req.params.id, uploadId, async () => {
            const decodedDir = joinPath(s.sessionDir, 'decoded');
            await mkdir(decodedDir, { recursive: true });
            const out = joinPath(decodedDir, `${uploadId}.wav`);
            // Second-caller check: if a prior decode finished between our initial
            // getDecodedPath and entering the factory, use its result.
            const cached = app.sessionManager.getDecodedPath(req.params.id, uploadId);
            if (cached) return cached;
            await decodeToCanonicalWav({
              input: uploadPath,
              output: out,
              validatorBin: app.config.audioValidatorBin,
            });
            app.sessionManager.cacheDecodedPath(req.params.id, uploadId, out);
            return out;
          });
        } catch (e) {
          return reply.code(400).send({
            error_code: e.code || 'DECODE_FAILED',
            message: e.message,
            stderr: e.stderr ? String(e.stderr).slice(-1024) : undefined,
          });
        }
      }

      params.decodedPath = decodedPath;

      try {
        const result = await app.actionProxy.execute(s, tool, params, req.id);
        const payload = result.result ?? result;
        if (cacheKey && app.requestCache) app.requestCache.put(cacheKey, payload);
        return payload;
      } catch (e) {
        return mapProxyError(reply, e);
      }
    }

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

    const uploadId = app.sessionManager.registerUpload(req.params.id, sanitized, size, destPath);
    // TODO(audio_region_add): remove `path` and `size` once upload_id-based flow is the only path (after Task 8). Kept here only so existing clients don't break mid-migration.
    return reply.code(200).send({
      upload_id: uploadId,
      filename: sanitized,
      bytes: size,
      size,
      path: destPath,
    });
  });

  // POST /v1/sessions/:id/export
  // Drives Session:simple_export via session/lua_eval.
  app.post('/sessions/:id/export', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping' || s.status === 'stopped' || s.status === 'dead') {
      return reply.code(409).send({ error_code: 'SESSION_STOPPING', status: s.status });
    }
    const body = req.body || {};
    const rawFilename = typeof body.filename === 'string' ? body.filename : '';
    const filename = sanitizeUploadFilename(rawFilename);
    if (!filename) {
      return reply.code(400).send({
        error_code: 'INVALID_FILENAME',
        error: 'filename required, no path separators, may not start with .',
      });
    }
    const formatKey = (body.format || 'wav').toLowerCase();
    const presetUuid = EXPORT_PRESETS[formatKey];
    if (!presetUuid) {
      return reply.code(400).send({
        error_code: 'UNSUPPORTED_FORMAT',
        error: `unknown format ${formatKey}; supported: ${Object.keys(EXPORT_PRESETS).join(', ')}`,
      });
    }
    const startSamples = Number.isFinite(body.start_samples) ? body.start_samples | 0 : 0;
    const endSamples = Number.isFinite(body.end_samples) ? body.end_samples | 0 : null;
    if (startSamples < 0) {
      return reply.code(400).send({ error_code: 'INVALID_RANGE', error: 'start_samples must be >= 0' });
    }
    if (endSamples !== null && endSamples <= startSamples) {
      return reply.code(400).send({
        error_code: 'INVALID_RANGE',
        error: 'end_samples must be > start_samples',
      });
    }

    const exportDir = resolvePath(s.sessionDir, 'export');
    await mkdir(exportDir, { recursive: true });

    // Parse a session/lua_eval result tolerantly (same pattern as actions handler).
    const parseLuaEvalResult = (rpcResult) => {
      const payload = rpcResult?.result ?? rpcResult;
      const text = payload?.content?.[0]?.text;
      try {
        const fixed = String(text || '').replace(/[\x00-\x1f]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
        return { inner: JSON.parse(fixed), payload };
      } catch {
        return { inner: null, payload };
      }
    };

    const luaStr = (v) => JSON.stringify(String(v));
    const code = `
local FOLDER = ${luaStr(exportDir)}
local NAME = ${luaStr(filename)}
local PRESET = ${luaStr(presetUuid)}
local START = ${startSamples}
local END_ARG = ${endSamples === null ? 'nil' : endSamples}

-- Resolve end sample by walking all regions on all tracks when not explicit.
local function compute_max_region_end()
  local max_end = 0
  local routes = Session:get_routes()
  for r in routes:iter() do
    local track = r:to_track()
    if not track:isnil() then
      local playlist = track:playlist()
      if playlist and not playlist:isnil() then
        local rl = playlist:region_list()
        for region in rl:iter() do
          local region_end = region:position():samples() + region:length():samples()
          if region_end > max_end then max_end = region_end end
        end
      end
    end
  end
  return max_end
end

local end_s = END_ARG
if end_s == nil then
  end_s = compute_max_region_end()
  if end_s == nil or end_s <= START then
    print("ERR no_content: session has no content after start_samples=" .. tostring(START))
    return
  end
end

Session:maybe_update_session_range(
  Temporal.timepos_t(START),
  Temporal.timepos_t(end_s)
)

local se = Session:simple_export()
se:set_name(NAME)
se:set_folder(FOLDER)
se:set_range(START, end_s)

local preset_ok = se:set_preset(PRESET)
if not preset_ok then
  print("ERR preset: set_preset returned false for uuid=" .. PRESET)
  return
end

local outputs_ok = se:check_outputs()
if not outputs_ok then
  print("ERR outputs: check_outputs returned false")
  return
end

local export_ok = se:run_export()
if not export_ok then
  print("ERR export: run_export returned false")
  return
end

print("OK")
print("start_samples=" .. tostring(START))
print("end_samples=" .. tostring(end_s))
print("duration_samples=" .. tostring(end_s - START))
print("sample_rate=" .. tostring(Session:sample_rate()))
print("folder=" .. FOLDER)
print("name=" .. NAME)
`.trim();

    try {
      const rpc = await app.actionProxy.execute(s, 'session/lua_eval', { code }, req.id);
      const { inner, payload } = parseLuaEvalResult(rpc);
      if (!inner || !inner.success) {
        return reply.code(500).send({
          error_code: 'EXPORT_FAILED',
          message: inner?.error || 'lua_eval failed',
          payload,
        });
      }
      const lines = String(inner.output || '').split('\n').filter(Boolean);
      if (lines[0] && lines[0].startsWith('ERR ')) {
        const [, errMsg] = lines[0].match(/^ERR (.+)$/) || [, lines[0]];
        return reply.code(500).send({
          error_code: 'EXPORT_FAILED',
          message: errMsg,
          output: inner.output,
        });
      }
      const fields = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf('=');
        if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1);
      }
      // Find the emitted file. SimpleExport may add extensions/suffixes.
      const candidates = [
        resolvePath(exportDir, `${filename}.wav`),
        resolvePath(exportDir, `${filename}.flac`),
        resolvePath(exportDir, `${filename}.ogg`),
        resolvePath(exportDir, `${filename}.mp3`),
      ];
      let outputPath = null;
      let outputBytes = 0;
      for (const p of candidates) {
        try {
          const st = await stat(p);
          outputPath = p;
          outputBytes = st.size;
          break;
        } catch {}
      }
      if (!outputPath) {
        return reply.code(500).send({
          error_code: 'EXPORT_NO_OUTPUT',
          message: 'export completed but no output file found',
          output: inner.output,
        });
      }
      if (req.body?.mashupMetadata) {
        try {
          const { embedIxmlInWav } = await import('../lib/ixml-embed.js');
          await embedIxmlInWav(outputPath, req.body.mashupMetadata);
        } catch (e) {
          // Don't fail the export — log a warning and continue.
          req.log?.warn?.({ err: e.message, outputPath }, 'iXML embed failed');
        }
      }
      const sampleRate = parseInt(fields.sample_rate || s.sampleRate, 10) || s.sampleRate;
      const durationSamples = parseInt(fields.duration_samples || '0', 10);
      const durationS = durationSamples / sampleRate;
      return reply.code(200).send({
        ok: true,
        output_path: outputPath,
        filename: outputPath.split('/').pop(),
        bytes: outputBytes,
        duration_s: durationS,
        sample_rate: sampleRate,
        start_samples: parseInt(fields.start_samples || '0', 10),
        end_samples: parseInt(fields.end_samples || '0', 10),
        format: formatKey,
      });
    } catch (e) {
      req.log.error({ err: e }, 'export failed');
      return reply.code(500).send({ error_code: 'EXPORT_FAILED', message: e.message });
    }
  });
}

// Preset UUIDs from components/ardour/share/export/*.preset
const EXPORT_PRESETS = {
  wav: '75969a1c-3133-4694-864b-a1fa50e43348',
  flac: 'e379c6d0-9761-413a-86fd-91bf19655dbd',
  ogg: 'a83019f9-858e-4b69-8cc2-8d0487003d14',
  mp3: '568b42e6-4436-40d6-b2db-a26dd0029d0f',
  cd: 'df340c53-88b5-4342-a1c8-58e0704872ea',
  streaming: '44c931f0-3989-4304-b16d-1984c7e00042',
};

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

function sanitizeUploadFilename(name) {
  if (!name) return null;
  if (name.startsWith('.')) return null;
  const basename = String(name).replace(/[\/\\]/g, '_').replace(/\0/g, '');
  if (basename.length > 255) return null;
  return basename;
}
