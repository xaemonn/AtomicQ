/**
 * src/shutdown.ts
 *
 * Centralised graceful-shutdown orchestrator.
 *
 * Usage:
 *   import { registerShutdownHandlers } from './shutdown';
 *   registerShutdownHandlers({ workers, queues, redisClients, httpServer, scheduler });
 *
 * What it does:
 *   1. Listens for SIGTERM + SIGINT (only registers once per process).
 *   2. On signal:
 *      a. Stops accepting new jobs (worker.stop() stops poll loop immediately).
 *      b. Waits for active jobs to drain — up to DRAIN_TIMEOUT_MS (30 s).
 *      c. Stops queue timers (cleanup + watchdog) and the scheduler.
 *      d. Closes HTTP server (stops new connections).
 *      e. Closes all Redis connections.
 *      f. Exits with code 0 (clean) or 1 (timed out / error).
 */

import { Worker }    from './Worker';
import { Queue }     from './Queue';
import { Scheduler } from './Scheduler';
import { Redis }     from 'ioredis';
import { Server }    from 'http';

export interface ShutdownOptions {
  workers?:      Worker[];
  queues?:       Queue[];
  redisClients?: Redis[];
  httpServer?:   Server;
  scheduler?:    Scheduler;
  /** How long to wait for active jobs to drain. Default: 30 000 ms */
  drainTimeoutMs?: number;
}

let registered = false; // guard — only register signal handlers once

export function registerShutdownHandlers(opts: ShutdownOptions = {}): void {
  if (registered) return;
  registered = true;

  const DRAIN_TIMEOUT = opts.drainTimeoutMs ?? Worker.DEFAULT_SHUTDOWN_TIMEOUT_MS;

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n\n[Shutdown] 🛑 ${signal} received — starting graceful shutdown…`);
    const start = Date.now();

    // ── 1. Stop each worker (drain active jobs, with shared timeout) ──────────
    const workers = opts.workers ?? [];
    if (workers.length > 0) {
      console.log(`[Shutdown] Stopping ${workers.length} worker(s)…`);
      const results = await Promise.all(workers.map(w => w.stop(DRAIN_TIMEOUT)));
      const allClean = results.every(Boolean);

      if (!allClean) {
        // At least one worker timed out
        console.error(`[Shutdown] ⚠️  One or more workers did not drain cleanly within ${DRAIN_TIMEOUT / 1000}s.`);
        cleanup(opts);
        console.error(`[Shutdown] Force exit after ${Date.now() - start}ms.`);
        process.exit(1);
      }
    }

    // ── 2. Stop queue background timers ──────────────────────────────────────
    const queues = opts.queues ?? [];
    queues.forEach(q => { q.stopCleanup(); q.stopWatchdog(); });
    if (queues.length > 0) {
      console.log(`[Shutdown] ✅ Queue timers stopped (${queues.length} queues).`);
    }

    // ── 3. Stop scheduler ────────────────────────────────────────────────────
    if (opts.scheduler) {
      opts.scheduler.stop();
      console.log('[Shutdown] ✅ Scheduler stopped.');
    }

    // ── 4. Close HTTP server ─────────────────────────────────────────────────
    await closeServer(opts.httpServer);

    // ── 5. Close Redis connections ────────────────────────────────────────────
    cleanup(opts);

    const elapsed = Date.now() - start;
    console.log(`[Shutdown] ✅ Clean exit after ${elapsed}ms.\n`);
    process.exit(0);
  }

  // Register once for both SIGTERM (production kill) and SIGINT (Ctrl+C)
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(fatalExit));
  process.once('SIGINT',  () => shutdown('SIGINT').catch(fatalExit));

  console.log('[Shutdown] 🔒 Signal handlers registered (SIGTERM, SIGINT). Drain timeout:', DRAIN_TIMEOUT / 1000, 's');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanup(opts: ShutdownOptions): void {
  const clients = opts.redisClients ?? [];
  clients.forEach(r => { try { r.disconnect(); } catch {} });
  if (clients.length > 0) {
    console.log(`[Shutdown] ✅ ${clients.length} Redis connection(s) closed.`);
  }
}

function closeServer(server?: Server): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise(resolve => {
    server.close(() => {
      console.log('[Shutdown] ✅ HTTP server closed.');
      resolve();
    });
    // Give it 5 s max
    setTimeout(resolve, 5_000);
  });
}

function fatalExit(err: Error): void {
  console.error('[Shutdown] ❌ Fatal error during shutdown:', err.message);
  process.exit(1);
}
