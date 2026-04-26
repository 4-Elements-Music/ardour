import { describe, it, before, after } from 'node:test';

const WORKER_FLUSH_MS = 50;
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { RequestCache } from '../lib/request-cache.js';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

describe('audio_region_stretch pre-hook', () => {
  let app, sessionManager, sessionId, tmp;

  before(async () => {
    tmp = join(tmpdir(), `stretch-hook-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    sessionManager = new SessionManager({
      config: {
        maxConcurrentSessions: 5, allowGui: false,
        sessionsDir: tmp, maxSessionUploadBytes: 10_000_000,
        audioValidatorBin: '/bin/true',
        luasessionBin: '/bin/true', mcpHostLua: '/dev/null', createSessionLua: '/dev/null',
        ardourGuiBin: '/bin/true', logRingBufferSize: 100,
      },
      portPool: { allocate: () => 5000, release: () => {} },
      spawner: () => ({ pid: 1, stdout: { on() {} }, stderr: { on() {} }, on() {}, once() {}, kill() {} }),
      httpClient: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });

    app = Fastify({ logger: false });
    app.decorate('sessionManager', sessionManager);
    app.decorate('actionProxy', {
      execute: async (session, tool, params) => {
        return { ok: true, content: [{ type: 'text', text: 'proxied' }] };
      },
    });
    app.decorate('exportService', null);
    app.decorate('requestCache', new RequestCache({ maxEntries: 16, ttlMs: 60_000 }));
    app.decorate('config', {
      maxConcurrentSessions: 5, allowGui: false,
      maxUploadBytes: 10_000_000, maxSessionUploadBytes: 10_000_000,
      audioValidatorBin: '/bin/true',
    });
    await app.register(fastifyMultipart);
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();

    const created = await sessionManager.create({ sessionName: 'stretch-hook-test' });
    sessionId = created.session_id;
    sessionManager.get(sessionId).status = 'ready';
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects missing regionId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_stretch', params: {} },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });

  it('rejects no-op (timeRatio=1, semitones=0)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_stretch', params: { regionId: 'region:abc' } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal(JSON.parse(res.body).error_code, 'NO_OP');
  });

  it('accepts valid stretch and returns jobId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_stretch', params: { regionId: 'region:abc', timeRatio: 1.5 } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 202, `expected 202, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.match(body.jobId, /^job_/);
    assert.equal(body.status, 'pending');
  });

  it('worker does not call actionProxy.execute when sessionManager returns null for the session', async () => {
    // The worker (onJobReady) fires as a floating async after addJob returns.
    // It calls app.sessionManager.get(spec.sessionId) as its very first step.
    // We patch sessionManager.get BEFORE inject so the spy is in place when the
    // worker microtask runs. We allow the first call through (the route pre-hook
    // guard) and return null for all subsequent calls with the target session ID.

    const proxyCalls = [];
    const originalGet = sessionManager.get.bind(sessionManager);
    const workerGetCalls = [];

    // Create the session before patching so we can reference its ID
    const created = await sessionManager.create({ sessionName: 'stretch-gone-test' });
    const goneId = created.session_id;
    sessionManager.get(goneId).status = 'ready';

    // Patch: first call with goneId returns real session (route guard), subsequent
    // calls return null (worker lookup).
    let callCount = 0;
    app.sessionManager.get = (id) => {
      if (id === goneId) {
        callCount++;
        if (callCount === 1) {
          // First call: route pre-hook guard — return real session so the route accepts
          return originalGet(id);
        }
        // Subsequent calls (worker): simulate gone session
        workerGetCalls.push(id);
        return null;
      }
      return originalGet(id);
    };

    app.actionProxy.execute = async (session, tool, params) => {
      proxyCalls.push({ session, tool, params });
      return { ok: true, content: [{ type: 'text', text: 'proxied' }] };
    };

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${goneId}/actions`,
        payload: { tool: 'audio_region_stretch', params: { regionId: 'region:gone', timeRatio: 1.5 } },
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(res.statusCode, 202, `expected 202, got ${res.statusCode}: ${res.body}`);

      // Yield to the microtask/timer queue so the worker floating promise resolves
      await new Promise(r => setTimeout(r, WORKER_FLUSH_MS));

      assert.ok(workerGetCalls.includes(goneId),
        'worker must call sessionManager.get with the session ID');
      assert.ok(
        proxyCalls.every(c => !c.session || c.session.id !== goneId),
        'actionProxy.execute must not be called for the gone session',
      );
    } finally {
      app.sessionManager.get = originalGet;
    }
  });
});
