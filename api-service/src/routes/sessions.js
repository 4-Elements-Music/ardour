/**
 * Sessions routes — lifecycle (create/list/get/delete).
 *
 * Reads sessionManager, config from Fastify decorators set in server.js.
 */
export async function sessionRoutes(app) {
  // POST /v1/sessions — create session (202 Accepted)
  app.post('/sessions', async (req, reply) => {
    const body = req.body || {};
    const opts = {
      sampleRate: body.sample_rate ?? 48000,
      sessionName: body.session_name ?? null,
      tempo: body.tempo ?? 120,
      timeSignature: body.time_signature ?? { numerator: 4, denominator: 4 },
      gui: !!body.gui,
    };
    try {
      const result = await app.sessionManager.create(opts);
      return reply.code(202).send({
        ...result,
        poll_url: `/v1/sessions/${result.session_id}`,
      });
    } catch (e) {
      if (e.code === 'MAX_SESSIONS') {
        return reply.code(429).send({ error_code: 'MAX_SESSIONS', error: e.message });
      }
      if (e.code === 'NO_PORTS') {
        return reply.code(503).send({ error_code: 'NO_PORTS', error: e.message });
      }
      req.log.error({ err: e }, 'session create failed');
      return reply.code(500).send({ error_code: 'INTERNAL', error: e.message });
    }
  });

  // GET /v1/sessions — list
  app.get('/sessions', async () => {
    const sessions = app.sessionManager.listAll().map(sessionToResponse);
    return {
      sessions,
      capacity: {
        active: app.sessionManager.activeCount(),
        max: app.config.maxConcurrentSessions,
      },
    };
  });

  // GET /v1/sessions/:id
  app.get('/sessions/:id', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    return sessionToResponse(s);
  });

  // DELETE /v1/sessions/:id
  app.delete('/sessions/:id', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping') {
      return reply.code(200).send({ status: 'stopping' });
    }
    await app.sessionManager.destroy(req.params.id);
    return reply.code(200).send({ status: 'stopped' });
  });
}

function sessionToResponse(s) {
  const out = {
    session_id: s.id,
    status: s.status,
    session_name: s.sessionName,
    sample_rate: s.sampleRate,
    created_at: new Date(s.createdAt).toISOString(),
    last_activity: new Date(s.lastActivity).toISOString(),
    uptime_seconds: Math.floor((Date.now() - s.createdAt) / 1000),
  };
  if (s.status === 'dead') {
    out.exit_code = s.exitCode;
    out.stderr_tail = s.stderrTail;
  }
  return out;
}
