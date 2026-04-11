import Fastify from 'fastify';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  bodyLimit: config.maxJobSpecBytes,
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
});

app.register(healthRoutes, { prefix: '/v1' });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
