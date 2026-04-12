export async function healthRoutes(app) {
  app.get('/health', async () => {
    const queue = app.jobQueue;
    const sm = app.sessionManager;
    return {
      status: 'ok',
      queue_depth: queue ? queue.queueDepth : 0,
      active_jobs: queue ? queue.activeCount : 0,
      sessions: sm ? {
        active: sm.activeCount(),
        max: app.config?.maxConcurrentSessions ?? 0,
      } : { active: 0, max: 0 },
    };
  });
}
