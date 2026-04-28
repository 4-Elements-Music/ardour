/**
 * Route-level tests for plugin_automation_add / plugin_automation_clear.
 *
 * Mocks the Ardour upstream via a stub actionProxy — no running session
 * required. Verifies that the API server forwards valid params to the proxy
 * and surfaces the structured response, and that obviously broken payloads
 * (e.g. neither/both of parameterIndex/controlId, empty points) are
 * rejected before the proxy is reached.
 *
 * Mock conventions match plugin-programs-hook.test.js (the closest neighbor
 * tool family). The api-service does not auto-route per-tool; all MCP tools
 * dispatch through POST /v1/sessions/:id/actions with {tool, params}.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sessionRoutes } from './sessions.js';
import { ActionProxy } from '../lib/action-proxy.js';

const __dirname = dirname (fileURLToPath (import.meta.url));

/* ---------- minimal session manager fake ---------- */

function fakeSessionManager () {
  const sessions = new Map ();
  return {
    _sessions: sessions,
    async create (opts) {
      const id = 'sid-' + sessions.size;
      const s = {
        id,
        status: 'starting',
        sessionName: opts?.sessionName || 'test',
        sampleRate: opts?.sampleRate || 44100,
        createdAt: Date.now (),
        lastActivity: Date.now (),
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
}

/* ---------- helpers ---------- */

async function buildReadyApp (fakeProxyCalls, proxyResultOrFn) {
  const sm = fakeSessionManager ();
  const { session_id } = await sm.create ({ sessionName: 'test' });
  const session = sm.get (session_id);
  session.status = 'ready';

  const app = Fastify ({ logger: false });
  app.decorate ('sessionManager', sm);
  app.decorate ('actionProxy', {
    async execute (_session, _tool, params, _reqId) {
      fakeProxyCalls.push ({ tool: _tool, params });
      const out = typeof proxyResultOrFn === 'function'
        ? proxyResultOrFn (_tool, params)
        : proxyResultOrFn;
      return out ?? {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true },
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

/* ---------- schema-level tests (Ajv via ActionProxy) ---------- */

function loadSchemas () {
  const path = resolve (__dirname, '../schemas/mcp-tools.json');
  return JSON.parse (readFileSync (path, 'utf8'));
}

describe ('mcp-tools.json: plugin_automation_add schema', () => {
  const schemas = loadSchemas ();
  const tool = schemas.tools.find (t => t.name === 'plugin_automation_add');

  it ('is registered in the catalog', () => {
    assert.ok (tool, 'plugin_automation_add not found in mcp-tools.json');
  });

  it ('inputSchema compiles under ajv with strict:false', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    assert.doesNotThrow (() => ajv.compile (tool.inputSchema));
  });

  it ('outputSchema compiles under ajv with strict:false', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    assert.doesNotThrow (() => ajv.compile (tool.outputSchema));
  });

  it ('accepts parameterIndex variant', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, parameterIndex: 12,
      points: [{ timeS: 0.0, value: 0.0 }, { timeS: 4.0, value: 0.85 }],
    }), true);
  });

  it ('accepts controlId variant', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, controlId: 1234,
      points: [{ timeS: 0.0, value: 0.5 }],
    }), true);
  });

  it ('rejects payload with both parameterIndex and controlId', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, parameterIndex: 1, controlId: 99,
      points: [{ timeS: 0.0, value: 0.0 }],
    }), false);
  });

  it ('rejects payload with neither parameterIndex nor controlId', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0,
      points: [{ timeS: 0.0, value: 0.0 }],
    }), false);
  });

  it ('rejects empty points array (minItems:1)', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, parameterIndex: 12, points: [],
    }), false);
  });

  it ('rejects negative timeS in a point', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, parameterIndex: 12,
      points: [{ timeS: -0.1, value: 0.0 }],
    }), false);
  });
});

