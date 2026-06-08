import { Redis } from 'ioredis';
import { CronExpressionParser } from 'cron-parser';
import { Queue } from './Queue';
import { RepeatableJobDef } from './types';
import { cronKey } from './keys';

/**
 * Scheduler polls cron job definitions and enqueues a new job
 * whenever a cron expression's next run time has passed.
 * 
 * Duplicate prevention: an atomic compare-and-swap on the cron definition
 * (advanceCron.lua), so even if multiple Scheduler instances run in parallel,
 * only one fires each occurrence.
 */
export class Scheduler {
  private redis: Redis;
  private queues: Queue[];
  private pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;

  constructor(redis: Redis, queues: Queue[], pollIntervalMs = 500) {
    this.redis = redis;
    this.queues = queues;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Start the scheduler poll loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[Scheduler] Started — polling every ${this.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      // Skip this interval if the previous tick is still running (slow Redis)
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch(err => console.error('[Scheduler] Tick error:', err.message))
        .finally(() => { this.ticking = false; });
    }, this.pollIntervalMs);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    console.log('[Scheduler] Stopped.');
  }

  /**
   * One polling tick: checks all queues for due cron jobs.
   * For each repeatable job definition where nextRunAt <= now:
   *   1. Compute the next run time from the cron expression
   *   2. Compare-and-swap the definition (advanceCron.lua) — only the instance
   *      whose swap succeeds owns this occurrence
   *   3. Enqueue the job into the waiting set
   *
   * If the owner crashes between steps 2 and 3 that one occurrence is skipped,
   * rather than the cron job getting stuck behind a held lock.
   */
  private async tick(): Promise<void> {
    const now = Date.now();

    for (const queue of this.queues) {
      const queueName = queue.getName();
      const ck = cronKey(queueName);

      // Read all cron definitions for this queue
      const raw = await this.redis.hgetall(ck);
      if (!raw || Object.keys(raw).length === 0) continue;

      for (const [jobName, rawDef] of Object.entries(raw)) {
        const def: RepeatableJobDef = JSON.parse(rawDef);

        // Check if this job is due
        if (def.nextRunAt > now) continue;

        // Compute next run time from the cron expression
        const nextRunAt = CronExpressionParser.parse(def.cron).next().toDate().getTime();
        const updatedDef: RepeatableJobDef = { ...def, nextRunAt };

        // Compare-and-swap: only the instance that advances the definition owns this occurrence
        const owned = await this.redis.advanceCron(1, ck, jobName, rawDef, JSON.stringify(updatedDef));
        if (owned !== 1) {
          // Another Scheduler instance already handled this — skip
          continue;
        }

        await queue.add(def.name, def.data, def.options || {});
        console.log(`[Scheduler] ⏰ Cron job "${jobName}" fired on queue "${queueName}"`);
      }
    }
  }
}
