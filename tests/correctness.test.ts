/**
 * Correctness Tests — regression tests for queue-semantics bugs.
 *
 * What is tested:
 *  - Worker concurrency actually runs N jobs in parallel
 *  - Retry backoff is honoured (failed job waits in `delayed`, not `waiting`)
 *  - Manual retry / stall recovery keep the job's priority score
 *  - cancel() rejects unknown/finished jobs and cleans the delayed set
 *  - Lock tokens: a worker that lost its lock cannot complete the job
 *  - Lifecycle events are published as JSON for the dashboard
 *  - Concurrent schedulers fire each cron occurrence exactly once
 *  - addBulk() enqueues in one round-trip
 *  - DELETE /jobs/completed is not swallowed by DELETE /jobs/:id
 *  - GET /repeatables lists cron definitions
 */

import express from 'express';
import { AddressInfo } from 'net';
import { Queue } from '../src/Queue';
import { Worker } from '../src/Worker';
import { Scheduler } from '../src/Scheduler';
import { createQueueRouter } from '../src/api';
import { Job } from '../src/types';
import { activeKey, channelKey, delayedKey, jobKey, waitingKey } from '../src/keys';
import { setupRedisContainer, teardownRedisContainer, TestContext } from './test-helper';

const TEST_QUEUE = 'test-correctness';
const WAIT_TIMEOUT = 20_000;

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

function makeWorker<T = any>(processor: (job: Job<T>) => Promise<void>, concurrency = 1): Worker<T> {
  const w = new Worker<T>(TEST_QUEUE, processor, context.redis, { concurrency, pollInterval: 100 });
  workers.push(w);
  return w;
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
});

describe('Worker concurrency', () => {
  it('runs up to `concurrency` jobs at the same time', async () => {
    for (let i = 0; i < 6; i++) await queue.add('slow', { i });

    let inFlight = 0;
    let maxInFlight = 0;
    const worker = makeWorker(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 400));
      inFlight--;
    }, 3);
    await worker.start();

    await waitFor(async () => (await queue.getMetrics()).completed === 6, WAIT_TIMEOUT, '6 completed');
    expect(maxInFlight).toBe(3);
  });
});

describe('Retry backoff', () => {
  it('parks a failed job in the delayed set until its backoff elapses', async () => {
    const job = await queue.add('flaky', {}, { attempts: 2, backoff: { type: 'fixed', delay: 1500 } });

    const attemptTimes: number[] = [];
    const worker = makeWorker(async () => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) throw new Error('first attempt fails');
    });
    await worker.start();

    await waitFor(async () => attemptTimes.length === 1, WAIT_TIMEOUT, 'first attempt');
    await waitFor(async () => (await context.redis.zscore(delayedKey(TEST_QUEUE), job.id)) !== null, 2_000, 'job in delayed');
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), job.id)).toBeNull();

    await waitFor(async () => (await queue.getMetrics()).completed === 1, WAIT_TIMEOUT, 'completed after retry');
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(1400);
  });
});

