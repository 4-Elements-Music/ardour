import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from './job-queue.js';

describe('JobQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new JobQueue();
  });

  it('accepts and stores a job', () => {
    const result = queue.addJob('job-1', { test: true });
    assert.equal(result.accepted, true);

    const job = queue.getJob('job-1');
    assert.equal(job.id, 'job-1');
    assert.equal(job.status, 'processing'); // auto-processed since maxConcurrent >= 1
    assert.deepEqual(job.spec, { test: true });
  });

  it('returns null for unknown job', () => {
    assert.equal(queue.getJob('nonexistent'), null);
  });

  it('tracks queue depth and active count', () => {
    assert.equal(queue.queueDepth, 0);
    assert.equal(queue.activeCount, 0);

    queue.addJob('job-1', {});
    // Job is immediately processing (active), not pending
    assert.equal(queue.activeCount, 1);
  });

  it('marks a job as complete', () => {
    queue.addJob('job-1', {});
    const outputs = [{ filename: 'output.wav', size: 1024 }];
    queue.markComplete('job-1', outputs, null);

    const job = queue.getJob('job-1');
    assert.equal(job.status, 'complete');
    assert.deepEqual(job.outputs, outputs);
    assert.ok(job.completedAt);
  });

  it('marks a job as failed', () => {
    queue.addJob('job-1', {});
    queue.markFailed('job-1', 'something broke');

    const job = queue.getJob('job-1');
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'something broke');
  });

  it('handles error objects in markFailed', () => {
    queue.addJob('job-1', {});
    queue.markFailed('job-1', new Error('boom'));

    const job = queue.getJob('job-1');
    assert.equal(job.error, 'boom');
  });

  it('fires onJobReady callback', () => {
    const readyJobs = [];
    queue.onJobReady = (id) => readyJobs.push(id);
    queue.addJob('job-1', {});
    assert.deepEqual(readyJobs, ['job-1']);
  });

  it('rejects jobs when queue is full', () => {
    // maxConcurrentJobs=1, maxQueueDepth=10
    // First job goes to active, next 10 fill pending to capacity, 12th is rejected
    for (let i = 0; i < 11; i++) {
      queue.addJob(`job-${i}`, {});
    }
    const result = queue.addJob('job-overflow', {});
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'queue_full');
  });
});
