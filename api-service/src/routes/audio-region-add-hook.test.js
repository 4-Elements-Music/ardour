import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import FormData from 'form-data';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { RequestCache } from '../lib/request-cache.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const repoRoot = resolve(import.meta.dirname, '../../..');
const validatorBin = process.env.AUDIO_VALIDATOR_BIN
  || join(repoRoot, 'build/tools/audio-validator/audio-validator');

const skipNoValidator = !existsSync(validatorBin) && 'validator binary missing; run waf build --targets=audio-validator';

describe('audio_region_add pre-hook', { skip: skipNoValidator }, () => {
  let app, sessionManager, sessionId, uploadId, tmp, fakeProxyCalls;

  before(async () => {
    tmp = join(tmpdir(), `ar-hook-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    // Real SessionManager but stub spawner/httpClient — we don't need Ardour for the pre-hook test
    sessionManager = new SessionManager({
      config: {
        maxConcurrentSessions: 5, allowGui: false,
        sessionsDir: tmp, maxSessionUploadBytes: 10_000_000,
        audioValidatorBin: validatorBin,
        luasessionBin: '/bin/true', mcpHostLua: '/dev/null', createSessionLua: '/dev/null',
        ardourGuiBin: '/bin/true', logRingBufferSize: 100,
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
        return { ok: true, content: [{ type: 'text', text: 'proxied' }], structuredContent: { ok: true, regionId: 'fake-region' } };
      },
    });
    app.decorate('exportService', null);
    app.decorate('requestCache', new RequestCache({ maxEntries: 16, ttlMs: 60_000 }));
    app.decorate('config', {
      maxConcurrentSessions: 5, allowGui: false,
      maxUploadBytes: 10_000_000, maxSessionUploadBytes: 10_000_000,
      audioValidatorBin: validatorBin,
    });
    await app.register(fastifyMultipart);
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();

    const created = await sessionManager.create({ sessionName: 'hook-test' });
    sessionId = created.session_id;
    // Force session ready (stubbed spawner never emits MCP_HTTP_READY)
    sessionManager.get(sessionId).status = 'ready';

    // Build a 1s mono WAV fixture and upload it via the real multipart route
    const fixturePath = join(tmp, 'fx.wav');
    spawnSync('python3', ['-c',
      `import wave; w=wave.open('${fixturePath}','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b'\\x00'*44100*2); w.close()`,
    ]);
    const form = new FormData();
    form.append('file', readFileSync(fixturePath), 'fx.wav');
    const uploadRes = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/upload`, payload: form.getBuffer(), headers: form.getHeaders() });
    assert.equal(uploadRes.statusCode, 200, `upload failed: ${uploadRes.body}`);
    uploadId = JSON.parse(uploadRes.body).upload_id;
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('decodes uploadId and injects decodedPath before dispatching to MCP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_add', params: { trackId: 'route:test', uploadId, position: { unit: 'samples', value: 0 } } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `action failed: ${res.body}`);
    assert.equal(fakeProxyCalls.length, 1);
    const injected = fakeProxyCalls[0].params;
    assert.equal(injected.tool, undefined); // tool is not in params
    assert.ok(injected.decodedPath, 'decodedPath should be injected');
    assert.ok(injected.decodedPath.includes('/decoded/'), `expected /decoded/ in path, got ${injected.decodedPath}`);
    assert.ok(injected.decodedPath.endsWith(`${uploadId}.wav`));
    assert.equal(injected.uploadId, uploadId);
  });

  it('strips client-supplied decodedPath (defense-in-depth)', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_add', params: {
        trackId: 'route:test', uploadId, position: { unit: 'samples', value: 0 },
        decodedPath: '/etc/passwd',
      } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200);
    const injected = fakeProxyCalls[0].params;
    assert.notEqual(injected.decodedPath, '/etc/passwd');
    assert.ok(injected.decodedPath.endsWith(`${uploadId}.wav`));
  });

  it('returns 404 MISSING_UPLOAD when uploadId is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'audio_region_add', params: { trackId: 'route:test', uploadId: 'upl_deadbeefdeadbeef', position: { unit: 'samples', value: 0 } } },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error_code, 'MISSING_UPLOAD');
  });

  it('dedupes by requestId and does not re-dispatch', async () => {
    fakeProxyCalls.length = 0;
    const payload = { tool: 'audio_region_add', params: { trackId: 'route:test', uploadId, position: { unit: 'samples', value: 0 }, requestId: 'rid-xyz' } };
    const a = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/actions`, payload, headers: { 'content-type': 'application/json' } });
    const b = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/actions`, payload, headers: { 'content-type': 'application/json' } });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(JSON.parse(a.body), JSON.parse(b.body));
    assert.equal(fakeProxyCalls.length, 1, 'proxy should be called once across two requestId-matching invocations');
  });
});
