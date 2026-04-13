import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestCache } from './request-cache.js';

describe('RequestCache', () => {
  it('caches by key and returns same value within TTL', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    let calls = 0;
    const fn = async () => { calls++; return { n: calls }; };
    const a = await c.compute('k1', fn);
    const b = await c.compute('k1', fn);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
  });

  it('caches distinct keys independently', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    const a = await c.compute('a', async () => 'A');
    const b = await c.compute('b', async () => 'B');
    assert.equal(a, 'A');
    assert.equal(b, 'B');
    assert.equal(c.size, 2);
  });

  it('evicts oldest when over capacity', async () => {
    const c = new RequestCache({ maxEntries: 2, ttlMs: 10000 });
    await c.compute('a', async () => 1);
    await c.compute('b', async () => 2);
    await c.compute('c', async () => 3);
    assert.equal(c.has('a'), false);
    assert.equal(c.has('b'), true);
    assert.equal(c.has('c'), true);
  });

  it('refreshes recency on get so accessed entries do not get evicted first', async () => {
    const c = new RequestCache({ maxEntries: 2, ttlMs: 10000 });
    await c.compute('a', async () => 1);
    await c.compute('b', async () => 2);
    // Touch 'a' so it becomes most recently used.
    assert.equal(c.get('a'), 1);
    // Now insert 'c' — least recently used is 'b', so 'b' should be evicted, not 'a'.
    await c.compute('c', async () => 3);
    assert.equal(c.has('a'), true);
    assert.equal(c.has('b'), false);
    assert.equal(c.has('c'), true);
  });

  it('expires entries after TTL using injected clock', async () => {
    let now = 1000;
    const c = new RequestCache({ maxEntries: 4, ttlMs: 100, now: () => now });
    await c.compute('k', async () => 'v');
    assert.equal(c.has('k'), true);
    now += 101;
    assert.equal(c.has('k'), false);
  });

  it('shares in-flight promise across concurrent callers (no thundering herd)', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    let calls = 0;
    let resolveInner;
    const slow = () => new Promise((resolve) => { resolveInner = () => { calls++; resolve('x'); }; });
    const p1 = c.compute('k', slow);
    const p2 = c.compute('k', slow);
    resolveInner();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, 'x');
    assert.equal(b, 'x');
    assert.equal(calls, 1);
  });

  it('does not cache when the underlying fn rejects', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    let calls = 0;
    const fn = async () => { calls++; throw new Error('boom'); };
    await assert.rejects(c.compute('k', fn));
    assert.equal(c.has('k'), false);
    // Subsequent call retries (no negative cache).
    await assert.rejects(c.compute('k', fn));
    assert.equal(calls, 2);
  });

  it('delete() removes an entry', async () => {
    const c = new RequestCache({ maxEntries: 4, ttlMs: 1000 });
    await c.compute('k', async () => 1);
    assert.equal(c.delete('k'), true);
    assert.equal(c.has('k'), false);
    assert.equal(c.delete('k'), false);
  });

  it('rejects invalid constructor args', () => {
    assert.throws(() => new RequestCache({ maxEntries: 0 }), /maxEntries/);
    assert.throws(() => new RequestCache({ ttlMs: 0 }), /ttlMs/);
  });
});
