import { Queue } from '../src/Queue';
import { setupRedisContainer, TestContext } from './test-helper';

describe('Phase 42 — Idempotency Keys', () => {
  let context: TestContext;
  const QUEUE_NAME = 'idem-test';

  beforeAll(async () => {
    context = await setupRedisContainer();
  }, 60000);

  afterAll(async () => {
    if (context) {
      await context.redis.quit();
      await context.container.stop();
    }
  });

  beforeEach(async () => {
    // Flush only our test queue keys
    const staleKeys = await context.redis.keys(`queue:${QUEUE_NAME}:*`);
    if (staleKeys.length > 0) await context.redis.del(...staleKeys);
  });

  it('should create only 1 job when calling add() 10 times with the same idempotencyKey', async () => {
    const queue = new Queue(QUEUE_NAME, context.redis);
    const IDEM_KEY = 'order-payment-123';
    const jobs = [];

    for (let i = 0; i < 10; i++) {
      const job = await queue.add('charge', { amount: 99 }, { idempotencyKey: IDEM_KEY });
      jobs.push(job.id);
    }

    // All 10 calls must return the SAME job id
    const uniqueIds = new Set(jobs);
    expect(uniqueIds.size).toBe(1);

    // Only 1 job should be in the waiting set
    const waitingCount = await queue.getWaitingCount();
    expect(waitingCount).toBe(1);
  });

  it('should produce different jobs for different idempotencyKeys', async () => {
    const queue = new Queue(QUEUE_NAME, context.redis);
    const jobA = await queue.add('charge', { amount: 10 }, { idempotencyKey: 'key-A' });
    const jobB = await queue.add('charge', { amount: 20 }, { idempotencyKey: 'key-B' });
    const jobC = await queue.add('charge', { amount: 30 }, { idempotencyKey: 'key-A' }); // duplicate of A

    expect(jobA.id).not.toBe(jobB.id);
    expect(jobC.id).toBe(jobA.id);
  });

  it('should always produce a fresh job when no idempotencyKey is provided', async () => {
    const queue = new Queue(QUEUE_NAME, context.redis);
    const noIdem1 = await queue.add('ping', {});
    const noIdem2 = await queue.add('ping', {});
    expect(noIdem1.id).not.toBe(noIdem2.id);
  });

  it('should create a fresh job after the idempotency key has expired (simulated)', async () => {
    const queue = new Queue(QUEUE_NAME, context.redis);
    const EXPIRE_KEY = 'email-welcome-456';

    const original = await queue.add('welcome-email', { userId: 1 }, { idempotencyKey: EXPIRE_KEY });

    // Manually delete the idem key to simulate TTL expiry
    await context.redis.del(`queue:${QUEUE_NAME}:idem:${EXPIRE_KEY}`);

    const afterExpiry = await queue.add('welcome-email', { userId: 1 }, { idempotencyKey: EXPIRE_KEY });
    expect(original.id).not.toBe(afterExpiry.id);
  });

  it('should emit "deduplicated" event on a duplicate call', async () => {
    const queue = new Queue(QUEUE_NAME, context.redis);
    let eventFired = false;
    queue.once('deduplicated', () => { eventFired = true; });

    const EVENT_KEY = 'event-test-789';
    await queue.add('task', {}, { idempotencyKey: EVENT_KEY });          // first → creates
    await queue.add('task', {}, { idempotencyKey: EVENT_KEY });          // second → duplicate

    expect(eventFired).toBe(true);
  });
});
