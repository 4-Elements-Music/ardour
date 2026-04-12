import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PortPool } from './port-pool.js';

describe('PortPool', () => {
  it('allocates lowest available port in range', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    assert.equal(pool.allocate(), 5000);
    assert.equal(pool.allocate(), 5001);
  });

  it('releases ports back to pool', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    const p = pool.allocate();
    pool.release(p);
    assert.equal(pool.allocate(), 5000);
  });

  it('returns null when all ports exhausted', () => {
    const pool = new PortPool({ start: 5000, end: 5001, portChecker: async () => false });
    pool.allocate();
    pool.allocate();
    assert.equal(pool.allocate(), null);
  });

  it('release is idempotent', () => {
    const pool = new PortPool({ start: 5000, end: 5010, portChecker: async () => false });
    pool.release(5005);
    pool.release(5005);
    assert.equal(pool.allocate(), 5000);
  });

  it('availableCount reflects state', () => {
    const pool = new PortPool({ start: 5000, end: 5002, portChecker: async () => false });
    assert.equal(pool.availableCount(), 3);
    pool.allocate();
    assert.equal(pool.availableCount(), 2);
  });

  it('scan marks occupied ports unavailable', async () => {
    const occupied = new Set([5002]);
    const pool = new PortPool({
      start: 5000, end: 5010,
      portChecker: async (port) => occupied.has(port),
    });
    await pool.scan();
    assert.equal(pool.allocate(), 5000);
    assert.equal(pool.allocate(), 5001);
    assert.equal(pool.allocate(), 5003); // skips 5002
  });

  it('constructor rejects invalid range', () => {
    assert.throws(() => new PortPool({ start: 5010, end: 5000, portChecker: async () => false }));
  });
});
