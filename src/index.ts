/**
 * Public entry point for using the engine as a library.
 *
 *   import { Queue, Worker, loadScripts } from 'atomicq';
 *
 * Call loadScripts(redis) once per Redis client before using Queue or Worker —
 * every state transition is a Lua script registered on that client.
 */

export { Queue } from './Queue';
export { Worker } from './Worker';
export { Scheduler } from './Scheduler';
export { loadScripts } from './scripts';
export { createQueueRouter } from './api';
export { registerShutdownHandlers } from './shutdown';
export type { ShutdownOptions } from './shutdown';
export {
  JobStatus,
  createJob,
  hydrateJob,
} from './types';
export type {
  Job,
  JobOptions,
  WorkerOptions,
  QueueMetrics,
  CleanupOptions,
  RepeatableJobDef,
  BackoffType,
} from './types';
