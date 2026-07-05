import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { generateJobId } from './utils';
import { createJob, hydrateJob, Job, JobOptions, JobStatus, QueueMetrics, CleanupOptions, RepeatableJobDef } from './types';
import { jobKey, jobKeyPrefix, waitingKey, delayedKey, activeKey, channelKey, completedKey, failedKey, cancelledKey, cronKey, latencyKey, pauseKey, idempotencyKey } from './keys';

// Map priority string to numeric score (lower = higher priority)
const PRIORITY_SCORES: Record<string, number> = { high: 1, normal: 5, low: 10 };
import { CronExpressionParser } from 'cron-parser';

/**
 * High-level Queue class to interact with Redis and the Lua scripts.
 */
export class Queue<T = any> extends EventEmitter {
  protected redis: Redis;
  private queueName: string;
  private watchdogTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(queueName: string, redis: Redis) {
    super();
    this.queueName = queueName;
    this.redis = redis;
  }

  /**
   * Adds a new job to the queue. 
   * Supports immediate and delayed jobs via options.delay.
   */
  async add(name: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    const job = createJob(generateJobId(), name, this.queueName, data, options);
    const returnedId = await this.enqueue(this.redis, job, options);
    return this.resolveAdded(job, returnedId);
  }

  /**
   * Adds many jobs in a single network round-trip (one pipeline of enqueue
   * scripts). Each job is still enqueued atomically and idempotency keys are
   * honoured per job.
   */
  async addBulk(jobs: Array<{ name: string; data: T; options?: JobOptions }>): Promise<Job<T>[]> {
    if (jobs.length === 0) return [];
    const pipeline = this.redis.pipeline();
    const created = jobs.map(({ name, data, options = {} }) => {
      const job = createJob(generateJobId(), name, this.queueName, data, options);
      this.enqueue(pipeline as unknown as Redis, job, options);
      return job;
    });

    const results = (await pipeline.exec()) ?? [];
    return Promise.all(created.map((job, i) => {
      const [err, returnedId] = results[i] ?? [];
      if (err) throw err;
      return this.resolveAdded(job, returnedId as string);
    }));
  }

  /** Issues the enqueue script on a client or pipeline. */
  private enqueue(client: Redis, job: Job<T>, options: JobOptions): Promise<string> {
    // KEYS[5]: idempotency slot — empty string means "no dedup check"
    const ik = options.idempotencyKey ? idempotencyKey(this.queueName, options.idempotencyKey) : '';
    const priorityScore = PRIORITY_SCORES[job.priority] || 5;

    // enqueue Lua returns:
    //   ARGV[1] (new jobId)  → fresh job was created
    //   existing jobId       → duplicate detected, returned the original
    return client.enqueue(
      5, jobKey(this.queueName, job.id), waitingKey(this.queueName), delayedKey(this.queueName),
      channelKey(this.queueName), ik,
      job.id, JSON.stringify(job), job.runAt, job.maxAttempts, priorityScore, Date.now(), this.queueName
    );
  }

  /** Maps the enqueue script's return value to the job the caller should see. */
  private async resolveAdded(job: Job<T>, returnedId: string): Promise<Job<T>> {
    // Duplicate: Lua returned a *different* id — fetch & return the original job
    if (returnedId && returnedId !== job.id) {
      const existingJob = await this.getJob(returnedId);
      if (existingJob) {
        this.emit('deduplicated', existingJob);
        return existingJob;
      }
      // Original job hash was already cleaned up; report its id rather than a job that was never stored
      const ghost = { ...job, id: returnedId };
      this.emit('deduplicated', ghost);
      return ghost;
    }

    this.emit('waiting', job);
    return job;
  }

  /**
   * Returns a job by its ID.
   */
  async getJob(jobId: string): Promise<Job<T> | null> {
    const jk = jobKey(this.queueName, jobId);
    const raw = await this.redis.hgetall(jk);
    return hydrateJob<T>(raw);
  }

  /**
   * Returns jobs that are delayed (ready at a future timestamp).
   */
  async getDelayedJobs(): Promise<string[]> {
    const dk = delayedKey(this.queueName);
    // All entries in the delayed sorted set are future-scheduled jobs
    return await this.redis.zrange(dk, 0, -1);
  }

