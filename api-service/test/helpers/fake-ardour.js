import { createServer } from 'http';

/**
 * Fake Ardour MCP HTTP server for tests.
 */
export class FakeArdourProcess {
  constructor() {
    this._server = null;
    this._port = null;
    this._toolResponses = new Map();
    this._simulateDelay = 0;
    this._simulateCrash = false;
    this._simulateTimeout = false;
    this._requestCount = 0;
  }

  setToolResponse(tool, structuredContent) {
    this._toolResponses.set(tool, structuredContent);
  }

  simulateDelay(ms) { this._simulateDelay = ms; }
  simulateCrash() { this._simulateCrash = true; }
  simulateTimeout(enabled = true) { this._simulateTimeout = enabled; }

  get requestCount() { return this._requestCount; }

  async start(port) {
    this._port = port;
    return new Promise((resolve, reject) => {
      this._server = createServer(async (req, res) => {
        this._requestCount++;
        if (this._simulateTimeout) return; // never respond
        if (this._simulateDelay) {
          await new Promise(r => setTimeout(r, this._simulateDelay));
        }
        if (this._simulateCrash) {
          req.socket.destroy();
          return;
        }
        let body = '';
        req.on('data', c => body += c.toString());
        req.on('end', () => {
          try {
            const msg = JSON.parse(body);
            const toolName = msg.params?.name || '';
            const structured = this._toolResponses.get(toolName) ?? { ok: true };
            const result = {
              jsonrpc: '2.0',
              id: msg.id ?? null,
              result: {
                content: [{ type: 'text', text: JSON.stringify(structured) }],
                structuredContent: structured,
              },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
      this._server.listen(port, '127.0.0.1', () => resolve());
      this._server.on('error', reject);
    });
  }

  async stop() {
    if (this._server) {
      return new Promise(resolve => this._server.close(resolve));
    }
  }
}
