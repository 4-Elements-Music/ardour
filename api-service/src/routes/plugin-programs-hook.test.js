/**
 * Route-level tests for plugin/list_programs and plugin/set_program.
 *
 * Ardour is mocked via a stub actionProxy — no running session required.
 * These tests verify that the API server accepts valid params and forwards
 * them to actionProxy, and rejects invalid/missing params with 400.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { RequestCache } from '../lib/request-cache.js';

/* ---------- minimal fakes ---------- */

function fakeSessionManager () {
  const sessions = new Map ();
  const sm = {
    _sessions: sessions,
    async create (opts) {
      const id = 'sid-' + sessions.size;
      const s = {
        id, status: 'starting', sessionName: opts?.sessionName || 'test',
        sampleRate: opts?.sampleRate || 44100,
        createdAt: Date.now (), lastActivity: Date.now (),
        uploads: new Map (),
        sessionDir: '/tmp/fake-session',
      };
      sessions.set (id, s);
      return { session_id: id, status: 'starting' };
    },
    get (id) { return sessions.get (id) || null; },
    listAll () { return [...sessions.values ()]; },
    activeCount () { return sessions.size; },
    async destroy (id) {
      const s = sessions.get (id);
      if (s) s.status = 'stopped';
    },
    getUploadPath () { return null; },
    getDecodedPath () { return null; },
    async decodeOnce () { return null; },
  };
  return sm;
}

/* ---------- helpers ---------- */

const SAMPLE_PROGRAMS = [
  { index: 0, uri: 'urn:preset:steinway-d', label: 'Steinway D Concert' },
  { index: 1, uri: 'urn:preset:yamaha-c7',  label: 'Yamaha C7' },
];

async function buildReadyApp (fakeProxyCalls, proxyResult) {
  const sm = fakeSessionManager ();
  const { session_id } = await sm.create ({ sessionName: 'test' });
  const session = sm.get (session_id);
  session.status = 'ready';

  const app = Fastify ({ logger: false });
  app.decorate ('sessionManager', sm);
  app.decorate ('actionProxy', {
    async execute (_session, _tool, params, _reqId) {
      fakeProxyCalls.push ({ tool: _tool, params });
      return proxyResult ?? {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true, programs: SAMPLE_PROGRAMS },
        },
      };
    },
  });
  app.decorate ('exportService', null);
  app.decorate ('requestCache', null);
  app.decorate ('config', {
    maxConcurrentSessions: 5,
    allowGui: false,
    audioValidatorBin: '/bin/false',
  });
  await app.register (fastifyMultipart);
  await app.register (sessionRoutes, { prefix: '/v1' });
  await app.ready ();

  return { app, sessionId: session_id };
}

/* ---------- plugin/list_programs tests ---------- */

describe ('plugin/list_programs', () => {
  let app, sessionId, fakeProxyCalls;

  before (async () => {
    fakeProxyCalls = [];
    ({ app, sessionId } = await buildReadyApp (fakeProxyCalls));
  });

  after (async () => {
    if (app) await app.close ();
  });

  it ('forwards missing trackId to actionProxy (C++ validates)', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin/list_programs',
        params: { pluginIndex: 0 },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
  });

  it ('forwards missing pluginIndex to actionProxy (C++ validates)', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin/list_programs',
        params: { trackId: 'track:abc' },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
  });

  it ('accepts valid params and forwards to actionProxy', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin/list_programs',
        params: { trackId: 'track:abc', pluginIndex: 0 },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
    assert.equal (fakeProxyCalls[0].tool, 'plugin/list_programs');
    assert.equal (fakeProxyCalls[0].params.trackId, 'track:abc');
    assert.equal (fakeProxyCalls[0].params.pluginIndex, 0);

    const body = res.json ();
    const sc = body.structuredContent ?? body.result?.structuredContent ?? body;
    assert.ok (sc.ok, 'response reports ok:true');
    assert.ok (Array.isArray (sc.programs), 'response includes programs array');
  });
});

/* ---------- plugin/set_program tests ---------- */

describe ('plugin/set_program', () => {
  let app, sessionId, fakeProxyCalls;

  before (async () => {
    fakeProxyCalls = [];
    ({ app, sessionId } = await buildReadyApp (fakeProxyCalls, {
      result: {
        content: [{ type: 'text', text: 'Plugin program set' }],
        structuredContent: {
          ok: true,
          loadedProgramIndex: 1,
          loadedProgramName: 'Yamaha C7',
        },
      },
    }));
  });

  after (async () => {
    if (app) await app.close ();
  });

  it ('forwards missing programIndex to actionProxy (C++ validates)', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin/set_program',
        params: { trackId: 'track:abc', pluginIndex: 0 },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
  });

  it ('accepts valid params and forwards to actionProxy, returns loaded program info', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin/set_program',
        params: { trackId: 'track:abc', pluginIndex: 0, programIndex: 1 },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
    assert.equal (fakeProxyCalls[0].tool, 'plugin/set_program');
    assert.equal (fakeProxyCalls[0].params.trackId, 'track:abc');
    assert.equal (fakeProxyCalls[0].params.pluginIndex, 0);
    assert.equal (fakeProxyCalls[0].params.programIndex, 1);

    const body = res.json ();
    const sc = body.structuredContent ?? body.result?.structuredContent ?? body;
    assert.ok (sc.ok, 'response reports ok:true');
    assert.equal (sc.loadedProgramIndex, 1);
    assert.equal (sc.loadedProgramName, 'Yamaha C7');
  });
});
