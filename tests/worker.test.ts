/**
 * Phase 39 — Worker Unit Tests
 *
 * Uses a REAL Redis connection on DB 1 (same as queue.test.ts via beforeEach FLUSHDB).
 * Tests run against a real Worker + Queue + Lua scripts pipeline.
 *
 * What is tested:
 *  - Successful job processing → metrics show 10 completed
 *  - Processor throws → job ends up in failed after maxAttempts
 *  - Retry logic → job re-queued after failure, processes on retry
 *  - Pause/Resume → paused queue does not process jobs
 */

import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { Worker } from '../src/Worker';
import { loadScripts } from '../src/scripts';
import { Job } from '../src/types';
import { setupRedisContainer, teardownRedisContainer, TestContext } from './test-helper';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_QUEUE = 'test-worker-unit';
const WAIT_TIMEOUT = 20_000; // ms — max time to wait for jobs

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for a predicate to become true, polling every 100ms */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT,
  label = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Create a worker, run it, wait for predicate, then stop it */
async function withWorker<T>(
  queue: Queue,
  redis: Redis,
  processor: (job: Job<T>) => Promise<void>,
  run: (worker: Worker<T>) => Promise<void>,
  options: { concurrency?: number } = {}
): Promise<void> {
  const worker = new Worker<T>(
    TEST_QUEUE,
    processor,
    redis,
    { concurrency: options.concurrency ?? 1, pollInterval: 100 }
  );
  await worker.start();
  try {
    await run(worker);
  } finally {
    await worker.stop();
  }
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

let context: TestContext;
let queue: Queue;

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Worker: successful processing', () => {
  it('should process a single job and metrics show 1 completed', async () => {
    await queue.add('ping', { value: 1 });

    await withWorker(queue, context.redis, async (_job) => {
      // No-op processor — job succeeds immediately
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.completed === 1 && m.waiting === 0;
      }, WAIT_TIMEOUT, '1 completed job');
    });

    const m = await queue.getMetrics();
    expect(m.completed).toBe(1);
    expect(m.waiting).toBe(0);
    expect(m.failed).toBe(0);
  });

  it('should process 10 jobs and show 10 completed', async () => {
    // Enqueue 10 jobs
    for (let i = 0; i < 10; i++) {
      await queue.add('task', { index: i });
    }

    const processed: number[] = [];

    await withWorker<{ index: number }>(
      queue, context.redis,
      async (job) => { processed.push(job.data.index); },
      async () => {
        await waitFor(async () => {
          const m = await queue.getMetrics();
          return m.completed === 10;
        }, WAIT_TIMEOUT, '10 completed jobs');
      },
      { concurrency: 3 }
    );

    const m = await queue.getMetrics();
    expect(m.completed).toBe(10);
    expect(m.waiting).toBe(0);
    expect(m.failed).toBe(0);
    expect(processed).toHaveLength(10);
  });

  it('should update jobsProcessed counter accurately', async () => {
    await queue.add('count-me', {});

    let processedCount = 0;
    const worker = new Worker(
      TEST_QUEUE,
      async () => { processedCount++; },
      context.redis,
      { pollInterval: 100 }
    );
    await worker.start();

    await waitFor(async () => {
      const m = await queue.getMetrics();
      return m.completed === 1;
    }, WAIT_TIMEOUT, 'job done');

    await worker.stop();
    expect(processedCount).toBe(1);
  });
});

describe('Worker: failure handling', () => {
  it('should move job to failed after maxAttempts exhausted', async () => {
    // attempts:1 → fails immediately with no retry
    await queue.add('always-fail', { reason: 'boom' }, { attempts: 1 });

    await withWorker(queue, context.redis, async (_job) => {
      throw new Error('Intentional failure for testing');
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.failed === 1;
      }, WAIT_TIMEOUT, '1 failed job');
    });

    const m = await queue.getMetrics();
    expect(m.failed).toBe(1);
    expect(m.completed).toBe(0);
  });

  it('should keep job in failed (not waiting) when maxAttempts=1', async () => {
    const job = await queue.add('fail-no-retry', {}, { attempts: 1 });

    await withWorker(queue, context.redis, async () => {
      throw new Error('fail');
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.failed >= 1;
      }, WAIT_TIMEOUT, 'job in failed');
    });

    const fetched = await queue.getJob(job.id);
    expect(fetched?.status).toBe('FAILED');
    expect(fetched?.attempts).toBe(1);
  });

  it('should process 10 failing jobs and all appear in failed', async () => {
    for (let i = 0; i < 10; i++) {
      await queue.add('fail-all', { i }, { attempts: 1 });
    }

    await withWorker(queue, context.redis, async () => {
      throw new Error('always fail');
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.failed === 10;
      }, WAIT_TIMEOUT, '10 failed jobs');
    }, { concurrency: 3 });

    const m = await queue.getMetrics();
    expect(m.failed).toBe(10);
    expect(m.completed).toBe(0);
  });
});

describe('Worker: retry logic', () => {
  it('should retry and eventually succeed on second attempt', async () => {
    await queue.add('flaky', {}, { attempts: 3, backoff: { type: 'fixed', delay: 100 } });

    let attempt = 0;
    await withWorker(queue, context.redis, async (_job) => {
      attempt++;
      if (attempt < 2) throw new Error('First attempt fails');
      // Second attempt succeeds
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.completed === 1;
      }, WAIT_TIMEOUT, 'job completed after retry');
    });

    const m = await queue.getMetrics();
    expect(m.completed).toBe(1);
    expect(m.failed).toBe(0);
    expect(attempt).toBe(2);
  });

  it('retryAll should re-queue all failed jobs', async () => {
    // Fail 3 jobs with maxAttempts=1
    for (let i = 0; i < 3; i++) {
      await queue.add('batch-fail', { i }, { attempts: 1 });
    }

    // Worker 1: fail all 3
    await withWorker(queue, context.redis, async () => {
      throw new Error('fail');
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.failed === 3;
      }, WAIT_TIMEOUT, '3 jobs failed');
    });

    // Call retryAll
    const retried = await queue.retryAll();
    expect(retried).toBe(3);

    // Worker 2: process re-queued jobs successfully
    await withWorker(queue, context.redis, async () => {
      // success this time
    }, async () => {
      await waitFor(async () => {
        const m = await queue.getMetrics();
        return m.completed === 3;
      }, WAIT_TIMEOUT, '3 retried jobs completed');
    });

    const m = await queue.getMetrics();
    expect(m.completed).toBe(3);
    expect(m.failed).toBe(0);
  });
});

describe('Worker: pause/resume', () => {
  it('should not process jobs while queue is paused', async () => {
    await queue.pauseQueue();
    await queue.add('should-not-run', {});

    let processed = false;
    const worker = new Worker(
      TEST_QUEUE,
      async () => { processed = true; },
      context.redis,
      { pollInterval: 100 }
    );
    await worker.start();

    // Wait 800ms — if paused, job should NOT be processed
    await new Promise(r => setTimeout(r, 800));
    expect(processed).toBe(false);

    // Resume and verify it now processes
    await queue.resumeQueue();
    await waitFor(async () => {
      const m = await queue.getMetrics();
      return m.completed === 1;
    }, WAIT_TIMEOUT, 'job processed after resume');

    await worker.stop();
    expect(processed).toBe(true);
  });
});
