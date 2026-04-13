/**
 * LRU + TTL cache used for idempotent retries on tools that have side-effects.
 *
 * Contract:
 *   - has(key)            -> true iff key is present and not expired
 *   - get(key)            -> cached value or undefined; touches recency on hit
 *   - put(key, value)     -> stores, evicting oldest if over capacity
 *   - compute(key, fn)    -> if cached, return it; else await fn(), cache the
 *                            resolved value, and return. While fn is in-flight,
 *                            concurrent callers with the same key share that
 *                            promise (no thundering herd). If fn rejects, the
 *                            rejection propagates and nothing is cached.
 *   - delete(key)         -> remove if present
 *   - size                -> current entry count (post-sweep of expired)
 *
 * Evicts least-recently-used (insertion + access order via Map iteration).
 * TTL is per-entry; expired entries are swept lazily on access.
 */
export class RequestCache {
  constructor ({ maxEntries = 256, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    if (maxEntries < 1) throw new Error('maxEntries must be >= 1');
    if (ttlMs < 1)      throw new Error('ttlMs must be >= 1');
    this._max = maxEntries;
    this._ttl = ttlMs;
    this._now = now;
    this._map = new Map();        // key -> { value, expiresAt }
    this._inflight = new Map();   // key -> Promise
  }

  get size () { this._sweep(); return this._map.size; }

  has (key) { this._sweep(); return this._map.has(key); }

  get (key) {
    this._sweep();
    const entry = this._map.get(key);
    if (!entry) return undefined;
    // Refresh recency: delete + re-insert.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  put (key, value) {
    this._sweep();
    if (this._map.has(key)) this._map.delete(key);
    while (this._map.size >= this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, { value, expiresAt: this._now() + this._ttl });
  }

  delete (key) { return this._map.delete(key); }

  async compute (key, fn) {
    if (this.has(key)) return this.get(key);
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        this.put(key, value);
        return value;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, p);
    return p;
  }

  _sweep () {
    const now = this._now();
    for (const [k, v] of this._map) {
      if (v.expiresAt <= now) this._map.delete(k);
    }
  }
}
