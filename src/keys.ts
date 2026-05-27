/**
 * Consistent Redis key naming templates to prevent collisions 
 * between different queues and different components.
 */

// Prefix to separate the engine data from other application data
const PREFIX = "queue";

export function jobKey(queueName: string, jobId: string): string {
  return `${PREFIX}:${queueName}:jobs:${jobId}`;
}

// Prefix passed to Lua scripts that build job keys from IDs they read out of a set.
export function jobKeyPrefix(queueName: string): string {
  return `${PREFIX}:${queueName}:jobs:`;
}

export function waitingKey(queueName: string): string {
  return `${PREFIX}:${queueName}:waiting`;
}

export function delayedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:delayed`;
}

export function limiterKey(queueName: string): string {
  return `${PREFIX}:${queueName}:limiter`;
}

export function activeKey(queueName: string): string {
  return `${PREFIX}:${queueName}:active`;
}

export function failedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:failed`;
}

export function completedKey(queueName: string): string {
  return `${PREFIX}:${queueName}:completed`;
}

export function cancelledKey(queueName: string): string {
  return `${PREFIX}:${queueName}:cancelled`;
}

export function metricsKey(queueName: string): string {
  return `${PREFIX}:${queueName}:metrics`;
}

export function channelKey(queueName: string): string {
  return `${PREFIX}:${queueName}:events`;
}

export function throughputKey(queueName: string, type: 'completed' | 'failed', minuteTimestamp: number): string {
  return `${PREFIX}:${queueName}:throughput:${type}:${minuteTimestamp}`;
}

// Stores all cron definitions for a queue (a Redis Hash)
// field = jobName, value = JSON of RepeatableJobDef
export function cronKey(queueName: string): string {
  return `${PREFIX}:${queueName}:cron`;
}

// Sorted set of job durations (ms). Score = duration, member = jobId.
// Capped at 1000 entries. Used for p50/p95/p99 latency calculations.
export function latencyKey(queueName: string): string {
  return `${PREFIX}:${queueName}:latency`;
}

// Simple string key. Exists = queue is paused. Workers skip polling when set.
export function pauseKey(queueName: string): string {
  return `${PREFIX}:${queueName}:paused`;
}

// Hash key for a single worker instance. Stores pid, host, heartbeat, stats.
// Pattern: queue:{queueName}:workers:{workerId}
// workerId must be unique across machines — a bare pid is not (every Docker
// container's main process is pid 1). Used for the Worker Status Panel (Phase 38).
export function workerKey(queueName: string, workerId: string): string {
  return `${PREFIX}:${queueName}:workers:${workerId}`;
}

// Glob pattern to SCAN for all worker keys across all queues.
export const WORKER_KEY_PATTERN = `${PREFIX}:*:workers:*`;

// Idempotency deduplication key. A simple Redis string (SET NX EX 86400).
// Stores the jobId that was originally created for this idempotency key.
export function idempotencyKey(queueName: string, key: string): string {
  return `${PREFIX}:${queueName}:idem:${key}`;
}