describe('Priority is preserved when a job re-enters `waiting`', () => {
  it('retry() re-queues with the original priority score', async () => {
    const job = await queue.add('important', {}, { priority: 'high', attempts: 1 });
    const worker = makeWorker(async () => { throw new Error('fail'); });
    await worker.start();
    await waitFor(async () => (await queue.getMetrics()).failed === 1, WAIT_TIMEOUT, 'failed');
    await worker.stop();

    expect(await queue.retry(job.id)).toBe(true);
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), job.id)).toBe('1');
  });

  it('retryAll() re-queues with each job\'s priority score', async () => {
    const low = await queue.add('low', {}, { priority: 'low', attempts: 1 });
    const high = await queue.add('high', {}, { priority: 'high', attempts: 1 });
    const worker = makeWorker(async () => { throw new Error('fail'); });
    await worker.start();
    await waitFor(async () => (await queue.getMetrics()).failed === 2, WAIT_TIMEOUT, 'failed');
    await worker.stop();

    expect(await queue.retryAll()).toBe(2);
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), low.id)).toBe('10');
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), high.id)).toBe('1');
  });

  it('stall recovery re-queues with the original priority and status WAITING', async () => {
    const job = await queue.add('stuck', {}, { priority: 'high', attempts: 3 });
    // Simulate a worker that grabbed the job and then died (stale heartbeat)
    await context.redis.zrem(waitingKey(TEST_QUEUE), job.id);
    await context.redis.hset(activeKey(TEST_QUEUE), job.id, String(Date.now() - 120_000));
    await context.redis.hset(jobKey(TEST_QUEUE, job.id), 'status', 'ACTIVE');

    const recovered = await queue.checkStalled(60_000);
    expect(recovered).toEqual([job.id]);
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), job.id)).toBe('1');
    const fetched = await queue.getJob(job.id);
    expect(fetched?.status).toBe('WAITING');
    expect(fetched?.attempts).toBe(1);
  });

  it('stall recovery fails a job that has exhausted its attempts', async () => {
    const job = await queue.add('poison', {}, { attempts: 1 });
    await context.redis.zrem(waitingKey(TEST_QUEUE), job.id);
    await context.redis.hset(activeKey(TEST_QUEUE), job.id, String(Date.now() - 120_000));

    await queue.checkStalled(60_000);
    const fetched = await queue.getJob(job.id);
    expect(fetched?.status).toBe('FAILED');
    expect((await queue.getMetrics()).failed).toBe(1);
    expect(await context.redis.zscore(waitingKey(TEST_QUEUE), job.id)).toBeNull();
  });
});

describe('cancel()', () => {
  it('returns false for an unknown job and does not create a job hash', async () => {
    expect(await queue.cancel('does-not-exist')).toBe(false);
    expect(await context.redis.exists(jobKey(TEST_QUEUE, 'does-not-exist'))).toBe(0);
  });

  it('removes a delayed job from the delayed set', async () => {
    const job = await queue.add('later', {}, { delay: 60_000 });
    expect(await queue.cancel(job.id)).toBe(true);
    expect(await queue.getDelayedJobs()).not.toContain(job.id);
    expect((await queue.getMetrics()).cancelled).toBe(1);
  });

  it('returns false for a job that already completed', async () => {
    const job = await queue.add('done', {});
    const worker = makeWorker(async () => {});
    await worker.start();
    await waitFor(async () => (await queue.getMetrics()).completed === 1, WAIT_TIMEOUT, 'completed');

    expect(await queue.cancel(job.id)).toBe(false);
    expect((await queue.getJob(job.id))?.status).toBe('COMPLETED');
  });

  it('a job cancelled while active is not resurrected as COMPLETED', async () => {
    const job = await queue.add('long', {});
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const worker = makeWorker(async () => { await gate; });
    await worker.start();
    await waitFor(async () => (await queue.getMetrics()).active === 1, WAIT_TIMEOUT, 'active');

    expect(await queue.cancel(job.id)).toBe(true);
    release();
    await new Promise(r => setTimeout(r, 300));

    expect((await queue.getJob(job.id))?.status).toBe('CANCELLED');
    expect((await queue.getMetrics()).completed).toBe(0);
  });
});

describe('Lock tokens', () => {
  it('a worker whose job was stall-recovered cannot complete it; the job runs again', async () => {
    await queue.add('slow', {});
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const lockLost: string[] = [];

    const worker = makeWorker(async () => {
      runs++;
      if (runs === 1) await gate; // first run hangs until we release it
    }, 2);
    worker.on('lock_lost', (j: Job) => lockLost.push(j.id));
    await worker.start();
    await waitFor(async () => runs === 1, WAIT_TIMEOUT, 'first run');

    // Watchdog decides the job is stalled (timeout -1 = everything is stalled)
    await queue.checkStalled(-1);
    await waitFor(async () => runs === 2, WAIT_TIMEOUT, 'second run');
    await waitFor(async () => (await queue.getMetrics()).completed === 1, WAIT_TIMEOUT, 'completed once');

    release(); // stale first run now tries to complete
    await waitFor(async () => lockLost.length === 1, WAIT_TIMEOUT, 'lock_lost event');
    expect((await queue.getMetrics()).completed).toBe(1);
  });
});

