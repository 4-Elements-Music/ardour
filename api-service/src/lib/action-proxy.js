import Ajv from 'ajv';

// Mirrors components/ardour/libs/surfaces/mcp_http/mcp_http_server.cc canonical_tool_name.
// The C++ canonicalizer only replaces the FIRST underscore that follows a known group
// prefix; a global s/_/// turns multi-underscore names like `audio_region_stretch`
// into the wrong shape (`audio/region/stretch` instead of `audio_region/stretch`).
const KNOWN_GROUPS = [
  'session', 'transport', 'markers', 'tracks', 'buses',
  'track', 'region', 'plugin', 'midi_region', 'midi_note', 'audio_region',
];

function canonicalSlashForm(name) {
  if (name.includes('/')) return null;
  for (const group of KNOWN_GROUPS) {
    const prefix = group + '_';
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return group + '/' + name.slice(prefix.length);
    }
  }
  return null;
}

/**
 * ActionProxy — validates MCP tool calls against schemas, forwards them to
 * the correct Ardour MCP HTTP endpoint via the session's action queue.
 */
export class ActionProxy {
  constructor({ toolSchemas, httpClient, config }) {
    if (!toolSchemas) throw new Error('toolSchemas required');
    if (!httpClient) throw new Error('httpClient required');
    if (!config) throw new Error('config required');
    this._httpClient = httpClient;
    this._config = config;
    this._validators = new Map();

    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of toolSchemas.tools || []) {
      // MCP HTTP accepts slash, underscore, and dot forms. Register all variants.
      const name = tool.name;
      const variants = [name];
      if (name.includes('/')) {
        variants.push(name.replace(/\//g, '_'), name.replace(/\//g, '.'));
      } else if (name.includes('_')) {
        const slash = canonicalSlashForm(name);
        if (slash) {
          variants.push(slash, slash.replace(/\//g, '.'));
        }
      }
      const validator = tool.inputSchema ? ajv.compile(tool.inputSchema) : () => true;
      for (const v of variants) {
        this._validators.set(v, { tool: name, validator });
      }
    }
  }

  _validate(tool, params) {
    const entry = this._validators.get(tool);
    if (!entry) {
      const err = new Error(`UNKNOWN_TOOL: ${tool}`);
      err.code = 'UNKNOWN_TOOL';
      throw err;
    }
    if (params == null) params = {};
    if (!entry.validator(params)) {
      const err = new Error(`INVALID_PARAMS for ${tool}`);
      err.code = 'INVALID_PARAMS';
      err.details = entry.validator.errors;
      throw err;
    }
    return entry.tool;
  }

  async _proxyCall(session, tool, params, requestId = null) {
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: params || {} },
      id: 1,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._config.actionTimeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (requestId) headers['x-request-id'] = requestId;
    try {
      const res = await this._httpClient(session.mcpBaseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`UPSTREAM_DOWN: HTTP ${res.status}`);
        err.code = 'UPSTREAM_DOWN';
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        const te = new Error('UPSTREAM_TIMEOUT');
        te.code = 'UPSTREAM_TIMEOUT';
        throw te;
      }
      if (!e.code) {
        const ue = new Error(`UPSTREAM_DOWN: ${e.message || 'Upstream unreachable'}`);
        ue.code = 'UPSTREAM_DOWN';
        throw ue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(session, tool, params, requestId = null) {
    const canonical = this._validate(tool, params);
    const task = () => this._proxyCall(session, canonical, params, requestId);
    const queuePromise = session.actionQueue.add(task);

    // Wrap with queue wait timeout
    const timer = new Promise((_, reject) => setTimeout(() => {
      const err = new Error('QUEUE_TIMEOUT');
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, this._config.actionQueueTimeoutMs));

    const result = await Promise.race([queuePromise, timer]);
    session.lastActivity = Date.now();
    return result;
  }

  async executeBatch(session, actions, { stopOnError = true, timeoutMs = 60000 } = {}) {
    if (!Array.isArray(actions)) {
      const err = new Error('INVALID_PARAMS: actions must be an array');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    const maxSize = this._config.maxBatchSize || 100;
    if (actions.length > maxSize) {
      const err = new Error(`BATCH_TOO_LARGE: ${actions.length} > ${maxSize}`);
      err.code = 'BATCH_TOO_LARGE';
      err.max = maxSize;
      throw err;
    }

    // All actions occupy one queue slot
    const batchTask = async () => {
      const results = new Array(actions.length).fill(null);
      const deadline = Date.now() + timeoutMs;
      let completed = 0;
      let timedOut = false;

      for (let i = 0; i < actions.length; i++) {
        if (Date.now() >= deadline) { timedOut = true; break; }
        const { tool, params } = actions[i];
        try {
          const canonical = this._validate(tool, params);
          const resp = await this._proxyCall(session, canonical, params);
          results[i] = { tool, success: true, result: resp.result ?? resp };
          completed++;
        } catch (e) {
          results[i] = { tool, success: false, error: e.message, error_code: e.code };
          if (stopOnError) break;
        }
      }
      return { results, completed, total: actions.length, timed_out: timedOut };
    };

    const queuePromise = session.actionQueue.add(batchTask);
    const timer = new Promise((_, reject) => setTimeout(() => {
      const err = new Error('QUEUE_TIMEOUT');
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, this._config.actionQueueTimeoutMs));

    const result = await Promise.race([queuePromise, timer]);
    session.lastActivity = Date.now();
    return result;
  }
}
