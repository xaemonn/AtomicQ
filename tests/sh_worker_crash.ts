import Redis from 'ioredis';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';

// Spawned by concurrency.test.ts: picks up one job from an existing queue and
// kills the process mid-job, leaving the job locked in `active`.
const QUEUE = process.env.CRASH_QUEUE || 'crash-test';
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
  await loadScripts(redis);

  const worker = new Worker(
    QUEUE,
    async () => {
      console.log('[worker] JOB STARTED');
      // Let stdout flush, then die without completing, failing or shutting down
      await new Promise(r => setTimeout(r, 200));
      process.exit(1);
    },
    redis,
    { concurrency: 1, pollInterval: 100 }
  );

  await worker.start();
}
main().catch(err => { console.error(err); process.exit(2); });
