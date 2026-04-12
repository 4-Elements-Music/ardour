import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutReaper } from './timeout-reaper.js';
import { FakeClock } from '../../test/helpers/fake-clock.js';

function makeSession(id, status, lastActivity, lastSave = null) {
  return {
    id, status, lastActivity,
    lastSave: lastSave ?? lastActivity,
    actionQueue: { clear() {}, pause() {} },
  };
}

describe('TimeoutReaper.reap', () => {
  it('does not reap recently-active sessions', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [makeSession('s1', 'ready', 999_000)],
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, []);
  });

  it('reaps idle sessions past threshold', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [makeSession('s1', 'ready', 900_000)], // 100s old
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, ['s1']);
  });

  it('skips starting and stopping sessions', () => {
    const clock = new FakeClock(1_000_000);
    const destroyed = [];
    const sm = {
      listAll: () => [
        makeSession('s1', 'starting', 500_000),
        makeSession('s2', 'stopping', 500_000),
      ],
      destroy: async (id) => destroyed.push(id),
    };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    assert.deepEqual(destroyed, []);
  });

  it('triggers auto-save on ready session with stale lastSave', async () => {
    const clock = new FakeClock(1_000_000);
    const savedSessions = [];
    const session = makeSession('s1', 'ready', 999_000, 500_000);
    const sm = {
      listAll: () => [session],
      destroy: async () => {},
    };
    const saver = async (s) => savedSessions.push(s.id);
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      saveSession: saver,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.reap();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(savedSessions, ['s1']);
  });

  it('start and stop control the interval', () => {
    const clock = new FakeClock(0);
    let reapCount = 0;
    const sm = { listAll: () => { reapCount++; return []; }, destroy: async () => {} };
    const reaper = new TimeoutReaper({
      sessionManager: sm, clock,
      config: { sessionIdleTimeoutMs: 30000, sessionAutoSaveIntervalMs: 300000 },
    });
    reaper.start(1000);
    clock.advance(2500);
    assert.equal(reapCount, 2);
    reaper.stop();
    clock.advance(2000);
    assert.equal(reapCount, 2);
  });
});
