import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import PQueue from 'p-queue';
import { ActionProxy } from './action-proxy.js';
import { FakeArdourProcess } from '../../test/helpers/fake-ardour.js';

const toolSchemas = {
  tools: [
    {
      name: 'tracks/add',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' } },
        required: ['name', 'type'],
      },
    },
    {
      name: 'hello_world',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  ],
};

function makeSession(port) {
  return {
    id: 's1',
    port,
    mcpBaseUrl: `http://127.0.0.1:${port}/mcp`,
    status: 'ready',
    lastActivity: 0,
    actionQueue: new PQueue({ concurrency: 1 }),
  };
}

describe('ActionProxy.execute', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('proxies a valid tool call', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5940);
    fake.setToolResponse('hello_world', { text: 'hi' });

    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5940);
    const result = await proxy.execute(session, 'hello_world', { name: 'x' });
    assert.ok(result.result);
    assert.equal(result.result.structuredContent.text, 'hi');
  });

  it('rejects unknown tool', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5941);
    await assert.rejects(
      () => proxy.execute(session, 'nonexistent/tool', {}),
      /UNKNOWN_TOOL/
    );
  });

  it('rejects invalid params', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5942);
    await assert.rejects(
      () => proxy.execute(session, 'tracks/add', { name: 'Kick' }), // missing 'type'
      /INVALID_PARAMS/
    );
  });

  it('updates lastActivity', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5943);
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000 },
    });
    const session = makeSession(5943);
    const before = session.lastActivity;
    await new Promise(r => setTimeout(r, 5));
    await proxy.execute(session, 'hello_world', {});
    assert.ok(session.lastActivity > before);
  });
});

describe('ActionProxy.executeBatch', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('runs multiple actions sequentially', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5945);
    fake.setToolResponse('hello_world', { ok: true });
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 100 },
    });
    const session = makeSession(5945);
    const out = await proxy.executeBatch(session, [
      { tool: 'hello_world', params: {} },
      { tool: 'hello_world', params: {} },
    ]);
    assert.equal(out.total, 2);
    assert.equal(out.completed, 2);
    assert.ok(out.results.every(r => r.success));
  });

  it('stops on error with stop_on_error', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5946);
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 100 },
    });
    const session = makeSession(5946);
    const out = await proxy.executeBatch(session, [
      { tool: 'unknown', params: {} },
      { tool: 'hello_world', params: {} },
    ], { stopOnError: true });
    assert.equal(out.completed, 0);
    assert.equal(out.results[0].success, false);
    assert.equal(out.results[1], null);
  });

  it('rejects batch exceeding max size', async () => {
    const proxy = new ActionProxy({
      toolSchemas,
      httpClient: globalThis.fetch,
      config: { actionTimeoutMs: 2000, actionQueueTimeoutMs: 5000, maxBatchSize: 2 },
    });
    const session = makeSession(5947);
    await assert.rejects(
      () => proxy.executeBatch(session, [
        { tool: 'hello_world' }, { tool: 'hello_world' }, { tool: 'hello_world' },
      ]),
      /BATCH_TOO_LARGE/
    );
  });
});
