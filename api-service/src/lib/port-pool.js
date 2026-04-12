import { createConnection } from 'net';

/**
 * Check whether a TCP port is in use by trying to connect.
 * Returns true if something is listening on the port.
 */
export async function tcpPortInUse(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let done = false;
    const cleanup = (inUse) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => cleanup(true));
    socket.on('timeout', () => cleanup(false));
    socket.on('error', () => cleanup(false));
  });
}

export class PortPool {
  constructor({ start, end, portChecker = tcpPortInUse } = {}) {
    if (typeof start !== 'number' || typeof end !== 'number' || start > end) {
      throw new Error(`Invalid port range: start=${start} end=${end}`);
    }
    this._start = start;
    this._end = end;
    this._occupied = new Set();
    this._portChecker = portChecker;
  }

  /**
   * Scan the range in parallel, marking in-use ports as occupied.
   */
  async scan() {
    const ports = [];
    for (let p = this._start; p <= this._end; p++) ports.push(p);
    const results = await Promise.all(ports.map(async (p) => [p, await this._portChecker(p)]));
    for (const [p, inUse] of results) {
      if (inUse) this._occupied.add(p);
    }
  }

  /**
   * Allocate the lowest available port in the range. Returns null if exhausted.
   */
  allocate() {
    for (let p = this._start; p <= this._end; p++) {
      if (!this._occupied.has(p)) {
        this._occupied.add(p);
        return p;
      }
    }
    return null;
  }

  /**
   * Release a port back to the pool. Idempotent.
   */
  release(port) {
    this._occupied.delete(port);
  }

  /**
   * Number of ports currently free.
   */
  availableCount() {
    return (this._end - this._start + 1) - this._occupied.size;
  }
}
