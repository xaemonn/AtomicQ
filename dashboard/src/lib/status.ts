import type { Job, JobEvent, Metrics, WorkerInfo } from './api';

export const STATUSES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'cancelled'] as const;
export type StatusKey = (typeof STATUSES)[number];

interface StatusStyle {
  label: string;
  /** Text colour */
  text: string;
  /** Solid fill (dots, bars) */
  fill: string;
  /** Tinted background + border, for pills */
  soft: string;
  /** Top edge of a pipeline stage */
  edge: string;
}

// Full class names so Tailwind's scanner can see them
export const STATUS: Record<StatusKey, StatusStyle> = {
  waiting:   { label: 'Waiting',   text: 'text-amber-300',   fill: 'bg-amber-400',   soft: 'border-amber-400/25 bg-amber-400/10',     edge: 'border-t-amber-400' },
  active:    { label: 'Active',    text: 'text-sky-300',     fill: 'bg-sky-400',     soft: 'border-sky-400/25 bg-sky-400/10',         edge: 'border-t-sky-400' },
  completed: { label: 'Completed', text: 'text-emerald-300', fill: 'bg-emerald-400', soft: 'border-emerald-400/25 bg-emerald-400/10', edge: 'border-t-emerald-400' },
  failed:    { label: 'Failed',    text: 'text-rose-300',    fill: 'bg-rose-400',    soft: 'border-rose-400/25 bg-rose-400/10',       edge: 'border-t-rose-400' },
  delayed:   { label: 'Delayed',   text: 'text-violet-300',  fill: 'bg-violet-400',  soft: 'border-violet-400/25 bg-violet-400/10',   edge: 'border-t-violet-400' },
  cancelled: { label: 'Cancelled', text: 'text-slate-400',   fill: 'bg-slate-500',   soft: 'border-slate-500/30 bg-slate-500/10',     edge: 'border-t-slate-500' },
};

/** Maps a job's server status ("ACTIVE") to its style key. */
export function statusKey(raw: string | undefined): StatusKey {
  const key = (raw ?? '').toLowerCase();
  return (STATUSES as readonly string[]).includes(key) ? (key as StatusKey) : 'waiting';
}

export const EMPTY_METRICS: Metrics = {
  waiting: 0, active: 0, completed: 0, failed: 0, cancelled: 0, delayed: 0,
  p50: null, p95: null, p99: null,
};

const dec = (n: number) => Math.max(0, n - 1);

/**
 * Applies a batch of live events to the per-queue counters so the numbers
 * move between polls. The next poll replaces them with the real counts.
 */
export function applyEvents(prev: Record<string, Metrics>, batch: JobEvent[]): Record<string, Metrics> {
  const next = { ...prev };
  for (const e of batch) {
    if (!next[e.queueName]) continue;
    // Copy a queue's counters the first time this batch touches them
    if (next[e.queueName] === prev[e.queueName]) next[e.queueName] = { ...prev[e.queueName] };
    const m = next[e.queueName];
    switch (e.event) {
      case 'job:added':     if (e.delayed) m.delayed++; else m.waiting++; break;
      case 'job:active':    m.waiting = dec(m.waiting); m.active++; break;
      case 'job:completed': m.active = dec(m.active); m.completed++; break;
      case 'job:failed':    m.active = dec(m.active); m.failed++; break;
      case 'job:retrying':  m.active = dec(m.active); m.delayed++; break;
    }
  }
  return next;
}

/** Applies one live event to a job row / detail that is already on screen. */
export function patchJob(job: Job, e: JobEvent): Job {
  switch (e.event) {
    case 'job:progress':  return e.progress === undefined ? job : { ...job, progress: e.progress };
    case 'job:active':    return { ...job, status: 'ACTIVE' };
    case 'job:completed': return { ...job, status: 'COMPLETED' };
    case 'job:retrying':  return { ...job, status: 'DELAYED' };
    case 'job:failed':    return { ...job, status: 'FAILED', error: e.error };
    case 'cancel':        return { ...job, status: 'CANCELLED' };
    default:              return job;
  }
}

/** Heartbeat age → health: live under 15 s, stale under 30 s, otherwise unresponsive. */
export function workerHealth(worker: WorkerInfo, now: number): { label: string; dot: string; text: string } {
  const age = now - (Number(worker.lastHeartbeat) || 0);
  if (age < 15_000) return { label: 'Live', dot: 'bg-emerald-400', text: 'text-emerald-300' };
  if (age < 30_000) return { label: 'Stale', dot: 'bg-amber-400', text: 'text-amber-300' };
  return { label: 'Unresponsive', dot: 'bg-rose-500', text: 'text-rose-300' };
}
