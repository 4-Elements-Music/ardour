/**
 * Injectable clock for testing time-dependent behavior without real timers.
 * Tests call advance(ms) to move virtual time forward.
 */
export class FakeClock {
  constructor(startTime = 0) {
    this._now = startTime;
    this._timers = new Map();
    this._nextId = 1;
  }

  now() { return this._now; }

  setTimeout(fn, ms) {
    const id = this._nextId++;
    this._timers.set(id, { fireAt: this._now + ms, fn, repeating: false, interval: 0 });
    return id;
  }

  clearTimeout(id) { this._timers.delete(id); }

  setInterval(fn, ms) {
    const id = this._nextId++;
    this._timers.set(id, { fireAt: this._now + ms, fn, repeating: true, interval: ms });
    return id;
  }

  clearInterval(id) { this._timers.delete(id); }

  /**
   * Advance virtual time by ms, firing any timers that come due.
   */
  advance(ms) {
    const target = this._now + ms;
    while (true) {
      let nextTimer = null;
      let nextId = null;
      for (const [id, t] of this._timers) {
        if (t.fireAt <= target && (nextTimer == null || t.fireAt < nextTimer.fireAt)) {
          nextTimer = t;
          nextId = id;
        }
      }
      if (!nextTimer) break;
      this._now = nextTimer.fireAt;
      if (nextTimer.repeating) {
        nextTimer.fireAt = this._now + nextTimer.interval;
      } else {
        this._timers.delete(nextId);
      }
      nextTimer.fn();
    }
    this._now = target;
  }
}
