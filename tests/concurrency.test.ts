/**
 * Phase 40 — Integration Tests: Concurrency Safety
 *
 * Several workers, each on its own Redis connection (as separate processes
 * would be), compete for the same queue.
 *
 * What is tested:
 *  - 3 workers × concurrency 2 over 100 jobs → every job runs exactly once
 *  - A worker process that dies mid-job → watchdog recovers it → job completes
 *  - 50 delayed jobs coming due together → promoted and run without duplicates
 */

import { spawn } from 'child_process';
import * as path from 'path';
import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';
import { Job } from '../src/types';
import { activeKey } from '../src/keys';
import { setupRedisContainer, teardownRedisContainer, TestContext } from './test-helper';

const ROOT = path.resolve(__dirname, '..');
const TEST_QUEUE = 'test-concurrency';
const WAIT_TIMEOUT = 30_000;
// Plain keys the processors write to, to prove how often each job ran
const COUNTER_KEY = 'test:concurrency:counter';
const RUNS_KEY = 'test:concurrency:runs';

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT,
  label = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

let context: TestContext;
let queue: Queue;
const workers: Worker[] = [];
const connections: Redis[] = [];

/** Starts `count` workers, each with a dedicated connection like a separate process. */
async function startWorkers(count: number, concurrency: number, processor: (job: Job) => Promise<void>): Promise<void> {
  for (let i = 0; i < count; i++) {
    const redis = context.redis.duplicate();
    await loadScripts(redis);
    connections.push(redis);
    const worker = new Worker(TEST_QUEUE, processor, redis, { concurrency, pollInterval: 50 });
    workers.push(worker);
    await worker.start();
  }
}

/** Counts one run of `job` — both in total and per job id. */
async function recordRun(job: Job): Promise<void> {
  await context.redis.incr(COUNTER_KEY);
  await context.redis.hincrby(RUNS_KEY, job.id, 1);
}

beforeAll(async () => {
  context = await setupRedisContainer();
}, 60000);

afterAll(async () => {
  await teardownRedisContainer(context);
});

beforeEach(async () => {
  await context.redis.flushdb();
  queue = new Queue(TEST_QUEUE, context.redis);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map(w => w.stop(5_000)));
  connections.splice(0).forEach(r => r.disconnect());
});

describe('Concurrent workers', () => {
  it('3 workers × concurrency 2 process 100 jobs exactly once each', async () => {
    const jobs = await queue.addBulk(
      Array.from({ length: 100 }, (_, i) => ({ name: 'count', data: { i } }))
    );

    await startWorkers(3, 2, async (job) => {
      await recordRun(job);
      // Yield so the workers genuinely interleave
      await new Promise(r => setTimeout(r, 5));
    });

    await waitFor(async () => (await queue.getMetrics()).completed === 100, WAIT_TIMEOUT, '100 completed');

    // Any value other than 100 means a job was lost or run twice
    expect(await context.redis.get(COUNTER_KEY)).toBe('100');
    const runs = await context.redis.hgetall(RUNS_KEY);
    expect(Object.keys(runs).sort()).toEqual(jobs.map(j => j.id).sort());
    expect(Object.values(runs).every(n => n === '1')).toBe(true);

    const m = await queue.getMetrics();
    expect(m.waiting).toBe(0);
    expect(m.active).toBe(0);
    expect(m.failed).toBe(0);
  }, 60000);
});

describe('Worker crash recovery', () => {
  /** Runs tests/sh_worker_crash.ts, whose worker kills its process mid-job. */
  function runCrashingWorker(): Promise<{ exitCode: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['ts-node', 'tests/sh_worker_crash.ts'], {
        cwd: ROOT,
        env: {
          ...process.env,
          REDIS_URL: `redis://${context.container.getHost()}:${context.container.getMappedPort(6379)}`,
          CRASH_QUEUE: TEST_QUEUE,
        },
        shell: true,
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('close', (code) => resolve({ exitCode: code, stdout }));
    });
  }

  it('a job abandoned by a crashed worker is recovered by the watchdog and completes', async () => {
    const job = await queue.add('fragile', {}, { attempts: 3 });

    const crashed = await runCrashingWorker();
    expect(crashed.stdout).toContain('JOB STARTED');
    expect(crashed.exitCode).toBe(1);

    // The dead worker still holds the job: locked in `active`, never completed
    expect(await context.redis.hexists(activeKey(TEST_QUEUE), job.id)).toBe(1);
    expect((await queue.getJob(job.id))?.status).toBe('ACTIVE');

    // No heartbeat arrives; once it is older than the stall timeout the watchdog takes the job back
    await new Promise(r => setTimeout(r, 300));
    expect(await queue.checkStalled(200)).toEqual([job.id]);
    expect((await queue.getJob(job.id))?.status).toBe('WAITING');

    await startWorkers(1, 1, recordRun);
    await waitFor(async () => (await queue.getMetrics()).completed === 1, WAIT_TIMEOUT, 'recovered job completed');

    const recovered = await queue.getJob(job.id);
    expect(recovered?.status).toBe('COMPLETED');
    expect(recovered?.attempts).toBe(1); // the crash counted as one failed attempt
    expect(await context.redis.get(COUNTER_KEY)).toBe('1');
  }, 60000);
});

describe('Delayed job promotion', () => {
  it('50 delayed jobs that come due together are each processed once', async () => {
    const jobs = await queue.addBulk(
      Array.from({ length: 50 }, (_, i) => ({ name: 'later', data: { i }, options: { delay: 1000 } }))
    );
    expect((await queue.getMetrics()).delayed).toBe(50);

    // All three workers race to promote the same batch the moment it comes due
    await startWorkers(3, 2, recordRun);
    await waitFor(async () => (await queue.getMetrics()).completed === 50, WAIT_TIMEOUT, '50 completed');

    expect(await context.redis.get(COUNTER_KEY)).toBe('50');
    const runs = await context.redis.hgetall(RUNS_KEY);
    expect(Object.keys(runs)).toHaveLength(jobs.length);
    expect(Object.values(runs).every(n => n === '1')).toBe(true);

    const m = await queue.getMetrics();
    expect(m.delayed).toBe(0);
    expect(m.waiting).toBe(0);
  }, 60000);
});
