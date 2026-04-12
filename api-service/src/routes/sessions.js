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

  // POST /v1/sessions/:id/actions
  app.post('/sessions/:id/actions', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping' || s.status === 'stopped' || s.status === 'dead') {
      return reply.code(409).send({ error_code: 'SESSION_STOPPING', status: s.status });
    }
    if (s.status !== 'ready') {
      return reply.code(409).send({ error_code: 'NOT_READY', status: s.status });
    }
    const { tool, params } = req.body || {};
    if (!tool) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'tool required' });
    try {
      const result = await app.actionProxy.execute(s, tool, params, req.id);
      return result.result ?? result;
    } catch (e) {
      return mapProxyError(reply, e);
    }
  });

  // POST /v1/sessions/:id/actions/batch
  app.post('/sessions/:id/actions/batch', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status !== 'ready') {
      return reply.code(409).send({ error_code: 'NOT_READY', status: s.status });
    }
    const { actions, stop_on_error = true, timeout_ms = 60000 } = req.body || {};
    if (!Array.isArray(actions)) {
      return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'actions must be an array' });
    }
    try {
      const out = await app.actionProxy.executeBatch(s, actions, {
        stopOnError: stop_on_error,
        timeoutMs: timeout_ms,
      });
      return out;
    } catch (e) {
      return mapProxyError(reply, e);
    }
  });

  // GET /v1/sessions/:id/logs?since=<cursor>
  app.get('/sessions/:id/logs', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    const since = req.query.since ?? 0;
    const { lines, cursor } = s.logBuffer.since(since);
    return { lines, cursor: String(cursor) };
  });

  // POST /v1/sessions/:id/upload
  app.post('/sessions/:id/upload', async (req, reply) => {
    const s = app.sessionManager.get(req.params.id);
    if (!s) return reply.code(404).send({ error_code: 'NOT_FOUND' });
    if (s.status === 'stopping' || s.status === 'stopped' || s.status === 'dead') {
      return reply.code(409).send({ error_code: 'SESSION_STOPPING', status: s.status });
    }

    const data = await req.file();
    if (!data) return reply.code(400).send({ error_code: 'INVALID_PARAMS', error: 'file required' });

    const rawName = data.filename || 'upload.bin';
    const sanitized = sanitizeUploadFilename(rawName);
    if (!sanitized) {
      return reply.code(400).send({ error_code: 'INVALID_FILENAME', error: 'filename contains path separators or is hidden' });
    }
    const allowedExts = /\.(wav|flac|aiff|ogg|mp3|mid|midi|sf2|sfz)$/i;
    if (!allowedExts.test(sanitized)) {
      return reply.code(400).send({ error_code: 'INVALID_FILE_TYPE', error: 'extension not allowed' });
    }

    const { mkdir, stat, writeFile } = await import('fs/promises');
    const { resolve: resolvePath, relative } = await import('path');
    const uploadsDir = resolvePath(s.sessionDir, 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const destPath = resolvePath(uploadsDir, sanitized);
    // Re-verify path is within uploadsDir
    const rel = relative(uploadsDir, destPath);
    if (rel.startsWith('..') || rel.includes('/')) {
      return reply.code(400).send({ error_code: 'INVALID_FILENAME' });
    }
    try {
      await stat(destPath);
      return reply.code(409).send({ error_code: 'FILE_EXISTS', filename: sanitized });
    } catch {}

    // Read the stream with size check
    const chunks = [];
    let size = 0;
    for await (const chunk of data.file) {
      size += chunk.length;
      if (size > app.config.maxUploadBytes) {
        return reply.code(413).send({ error_code: 'FILE_TOO_LARGE', max: app.config.maxUploadBytes });
      }
      if (s.uploadBytesUsed + size > app.config.maxSessionUploadBytes) {
        return reply.code(413).send({ error_code: 'SESSION_UPLOAD_QUOTA', max: app.config.maxSessionUploadBytes });
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    await writeFile(destPath, buf);
    s.uploadBytesUsed += size;

    return reply.code(200).send({
      path: destPath,
      filename: sanitized,
      size,
    });
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

function mapProxyError(reply, e) {
  if (e.code === 'UNKNOWN_TOOL') return reply.code(400).send({ error_code: 'UNKNOWN_TOOL', tool: e.message });
  if (e.code === 'INVALID_PARAMS') return reply.code(400).send({ error_code: 'INVALID_PARAMS', details: e.details });
  if (e.code === 'BATCH_TOO_LARGE') return reply.code(400).send({ error_code: 'BATCH_TOO_LARGE', max: e.max });
  if (e.code === 'QUEUE_FULL') return reply.code(429).send({ error_code: 'QUEUE_FULL' });
  if (e.code === 'QUEUE_TIMEOUT') return reply.code(504).send({ error_code: 'QUEUE_TIMEOUT' });
  if (e.code === 'UPSTREAM_DOWN') return reply.code(502).send({ error_code: 'UPSTREAM_DOWN' });
  if (e.code === 'UPSTREAM_TIMEOUT') return reply.code(504).send({ error_code: 'UPSTREAM_TIMEOUT' });
  return reply.code(500).send({ error_code: 'INTERNAL', error: e.message });
}

function sanitizeUploadFilename(name) {
  if (!name) return null;
  if (name.startsWith('.')) return null;
  const basename = String(name).replace(/[\/\\]/g, '_').replace(/\0/g, '');
  if (basename.length > 255) return null;
  return basename;
}