  /**
   * Returns jobs ready to run now.
   */
  async getWaitingJobsIds(): Promise<string[]> {
    const wk = waitingKey(this.queueName);
    const now = Date.now();
    return await this.redis.zrangebyscore(wk, 0, now);
  }

  /**
   * Returns N most recent completed job IDs.
   */
  async getCompletedJobs(limit: number = 10): Promise<string[]> {
    const ck = completedKey(this.queueName);
    // ZREVRANGE for most recent (highest score) first
    return await this.redis.zrevrange(ck, 0, limit - 1);
  }

  /**
   * Gets the total count of completed jobs in the history.
   */
  async getCompletedCount(): Promise<number> {
    const ck = completedKey(this.queueName);
    return await this.redis.zcard(ck);
  }

  /**
   * Retrieves comprehensive metrics for the queue using a single pipeline call.
   * Also computes p50/p95/p99 latency over the most recent completed jobs.
   */
  async getMetrics(): Promise<QueueMetrics> {
    const wk  = waitingKey(this.queueName);
    const dk  = delayedKey(this.queueName);
    const ak  = activeKey(this.queueName);
    const ck  = completedKey(this.queueName);
    const fk  = failedKey(this.queueName);
    const cnk = cancelledKey(this.queueName);
    const lk  = latencyKey(this.queueName);

    const pipeline = this.redis.pipeline();
    pipeline.zcard(wk);              // [0] Waiting
    pipeline.zcard(dk);              // [1] Delayed
    pipeline.hlen(ak);               // [2] Active
    pipeline.zcard(ck);              // [3] Completed
    pipeline.zcard(fk);              // [4] Failed
    pipeline.zcard(cnk);             // [5] Cancelled
    // Most recent durations (newest first)
    pipeline.lrange(lk, 0, -1);      // [6] latency samples

    const results = await pipeline.exec();

    // ── Percentile calculation ────────────────────────────────────────────
    const rawLatency = (results?.[6]?.[1] as string[]) || [];
    // The list is in arrival order — percentiles need it sorted ASC
    const durations = rawLatency.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, Math.min(idx, arr.length - 1))];
    };

    return {
      waiting:   (results?.[0]?.[1] as number) || 0,
      delayed:   (results?.[1]?.[1] as number) || 0,
      active:    (results?.[2]?.[1] as number) || 0,
      completed: (results?.[3]?.[1] as number) || 0,
      failed:    (results?.[4]?.[1] as number) || 0,
      cancelled: (results?.[5]?.[1] as number) || 0,
      p50: pct(durations, 50),
      p95: pct(durations, 95),
      p99: pct(durations, 99),
    };
  }

  /**
   * Cancels a job. If it is in waiting or delayed, it will be moved to cancelled.
   * If it is active, it will be marked for cancellation.
   */
  async cancel(jobId: string): Promise<boolean> {
     const jk = jobKey(this.queueName, jobId);
     const ak = activeKey(this.queueName);
     const wk = waitingKey(this.queueName);
     const cnk = cancelledKey(this.queueName);
     const dk = delayedKey(this.queueName);

     const result = await this.redis.cancel(5, jk, ak, wk, cnk, dk, jobId, Date.now());

     if (result === 1) {
        this.emit('cancelled', jobId);
        // Tell workers to flip job.isCancelled() for a job that is mid-flight
        await this.redis.publish(channelKey(this.queueName), JSON.stringify({ event: 'cancel', queueName: this.queueName, jobId }));
        return true;
     }
     return false;
  }

  /**
   * Runs one cleanup pass on completed, failed, and cancelled sets.
   * Removes job hashes AND their sorted set entries atomically via Lua.
   */
  async runCleanup(options: CleanupOptions): Promise<{ completed: number; failed: number; cancelled: number }> {
    const jobPrefix = jobKeyPrefix(this.queueName);
    const maxAge = options.maxAge || 0;
    const maxCount = options.maxCount || 0;
    const now = Date.now();

    const [completedDel, failedDel, cancelledDel] = await Promise.all([
      (this.redis as any).cleanup(2, completedKey(this.queueName), jobPrefix, maxAge, maxCount, now),
      (this.redis as any).cleanup(2, failedKey(this.queueName), jobPrefix, maxAge, maxCount, now),
      (this.redis as any).cleanup(2, cancelledKey(this.queueName), jobPrefix, maxAge, maxCount, now),
    ]);

    const result = { completed: completedDel, failed: failedDel, cancelled: cancelledDel };
    const total = completedDel + failedDel + cancelledDel;
    if (total > 0) {
      console.log(`[Cleanup:${this.queueName}] Pruned ${total} job(s) (✅${completedDel} ❌${failedDel} ⛔${cancelledDel})`);
      this.emit('cleaned', result);
    }

    return result;
  }

  /**
   * Starts an automatic periodic cleanup loop.
   */
  startCleanup(options: CleanupOptions): void {
    this.stopCleanup();
    const interval = options.intervalMs || 30000;
    console.log(`[Cleanup:${this.queueName}] Auto-cleanup started (every ${interval}ms, maxAge=${options.maxAge || 'off'}, maxCount=${options.maxCount || 'off'})`);
    this.cleanupTimer = setInterval(() => {
      this.runCleanup(options).catch(err => {
        console.error(`[Cleanup:${this.queueName}] Error:`, err.message);
      });
    }, interval);
  }

  /**
   * Stops the automatic cleanup loop.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Gets the total count of waiting/delayed jobs.
   */
  async getWaitingCount(): Promise<number> {
    const wk = waitingKey(this.queueName);
    return await this.redis.zcard(wk);
  }

  /**
   * Fetches the unique IDs of all jobs currently in the active set.
   */
  async getActiveJobs(): Promise<string[]> {
    const ak = activeKey(this.queueName);
    return await this.redis.hkeys(ak);
  }

  /**
   * Periodically checks for and recovers stalled jobs (Watchdog).
   */
  startWatchdog(checkInterval: number = 30000, stallTimeout: number = 60000): void {
     this.stopWatchdog();
     this.watchdogTimer = setInterval(() => {
        this.checkStalled(stallTimeout).catch(err => {
            console.error(`[Watchdog:${this.queueName}] Error:`, err.message);
        });
     }, checkInterval);
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Identifies and re-queues jobs that have haven't signaled liveness (heartbeat)
   * within the stallTimeout period.
   */
  async checkStalled(stallTimeout: number): Promise<string[]> {
     const ak = activeKey(this.queueName);
     const wk = waitingKey(this.queueName);
     const fk = failedKey(this.queueName);
     const now = Date.now();

     const recovered = await this.redis.cleanStalled(3, ak, wk, fk, now, stallTimeout, jobKeyPrefix(this.queueName));
     
     if (recovered && recovered.length > 0) {
        this.emit('stalled_recovered', recovered);
     }
     
     return recovered || [];
  }

  /**
   * Retries a failed job by moving it back to the waiting set.
   */
  async retry(jobId: string): Promise<boolean> {
    const ok = await this.redis.retry(
      3, jobKey(this.queueName, jobId), failedKey(this.queueName), waitingKey(this.queueName), jobId, Date.now()
    );
    if (ok !== 1) return false;
    this.emit('retried', jobId);
    return true;
  }

  /**
   * Phase 37: Retries ALL jobs currently in the failed set.
   * Returns the count of successfully re-queued jobs.
   */
  async retryAll(): Promise<number> {
    const fk = failedKey(this.queueName);
    const wk = waitingKey(this.queueName);
    // Grab all failed job IDs in one shot
    const ids = await this.redis.zrange(fk, 0, -1);
    if (ids.length === 0) return 0;

    // Each retry is atomic; pipeline them for speed
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      (pipeline as unknown as Redis).retry(3, jobKey(this.queueName, id), fk, wk, id, now);
    }
    const results = (await pipeline.exec()) ?? [];
    const count = results.filter(([err, ok]) => !err && ok === 1).length;
    this.emit('retried_all', count);
    return count;
  }

  /**
   * Phase 37: Removes all completed jobs older than `maxAgeMs` (default 3600000 = 1h).
   * Returns the count of deleted jobs.
   */
  async clearCompleted(maxAgeMs: number = 60 * 60 * 1000): Promise<number> {
    const ck      = completedKey(this.queueName);
    const cutoff  = Date.now() - maxAgeMs;
    const jobPfx  = jobKeyPrefix(this.queueName);

    // Get all IDs with score (completedAt) <= cutoff
    const ids = await this.redis.zrangebyscore(ck, '-inf', cutoff);
    if (ids.length === 0) return 0;

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.del(`${jobPfx}${id}`);
    }
    pipeline.zremrangebyscore(ck, '-inf', cutoff);
    await pipeline.exec();
    return ids.length;
  }

  /**
   * Phase 37: Pauses the queue — workers will stop picking up new jobs.
   * Sets a simple Redis key that the Worker checks before each poll.
   */
  async pauseQueue(): Promise<void> {
    await this.redis.set(pauseKey(this.queueName), '1');
    this.emit('paused');
  }

  /**
   * Phase 37: Resumes the queue.
   */
  async resumeQueue(): Promise<void> {
    await this.redis.del(pauseKey(this.queueName));
    this.emit('resumed');
  }

  /**
   * Phase 37: Returns true if the queue is currently paused.
   */
  async isPaused(): Promise<boolean> {
    const val = await this.redis.get(pauseKey(this.queueName));
    return val === '1';
  }

  /**
   * Lists job IDs from a given status set with pagination support (start and limit).
   */
  async getJobsByStatus(status: string, start: number = 0, limit: number = 20): Promise<string[]> {
    const end = start + limit - 1;
    switch (status) {
      case 'waiting':
        return this.redis.zrange(waitingKey(this.queueName), start, end);
      case 'delayed':
        return this.redis.zrange(delayedKey(this.queueName), start, end);
      case 'active':
        // Note: Active jobs are in a Hash, so pagination is less direct than Sorted Sets.
        // For Active, we usually just return everything or use HSCAN if very large.
        // For now, we'll slice the keys array.
        const keys = await this.redis.hkeys(activeKey(this.queueName));
        return keys.slice(start, start + limit);
      case 'completed':
        return this.redis.zrevrange(completedKey(this.queueName), start, end);
      case 'failed':
        return this.redis.zrevrange(failedKey(this.queueName), start, end);
      case 'cancelled':
        return this.redis.zrevrange(cancelledKey(this.queueName), start, end);
      default:
        return [];
    }
  }

  /**
   * Registers a repeatable (cron) job definition.
   * The Scheduler will pick this up and enqueue jobs on schedule.
   * 
   * @param name   - Unique name for this repeatable job (also used for deduplication)
   * @param data   - Data to pass to the processor each time it runs
   * @param cron   - Cron expression, e.g. "* /10 * * * *" (every 10s — remove space)
   * @param options - Standard job options (priority, attempts, etc.)
   */
  async addRepeatable(name: string, data: any, cron: string, options: JobOptions = {}): Promise<RepeatableJobDef> {
    const ck = cronKey(this.queueName);
    
    // Parse the cron expression to get the first nextRunAt
    const interval = CronExpressionParser.parse(cron);
    const nextRunAt = interval.next().toDate().getTime();

    const def: RepeatableJobDef = {
      name,
      cron,
      data,
      options,
      nextRunAt,
      createdAt: Date.now(),
    };

    // Store in Redis Hash: field = name, value = serialized def
    await this.redis.hset(ck, name, JSON.stringify(def));
    console.log(`[Cron:${this.queueName}] Registered repeatable job "${name}" (${cron}) — next run at ${new Date(nextRunAt).toISOString()}`);
    return def;
  }

  /**
   * Returns all registered repeatable (cron) job definitions for this queue.
   */
  async getRepeatableJobs(): Promise<RepeatableJobDef[]> {
    const ck = cronKey(this.queueName);
    const raw = await this.redis.hgetall(ck);
    if (!raw) return [];
    return Object.values(raw).map(v => JSON.parse(v));
  }

  /**
   * Removes a repeatable job definition by name.
   */
  async removeRepeatable(name: string): Promise<boolean> {
    const ck = cronKey(this.queueName);
    const result = await this.redis.hdel(ck, name);
    return result === 1;
  }

  /** Expose the queue name for API use */
  getName(): string {
    return this.queueName;
  }
}
