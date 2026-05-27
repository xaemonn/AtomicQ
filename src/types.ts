export interface CleanupOptions {
  /** Remove jobs completed/failed more than this many ms ago. Default: 0 (disabled) */
  maxAge?: number;
  /** Keep only the N most recent completed/failed jobs. Default: 0 (disabled) */
  maxCount?: number;
  /** How often to run cleanup (ms). Default: 30000 (30s) */
  intervalMs?: number;
}

export enum JobStatus {
  WAITING = "WAITING",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  DELAYED = "DELAYED",
  CANCELLED = "CANCELLED",
}

export type BackoffType = "fixed" | "exponential";

export interface JobOptions {
  delay?: number;
  priority?: "low" | "normal" | "high";
  attempts?: number;
  backoff?: {
    type: BackoffType;
    delay: number;
  };
  /** If provided, duplicate calls with the same key within 24h return the original job. */
  idempotencyKey?: string;
}

export interface Job<T = any> {
  id: string;
  name: string;
  queueName: string;
  data: T;
  status: JobStatus;
  priority: "low" | "normal" | "high";
  attempts: number;
  maxAttempts: number;
  backoff?: JobOptions["backoff"];
  runAt: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  error?: {
    message: string;
    stack?: string;
  };
  progress?: number;
  heartbeatAt?: number;
  updateProgress?(progress: number): Promise<void>;
  isCancelled?(): boolean;
}

export interface WorkerOptions {
  concurrency?: number;
  pollInterval?: number;
  /** How often active jobs refresh their heartbeat (ms). Must be well below the watchdog stall timeout. Default: 15000 */
  heartbeatInterval?: number;
  rateLimit?: {
    max: number;
    durationMs: number;
  };
  /** Auto-cleanup options for completed/failed/cancelled jobs */
  cleanup?: CleanupOptions;
}

export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  cancelled: number;
  /** p50 processing latency in ms (median), null when no data */
  p50: number | null;
  /** p95 processing latency in ms, null when no data */
  p95: number | null;
  /** p99 processing latency in ms, null when no data */
  p99: number | null;
}

/** Describes a repeatable (cron) job stored in Redis */
export interface RepeatableJobDef {
  /** Unique name used as the key in Redis — also prevents duplicates */
  name: string;
  // Cron expression, e.g. every 10 seconds: "* /10 * * * *" (no space)
  cron: string;
  /** The job data payload to enqueue each time */
  data: any;
  /** Job options like attempts, priority */
  options?: JobOptions;
  /** Unix ms — when this job should next run */
  nextRunAt: number;
  /** When it was registered */
  createdAt: number;
}

/**
 * Factory function to create a new Job object
 */
export function createJob<T>(
  id: string,
  name: string,
  queueName: string,
  data: T,
  options: JobOptions = {}
): Job<T> {
  const now = Date.now();
  const delay = options.delay || 0;
  const runAt = now + delay;

  return {
    id,
    name,
    queueName,
    data,
    status: delay > 0 ? JobStatus.DELAYED : JobStatus.WAITING,
    priority: options.priority || "normal",
    attempts: 0,
    maxAttempts: options.attempts || 3,
    backoff: options.backoff,
    runAt,
    createdAt: now,
    progress: 0
  };
}

/**
 * Reconstructs a Job object from its raw Redis Hash representation
 */
export function hydrateJob<T>(raw: Record<string, string>): Job<T> | null {
  if (!raw || Object.keys(raw).length === 0) return null;

  try {
    const job: Job<T> = JSON.parse(raw.data || "{}");
    job.status = (raw.status as any);
    
    if (raw.attempts) job.attempts = Number(raw.attempts);
    if (raw.maxAttempts) job.maxAttempts = Number(raw.maxAttempts);
    if (raw.runAt) job.runAt = Number(raw.runAt);
    if (raw.startedAt) job.startedAt = Number(raw.startedAt);
    if (raw.completedAt) job.completedAt = Number(raw.completedAt);
    if (raw.failedAt) job.failedAt = Number(raw.failedAt);
    if (raw.heartbeatAt) job.heartbeatAt = Number(raw.heartbeatAt);
    if (raw.progress) job.progress = Number(raw.progress);
    
    if (raw.error) {
      try {
        job.error = JSON.parse(raw.error);
      } catch {
        job.error = { message: raw.error };
      }
    }
    
    return job;
  } catch (err) {
    console.error("❌ Failed to hydrate job:", err);
    return null;
  }
}
