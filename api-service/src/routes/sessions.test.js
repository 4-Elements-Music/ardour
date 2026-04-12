import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { sessionRoutes } from './sessions.js';
import FormData from 'form-data';
import fastifyMultipart from '@fastify/multipart';

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
