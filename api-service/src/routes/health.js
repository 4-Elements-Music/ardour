export async function healthRoutes(app) {
  app.get('/health', async () => {
    // queue is registered by jobRoutes on the same app instance
    const queue = app.jobQueue;
    return {
      status: 'ok',
      queue_depth: queue ? queue.queueDepth : 0,
      active_jobs: queue ? queue.activeCount : 0,
    };
  });
}
