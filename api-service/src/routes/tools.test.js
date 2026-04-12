import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { toolRoutes } from './tools.js';

describe('GET /v1/tools', () => {
  it('returns tool catalog with categories', async () => {
    const app = Fastify({ logger: false });
    app.register(toolRoutes, { prefix: '/v1' });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/tools' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.length > 0);
    assert.ok(Array.isArray(body.categories));
    for (const t of body.tools) {
      assert.ok(t.name);
      assert.ok(t.category);
      assert.ok(t.input_schema);
    }
    await app.close();
  });
});