describe ('mcp-tools.json: plugin_automation_clear schema', () => {
  const schemas = loadSchemas ();
  const tool = schemas.tools.find (t => t.name === 'plugin_automation_clear');

  it ('is registered in the catalog', () => {
    assert.ok (tool, 'plugin_automation_clear not found in mcp-tools.json');
  });

  it ('inputSchema compiles under ajv with strict:false', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    assert.doesNotThrow (() => ajv.compile (tool.inputSchema));
  });

  it ('outputSchema compiles under ajv with strict:false', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    assert.doesNotThrow (() => ajv.compile (tool.outputSchema));
  });

  it ('accepts parameterIndex variant', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({ id: 'route-uuid', pluginIndex: 0, parameterIndex: 12 }), true);
  });

  it ('accepts controlId variant', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({ id: 'route-uuid', pluginIndex: 0, controlId: 1234 }), true);
  });

  it ('rejects payload with both parameterIndex and controlId', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({
      id: 'route-uuid', pluginIndex: 0, parameterIndex: 1, controlId: 99,
    }), false);
  });

  it ('rejects payload with neither parameterIndex nor controlId', () => {
    const ajv = new Ajv ({ allErrors: true, strict: false });
    const v = ajv.compile (tool.inputSchema);
    assert.equal (v ({ id: 'route-uuid', pluginIndex: 0 }), false);
  });
});

/* ---------- ActionProxy registration tests ---------- */