describe('Lifecycle events', () => {
  it('publishes JSON job:added / job:active / job:completed events', async () => {
    const sub = context.redis.duplicate();
    const events: any[] = [];
    await sub.subscribe(channelKey(TEST_QUEUE));
    sub.on('message', (_ch, msg) => events.push(JSON.parse(msg)));

    try {
      const job = await queue.add('evt', {});
      const worker = makeWorker(async () => {});
      await worker.start();
      await waitFor(async () => events.some(e => e.event === 'job:completed'), WAIT_TIMEOUT, 'completed event');

      const forJob = events.filter(e => e.jobId === job.id).map(e => e.event);
      expect(forJob).toEqual(['job:added', 'job:active', 'job:completed']);
      expect(events.every(e => e.queueName === TEST_QUEUE)).toBe(true);
    } finally {
      sub.disconnect();
    }
  });
});

describe('Scheduler', () => {
  it('fires a due cron occurrence exactly once across concurrent scheduler instances', async () => {
    await queue.addRepeatable('report', {}, '0 0 * * *');
    // Make the definition due now
    const ck = `queue:${TEST_QUEUE}:cron`;
    const def = JSON.parse((await context.redis.hget(ck, 'report'))!);
    await context.redis.hset(ck, 'report', JSON.stringify({ ...def, nextRunAt: Date.now() - 1000 }));

    const schedulers = Array.from({ length: 5 }, () => new Scheduler(context.redis, [queue]));
    await Promise.all(schedulers.map(s => (s as any).tick()));

    expect(await queue.getWaitingCount()).toBe(1);
    const advanced = JSON.parse((await context.redis.hget(ck, 'report'))!);
    expect(advanced.nextRunAt).toBeGreaterThan(Date.now());
  });
});

describe('Queue.addBulk()', () => {
  it('enqueues many jobs in one round-trip and honours idempotency keys', async () => {
    const jobs = await queue.addBulk([
      { name: 'a', data: { n: 1 } },
      { name: 'b', data: { n: 2 }, options: { priority: 'high' } },
      { name: 'c', data: { n: 3 }, options: { idempotencyKey: 'dup' } },
      { name: 'c', data: { n: 3 }, options: { idempotencyKey: 'dup' } },
    ]);

    expect(jobs).toHaveLength(4);
    expect(jobs[2].id).toBe(jobs[3].id);
    expect(await queue.getWaitingCount()).toBe(3);
    // High priority is first in line
    expect(await context.redis.zrange(waitingKey(TEST_QUEUE), 0, 0)).toEqual([jobs[1].id]);
  });
});

describe('API routing', () => {
  it('DELETE /queues/:name/jobs/completed clears completed jobs instead of cancelling a job named "completed"', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createQueueRouter({ [TEST_QUEUE]: queue }, context.redis));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/queues/${TEST_QUEUE}/jobs/completed?maxAgeMs=0`, { method: 'DELETE' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.count).toBe(0);
      expect(await context.redis.exists(jobKey(TEST_QUEUE, 'completed'))).toBe(0);
    } finally {
      server.close();
    }
  });

  it('GET /queues/:name/repeatables lists the queue\'s cron definitions', async () => {
    await queue.addRepeatable('nightly', { kind: 'report' }, '0 0 * * *', { attempts: 2 });

    const app = express();
    app.use('/api', createQueueRouter({ [TEST_QUEUE]: queue }, context.redis));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/queues/${TEST_QUEUE}/repeatables`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.repeatables).toHaveLength(1);
      expect(body.repeatables[0]).toMatchObject({ name: 'nightly', cron: '0 0 * * *', data: { kind: 'report' } });
      expect(body.repeatables[0].nextRunAt).toBeGreaterThan(Date.now());

      const missing = await fetch(`http://127.0.0.1:${port}/api/queues/no-such-queue/repeatables`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toContain('no-such-queue');
    } finally {
      server.close();
    }
  });
});
