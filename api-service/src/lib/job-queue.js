import { config } from '../config.js';

export class JobQueue {
  constructor() {
    this._jobs = new Map();
    this._pending = [];
    this._active = new Set();
    this.onJobReady = null;
  }

  get queueDepth() {
    return this._pending.length;
  }

  get activeCount() {
    return this._active.size;
  }

  addJob(jobId, spec) {
    if (this._pending.length >= config.maxQueueDepth) {
      return { accepted: false, reason: 'queue_full' };
    }

    const job = {
      id: jobId,
      spec,
      status: 'pending',
      progress: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      outputs: null,
      analysis: null,
      error: null,
    };

    this._jobs.set(jobId, job);
    this._pending.push(jobId);
    this._tryProcessNext();

    return { accepted: true };
  }

  getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  markProcessing(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return;
    job.status = 'processing';
    job.startedAt = Date.now();
    this._active.add(jobId);
  }

  markComplete(jobId, outputs, analysis) {
    const job = this._jobs.get(jobId);
    if (!job) return;
    job.status = 'complete';
    job.completedAt = Date.now();
    job.outputs = outputs;
    job.analysis = analysis;
    this._active.delete(jobId);
    this._scheduleCleanup(jobId);
    this._tryProcessNext();
  }

  markFailed(jobId, error) {
    const job = this._jobs.get(jobId);
    if (!job) return;
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = typeof error === 'string' ? error : error.message || String(error);
    this._active.delete(jobId);
    this._scheduleCleanup(jobId);
    this._tryProcessNext();
  }

  _tryProcessNext() {
    while (
      this._active.size < config.maxConcurrentJobs &&
      this._pending.length > 0
    ) {
      const jobId = this._pending.shift();
      const job = this._jobs.get(jobId);
      if (!job) continue;

      this.markProcessing(jobId);

      if (this.onJobReady) {
        this.onJobReady(jobId, job.spec);
      }
    }
  }

  _scheduleCleanup(jobId) {
    setTimeout(() => {
      this._jobs.delete(jobId);
    }, config.outputTtlMs);
  }
}
