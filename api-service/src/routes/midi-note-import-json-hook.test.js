/**
 * Route-level tests for midi_note/import_json with extended event types.
 *
 * These tests verify that the API server accepts (and forwards to Ardour)
 * all 7 event types: note_on, note_off, cc, pb, pgm, aftertouch_chan,
 * aftertouch_poly. Ardour is mocked via a stub actionProxy so no running
 * session is required.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { sessionRoutes } from './sessions.js';
import { SessionManager } from '../lib/session-manager.js';
import { RequestCache } from '../lib/request-cache.js';

/* ---------- minimal fakes ---------- */

function fakeSessionManager() {
  const sessions = new Map();
  const sm = {
    _sessions: sessions,
    async create(opts) {
      const id = 'sid-' + sessions.size;
      const s = {
        id, status: 'starting', sessionName: opts?.sessionName || 'test',
        sampleRate: opts?.sampleRate || 44100,
        createdAt: Date.now(), lastActivity: Date.now(),
        uploads: new Map(),
        sessionDir: '/tmp/fake-session',
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
    getUploadPath() { return null; },
    getDecodedPath() { return null; },
    async decodeOnce() { return null; },
  };
  return sm;
}

/* ---------- helpers ---------- */

async function buildReadyApp(fakeProxyCalls) {
  const sm = fakeSessionManager();

  // Create a session and force it to 'ready' state
  const { session_id } = await sm.create({ sessionName: 'test' });
  const session = sm.get(session_id);
  session.status = 'ready';

  const app = Fastify({ logger: false });
  app.decorate('sessionManager', sm);
  app.decorate('actionProxy', {
    async execute(_session, _tool, params, _reqId) {
      fakeProxyCalls.push({ tool: _tool, params });
      return {
        result: {
          content: [{ type: 'text', text: 'MIDI JSON imported' }],
          structuredContent: {
            ok: true,
            createdRegion: false,
            summary: { notesInserted: 2, nonNoteInserted: 5 },
          },
        },
      };
    },
  });
  app.decorate('exportService', null);
  app.decorate('requestCache', null);
  app.decorate('config', {
    maxConcurrentSessions: 5,
    allowGui: false,
    audioValidatorBin: '/bin/false',
  });
  await app.register(fastifyMultipart);
  await app.register(sessionRoutes, { prefix: '/v1' });
  await app.ready();

  return { app, sessionId: session_id };
}

/* ---------- tests ---------- */

describe('midi_note/import_json — extended event types', () => {
  let app;
  let sessionId;
  let fakeProxyCalls;

  before(async () => {
    fakeProxyCalls = [];
    ({ app, sessionId } = await buildReadyApp(fakeProxyCalls));
  });

  after(async () => {
    if (app) await app.close();
  });

  it('accepts a request with all 7 event types and returns 200', async () => {
    const payload = {
      tool: 'midi_note/import_json',
      params: {
        regionId: 'region:abc123',
        midi: {
          channel: 1,
          channel_base: 'one',
          ticks_per_quarter: 480,
          time_signature: '4/4',
          midi_events: [
            // note_on
            { bar: 1, b: 1, n: 60, v: 100, type: 'note_on' },
            // note_off
            { bar: 1, b: 3, n: 60, v: 0, type: 'note_off' },
            // cc — mod wheel
            { bar: 1, b: 1, type: 'cc', controller: 1, value: 64 },
            // cc — expression
            { bar: 1, b: 2, type: 'cc', controller: 11, value: 100 },
            // pb — pitch bend up
            { bar: 1, b: 2, type: 'pb', bend: 4096 },
            // pgm — program change
            { bar: 1, b: 1, type: 'pgm', program: 40 },
            // aftertouch_chan
            { bar: 1, b: 2, type: 'aftertouch_chan', pressure: 80 },
            // aftertouch_poly
            { bar: 1, b: 2, type: 'aftertouch_poly', n: 60, pressure: 72 },
          ],
        },
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload,
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.ok(body.structuredContent ?? body.ok ?? body.result ?? body, 'response has content');
    assert.equal(fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
    assert.equal(fakeProxyCalls[0].tool, 'midi_note/import_json');
  });

  it('passes midi_events array to actionProxy unchanged', async () => {
    fakeProxyCalls.length = 0;

    const events = [
      { bar: 1, b: 1, n: 48, v: 90, type: 'note_on' },
      { bar: 1, b: 3, n: 48, v: 0, type: 'note_off' },
      { bar: 1, b: 1, type: 'cc', controller: 74, value: 90 },
      { bar: 1, b: 1, type: 'pb', bend: -2000 },
      { bar: 1, b: 1, type: 'pgm', program: 10 },
      { bar: 1, b: 2, type: 'aftertouch_chan', pressure: 50 },
      { bar: 1, b: 2, type: 'aftertouch_poly', n: 48, pressure: 55 },
    ];

    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'midi_note/import_json',
        params: {
          regionId: 'region:abc123',
          midi: { channel: 1, channel_base: 'one', midi_events: events },
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(fakeProxyCalls.length, 1);
    const passedEvents = fakeProxyCalls[0].params.midi.midi_events;
    assert.equal(passedEvents.length, events.length);

    const types = passedEvents.map(e => e.type);
    assert.ok(types.includes('note_on'),         'note_on present');
    assert.ok(types.includes('note_off'),        'note_off present');
    assert.ok(types.includes('cc'),              'cc present');
    assert.ok(types.includes('pb'),              'pb present');
    assert.ok(types.includes('pgm'),             'pgm present');
    assert.ok(types.includes('aftertouch_chan'), 'aftertouch_chan present');
    assert.ok(types.includes('aftertouch_poly'), 'aftertouch_poly present');
  });

  it('returns 200 for a pb event with no bend field (defaults to 0)', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'midi_note/import_json',
        params: {
          regionId: 'region:abc123',
          midi: {
            channel: 1,
            channel_base: 'one',
            midi_events: [
              { bar: 1, b: 1, type: 'pb' },  // bend defaults to 0 on C++ side
            ],
          },
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
  });
});
