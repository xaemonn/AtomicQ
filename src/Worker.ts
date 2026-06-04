import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import * as os from 'os';
import { Job, JobOptions, hydrateJob, JobStatus, WorkerOptions } from './types';
import { randomUUID } from 'crypto';
import { jobKey, jobKeyPrefix, waitingKey, delayedKey, activeKey, failedKey, completedKey, channelKey, limiterKey, latencyKey, pauseKey, workerKey } from './keys';

/**
 * Worker class to process jobs from one or more queues.
 */
export class Worker<T = any> extends EventEmitter {
  private redis: Redis;
  private queueNames: string[];
  private currentQueueIndex: number = 0;
  private processor: (job: Job<T>) => Promise<void>;
  private running: boolean = false;
  private concurrency: number;
  private activeJobsCount: number = 0;
  private pollInterval: number;
  /** Resolves the current idle wait early (job finished / job added). */
  private wakeUp?: () => void;
  private pausedQueues: Set<string> = new Set();

  private activeJobs: Map<string, Job<T>> = new Map(); // jobId -> Job
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInterval: number;

  private subRedis?: Redis;
  private cancelledJobs: Set<string> = new Set();
  private options: WorkerOptions;

  // Phase 38: Worker identity & stats
  private readonly workerPid: number = process.pid;
  private readonly workerHost: string = os.hostname();
  /**
   * Unique per Worker instance. Used as the Redis status key suffix and as the
   * lock token stamped on every job this worker claims, so a worker that lost
   * a job (stall recovery / cancel) cannot complete or fail it afterwards.
   */
  readonly workerId: string = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly startedAt: number = Date.now();
  private jobsProcessed: number = 0;
  private workerStatusTimer?: NodeJS.Timeout;
  private readonly statusTtlSeconds: number;

  /** Default drain timeout for graceful shutdown (30 s) */
  static readonly DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

  constructor(
    queueNames: string | string[], 
    processor: (job: Job<T>) => Promise<void>, 
    redis: Redis,
    options: WorkerOptions = {}
  ) {
    super();
    this.queueNames = Array.isArray(queueNames) ? queueNames : [queueNames];
    this.processor = processor;
    this.redis = redis;
    this.options = options || {};
    this.concurrency = options.concurrency || 1;
    this.pollInterval = options.pollInterval || 1000;
    this.heartbeatInterval = options.heartbeatInterval || 15000;
    // Status key expires after 3 missed heartbeats
    this.statusTtlSeconds = Math.ceil((this.heartbeatInterval * 3) / 1000);
  }

  private async setupSubscriber(): Promise<void> {
    if (this.subRedis) return;
    
    this.subRedis = this.redis.duplicate();
    for (const q of this.queueNames) {
       const ch = channelKey(q);
       await this.subRedis.subscribe(ch);
       this.log(`📡 Subscribed to cancellation events on: ${ch}`, q);
    }

    this.subRedis.on('message', (channel, message) => {
       try {
          const { event, jobId } = JSON.parse(message);
          if (event === 'cancel') {
             this.log(`⛔ Job cancellation received: ${jobId}`, channel);
             this.cancelledJobs.add(jobId);
          } else if (event === 'job:added') {
             // Push notification: skip the rest of the idle poll interval
             this.wake();
          }
       } catch {}
    });
  }

  /**
   * Internal logger.
   */
  private log(message: string, queueName?: string): void {
    const qLabel = queueName || this.queueNames.join(',');
    console.log(`[Worker:${qLabel}] ${message}`);
  }

