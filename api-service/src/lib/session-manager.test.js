import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { SessionManager } from './session-manager.js';
import { PortPool } from './port-pool.js';
import { FakeClock } from '../../test/helpers/fake-clock.js';
import { FakeArdourProcess } from '../../test/helpers/fake-ardour.js';

function makeConfig(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'sm-test-'));
  return {
    sessionsDir: tmp,
    maxConcurrentSessions: 5,
    sessionStartupTimeoutMs: 5000,
    actionTimeoutMs: 2000,
    actionQueueDepth: 20,
    actionQueueTimeoutMs: 30000,
    mcpPortRangeStart: 5900,
    mcpPortRangeEnd: 5920,
    logRingBufferSize: 100,
    luasessionBin: '/bin/echo',
    mcpHostLua: '/tmp/mcp_host.lua',
    ardourRoot: '/tmp',
    ...overrides,
  };
}

function makeFakeSpawner(mockArdour) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 99999;
    child.kill = () => child.emit('exit', 0, null);
    // Simulate ready marker after 10ms
    setTimeout(() => child.stdout.emit('data', Buffer.from('MCP_HTTP_READY\n')), 10);
    return child;
  };
}

describe('SessionManager.create', () => {
  let fake;
  afterEach(async () => { if (fake) await fake.stop(); });

  it('spawns a session with allocated port', async () => {
    fake = new FakeArdourProcess();
    await fake.start(5900);

    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5901 });
    const clock = new FakeClock(1000);
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(fake),
      httpClient: globalThis.fetch,
    });

    const result = await sm.create({ sessionName: 'test', sampleRate: 48000 });
    assert.ok(result.session_id);
    assert.equal(result.status, 'starting');

    // Wait for ready
    await new Promise(r => setTimeout(r, 50));
    const session = sm.get(result.session_id);
    assert.ok(session);
    assert.equal(session.port, 5900);
  });

  it('rejects when max concurrent reached', async () => {
    const config = makeConfig({ maxConcurrentSessions: 1 });
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    await sm.create({ sessionName: 's1' });
    await assert.rejects(
      () => sm.create({ sessionName: 's2' }),
      /MAX_SESSIONS/
    );
  });

  it('list and get work', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    assert.ok(sm.get(r.session_id));
    assert.equal(sm.listAll().length, 1);
    assert.equal(sm.activeCount(), 1);
  });

  it('destroy removes session and releases port', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    await sm.destroy(r.session_id);
    const session = sm.get(r.session_id);
    // Session either gone or in stopped/dead state
    if (session) {
      assert.ok(['stopping', 'stopped', 'dead'].includes(session.status));
    }
    assert.equal(portPool.availableCount(), 6);
  });

  it('destroy is idempotent', async () => {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    const r = await sm.create({ sessionName: 's1' });
    await sm.destroy(r.session_id);
    await sm.destroy(r.session_id); // should not throw
  });
});

describe('SessionManager uploads registry', () => {
  function makeSm() {
    const config = makeConfig();
    const portPool = new PortPool({ start: 5900, end: 5905 });
    const clock = new FakeClock();
    const sm = new SessionManager({
      config, portPool, clock,
      spawner: makeFakeSpawner(),
      httpClient: globalThis.fetch,
    });
    return sm;
  }

  it('registerUpload returns id matching expected format', async () => {
    const sm = makeSm();
    const r = await sm.create({ sessionName: 's1' });
    const id = sm.registerUpload(r.session_id, 'kick.wav', 42, '/tmp/foo/kick.wav');
    assert.match(id, /^upl_[a-f0-9]{16}$/);
  });

  it('getUploadPath round-trips', async () => {
    const sm = makeSm();
    const r = await sm.create({ sessionName: 's1' });
    const id = sm.registerUpload(r.session_id, 'k.wav', 10, '/tmp/x/k.wav');
    assert.equal(sm.getUploadPath(r.session_id, id), '/tmp/x/k.wav');
  });

  it('getUploads returns entry with the right shape', async () => {
    const sm = makeSm();
    const r = await sm.create({ sessionName: 's1' });
    const id = sm.registerUpload(r.session_id, 'k.wav', 10, '/tmp/x/k.wav');
    const list = sm.getUploads(r.session_id);
    assert.equal(list.length, 1);
    assert.equal(list[0].upload_id, id);
    assert.equal(list[0].filename, 'k.wav');
    assert.equal(list[0].bytes, 10);
    assert.ok(typeof list[0].created_at === 'string');
  });

  it('returns distinct ids across multiple uploads', async () => {
    const sm = makeSm();
    const r = await sm.create({ sessionName: 's1' });
    const id1 = sm.registerUpload(r.session_id, 'kick.wav', 10, '/tmp/x/kick.wav');
    const id2 = sm.registerUpload(r.session_id, 'snare.wav', 12, '/tmp/x/snare.wav');
    assert.notEqual(id1, id2);
  });

  it('unknown session id yields null / empty', () => {
    const sm = makeSm();
    assert.equal(sm.registerUpload('nope', 'a', 1, '/x'), null);
    assert.equal(sm.getUploadPath('nope', 'upl_x'), null);
    assert.deepEqual(sm.getUploads('nope'), []);
  });
});
