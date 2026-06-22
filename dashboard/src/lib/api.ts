// Typed client for the AtomicQ REST API (src/api.ts on the server).

export interface Metrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  delayed: number;
  /** Processing latency percentiles in ms, null when no data */
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface JobError {
  message: string;
  stack?: string;
}

export interface Job {
  id: string;
  name: string;
  queueName?: string;
  status: string;
  priority?: string;
  attempts: number;
  maxAttempts: number;
  backoff?: { type: string; delay: number };
  data: unknown;
  progress?: number;
  runAt: number;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  error?: JobError | string;
}

// Payload relayed from Redis Pub/Sub (queue:{name}:events) over Socket.IO
export interface JobEvent {
  event: 'job:added' | 'job:active' | 'job:progress' | 'job:completed' | 'job:retrying' | 'job:failed' | 'cancel';
  queueName: string;
  jobId: string;
  progress?: number;
  error?: string;
  runAt?: number;
}

/** A live event as shown in the event stream: stamped on arrival in the browser. */
export interface FeedItem extends JobEvent {
  key: number;
  at: number;
}

export interface ThroughputBucket {
  /** Bucket end, formatted in the server's timezone */
  time: string;
  /** Bucket end in ms — format this one for display */
  timestamp?: number;
  completed: number;
  failed: number;
}

// Worker status hash — every field is a string in Redis
export interface WorkerInfo {
  id?: string;
  pid: string;
  host: string;
  queues: string;
  startedAt: string;
  jobsProcessed: string;
  currentJob: string;
  lastHeartbeat: string;
  concurrency: string;
}

export interface Health {
  status: string;
  redisConnected: boolean;
  activeWorkers?: number;
  queueDepth?: number;
}

export interface Repeatable {
  name: string;
  cron: string;
  data: unknown;
  options?: { priority?: string; attempts?: number };
  nextRunAt: number;
  createdAt: number;
}

export interface NewJob {
  name: string;
  data: unknown;
  options: { priority?: string; delay?: number; attempts?: number };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const q = (queue: string) => `/queues/${encodeURIComponent(queue)}`;
const post = (body?: unknown): RequestInit =>
  body === undefined
    ? { method: 'POST' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };

export const api = {
  queues: () => request<{ queues: string[] }>('/queues').then(r => r.queues),
  metrics: (queue: string) => request<{ metrics: Metrics }>(`${q(queue)}/metrics`).then(r => r.metrics),
  jobs: (queue: string, status: string, start: number, limit: number) =>
    request<{ jobs: Job[] }>(`${q(queue)}/jobs?status=${status}&start=${start}&limit=${limit}`).then(r => r.jobs),
  job: (queue: string, id: string) =>
    request<{ job: Job }>(`${q(queue)}/jobs/${encodeURIComponent(id)}`).then(r => r.job),
  addJob: (queue: string, job: NewJob) => request<{ job: Job }>(`${q(queue)}/jobs`, post(job)).then(r => r.job),
  retry: (queue: string, id: string) => request<unknown>(`${q(queue)}/jobs/${encodeURIComponent(id)}/retry`, post()),
  cancel: (queue: string, id: string) =>
    request<unknown>(`${q(queue)}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  retryAll: (queue: string) => request<{ count: number }>(`${q(queue)}/retry-all`, post()).then(r => r.count),
  /** Removes completed jobs older than one hour. */
  clearCompleted: (queue: string) =>
    request<{ count: number }>(`${q(queue)}/jobs/completed`, { method: 'DELETE' }).then(r => r.count),
  /** Removes every completed, failed and cancelled record (anything older than 1 ms). */
  purgeHistory: (queue: string) =>
    request<{ details: { completed: number; failed: number; cancelled: number } }>(
      `${q(queue)}/cleanup`,
      post({ maxAge: 1 }),
    ).then(r => r.details),
  isPaused: (queue: string) => request<{ paused: boolean }>(`${q(queue)}/pause`).then(r => r.paused),
  pause: (queue: string) => request<unknown>(`${q(queue)}/pause`, post()),
  resume: (queue: string) => request<unknown>(`${q(queue)}/pause`, { method: 'DELETE' }),
  throughput: (queue: string) =>
    request<{ buckets: ThroughputBucket[] }>(`${q(queue)}/throughput`).then(r => r.buckets),
  repeatables: (queue: string) =>
    request<{ repeatables: Repeatable[] }>(`${q(queue)}/repeatables`).then(r => r.repeatables),
  workers: () => request<{ workers: WorkerInfo[] }>('/workers').then(r => r.workers),
  // Answers 503 with a body when Redis is down, so read the body whatever the status
  health: async (): Promise<Health> => {
    const res = await fetch('/api/health');
    return (await res.json()) as Health;
  },
};
