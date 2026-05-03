import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { RequestCache } from '../lib/request-cache.js';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('load_nks_preset tool', () => {
  let app, sessionManager, sessionId, tmp, fakeProxyCalls;

  before(async () => {
    tmp = join(tmpdir(), `nks-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    sessionManager = new SessionManager({
      config: {
        maxConcurrentSessions: 5, allowGui: false,
        sessionsDir: tmp, maxSessionUploadBytes: 10_000_000,
        luasessionBin: '/bin/true', mcpHostLua: '/dev/null',
        createSessionLua: '/dev/null', ardourGuiBin: '/bin/true',
        logRingBufferSize: 100,
      },
      portPool: { allocate: () => 5000, release: () => {} },
      spawner: () => ({ pid: 1, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, kill() {} }),
      httpClient: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    app = Fastify({ logger: false });
    fakeProxyCalls = [];
    app.decorate('sessionManager', sessionManager);
    app.decorate('actionProxy', {
      execute: async (session, tool, params) => {
        fakeProxyCalls.push({ tool, params });
        // Mock preset/load returning a successful Lua eval
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: true,
            output: 'OK\nplugin=Massive X\nreused=false\nloaded=true\nresolved_uri=mock://uri\nlast_uri=mock://uri\nlast_label=Massive Pad\n',
          })}],
        };
      },
    });
    app.decorate('presetStore', {
      knownFuids: () => ({
        'Massive X': { uid: 'D39D5B69D6AF42FA1234567844695661', type: 7, vendor: 'NI' },
      }),
      captureByUri: () => null,
    });
    app.decorate('requestCache', new RequestCache({ maxEntries: 16, ttlMs: 60_000 }));
    app.decorate('config', { maxConcurrentSessions: 5, allowGui: false });
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();
    const created = await sessionManager.create({ sessionName: 'nks-test' });
    sessionId = created.session_id;
    sessionManager.get(sessionId).status = 'ready';
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 404 NKS_NOT_FOUND when nksPath is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'load_nks_preset', params: {
        track: 'midi_track_1', nksPath: '/nope/missing.nksf',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error_code, 'NKS_NOT_FOUND');
  });

  it('returns 400 INVALID_PARAMS when track is missing', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'load_nks_preset', params: { nksPath: '/whatever.nksf' } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });

  it('parses NKS, resolves plugin, and dispatches preset/load', async () => {
    // Build a synthetic NKSF: RIFF/NIKS container with NISI + PLID + PCHK chunks.
    const { encode } = await import('@msgpack/msgpack');
    const nisi = encode({
      vendor: 'NI', product: 'Massive X', preset_name: 'Test Pad',
      bankchain: ['Massive X'], modes: [], device_type: 'INST',
    });
    const plid = encode({ VST3: 'D39D5B69D6AF42FA1234567844695661', vst3_id: 'D39D5B69D6AF42FA1234567844695661' });
    const pchk = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);

    function makeChunk(tag, payload) {
      const versionPrefix = Buffer.from([1, 0, 0, 0]);
      const body = Buffer.concat([versionPrefix, Buffer.from(payload)]);
      const hdr = Buffer.alloc(8);
      hdr.write(tag, 0, 'ascii');
      hdr.writeUInt32LE(body.length, 4);
      const padded = body.length % 2 === 0 ? body : Buffer.concat([body, Buffer.from([0])]);
      return Buffer.concat([hdr, padded]);
    }

    const niksContents = Buffer.concat([
      Buffer.from('NIKS', 'ascii'),
      makeChunk('NISI', nisi),
      makeChunk('PLID', plid),
      makeChunk('PCHK', pchk),
    ]);
    const riffHdr = Buffer.alloc(8);
    riffHdr.write('RIFF', 0, 'ascii');
    riffHdr.writeUInt32LE(niksContents.length, 4);
    const nksf = Buffer.concat([riffHdr, niksContents]);

    const nksPath = join(tmp, 'pad.nksf');
    writeFileSync(nksPath, nksf);

    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'load_nks_preset', params: { track: 'midi_track_1', nksPath } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `load_nks_preset failed: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.track, 'midi_track_1');
    assert.equal(body.fuid, 'D39D5B69D6AF42FA1234567844695661');
    // Underlying call must have been preset/load via lua_eval
    const luaCalls = fakeProxyCalls.filter((c) => c.tool === 'session/lua_eval');
    assert.ok(luaCalls.length >= 1, 'expected at least one lua_eval call');
  });
});
