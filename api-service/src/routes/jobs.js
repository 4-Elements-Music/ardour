import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';
import { generateLuaScript } from '../lib/lua-generator.js';
import { executeJob, cleanupJob } from '../lib/executor.js';
import { JobQueue } from '../lib/job-queue.js';

const queue = new JobQueue();

queue.onJobReady = async (jobId) => {
  const job = queue.getJob(jobId);
  if (!job) return;

  try {
    const luaScript = generateLuaScript(job.spec, join(config.jobsDir, jobId), config.libraryBaseDir);
    const result = await executeJob(jobId, luaScript, console);
    const outputs = result.outputs.map(o => ({
      format: o.filename.split('.').pop(),
      filename: o.filename,
      url: `/v1/jobs/${jobId}/output/${o.filename}`,
      size: o.size,
    }));
    queue.markComplete(jobId, outputs, null);
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err.message);
    queue.markFailed(jobId, err.message);
  }
};

export async function jobRoutes(app) {
  app.post('/jobs', async (req, reply) => {
    const spec = req.body;
    if (!spec || !spec.session || !spec.tracks) {
      return reply.code(400).send({ error: 'Invalid job spec: missing session or tracks' });
    }
    if ((spec.tracks || []).length > config.maxTracks) {
      return reply.code(413).send({ error: `Too many tracks (max ${config.maxTracks})` });
    }

    const jobId = randomUUID();
    const result = queue.addJob(jobId, spec);
    if (!result.accepted) {
      return reply.code(429).send({ error: 'Queue full, try later' });
    }

    return reply.code(202).send({ job_id: jobId, status: 'pending' });
  });

  app.get('/jobs/:id', async (req, reply) => {
    const job = queue.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    const response = { job_id: job.id, status: job.status, progress: job.progress };
    if (job.status === 'complete') response.outputs = job.outputs;
    if (job.status === 'failed') response.error = job.error;
    return response;
  });

  app.get('/jobs/:id/output/:filename', async (req, reply) => {
    const job = queue.getJob(req.params.id);
    if (!job || job.status !== 'complete') return reply.code(404).send({ error: 'Output not found' });

    const output = job.outputs.find(o => o.filename === req.params.filename);
    if (!output) return reply.code(404).send({ error: 'File not found' });

    const filePath = join(config.jobsDir, req.params.id, 'export', req.params.filename);
    try {
      const s = await stat(filePath);
      const ext = req.params.filename.split('.').pop();
      const mime = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[ext] || 'application/octet-stream';
      reply.header('Content-Type', mime);
      reply.header('Content-Length', s.size);
      reply.header('Content-Disposition', `attachment; filename="${req.params.filename}"`);
      return reply.send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'File not found on disk' });
    }
  });
}

export { queue };
