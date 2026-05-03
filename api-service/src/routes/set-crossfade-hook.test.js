import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('set_crossfade tool', () => {
  let app, sessionManager, sessionId, tmp, fakeProxyCalls;

  before(async () => {
    tmp = join(tmpdir(), `xfade-${Date.now()}`);
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
        // Lua-eval response shape: nested content[0].text JSON
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, output: 'OK\n' }) }],
        };
      },
    });
    app.decorate('requestCache', null);
    app.decorate('config', { maxConcurrentSessions: 5, allowGui: false });
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();
    const created = await sessionManager.create({ sessionName: 'xfade-test' });
    sessionId = created.session_id;
    sessionManager.get(sessionId).status = 'ready';
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Lua sets both fade-out on regionA and fade-in on regionB', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0.5, curve: 'equal_power',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `set_crossfade failed: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.regionAId, 'r1');
    assert.equal(body.regionBId, 'r2');
    assert.equal(body.durationS, 0.5);
    assert.equal(fakeProxyCalls.length, 1);
    assert.equal(fakeProxyCalls[0].tool, 'session/lua_eval');
    const code = fakeProxyCalls[0].params.code;
    assert.ok(code.includes('"r1"'), 'region A id should be in lua');
    assert.ok(code.includes('"r2"'), 'region B id should be in lua');
    assert.ok(
      code.includes('set_fade_out_length') && code.includes('set_fade_in_length'),
      'lua must call BOTH set_fade_out_length and set_fade_in_length',
    );
    assert.ok(
      code.includes('set_fade_out_active(true)') && code.includes('set_fade_in_active(true)'),
      'lua must activate BOTH fade-out and fade-in',
    );
  });

  it('emits FadeConstantPower in Lua for equal_power curve', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0.5, curve: 'equal_power',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `set_crossfade failed: ${res.body}`);
    const code = fakeProxyCalls[0].params.code;
    assert.ok(
      code.includes('ARDOUR.FadeShape.FadeConstantPower'),
      'lua must reference FadeConstantPower for equal_power curve',
    );
    assert.ok(
      !code.includes('ARDOUR.FadeShape.FadeSlow'),
      'lua must NOT reference FadeSlow (was the prior wrong mapping)',
    );
  });

  it('emits FadeLinear in Lua for linear curve', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0.5, curve: 'linear',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `set_crossfade failed: ${res.body}`);
    const code = fakeProxyCalls[0].params.code;
    assert.ok(
      code.includes('ARDOUR.FadeShape.FadeLinear'),
      'lua must reference FadeLinear for linear curve',
    );
  });

  it('emits FadeSymmetric in Lua for fast_in_slow_out curve', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0.5, curve: 'fast_in_slow_out',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `set_crossfade failed: ${res.body}`);
    const code = fakeProxyCalls[0].params.code;
    assert.ok(
      code.includes('ARDOUR.FadeShape.FadeSymmetric'),
      'lua must reference FadeSymmetric for fast_in_slow_out curve',
    );
  });

  it('rejects missing regionAId/regionBId with INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: { regionAId: 'r1', durationS: 0.5 } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });

  it('rejects nonpositive durationS with INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0,
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });

  it('rejects durationS > 30 with INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 30.5,
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });

  it('rejects unknown curve with INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'set_crossfade', params: {
        regionAId: 'r1', regionBId: 'r2', durationS: 0.5, curve: 'S-curve',
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });
});