describe ('ActionProxy registers plugin_automation_* tools', () => {
  const schemas = loadSchemas ();

  it ('rejects invalid plugin_automation_add params with INVALID_PARAMS', async () => {
    const proxy = new ActionProxy ({
      toolSchemas: schemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    // Drive _validate directly via execute against a session whose actionQueue we never use.
    // Simpler: hit the private validator via the public surface.
    await assert.rejects (
      () => proxy.execute (
        { id: 's', mcpBaseUrl: 'http://127.0.0.1:1/mcp', actionQueue: { add: (fn) => fn () } },
        'plugin_automation_add',
        { id: 'r', pluginIndex: 0, points: [] },  // empty points
      ),
      /INVALID_PARAMS/,
    );
  });

  it ('rejects plugin_automation_clear with both parameterIndex and controlId', async () => {
    const proxy = new ActionProxy ({
      toolSchemas: schemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    await assert.rejects (
      () => proxy.execute (
        { id: 's', mcpBaseUrl: 'http://127.0.0.1:1/mcp', actionQueue: { add: (fn) => fn () } },
        'plugin_automation_clear',
        { id: 'r', pluginIndex: 0, parameterIndex: 1, controlId: 99 },
      ),
      /INVALID_PARAMS/,
    );
  });
});

/* ---------- route-level integration tests (mocked actionProxy) ---------- */

describe ('POST /v1/sessions/:id/actions with plugin_automation_add', () => {
  let app, sessionId, fakeProxyCalls;

  before (async () => {
    fakeProxyCalls = [];
    ({ app, sessionId } = await buildReadyApp (fakeProxyCalls, {
      result: {
        content: [{ type: 'text', text: 'Automation added' }],
        structuredContent: {
          id: 'route-uuid',
          pluginIndex: 0,
          parameterIndex: 12,
          controlId: 1234,
          label: 'Wet',
          pointsAdded: 2,
          automationState: 'Play',
        },
      },
    }));
  });

  after (async () => {
    if (app) await app.close ();
  });

  it ('forwards valid params to actionProxy and returns pointsAdded', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_add',
        params: {
          id: 'route-uuid',
          pluginIndex: 0,
          parameterIndex: 12,
          points: [
            { timeS: 0.0, value: 0.0 },
            { timeS: 4.0, value: 0.85 },
          ],
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
    assert.equal (fakeProxyCalls[0].tool, 'plugin_automation_add');
    assert.equal (fakeProxyCalls[0].params.id, 'route-uuid');
    assert.equal (fakeProxyCalls[0].params.pluginIndex, 0);
    assert.equal (fakeProxyCalls[0].params.parameterIndex, 12);
    assert.deepEqual (fakeProxyCalls[0].params.points, [
      { timeS: 0.0, value: 0.0 },
      { timeS: 4.0, value: 0.85 },
    ]);

    const body = res.json ();
    const sc = body.structuredContent ?? body.result?.structuredContent ?? body;
    assert.equal (sc.pointsAdded, 2);
    assert.equal (sc.automationState, 'Play');
    assert.equal (sc.label, 'Wet');
  });

  it ('forwards controlId variant to actionProxy', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_add',
        params: {
          id: 'route-uuid',
          pluginIndex: 0,
          controlId: 1234,
          points: [{ timeS: 0.0, value: 0.5 }],
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1);
    assert.equal (fakeProxyCalls[0].params.controlId, 1234);
    assert.equal (fakeProxyCalls[0].params.parameterIndex, undefined);
  });
});

describe ('POST /v1/sessions/:id/actions with plugin_automation_add (validation)', () => {
  let app, sessionId, fakeProxyCalls;

  before (async () => {
    fakeProxyCalls = [];
    // For validation tests, build the app with a real ActionProxy wired to the
    // production schema, so INVALID_PARAMS surfaces as 400 from the route.
    const schemas = loadSchemas ();
    const sm = fakeSessionManager ();
    const { session_id } = await sm.create ({ sessionName: 'test' });
    const session = sm.get (session_id);
    session.status = 'ready';
    session.actionQueue = { add: async (fn) => fn () };
    sessionId = session_id;

    const realProxy = new ActionProxy ({
      toolSchemas: schemas,
      // Should never be called — validation should fail first.
      httpClient: async () => {
        throw new Error ('httpClient should not be invoked when validation fails');
      },
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });

    app = Fastify ({ logger: false });
    app.decorate ('sessionManager', sm);
    app.decorate ('actionProxy', realProxy);
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
  });

  after (async () => {
    if (app) await app.close ();
  });

  it ('rejects empty points array with 400 INVALID_PARAMS', async () => {
    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_add',
        params: {
          id: 'route-uuid', pluginIndex: 0, parameterIndex: 12, points: [],
        },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 400, `Expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal (res.json ().error_code, 'INVALID_PARAMS');
  });

  it ('rejects payload missing parameterIndex AND controlId with 400', async () => {
    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_add',
        params: {
          id: 'route-uuid', pluginIndex: 0,
          points: [{ timeS: 0.0, value: 0.0 }],
        },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 400, `Expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal (res.json ().error_code, 'INVALID_PARAMS');
  });

  it ('rejects payload with BOTH parameterIndex and controlId with 400', async () => {
    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_add',
        params: {
          id: 'route-uuid', pluginIndex: 0, parameterIndex: 1, controlId: 99,
          points: [{ timeS: 0.0, value: 0.0 }],
        },
      },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal (res.statusCode, 400, `Expected 400, got ${res.statusCode}: ${res.body}`);
    assert.equal (res.json ().error_code, 'INVALID_PARAMS');
  });
});

describe ('POST /v1/sessions/:id/actions with plugin_automation_clear', () => {
  let app, sessionId, fakeProxyCalls;

  before (async () => {
    fakeProxyCalls = [];
    ({ app, sessionId } = await buildReadyApp (fakeProxyCalls, {
      result: {
        content: [{ type: 'text', text: 'Automation cleared' }],
        structuredContent: {
          id: 'route-uuid',
          pluginIndex: 0,
          parameterIndex: 12,
          controlId: 1234,
          pointsCleared: 7,
          automationState: 'Off',
        },
      },
    }));
  });

  after (async () => {
    if (app) await app.close ();
  });

  it ('forwards valid params to actionProxy and returns pointsCleared', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_clear',
        params: {
          id: 'route-uuid',
          pluginIndex: 0,
          parameterIndex: 12,
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1, 'actionProxy.execute called exactly once');
    assert.equal (fakeProxyCalls[0].tool, 'plugin_automation_clear');
    assert.equal (fakeProxyCalls[0].params.id, 'route-uuid');
    assert.equal (fakeProxyCalls[0].params.pluginIndex, 0);
    assert.equal (fakeProxyCalls[0].params.parameterIndex, 12);

    const body = res.json ();
    const sc = body.structuredContent ?? body.result?.structuredContent ?? body;
    assert.equal (sc.pointsCleared, 7);
    assert.equal (sc.automationState, 'Off');
  });

  it ('forwards controlId variant to actionProxy', async () => {
    fakeProxyCalls.length = 0;

    const res = await app.inject ({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/actions`,
      payload: {
        tool: 'plugin_automation_clear',
        params: {
          id: 'route-uuid',
          pluginIndex: 0,
          controlId: 1234,
        },
      },
      headers: { 'content-type': 'application/json' },
    });

    assert.equal (res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.equal (fakeProxyCalls.length, 1);
    assert.equal (fakeProxyCalls[0].params.controlId, 1234);
  });
});
