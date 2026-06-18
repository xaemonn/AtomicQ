import Redis from 'ioredis';
import { Queue }  from '../src/Queue';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';
import { registerShutdownHandlers } from '../src/shutdown';

const QUEUE = 'shutdown-test-slow';
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
  await loadScripts(redis);
  const stale = await redis.keys('queue:' + QUEUE + ':*');
  if (stale.length > 0) await redis.del(...stale);

  const queue  = new Queue(QUEUE, redis);
  const worker = new Worker(
    QUEUE,
    async () => {
      console.log('[worker] job started (5s delay)');
      await new Promise(r => setTimeout(r, 5_000));
      console.log('[worker] job DONE');
    },
    redis,
    { concurrency: 1, pollInterval: 100 }
  );

  await worker.start();
  await queue.add('slow-job', {});

  registerShutdownHandlers({
    workers: [worker],
    redisClients: [redis],
    drainTimeoutMs: 30_000,
  });

  worker.once('active', () => {
    console.log('READY');
    setTimeout(() => {
      console.log('[test-worker] Emitting SIGTERM natively');
      process.emit('SIGTERM' as any);
    }, 500);
  });
}
main().catch(err => { console.error(err); process.exit(1); });
