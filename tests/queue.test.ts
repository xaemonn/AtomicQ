/**
 * Phase 39 — Queue Unit Tests
 *
 * Uses a REAL Redis connection (localhost:6379).
 * Every test gets a fresh Redis DB via FLUSHDB in beforeEach.
 *
 * What is tested:
 *  - add() → job stored with correct defaults
 *  - getJob() → returns hydrated job
 *  - getMetrics() → counts reflect actual state
 *  - delayed jobs → appear in delayed, not waiting
 *  - cancel() → job moves to cancelled set
 */

import Redis from 'ioredis';
import { Queue } from '../src/Queue';
import { loadScripts } from '../src/scripts';
import { setupRedisContainer, teardownRedisContainer, TestContext } from './test-helper';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_QUEUE = 'test-queue-unit';

let context: TestContext;
let queue: Queue;

// Shared setup: one Redis client for all tests
beforeAll(async () => {
  context = await setupRedisContainer();
}, 60000);

afterAll(async () => {
  await teardownRedisContainer(context);
});

// Wipe DB 1 before every test to guarantee isolation
beforeEach(async () => {
  await context.redis.flushdb();
  queue = new Queue(TEST_QUEUE, context.redis);
});

// ─── add() ────────────────────────────────────────────────────────────────────

describe('Queue.add()', () => {
  it('should return a job with the correct name and data', async () => {
    const job = await queue.add('send-email', { to: 'user@example.com' });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe('send-email');
    expect(job.data).toEqual({ to: 'user@example.com' });
    expect(job.status).toBe('WAITING');
  });

  it('should default to normal priority and 3 maxAttempts', async () => {
    const job = await queue.add('task', {});

    expect(job.priority).toBe('normal');
    expect(job.maxAttempts).toBe(3);
    expect(job.attempts).toBe(0);
  });

  it('should respect custom priority option', async () => {
    const job = await queue.add('critical-task', {}, { priority: 'high' });
    expect(job.priority).toBe('high');
  });

  it('should add job to the waiting sorted set immediately', async () => {
    const job = await queue.add('task', {});
    const ids = await queue.getWaitingJobsIds();
    expect(ids).toContain(job.id);
  });

  it('should put delayed jobs in the delayed set', async () => {
    const job = await queue.add('deferred', {}, { delay: 60_000 }); // 1 min delay
    const delayed = await queue.getDelayedJobs();
    const waiting = await queue.getWaitingJobsIds();

    expect(delayed).toContain(job.id);
    expect(waiting).not.toContain(job.id);
  });

  it('should add multiple jobs without collision', async () => {
    const jobs = await Promise.all([
      queue.add('j1', { n: 1 }),
      queue.add('j2', { n: 2 }),
      queue.add('j3', { n: 3 }),
    ]);

    const ids = jobs.map(j => j.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});

// ─── getJob() ─────────────────────────────────────────────────────────────────

describe('Queue.getJob()', () => {
  it('should return the job by ID', async () => {
    const added = await queue.add('fetch-me', { x: 42 });
    const fetched = await queue.getJob(added.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(added.id);
    expect(fetched!.name).toBe('fetch-me');
    expect(fetched!.data).toEqual({ x: 42 });
  });

  it('should return null for a non-existent job ID', async () => {
    const result = await queue.getJob('does-not-exist-xxx');
    expect(result).toBeNull();
  });
});

// ─── getMetrics() ─────────────────────────────────────────────────────────────

describe('Queue.getMetrics()', () => {
  it('should return all zeros on an empty queue', async () => {
    const m = await queue.getMetrics();
    expect(m.waiting).toBe(0);
    expect(m.active).toBe(0);
    expect(m.completed).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.cancelled).toBe(0);
  });

  it('should count waiting jobs correctly', async () => {
    await queue.add('t1', {});
    await queue.add('t2', {});
    await queue.add('t3', {});

    const m = await queue.getMetrics();
    expect(m.waiting).toBe(3);
    expect(m.completed).toBe(0);
    expect(m.failed).toBe(0);
  });

  it('should count cancelled jobs after cancel()', async () => {
    const job = await queue.add('cancel-me', {});
    const ok = await queue.cancel(job.id);

    expect(ok).toBe(true);
    const m = await queue.getMetrics();
    expect(m.cancelled).toBe(1);
    expect(m.waiting).toBe(0);
  });
});

// ─── Bulk operations (Phase 37) ───────────────────────────────────────────────

describe('Queue.clearCompleted()', () => {
  it('should return 0 when there is nothing to clear', async () => {
    // clearCompleted takes maxAgeMs: number (default 1h)
    // Passing 0 means "anything older than now" — empty queue = 0 removed
    const removed = await queue.clearCompleted(0);
    expect(removed).toBe(0);
  });
});

describe('Queue.isPaused()', () => {
  it('should not be paused by default', async () => {
    expect(await queue.isPaused()).toBe(false);
  });

  it('should be paused after pauseQueue()', async () => {
    await queue.pauseQueue();
    expect(await queue.isPaused()).toBe(true);
  });

  it('should be unpaused after resumeQueue()', async () => {
    await queue.pauseQueue();
    await queue.resumeQueue();
    expect(await queue.isPaused()).toBe(false);
  });
});