  /**
   * Starts the polling loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log(`👷 Worker started (concurrency: ${this.concurrency})`);

    await this.setupSubscriber().catch(err => {
        this.log(`❌ Failed to setup subscriber: ${err.message}`);
    });

    this.startHeartbeatLoop();
    this.startWorkerStatusLoop(); // Phase 38

    // Begin the fetch loop (not awaited — runs until stop())
    this.runLoop().catch(err => this.log(`❌ Fetch loop crashed: ${err.message}`));
  }

  /**
   * Graceful shutdown.
   * Stops polling, waits up to `timeoutMs` for active jobs to drain.
   * If they don't finish in time, emits 'drain_timeout' and resolves anyway
   * (the caller decides whether to force-exit).
   *
   * @param timeoutMs  Max ms to wait for active jobs. Default: 30 000 (30 s)
   * @returns          true = clean drain, false = timed out
   */
  async stop(timeoutMs: number = Worker.DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
    this.running = false;
    this.wake();
    this.log(`🛑 Stopping worker gracefully (timeout: ${timeoutMs / 1000}s)…`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Phase 38: stop status loop & delete worker hash keys
    if (this.workerStatusTimer) {
      clearInterval(this.workerStatusTimer);
      this.workerStatusTimer = undefined;
    }
    await this.deleteWorkerStatus().catch(() => {});

    if (this.subRedis) {
      this.subRedis.disconnect();
      this.subRedis = undefined;
    }

    // Race: drain active jobs vs. hard timeout
    let timedOut = false;
    const drainLoop = async () => {
      while (this.activeJobsCount > 0 && !timedOut) {
        this.log(`⏳ Waiting for ${this.activeJobsCount} active job(s) to finish…`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    const timeoutPromise = new Promise<void>(resolve =>
      setTimeout(resolve, timeoutMs)
    );

    await Promise.race([
      drainLoop(),
      timeoutPromise.then(() => { timedOut = true; }),
    ]);

    if (timedOut) {
      this.log(`⚠️  Drain timeout reached (${timeoutMs / 1000}s). ${this.activeJobsCount} job(s) still active — forcing stop.`);
      this.emit('drain_timeout', this.activeJobsCount);
      return false; // caller should force-exit
    }

    this.log('✅ Worker stopped cleanly.');
    return true; // clean drain
  }

  /** Returns the number of jobs currently being processed by this worker. */
  getActiveCount(): number {
    return this.activeJobsCount;
  }

  /**
   * Main fetch loop. Fills free concurrency slots as fast as jobs are
   * available, then idles until a slot frees up, a `job:added` event arrives,
   * or the poll interval elapses (fallback if a pub/sub message is missed).
   */
  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.activeJobsCount >= this.concurrency) {
        await this.idle(this.pollInterval);
        continue;
      }

      const result = await this.fetchNextJob();
      if (result === 'RATE_LIMIT') {
        await this.idle(1000);
      } else if (result) {
        this.activeJobsCount++;
        this.processJob(result).finally(() => {
          this.activeJobsCount--;
          this.wake();
        });
      } else {
        await this.idle(this.pollInterval);
      }
    }
  }

  /** Sleeps for up to `ms`, returning early if wake() is called. */
  private idle(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        if (this.wakeUp === done) this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }

  private wake(): void {
    this.wakeUp?.();
  }

  /**
   * Tries each queue once, round-robin, and claims at most one job.
   */
  private async fetchNextJob(): Promise<Job<T> | 'RATE_LIMIT' | null> {
    let rateLimited = false;

    for (let i = 0; i < this.queueNames.length; i++) {
      const qIdx = (this.currentQueueIndex + i) % this.queueNames.length;
      const qName = this.queueNames[qIdx];

      try {
        // Phase 37: Skip this queue if it is paused
        const paused = (await this.redis.get(pauseKey(qName))) === '1';
        if (paused !== this.pausedQueues.has(qName)) {
          // Log on state change only, not on every poll
          if (paused) this.pausedQueues.add(qName); else this.pausedQueues.delete(qName);
          this.log(paused ? `⏸️  Queue '${qName}' is paused.` : `▶️  Queue '${qName}' resumed.`, qName);
        }
        if (paused) continue;

        const jobId = await this.redis.moveToActive(
          5, delayedKey(qName), waitingKey(qName), activeKey(qName), limiterKey(qName), channelKey(qName),
          Date.now(), jobKeyPrefix(qName),
          this.options.rateLimit?.max || 0, this.options.rateLimit?.durationMs || 0,
          this.workerId, qName
        );

        if (jobId === 'RATE_LIMIT') {
          rateLimited = true;
          continue;
        }
        if (!jobId) continue;

        // Next fetch starts from the queue after this one, so a busy queue cannot starve the others
        this.currentQueueIndex = (qIdx + 1) % this.queueNames.length;

        const job = hydrateJob<T>(await this.redis.hgetall(jobKey(qName, jobId)));
        if (job) return job;
        // Orphaned ID? Just remove it
        await this.redis.hdel(activeKey(qName), jobId);
      } catch (err: any) {
        this.log(`❌ Poll error on ${qName}: ${err.message}`);
      }
    }

    this.currentQueueIndex = (this.currentQueueIndex + 1) % this.queueNames.length;
    return rateLimited ? 'RATE_LIMIT' : null;
  }

  /**
   * Internal job execution handler.
   */
  private async processJob(job: Job<T>): Promise<void> {
    const qName = job.queueName;
    const jk = jobKey(qName, job.id);
    const ak = activeKey(qName);

    // Attach progress reporter
    job.updateProgress = async (progress: number) => {
      await this.redis.updateProgress(1, jk, progress.toString());
      await this.redis.publish(channelKey(qName), JSON.stringify({ event: 'job:progress', queueName: qName, jobId: job.id, progress }));
      job.progress = progress;
      this.emit('progress', job, progress);
    };

    job.isCancelled = () => {
       return this.cancelledJobs.has(job.id);
    };

    try {
      if (job.isCancelled()) return;
      
      this.activeJobs.set(job.id, job);
      this.log(`🚀 Processing job [${qName}]: ${job.name} (ID: ${job.id})`);
      this.emit('active', job);

      // Call user logic
      const result = await this.processor(job);

      const finishedAt = Date.now();
      const completed = await this.redis.complete(
        4, jk, ak, completedKey(qName), channelKey(qName), job.id, finishedAt, this.workerId, qName
      );
      if (completed === -1) {
        this.lockLost(job);
        return;
      }

      // ── Phase 36: Record processing duration in latency sorted set ────────
      // Score = duration ms, member = jobId. Cap at 1000 entries.
      const startedAt = job.startedAt ?? finishedAt;
      const duration  = finishedAt - startedAt;
      const lk = latencyKey(qName);
      const latencyPipeline = this.redis.pipeline();
      latencyPipeline.zadd(lk, duration, job.id);    // store duration
      latencyPipeline.zremrangebyrank(lk, 0, -1001); // keep newest 1000
      await latencyPipeline.exec();

      // Phase 38: count completed jobs + push fresh status immediately
      this.jobsProcessed++;
      this.publishWorkerStatus().catch(() => {});

      this.log(`✅ Job completed: ${job.id} (${duration}ms)`, qName);
      this.emit('completed', job, result);
    } catch (err: any) {
      const now = Date.now();
      const nextRunAt = this.calculateNextRunAt(job, now);
      const errorJson = JSON.stringify({ message: err?.message, stack: err?.stack });

      try {
        const outcome = await this.redis.fail(
          5, jk, ak, delayedKey(qName), failedKey(qName), channelKey(qName),
          job.id, errorJson, now, nextRunAt, this.workerId, qName
        );
        if (outcome === -1) {
          this.lockLost(job);
          return;
        }
        const retryNote = outcome === 0 ? ` (retry at ${new Date(nextRunAt).toISOString()})` : '';
        this.log(`❌ Job failed: ${job.id} - ${err?.message}${retryNote}`, qName);
        this.emit('failed', job, err);
      } catch (redisErr: any) {
        // Job stays in 'active'; the watchdog recovers it once heartbeats stop
        this.log(`❌ Could not record failure for ${job.id}: ${redisErr.message}`, qName);
      }
    } finally {
      this.activeJobs.delete(job.id);
      this.cancelledJobs.delete(job.id);
    }
  }

  /** Our lock was revoked (job cancelled or stall-recovered) — drop the result. */
  private lockLost(job: Job<T>): void {
    this.log(`⚠️  Lost lock on job ${job.id} (cancelled or recovered as stalled) — result discarded`, job.queueName);
    this.emit('lock_lost', job);
  }

  private startHeartbeatLoop(): void {
     this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeats().catch(err => this.log(`Heartbeat Error: ${err.message}`));
     }, this.heartbeatInterval);
  }

  private async sendHeartbeats(): Promise<void> {
    if (this.activeJobs.size === 0) return;

    const now = Date.now();
    const promises: Promise<any>[] = [];

    for (const job of this.activeJobs.values()) {
        const ak = activeKey(job.queueName);
        promises.push(this.redis.heartbeat(1, ak, job.id, now));
    }

    await Promise.all(promises);
  }

  // ── Phase 38: Worker Status Heartbeat ──────────────────────────────────────
  private startWorkerStatusLoop(): void {
    // Publish immediately, then every heartbeat interval
    this.publishWorkerStatus().catch(() => {});
    this.workerStatusTimer = setInterval(() => {
      this.publishWorkerStatus().catch(err => this.log(`Status Heartbeat Error: ${err.message}`));
    }, this.heartbeatInterval);
  }

  /**
   * Writes worker identity + live stats into a Redis Hash with a TTL of three
   * heartbeat intervals. One Hash per (queueName × workerId).
   */
  private async publishWorkerStatus(): Promise<void> {
    const now     = Date.now();
    const current = this.activeJobs.size > 0
      ? [...this.activeJobs.keys()].join(',')
      : '';

    const pipeline = this.redis.pipeline();
    for (const qName of this.queueNames) {
      const wk = workerKey(qName, this.workerId);
      pipeline.hset(wk,
        'id',             this.workerId,
        'pid',            String(this.workerPid),
        'host',           this.workerHost,
        'queues',         this.queueNames.join(','),
        'startedAt',      String(this.startedAt),
        'jobsProcessed',  String(this.jobsProcessed),
        'currentJob',     current,
        'lastHeartbeat',  String(now),
        'concurrency',    String(this.concurrency),
      );
      pipeline.expire(wk, this.statusTtlSeconds);
    }
    await pipeline.exec();
  }

  /** Deletes all worker hash keys for this process on graceful stop. */
  private async deleteWorkerStatus(): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const qName of this.queueNames) {
      pipeline.del(workerKey(qName, this.workerId));
    }
    await pipeline.exec();
  }

  private calculateNextRunAt(job: Job<T>, now: number): number {
    const strategy = job.backoff;
    if (!strategy) return now + 1000;

    const { type, delay } = strategy;
    const attemptsMade = job.attempts;

    if (type === "fixed") {
      return now + delay;
    } else if (type === "exponential") {
      return now + (delay * Math.pow(2, attemptsMade));
    }

    return now + delay;
  }
}
