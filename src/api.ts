import { Router, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { Queue } from './Queue';
import { CleanupOptions } from './types';
import { WORKER_KEY_PATTERN, completedKey, failedKey, waitingKey } from './keys';

/**
 * Creates an Express router that exposes all queue management endpoints.
 *
 * Usage:
 *   const registry = { emails: new Queue('emails', redis) };
 *   app.use('/api', createQueueRouter(registry));
 */
export function createQueueRouter(registry: Record<string, Queue>, redis: Redis): Router {
  const router = Router();

  // Helpers — cast Express 5 union params to plain strings
  const p = (req: Request, key: string): string => String((req.params as any)[key]);



  function resolveQueue(res: Response, name: string): Queue | null {
    const queue = registry[name];
    if (!queue) {
      res.status(404).json({ error: `Queue '${name}' not found.` });
      return null;
    }
    return queue;
  }

  // ─── GET /queues ──────────────────────────────────────────
  router.get('/queues', (_req: Request, res: Response) => {
    res.json({ queues: Object.keys(registry) });
  });

  // ─── GET /workers ─────────────────────────────────────────
  // Phase 38: Scans all worker hash keys and returns live worker info.
  router.get('/workers', async (_req: Request, res: Response) => {
    try {
      // A worker serving several queues writes one status hash per queue — keep one per worker id
      const workers = new Map<string, Record<string, string>>();
      let cursor = '0';
      // SCAN incrementally to avoid blocking Redis
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', WORKER_KEY_PATTERN, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          const pipeline = redis.pipeline();
          for (const key of keys) pipeline.hgetall(key);
          const results = await pipeline.exec();
          results?.forEach(([err, data]) => {
            if (!err && data && typeof data === 'object') {
              const w = data as Record<string, string>;
              workers.set(w.id || `${w.host}:${w.pid}`, w);
            }
          });
        }
      } while (cursor !== '0');

      res.json({ workers: [...workers.values()] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/metrics ────────────────────────────
  router.get('/queues/:name/metrics', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const metrics = await queue.getMetrics();
      res.json({ queue: name, metrics });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/jobs?status=failed&limit=20 ────────
  router.get('/queues/:name/jobs', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const status = String(req.query.status || 'waiting');
    const start = Math.max(parseInt(String(req.query.start || '0')), 0);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20')), 1), 100);
    const valid = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];

    if (!valid.includes(status)) {
      res.status(400).json({ error: `Invalid status. Use: ${valid.join(', ')}` });
      return;
    }

    try {
      const ids = await queue.getJobsByStatus(status, start, limit);
      const jobs = (await Promise.all(ids.map(id => queue.getJob(id)))).filter(Boolean);
      res.json({ queue: name, status, start, limit, count: jobs.length, jobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/jobs/:id ───────────────────────────
  router.get('/queues/:name/jobs/:id', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const job = await queue.getJob(id);
      if (!job) { res.status(404).json({ error: `Job '${id}' not found.` }); return; }
      res.json({ job });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/jobs ──────────────────────────────
  router.post('/queues/:name/jobs', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const { name: jobName, data, options } = req.body;
    if (!jobName || data === undefined) {
      res.status(400).json({ error: 'Body must include: { name, data, options? }' });
      return;
    }
    try {
      const job = await queue.add(jobName, data, options || {});
      res.status(201).json({ message: 'Job added.', job });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/jobs/:id/retry ────────────────────
  router.post('/queues/:name/jobs/:id/retry', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const ok = await queue.retry(id);
      if (!ok) { res.status(404).json({ error: `Job '${id}' not found in failed set.` }); return; }
      res.json({ message: `Job '${id}' re-queued.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /queues/:name/jobs/completed ───────────────────
  // Phase 37: Clears completed jobs older than 1 hour (default).
  // Must be registered before DELETE /jobs/:id, or Express routes it there with id='completed'.
  router.delete('/queues/:name/jobs/completed', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    const maxAgeMs = req.query.maxAgeMs ? Number(req.query.maxAgeMs) : 60 * 60 * 1000;
    try {
      const count = await queue.clearCompleted(maxAgeMs);
      res.json({ message: `Cleared ${count} completed job(s).`, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /queues/:name/jobs/:id ────────────────────────
  router.delete('/queues/:name/jobs/:id', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const id = p(req, 'id');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const ok = await queue.cancel(id);
      if (!ok) { res.status(404).json({ error: `Job '${id}' could not be cancelled.` }); return; }
      res.json({ message: `Job '${id}' cancelled.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/retry-all ─────────────────────────
  // Phase 37: Re-queues ALL jobs currently in the failed set.
  router.post('/queues/:name/retry-all', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const count = await queue.retryAll();
      res.json({ message: `Re-queued ${count} failed job(s).`, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/pause ──────────────────────────────
  // Phase 37: Pauses the queue — workers stop picking new jobs.
  router.post('/queues/:name/pause', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      await queue.pauseQueue();
      res.json({ message: `Queue '${name}' paused.`, paused: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── DELETE /queues/:name/pause ────────────────────────────
  // Phase 37: Resumes the queue.
  router.delete('/queues/:name/pause', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      await queue.resumeQueue();
      res.json({ message: `Queue '${name}' resumed.`, paused: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/pause ───────────────────────────────
  // Phase 37: Returns whether the queue is currently paused.
  router.get('/queues/:name/pause', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const paused = await queue.isPaused();
      res.json({ queue: name, paused });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/repeatables ─────────────────────────
  // Lists the cron (repeatable) job definitions registered on the queue.
  router.get('/queues/:name/repeatables', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;
    try {
      const repeatables = await queue.getRepeatableJobs();
      res.json({ queue: name, repeatables });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /queues/:name/cleanup ───────────────────────────

  router.post('/queues/:name/cleanup', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    const options: CleanupOptions = { maxAge: req.body.maxAge, maxCount: req.body.maxCount };
    if (!options.maxAge && !options.maxCount) {
      res.status(400).json({ error: 'Provide maxAge (ms) and/or maxCount.' });
      return;
    }
    try {
      const result = await queue.runCleanup(options);
      const total = result.completed + result.failed + result.cancelled;
      res.json({ message: `Pruned ${total} job(s).`, details: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /queues/:name/throughput ────────────────────────
  // Returns completed and failed job counts per minute for the last 10 minutes.
  // Uses Redis ZCOUNT on the completed/failed sorted sets, slicing by time buckets.
  router.get('/queues/:name/throughput', async (req: Request, res: Response) => {
    const name = p(req, 'name');
    const queue = resolveQueue(res, name);
    if (!queue) return;

    try {
      const ck = completedKey(name);
      const fk = failedKey(name);

      const now = Date.now();
      const MINUTE = 60 * 1000;
      // `timestamp` (bucket end, ms) lets the client label buckets in its own
      // timezone; `time` is the same instant formatted in the server's.
      const buckets: Array<{ time: string; timestamp: number; completed: number; failed: number }> = [];

      // Build 10 one-minute buckets going back from now
      const pipeline = redis.pipeline();
      for (let i = 9; i >= 0; i--) {
        const bucketStart = now - (i + 1) * MINUTE;
        const bucketEnd   = now - i * MINUTE;
        pipeline.zcount(ck, bucketStart, bucketEnd);
        pipeline.zcount(fk, bucketStart, bucketEnd);
      }

      const results = await pipeline.exec();

      for (let i = 9; i >= 0; i--) {
        const idx = (9 - i) * 2;
        const bucketEnd = now - i * MINUTE;
        const label = new Date(bucketEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        buckets.push({
          time: label,
          timestamp: bucketEnd,
          completed: Number(results?.[idx]?.[1] ?? 0),
          failed:    Number(results?.[idx + 1]?.[1] ?? 0),
        });
      }

      res.json({ queue: name, buckets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /health ──────────────────────────────────────────
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      // Check Redis connection
      const isRedisConnected = redis.status === 'ready' || redis.status === 'connect';
      if (!isRedisConnected) {
        return res.status(503).json({ status: 'unhealthy', redisConnected: false });
      }

      // Count active workers via existing cursor loop
      const workerIds = new Set<string>();
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', WORKER_KEY_PATTERN, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) workerIds.add(key.slice(key.indexOf(':workers:') + ':workers:'.length));
      } while (cursor !== '0');

      // Calculate total queue depth
      let queueDepth = 0;
      for (const queueName of Object.keys(registry)) {
        queueDepth += await redis.zcard(waitingKey(queueName));
      }

      res.json({
        status: 'ok',
        redisConnected: true,
        activeWorkers: workerIds.size,
        queueDepth
      });
    } catch (err) {
      console.error('Healthcheck failed:', err);
      res.status(503).json({ status: 'unhealthy', redisConnected: false });
    }
  });

  return router;
}
