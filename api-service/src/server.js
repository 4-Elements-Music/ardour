import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes, queue } from './routes/jobs.js';
import { pluginRoutes } from './routes/plugins.js';
import { sessionRoutes } from './routes/sessions.js';
import { toolRoutes } from './routes/tools.js';
import { SessionManager } from './lib/session-manager.js';
import { ActionProxy } from './lib/action-proxy.js';
import { PortPool } from './lib/port-pool.js';
import { TimeoutReaper } from './lib/timeout-reaper.js';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: config.maxJobSpecBytes,
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
  forceCloseConnections: 'idle',
});

// Load MCP tool schemas
const toolSchemasPath = resolve(__dirname, 'schemas/mcp-tools.json');
let toolSchemas = { tools: [] };
if (existsSync(toolSchemasPath)) {
  toolSchemas = JSON.parse(readFileSync(toolSchemasPath, 'utf8'));
} else {
  app.log.warn('mcp-tools.json not found — run `npm run extract-tools`');
}

// Compose session subsystem
const portPool = new PortPool({ start: config.mcpPortRangeStart, end: config.mcpPortRangeEnd });
await portPool.scan();
app.log.info({ freePorts: portPool.availableCount() }, 'port pool scanned');

const sessionManager = new SessionManager({
  config,
  portPool,
  spawner: spawn,
  httpClient: globalThis.fetch,
});

const actionProxy = new ActionProxy({ toolSchemas, httpClient: globalThis.fetch, config });

const reaper = new TimeoutReaper({
  sessionManager,
  config,
  saveSession: async (s) => {
    try {
      await actionProxy.execute(s, 'session/save', {});
    } catch {}
  },
});
reaper.start(60000);

// Decorators
app.decorate('jobQueue', queue);
app.decorate('sessionManager', sessionManager);
app.decorate('actionProxy', actionProxy);
app.decorate('config', config);

// Register plugins
await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes } });
await app.register(fastifyStatic, { root: resolve(__dirname, '../public'), prefix: '/' });

// Routes
app.register(healthRoutes, { prefix: '/v1' });
app.register(jobRoutes, { prefix: '/v1' });
app.register(pluginRoutes, { prefix: '/v1' });
app.register(sessionRoutes, { prefix: '/v1' });
app.register(toolRoutes, { prefix: '/v1' });

// Graceful shutdown
app.addHook('onClose', async () => {
  reaper.stop();
  for (const s of sessionManager.listAll()) {
    try { await sessionManager.destroy(s.id, { timeoutMs: 5000 }); } catch {}
  }
});

const shutdown = () => {
  app.log.info('shutting down');
  app.close().then(() => process.exit(0)).catch((err) => {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
