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
const skipNoValidator = !existsSync(validatorBin) && 'validator binary missing';

describe('place_stem_region tool', { skip: skipNoValidator }, () => {
  let app, sessionManager, sessionId, uploadId, tmp, fakeProxyCalls;

  before(async () => {
    tmp = join(tmpdir(), `stem-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    sessionManager = new SessionManager({
      config: {
        maxConcurrentSessions: 5, allowGui: false,
        sessionsDir: tmp, maxSessionUploadBytes: 10_000_000,
        audioValidatorBin: validatorBin,
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
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true, regionId: 'fake-stem-region' },
        };
      },
    });
    app.decorate('requestCache', new RequestCache({ maxEntries: 16, ttlMs: 60_000 }));
    app.decorate('config', {
      maxConcurrentSessions: 5, allowGui: false,
      maxUploadBytes: 10_000_000, maxSessionUploadBytes: 10_000_000,
      audioValidatorBin: validatorBin,
    });
    await app.register(fastifyMultipart);
    await app.register(sessionRoutes, { prefix: '/v1' });
    await app.ready();
    const created = await sessionManager.create({ sessionName: 'stem-test' });
    sessionId = created.session_id;
    sessionManager.get(sessionId).status = 'ready';

    const fixturePath = join(tmp, 'stem.wav');
    spawnSync('python3', ['-c',
      `import wave; w=wave.open('${fixturePath}','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b'\\x00'*44100*2); w.close()`,
    ]);
    const form = new FormData();
    form.append('file', readFileSync(fixturePath), 'stem.wav');
    const ur = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/upload`,
      payload: form.getBuffer(), headers: form.getHeaders(),
    });
    uploadId = JSON.parse(ur.body).upload_id;
  });

  after(async () => {
    if (app) await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('dispatches audio_region_add with stemType + fidelityRank tagged', async () => {
    fakeProxyCalls.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'place_stem_region', params: {
        trackId: 'route:bass', uploadId,
        stemType: 'bass', fidelityRank: 0,
        position: { unit: 'samples', value: 0 },
        timelineLength: { unit: 'samples', value: 44100 },
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200, `place_stem_region failed: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.regionId);
    assert.equal(body.stemType, 'bass');
    assert.equal(body.fidelityRank, 0);
    // exactly one underlying audio_region_add dispatch
    const adds = fakeProxyCalls.filter((c) => c.tool === 'audio_region_add');
    assert.equal(adds.length, 1);
    assert.equal(adds[0].params.stemType, 'bass');
    assert.equal(adds[0].params.fidelityRank, 0);
  });

  it('rejects unknown stemType with INVALID_PARAMS', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/sessions/${sessionId}/actions`,
      payload: { tool: 'place_stem_region', params: {
        trackId: 'route:bass', uploadId,
        stemType: 'kazoo', fidelityRank: 0,
        position: { unit: 'samples', value: 0 },
      }},
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error_code, 'INVALID_PARAMS');
  });
});
