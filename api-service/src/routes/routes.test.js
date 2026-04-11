import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { healthRoutes } from './health.js';
import { jobRoutes, queue } from './jobs.js';
import { pluginRoutes } from './plugins.js';

function buildApp() {
  const app = Fastify({ logger: false });
  app.decorate('jobQueue', queue);
  app.register(healthRoutes, { prefix: '/v1' });
  app.register(jobRoutes, { prefix: '/v1' });
  app.register(pluginRoutes, { prefix: '/v1' });
  return app;
}

function minimalSpec() {
  return {
    session: {
      sample_rate: 48000,
      tempo: [{ bar: 1, bpm: 120 }],
      time_signature: [{ bar: 1, numerator: 4, denominator: 4 }],
      duration_bars: 4,
    },
    tracks: [{ name: 'Test', type: 'audio', regions: [{ file: 'stems/kick.wav', position_bar: 1 }] }],
    output: { formats: [{ format: 'wav' }] },
  };
}

describe('GET /v1/health', () => {
  it('returns status ok with queue info', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.queue_depth, 'number');
    assert.equal(typeof body.active_jobs, 'number');
    await app.close();
  });
});

describe('GET /v1/plugins', () => {
  it('returns a list of plugins', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/plugins' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    assert.ok(body[0].name);
    assert.ok(body[0].uri);
    assert.ok(body[0].type);
    assert.ok(body[0].category);
    await app.close();
  });
});

describe('POST /v1/jobs', () => {
  it('rejects a non-object body', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload: 'not json', headers: { 'content-type': 'application/json' } });
    assert.ok(res.statusCode >= 400);
    await app.close();
  });

  it('rejects an empty object', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload: {} });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error);
    assert.ok(body.details);
    await app.close();
  });

  it('rejects a spec with invalid track type', async () => {
    const app = buildApp();
    await app.ready();
    const spec = minimalSpec();
    spec.tracks[0].type = 'video';
    const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload: spec });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('accepts a valid spec and returns 202', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/jobs', payload: minimalSpec() });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.ok(body.job_id);
    assert.equal(body.status, 'pending');
    await app.close();
  });
});

describe('GET /v1/jobs/:id', () => {
  it('returns 404 for unknown job', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/jobs/nonexistent-id' });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('GET /v1/jobs/:id/output/:filename', () => {
  it('returns 404 for unknown job output', async () => {
    const app = buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/jobs/nonexistent-id/output/test.wav' });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});
