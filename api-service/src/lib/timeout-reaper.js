/**
 * TimeoutReaper — background interval that reaps idle sessions,
 * triggers auto-save, and cleans up dead session directories.
 */
export class TimeoutReaper {
  constructor({ sessionManager, clock = null, config, saveSession = null }) {
    if (!sessionManager) throw new Error('sessionManager required');
    if (!config) throw new Error('config required');
    this._sm = sessionManager;
    this._clock = clock;
    this._config = config;
    this._saveSession = saveSession;
    this._intervalId = null;
  }

  _now() { return this._clock ? this._clock.now() : Date.now(); }

  /**
   * Run one reap cycle synchronously. Safe to call in tests.
   */
  reap() {
    const now = this._now();
    for (const session of this._sm.listAll()) {
      if (session.status !== 'ready' && session.status !== 'unhealthy') {
        continue;
      }

      const idleFor = now - session.lastActivity;
      if (idleFor >= this._config.sessionIdleTimeoutMs) {
        // fire-and-forget destruction
        this._sm.destroy(session.id).catch(() => {});
        continue;
      }

      // Auto-save check
      if (this._saveSession && session.status === 'ready') {
        const sinceSave = now - (session.lastSave ?? 0);
        if (sinceSave >= this._config.sessionAutoSaveIntervalMs && session.lastActivity > (session.lastSave ?? 0)) {
          session.lastSave = now;
          this._saveSession(session).catch(() => {});
        }
      }
    }
  }

  start(intervalMs = 60000) {
    const si = this._clock ? this._clock.setInterval.bind(this._clock) : setInterval;
    this._intervalId = si(() => this.reap(), intervalMs);
  }

  stop() {
    if (this._intervalId != null) {
      const ci = this._clock ? this._clock.clearInterval.bind(this._clock) : clearInterval;
      ci(this._intervalId);
      this._intervalId = null;
    }
  }
}
