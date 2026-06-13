import './logger';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import redis from './redis';
import { loadScripts } from './scripts';
import { Queue } from './Queue';
import { Worker } from './Worker';
import { Scheduler } from './Scheduler';
import { createQueueRouter } from './api';
import { registerShutdownHandlers } from './shutdown';
import { HEARTBEAT_INTERVAL_MS, STALL_THRESHOLD_MS, QUEUE_DEFAULT_CONCURRENCY, SCHEDULER_POLL_MS, REDIS_URL } from './config';
import * as path from 'path';
import * as fs from 'fs';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DISABLE_WORKERS = process.env.DISABLE_WORKERS === 'true';
const DISABLE_API = process.env.DISABLE_API === 'true';
const DISABLE_SCHEDULER = process.env.DISABLE_SCHEDULER === 'true';

async function main() {
  // Step 1: Load all Lua scripts into Redis
  await loadScripts(redis);
  console.log('✅ Lua scripts loaded.');

  // Create a dedicated Redis client for Pub/Sub
  const subRedis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null
  });

  // Step 2: Register your queues here
  const queues: Record<string, Queue> = {
    'emails':       new Queue('emails', redis),
    'notifications': new Queue('notifications', redis),
    'reports':      new Queue('reports', redis),
  };

  // Step 3: Example workers (only if not disabled)
  const workers: Worker[] = [];
  if (!DISABLE_WORKERS) {
    const emailWorker = new Worker('emails', async (job) => {
      // Phase 36 test: random duration so p50/p95/p99 are meaningfully different
      const delay = Math.floor(Math.random() * 1950) + 50; // 50ms – 2000ms
      console.log(`[Worker ${process.env.HOSTNAME || 'local'}] Processing: ${job.name} (simulated ${delay}ms)`, job.data);
      await new Promise(r => setTimeout(r, delay));
    }, redis, { concurrency: Math.max(QUEUE_DEFAULT_CONCURRENCY, 3), heartbeatInterval: HEARTBEAT_INTERVAL_MS });

    const multiWorker = new Worker(
      ['notifications', 'reports'],
      async (job) => {
        console.log(`[Worker ${process.env.HOSTNAME || 'local'}] Processing [${job.queueName}]: ${job.name}`);
        await new Promise(r => setTimeout(r, 200));
      },
      redis,
      { concurrency: Math.max(QUEUE_DEFAULT_CONCURRENCY, 2), heartbeatInterval: HEARTBEAT_INTERVAL_MS }
    );

    await emailWorker.start();
    await multiWorker.start();
    workers.push(emailWorker, multiWorker);
    console.log('✅ Workers started.');
  } else {
    console.log('ℹ️ Workers disabled via env.');
  }

  // Step 4: Start auto-cleanup/watchdog on all queues
  Object.values(queues).forEach(q => {
    q.startCleanup({ maxCount: 500, maxAge: 24 * 60 * 60 * 1000, intervalMs: 60_000 });
    // Check twice per stall window; a job is stalled after STALL_THRESHOLD_MS without a heartbeat
    q.startWatchdog(Math.max(1000, Math.floor(STALL_THRESHOLD_MS / 2)), STALL_THRESHOLD_MS);
  });

  // Step 4b: Start Scheduler for cron/repeatable jobs (only if not disabled)
  let scheduler: Scheduler | undefined;
  if (!DISABLE_SCHEDULER) {
    scheduler = new Scheduler(redis, Object.values(queues), SCHEDULER_POLL_MS);
    scheduler.start();

    // Register a sample repeatable job — runs every 10 seconds (for testing)
    await queues['reports'].addRepeatable(
      'daily-summary',
      { type: 'summary', time: 'auto' },
      '*/10 * * * * *',
      { attempts: 2, priority: 'normal' }
    );
    console.log('✅ Scheduler started.');
  }

  if (!DISABLE_API) {
    // Step 5: Build Express & Socket.IO app
    const app = express();
    const httpServer = createServer(app);
    const io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*", 
        methods: ["GET", "POST"]
      }
    });

    app.use(express.json());

    // Mount the queue API under /api
    const apiRouter = createQueueRouter(queues, redis);
    app.use('/api', apiRouter);

    // Same payload as /api/health — used by the Docker HEALTHCHECK.
    // Must be registered before the dashboard fallback below, which answers every other GET.
    app.get('/health', (req, res, next) => {
      req.url = '/health';
      apiRouter(req, res, next);
    });

    // Serve dashboard static files if they exist
    const dashboardPath = path.join(__dirname, '../dashboard/dist');
    if (fs.existsSync(dashboardPath)) {
      app.use(express.static(dashboardPath));
      app.use((req, res, next) => {
        if (req.path.startsWith('/api') || req.method !== 'GET') return next();
        res.sendFile(path.join(dashboardPath, 'index.html'));
      });
      console.log(`✅ Serving dashboard from ${dashboardPath}`);
    }

    // Root welcome route
    app.get('/', (_req, res) => {
      res.json({
        name: 'AtomicQ',
        version: '1.0.0',
        docs: 'GET /health | GET /api/queues | GET /api/queues/:name/metrics',
      });
    });

    // Socket.IO Connection Logic
    io.on('connection', (socket) => {
      console.log(`📡 Dashboard client connected: ${socket.id}`);
      socket.on('disconnect', () => console.log(`🔌 Dashboard client disconnected: ${socket.id}`));
    });

    // Step 6: Relay Redis events to Socket.IO
    const channels = Object.keys(queues).map(name => `queue:${name}:events`);
    if (channels.length > 0) {
      await subRedis.subscribe(...channels);
      subRedis.on('message', (channel, message) => {
        try {
          const data = JSON.parse(message);
          io.emit('job-event', { ...data, channel });
        } catch (e) {
          console.error('Failed to parse Redis event message', e);
        }
      });
      console.log(`📢 Subscribed to events for: ${Object.keys(queues).join(', ')}`);
    }

    // Global error handler
    app.use((err: any, _req: any, res: any, _next: any) => {
      console.error('API Error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    });

    httpServer.listen(PORT, () => {
      console.log(`\n🚀 AtomicQ Dashboard + Real-time Socket Server running at http://localhost:${PORT}`);
      console.log(`   Health:  http://localhost:${PORT}/api/health`);
      console.log(`   Queues:  http://localhost:${PORT}/api/queues`);
    });

    // ── Graceful shutdown (SIGTERM + SIGINT) ──────────────────────────────────
    registerShutdownHandlers({
      workers,
      queues:       Object.values(queues),
      redisClients: [redis, subRedis],
      httpServer,
      scheduler,
      drainTimeoutMs: 30_000,
    });
  } else {
    console.log('ℹ️ API disabled via env.');
    
    // Add HTTP health endpoint on a random port for worker
    const workerServer = require('http').createServer((req: any, res: any) => {
      if (req.url === '/health') {
        const isRedisConnected = redis.status === 'ready' || redis.status === 'connect';
        if (!isRedisConnected) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'unhealthy', redisConnected: false }));
          return;
        }

        const activeJobs = workers.reduce((acc, w) => acc + w.getActiveCount(), 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pid: process.pid, activeJobs, uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    workerServer.listen(0, () => {
      const addr = workerServer.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      console.log(`⚕️  Worker health endpoint listening on random port ${port}`);
      try {
        fs.writeFileSync('/tmp/health_port', String(port));
      } catch (e) {
        console.error('Failed to write random port to /tmp/health_port');
      }
    });

    // If no API, we still need shutdown handlers for workers/scheduler
    registerShutdownHandlers({
      workers,
      queues:       Object.values(queues),
      redisClients: [redis, subRedis],
      scheduler,
      drainTimeoutMs: 30_000,
    });
  }
}

main().catch(err => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
